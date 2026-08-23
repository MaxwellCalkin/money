import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decodeSettlement } from "../bridge/x402.ts";
import { configuredHttpOrigin } from "../core/api-client.ts";
import { readBoundedResponseText } from "../core/bounded-response.ts";
import { signedHeaders } from "../core/identity.ts";
import { secretFromEnv } from "../core/key-files.ts";
import { fmt, usd } from "../core/types.ts";
import { AgentFetchPolicy, pinnedAgentFetch } from "./outbound.ts";
import { parseExternalPaymentDemand, type ExternalPaymentDemand } from "./x402-demand.ts";

/**
 * The agent-facing surface: an MCP server any runtime (Claude Code, Cursor,
 * Codex) can mount with one config line. The agent gets these verbs:
 *
 *   money_balance     — how much can I still spend under the mandate?
 *   money_pay         — pay any account on the network (agent, provider, user)
 *   money_fetch       — GET a URL; if it answers 402, pay the challenge within
 *                       the mandate and retry (the x402-shaped loop)
 *   money_card_create — reserved virtual card for ordinary merchants, under
 *                       the same mandate (never returns the card number)
 *   money_card_status — one card's state and authorizations
 *   money_card_close  — close a card; the unspent remainder returns
 *   money_feed        — the receipt feed
 *
 * The agent never holds keys or balances — only its account id. Every spend
 * is policy-checked server-side against the owner's mandate.
 *
 * The agent's identity is its Ed25519 private key: every network API call is
 * signed, and the network verifies against the public key registered at
 * agent creation. Spend requests without a valid signature are rejected.
 *
 * Config:
 *   MONEY_API            base URL of the network API (default http://127.0.0.1:4021)
 *   MONEY_AGENT_ID       this agent's account id (required)
 *   MONEY_AGENT_KEY_FILE path to a file whose first line is the agent's
 *                        private key, base64 PKCS#8 (written by onboarding;
 *                        preferred — keeps the key out of .mcp.json)
 *   MONEY_AGENT_KEY      the private key inline (fallback; treat like a password)
 */
const MAX_NETWORK_RESPONSE_BYTES = 256 * 1024;
const MAX_RESOURCE_RESPONSE_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

const API = configuredHttpOrigin(
  process.env.MONEY_API ?? "http://127.0.0.1:4021",
  "MONEY_API",
);
const AGENT_ID = process.env.MONEY_AGENT_ID;
let AGENT_KEY: string | undefined;
try {
  AGENT_KEY = secretFromEnv("MONEY_AGENT_KEY");
} catch (error) {
  // A missing or unreadable key file is the expected failure when a checked-in
  // .mcp.json lands on a machine without the gitignored .money/ directory —
  // it deserves a directed message, not a raw ENOENT stack.
  console.error(
    `money MCP: could not read MONEY_AGENT_KEY_FILE (${error instanceof Error ? error.message : error}). ` +
    "Fix the path in .mcp.json, or re-run onboarding on this machine to write the key file.",
  );
  process.exit(1);
}
const fetchPolicy = new AgentFetchPolicy({
  privateOrigins: process.env.MONEY_FETCH_PRIVATE_ORIGINS,
});

if (!AGENT_ID || !AGENT_KEY) {
  console.error("MONEY_AGENT_ID and MONEY_AGENT_KEY_FILE (or MONEY_AGENT_KEY) are required — both come from onboarding on your money network");
  process.exit(1);
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const body = typeof init?.body === "string" ? init.body : "";
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...signedHeaders(AGENT_ID!, AGENT_KEY!, { method: init?.method ?? "GET", path, body }),
      ...(init?.headers ?? {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const responseBody = await readBoundedResponseText(
    res,
    MAX_NETWORK_RESPONSE_BYTES,
    "money API response is too large",
  );
  let parsed: unknown = {};
  try {
    parsed = responseBody ? JSON.parse(responseBody) as unknown : {};
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed };
}

async function agentFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return pinnedAgentFetch(fetchPolicy, url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

async function resourceBody(response: Response): Promise<string> {
  return readBoundedResponseText(
    response,
    MAX_RESOURCE_RESPONSE_BYTES,
    "fetched resource is too large",
  );
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

const server = new McpServer({ name: "money", version: "0.14.0" });

server.tool(
  "money_balance",
  "Check how much this agent can still spend under its owner's mandate on the money network.",
  {},
  async () => {
    const { body } = await api("/agent/state");
    return text({ account: body.account, mandate: body.mandate });
  }
);

server.tool(
  "money_pay",
  "Pay another account on the money network (an agent, a provider, or a user). Spends under the owner's mandate; larger payments return a durable approval_required request for the owner inbox.",
  {
    to: z.string().describe("destination account id or public handle, e.g. agt_1a2b3c4d or @researcher"),
    amount_usd: z.number().positive().describe("amount in dollars, e.g. 0.25"),
    memo: z.string().default("").describe("what this payment is for"),
    idempotency_key: z
      .string()
      .min(1)
      .describe(
        "REQUIRED stable key for this logical payment (e.g. 'task-123-pay-writer'). When retrying the SAME payment, reuse the exact same key — the network will return the original receipt instead of charging twice. A new payment needs a new key."
      ),
  },
  async ({ to, amount_usd, memo, idempotency_key }) => {
    const { body } = await api("/pay", {
      method: "POST",
      body: JSON.stringify({
        to,
        amountMicros: usd(amount_usd),
        memo,
        idempotencyKey: idempotency_key,
      }),
    });
    return text(body);
  }
);

/**
 * Paid-but-unredeemed challenges, by URL. If the post-payment fetch fails,
 * the credentials wait here so the next money_fetch of the same URL resumes
 * with the existing receipt instead of paying a second time.
 */
const pendingRedemptions = new Map<string, { challengeId: string; receiptId: string }>();
/** High-value internal calls waiting for the owner's durable approval. The
 * original challenge is retained so the next tool call recovers the approved
 * receipt instead of generating a second challenge/request. */
const pendingApprovals = new Map<string, WaitingApproval>();

/**
 * External x402 purchases in flight, by URL (separate namespace from the
 * internal map — a URL that switches flows must not cross-wire state). The
 * idempotency key is stored BEFORE paying, so a lost response resumes with
 * the same key and the network returns the original header — never a second
 * debit or a second signed authorization.
 */
const pendingExternal = new Map<string, PendingExternal>();

async function fetchWithReceipt(url: string, challengeId: string, receiptId: string): Promise<Response> {
  return agentFetch(url, {
    headers: {
      "x-agent-id": AGENT_ID!,
      "x-payment-challenge": challengeId,
      "x-payment-receipt": receiptId,
    },
  });
}

async function deliverInternal(
  url: string,
  challengeId: string,
  payment: any,
  advertised: number
) {
  const paidMicros: number = payment.receipt.amount;
  const receiptId: string = payment.receipt.id;
  pendingRedemptions.set(url, { challengeId, receiptId });

  let retry: Response;
  try {
    retry = await fetchWithReceipt(url, challengeId, receiptId);
  } catch {
    return text({
      status: 0,
      error: "paid, but the retry fetch failed — receipt retained; call money_fetch again with the same url to resume without paying twice",
      paid: fmt(paidMicros),
      receiptId,
    });
  }
  const body = await resourceBody(retry);
  if (retry.ok) pendingRedemptions.delete(url);
  return text({
    status: retry.status,
    paid: fmt(paidMicros),
    ...(advertised !== paidMicros ? { warning: `page advertised ${fmt(advertised)} but the network charged ${fmt(paidMicros)}` } : {}),
    ...(retry.ok ? {} : { note: "paid but resource not served; receipt retained — call money_fetch again to resume" }),
    receiptId,
    body: safeJson(body),
  });
}

type WaitingApproval = { challengeId: string; approvalId: string; advertised: number };

async function resumeInternalApproval(url: string, waiting: WaitingApproval) {
  const resumedPayment = await api("/pay-challenge", {
    method: "POST",
    body: JSON.stringify({ challengeId: waiting.challengeId }),
  });
  if (resumedPayment.body?.status === "approval_required") {
    return text({
      status: 202,
      approval: resumedPayment.body.approval,
      note: "payment is still waiting in the owner's approval inbox",
    });
  }
  pendingApprovals.delete(url);
  if (resumedPayment.body?.status === "paid") {
    return deliverInternal(url, waiting.challengeId, resumedPayment.body, waiting.advertised);
  }
  return text({ status: resumedPayment.status, error: "owner approval did not produce a payment", decision: resumedPayment.body });
}

/** Rediscover a challenge approval after this MCP process restarted. */
async function discoverApproval(url: string): Promise<WaitingApproval | undefined> {
  const parsed = new URL(url);
  const memos = new Set([`402:${parsed.toString()}`, `402:${parsed.pathname}${parsed.search}`]);
  const state = await api("/agent/state?limit=1");
  const approvals = Array.isArray(state.body?.approvals) ? state.body.approvals : [];
  const approval = [...approvals].reverse().find((candidate: any) =>
    (candidate.status === "pending" || candidate.status === "approved") &&
    candidate.challenge?.redeemed === false &&
    typeof candidate.idempotencyKey === "string" &&
    candidate.idempotencyKey.startsWith("chl_") &&
    memos.has(candidate.memo)
  );
  if (!approval) return undefined;
  return {
    challengeId: approval.challenge.id,
    approvalId: approval.id,
    advertised: approval.amount,
  };
}

type PendingExternal = {
  idempotencyKey?: string;
  externalId?: string;
  paymentHeader?: string;
  paymentHeaderName?: string;
  paidMicros?: number;
  settlementHeader?: string;
  settlementHeaderName?: string;
  deliveredStatus?: number;
  deliveredBody?: string;
};

async function confirmExternalDelivery(url: string, pending: PendingExternal) {
  if (!pending.externalId || !pending.settlementHeader) {
    return text({
      status: pending.deliveredStatus ?? 502,
      paid: fmt(pending.paidMicros ?? 0),
      error: "seller delivered without a verifiable x402 settlement claim; the pending debit will auto-reverse",
      body: safeJson(pending.deliveredBody ?? ""),
    });
  }
  const confirmation = await api(`/pay-external/${pending.externalId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ settlement: pending.settlementHeader }),
  }).catch(() => ({ status: 0, body: { error: "network_unavailable" } }));
  if (confirmation.status >= 200 && confirmation.status < 300 && confirmation.body?.ok === true) {
    pendingExternal.delete(url);
    return text({
      status: pending.deliveredStatus ?? 200,
      paid: fmt(pending.paidMicros ?? 0),
      ...(confirmation.body.settledTx ? { settledTx: confirmation.body.settledTx } : {}),
      body: safeJson(pending.deliveredBody ?? ""),
    });
  }
  // Keep the seller's claim and response in memory. The next tool call retries
  // confirmation only; it never resends the one-time payment authorization.
  return text({
    status: confirmation.status,
    paid: fmt(pending.paidMicros ?? 0),
    externalId: pending.externalId,
    error: "seller delivered, but settlement confirmation has not completed; call money_fetch again to retry confirmation",
    confirmation: confirmation.body,
    body: safeJson(pending.deliveredBody ?? ""),
  });
}

/** Retry an external URL with an already-issued X-PAYMENT header, then
 *  confirm settlement (finalizing the pending debit — unconfirmed payments
 *  auto-reverse server-side). */
async function retryExternal(url: string, pending: PendingExternal) {
  if (pending.settlementHeader) return confirmExternalDelivery(url, pending);
  let res: Response;
  try {
    res = await agentFetch(url, {
      headers: { [pending.paymentHeaderName ?? "x-payment"]: pending.paymentHeader! },
    });
  } catch {
    return text({
      status: 0,
      error: "paid, but the retry fetch failed — payment header retained; call money_fetch again with the same url to resume without paying twice",
      paid: fmt(pending.paidMicros ?? 0),
      externalId: pending.externalId,
    });
  }
  const bodyText = await resourceBody(res);
  if (res.ok) {
    const settlementHeader = res.headers.get(pending.settlementHeaderName ?? "x-payment-response");
    pending.deliveredStatus = res.status;
    pending.deliveredBody = bodyText;
    if (!settlementHeader || !decodeSettlement(settlementHeader)) {
      pendingExternal.delete(url);
      return text({
        status: res.status,
        paid: fmt(pending.paidMicros ?? 0),
        error: "seller delivered without a valid x402 settlement response; the pending debit will auto-reverse",
        body: safeJson(bodyText),
      });
    }
    pending.settlementHeader = settlementHeader;
    return confirmExternalDelivery(url, pending);
  }
  // The seller refused the header (expired, replayed, or hostile). Drop the
  // local state; the unredeemed pending payment auto-reverses server-side.
  pendingExternal.delete(url);
  return text({
    status: res.status,
    paid: fmt(pending.paidMicros ?? 0),
    error: "paid but the external server refused the payment header; the unconfirmed payment will auto-reverse",
    body: safeJson(bodyText),
  });
}

/** Fresh external x402 purchase: pay through the bridge, retry with the
 *  issued X-PAYMENT header. */
async function externalFetch(url: string, demand: ExternalPaymentDemand) {
  let pending = pendingExternal.get(url);
  if (!pending) {
    const recovered = await bestEffortRecovery("external payment recovery", discoverExternal(url));
    if (recovered) {
      pendingExternal.set(url, recovered);
      const resumed = await resumeExternal(url, recovered);
      if (resumed) return resumed;
    }
  }
  pending = pendingExternal.get(url);
  if (!pending) {
    pending = { idempotencyKey: `xfetch-${randomUUID()}` };
    pendingExternal.set(url, pending); // stored BEFORE paying: a lost response resumes with the same key
  }

  const payment = await api("/pay-external", {
    method: "POST",
    body: JSON.stringify({
      url,
      requirement: demand.requirement,
      idempotencyKey: pending.idempotencyKey,
      x402Version: demand.protocolVersion,
      ...(demand.resource ? { resource: demand.resource } : {}),
      ...(demand.extensions ? { extensions: demand.extensions } : {}),
    }),
  });
  if (payment.body?.status === "approval_required") {
    pending.externalId = payment.body.externalId;
    return text({
      status: 202,
      approval: payment.body.approval,
      externalId: payment.body.externalId,
      note: "external payment is waiting in the owner's approval inbox; call money_fetch again after the owner decides",
    });
  }
  if (payment.body?.status !== "paid") {
    pendingExternal.delete(url); // nothing debited — a future attempt starts fresh
    return text({ status: 402, error: "external payment was not authorized by policy", decision: payment.body });
  }
  pending.externalId = payment.body.externalId;
  pending.paymentHeader = payment.body.paymentHeader;
  pending.paymentHeaderName = payment.body.paymentHeaderName;
  pending.settlementHeaderName = payment.body.settlementHeaderName;
  pending.paidMicros = payment.body.receipt?.amount;
  return retryExternal(url, pending);
}

async function resumeExternal(url: string, pending: PendingExternal) {
  if (!pending.externalId) return undefined;
  const resumed = await api(`/pay-external/${pending.externalId}/resume`, {
    method: "POST",
    body: "{}",
  });
  if (resumed.body?.status === "approval_required") {
    return text({
      status: 202,
      approval: resumed.body.approval,
      externalId: pending.externalId,
      note: "external payment is still waiting in the owner's approval inbox",
    });
  }
  if (resumed.body?.status !== "paid") {
    if (resumed.status === 404 && resumed.body?.error !== "external_payment_not_found") {
      warnRecoveryUnsupported("/pay-external/:id/resume");
    }
    pendingExternal.delete(url);
    return text({ status: resumed.status, error: "durable external payment could not be resumed", decision: resumed.body });
  }
  pending.paymentHeader = resumed.body.paymentHeader;
  pending.paymentHeaderName = resumed.body.paymentHeaderName;
  pending.settlementHeaderName = resumed.body.settlementHeaderName;
  pending.paidMicros = resumed.body.receipt?.amount;
  return retryExternal(url, pending);
}

/** Recovery is best-effort, but its failures must be audible: a connected API
 * that lacks the durable recovery endpoints (the JSONL showcase server) means
 * crash recovery of in-flight external payments silently does not exist. */
let recoveryUnsupportedWarned = false;

function warnRecoveryUnsupported(path: string): void {
  if (recoveryUnsupportedWarned) return;
  recoveryUnsupportedWarned = true;
  console.error(
    `money MCP: ${API} does not implement ${path} — crash recovery of in-flight external payments is unavailable on this API. Point MONEY_API at a network API with durable recovery (the Postgres-backed server).`,
  );
}

async function bestEffortRecovery<T>(operation: string, task: Promise<T>): Promise<T | undefined> {
  try {
    return await task;
  } catch (error) {
    console.error(
      `money MCP: ${operation} failed (${error instanceof Error ? error.message : "unknown error"}); continuing without recovered state`,
    );
    return undefined;
  }
}

/** Rediscover an unresolved external purchase after this MCP process restarts. */
async function discoverExternal(url: string): Promise<PendingExternal | undefined> {
  const lookup = await api(`/pay-external/unresolved?resource=${encodeURIComponent(url)}`);
  if (lookup.status === 200 && typeof lookup.body?.externalId === "string") {
    return { externalId: lookup.body.externalId };
  }
  // The Postgres API answers "nothing to recover" with an explicit error body;
  // a bare 404 means the route itself is missing on this server.
  if (lookup.status === 404 && lookup.body?.error !== "external_payment_not_found") {
    warnRecoveryUnsupported("/pay-external/unresolved");
  }
  return undefined;
}

server.tool(
  "money_fetch",
  "Fetch a URL. If the server responds 402 Payment Required — either a money-network challenge or an external x402 seller (accepts[]) — pay it from this agent's mandate and retry automatically. External payments go through the network's x402 bridge: policy-checked, capped, and auto-reversed if the seller never delivers. Retry-safe: if a previous call paid but failed to retrieve the resource, this resumes with the existing receipt/header instead of paying again. Returns the resource plus what was actually paid (from the receipt).",
  {
    url: z.string().url().describe("the URL to fetch"),
  },
  async ({ url }) => {
    try {
      // Canonical href is also the retry/idempotency map key. Fragments,
      // default-port aliases, and host casing must not create a second pay.
      url = (await fetchPolicy.validate(url)).href;
    } catch (error) {
      return text({
        status: 0,
        error: "fetch_target_rejected",
        reason: error instanceof Error ? error.message : "unsafe fetch target",
      });
    }

    // Resume path (external): memory first, then the durable network record so
    // an MCP restart cannot create a second debit for the same in-flight URL.
    const extPending = pendingExternal.get(url);
    if (extPending?.paymentHeader) {
      return retryExternal(url, extPending);
    }
    if (extPending?.externalId) {
      const resumed = await resumeExternal(url, extPending);
      if (resumed) return resumed;
    }
    const recoveredExternal = await bestEffortRecovery("external payment recovery", discoverExternal(url));
    if (recoveredExternal) {
      pendingExternal.set(url, recoveredExternal);
      const resumed = await resumeExternal(url, recoveredExternal);
      if (resumed) return resumed;
    }

    // Resume path (internal): we already paid for this URL but never got the resource.
    const pending = pendingRedemptions.get(url);
    if (pending) {
      try {
        const resumed = await fetchWithReceipt(url, pending.challengeId, pending.receiptId);
        if (resumed.ok) {
          pendingRedemptions.delete(url);
          const body = await resourceBody(resumed);
          return text({ status: resumed.status, paid: "$0.00", note: "resumed with previously paid receipt", body: safeJson(body) });
        }
        if (resumed.status >= 300 && resumed.status < 400) {
          await resumed.body?.cancel().catch(() => undefined);
          return text({
            status: resumed.status,
            error: "paid resource attempted to redirect; receipt retained and credentials were not forwarded",
            challengeId: pending.challengeId,
            receiptId: pending.receiptId,
          });
        }
        // Redemption rejected (expired/consumed) — drop it and start fresh.
        pendingRedemptions.delete(url);
      } catch {
        return text({
          status: 0,
          error: "network error while resuming a previously paid fetch; receipt retained — call money_fetch again",
          challengeId: pending.challengeId,
          receiptId: pending.receiptId,
        });
      }
    }

    // Resume path (approval): retry the SAME challenge. While pending, the
    // network returns the same approval; once approved it returns the original
    // receipt and the resource retry continues without a second debit.
    const waiting = pendingApprovals.get(url);
    if (waiting) return resumeInternalApproval(url, waiting);

    let first: Response;
    try {
      first = await agentFetch(url, { headers: { "x-agent-id": AGENT_ID! } });
    } catch (error) {
      return text({
        status: 0,
        error: "fetch_failed",
        reason: error instanceof Error ? error.message : "network error",
      });
    }
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get("location");
      await first.body?.cancel().catch(() => undefined);
      if (!location) return text({ status: first.status, error: "redirect is missing Location" });
      try {
        const redirect = await fetchPolicy.validate(new URL(location, url).href);
        return text({
          status: first.status,
          redirect: redirect.href,
          note: "redirect was not followed automatically; call money_fetch with this validated URL",
        });
      } catch (error) {
        return text({
          status: first.status,
          error: "unsafe_redirect",
          reason: error instanceof Error ? error.message : "redirect target rejected",
        });
      }
    }
    if (first.status !== 402) {
      const body = await resourceBody(first);
      return text({ status: first.status, paid: "$0.00", body: safeJson(body) });
    }

    type ChallengeBody = {
      challengeId?: string;
      amountMicros?: number;
      payTo?: string;
      accepts?: unknown[];
      x402Version?: number;
      resource?: unknown;
      extensions?: unknown;
    };
    const challengeText = await resourceBody(first);
    let challenge: ChallengeBody | null = null;
    try {
      const parsed = challengeText ? JSON.parse(challengeText) as unknown : null;
      challenge = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as ChallengeBody : null;
    } catch {
      challenge = null;
    }
    if (!challenge?.challengeId) {
      // Not our network's 402. If it speaks external x402 (accepts[]), pay it
      // through the bridge. The internal challengeId flow is deliberately
      // preferred when both are present — flow choice must not be steerable
      // by a malicious body.
      const demand = parseExternalPaymentDemand(first.headers.get("payment-required"), challenge);
      const paymentUrl = url;
      return demand.ok
        ? externalFetch(paymentUrl, demand.demand)
        : text({ status: 402, error: demand.reason, body: challenge });
    }

    // A fresh seller challenge may have been issued after this MCP process
    // restarted. Prefer any older durable, unredeemed approval for the same
    // resource and let the new unpaid challenge expire in memory.
    const recovered = await bestEffortRecovery("approval recovery", discoverApproval(url));
    if (recovered) {
      pendingApprovals.set(url, recovered);
      return resumeInternalApproval(url, recovered);
    }

    const payment = await api("/pay-challenge", {
      method: "POST",
      body: JSON.stringify({ challengeId: challenge.challengeId }),
    });
    const advertised = challenge.amountMicros ?? 0;
    if (payment.body?.status === "approval_required") {
      const approvalKey: string = payment.body.approval.idempotencyKey;
      pendingApprovals.set(url, {
        challengeId: approvalKey.startsWith("chl_") ? approvalKey.slice(4) : challenge.challengeId,
        approvalId: payment.body.approval.id,
        advertised,
      });
      return text({
        status: 202,
        approval: payment.body.approval,
        note: "payment is waiting in the owner's approval inbox; call money_fetch again after the owner decides",
      });
    }
    if (payment.body?.status !== "paid") {
      return text({ status: 402, error: "payment was not authorized by policy", decision: payment.body });
    }

    // Amount comes from the receipt (authoritative), never from the 402 body.
    return deliverInternal(url, challenge.challengeId, payment.body, advertised);
  }
);

/** The card rail exists only on the Postgres-backed network API. A bare 404
 * (no typed error body) from /cards means this API predates the rail; say so
 * audibly once, mirroring the recovery-endpoint warning above. */
let cardsUnsupportedWarned = false;

function warnCardsUnsupported(): void {
  if (cardsUnsupportedWarned) return;
  cardsUnsupportedWarned = true;
  console.error(
    `money MCP: ${API} does not implement /cards — reserved virtual cards are unavailable on this API. Point MONEY_API at a network API with the card rail (the Postgres-backed server, v0.14+).`,
  );
}

function cardsUnsupported(status: number) {
  warnCardsUnsupported();
  return text({
    status,
    error: "this API does not implement /cards",
    note: "reserved virtual cards need the Postgres-backed network API (v0.14 or later); ask the operator to point MONEY_API there",
  });
}

/** Decline codes become actions the agent can actually take. */
function cardDenialNote(code: string | undefined): string {
  switch (code) {
    case "per_tx_cap":
      return "exceeds the owner's per-transaction cap; request a smaller card or ask the owner";
    case "new_payee_cap":
      return "new merchant above the owner's new-payee throttle; ask the owner to allowlist it or approve this card";
    case "payee_not_allowed":
      return "merchant is not on the owner's allowlist; ask the owner to add card:hint:<merchant> to the mandate";
    case "mcc_not_allowed":
      return "merchant category not allowed on this card";
    case "budget":
      return "the mandate's remaining budget cannot cover this cap; request a smaller card or ask the owner to raise it";
    case "daily_cap":
      return "the mandate's daily cap is exhausted for today; retry tomorrow or ask the owner";
    case "insufficient_funds":
      return "agent funds cannot cover this cap; ask the owner to allocate more";
    case "no_mandate":
    case "mandate_expired":
      return "no active spend mandate; ask the owner to grant one";
    case "compliance_required":
      return "this merchant has not been cleared for card spend yet; ask the operator to register and screen it";
    case "approval_rejected":
      return "the owner rejected this card request";
    case "approval_expired":
      return "the owner approval expired before it was decided; request the card again";
    case "idempotency_conflict":
      return "this idempotency key was already used with different card terms; use a new key for a new card";
    case "risk_limit":
      return "declined by the network's risk policy";
    default:
      return "the card request was declined by policy";
  }
}

server.tool(
  "money_card_create",
  "Create a reserved virtual card under the owner's spend mandate for buying at an ordinary online merchant (checkout pages, APIs, SaaS). Issuing the card reserves its full cap from the mandate up front; the unspent remainder returns to the agent's funds when the card closes. Returns only the last4 — this tool never sees or returns the card number. Caps above the owner's escalation threshold create a durable approval request for the owner instead.",
  {
    amount_usd: z.number().positive().describe("the card's cap in dollars, e.g. 29 — a spend mandate up to this amount, reserved in full at issue"),
    merchant: z.string().min(1).max(100).describe("the merchant host this card is for, e.g. mock-shop.example"),
    single_use: z.boolean().default(true).describe("close the card after its first cleared purchase (default true)"),
    expires_in_minutes: z.number().int().min(1).max(43_200).default(60).describe("how long the card stays usable (default 60 minutes, max 30 days)"),
    idempotency_key: z
      .string()
      .min(1)
      .describe(
        "REQUIRED stable key for this logical card (e.g. 'task-123-shop-card'). When retrying the SAME card request, reuse the exact same key — the network returns the original card instead of reserving twice. A new card needs a new key."
      ),
  },
  async ({ amount_usd, merchant, single_use, expires_in_minutes, idempotency_key }) => {
    const { status, body } = await api("/cards", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: idempotency_key,
        capMicros: usd(amount_usd),
        merchantHint: merchant.trim().toLowerCase(),
        singleUse: single_use,
        expiresInSeconds: expires_in_minutes * 60,
      }),
    });
    if (status === 404) return cardsUnsupported(status);
    if (status === 503) {
      return text({
        status,
        error: body?.error === "card_bridge_unavailable"
          ? "the network API has no card issuer configured; ask the operator to enable the card rail"
          : "card spending is paused by the operator",
      });
    }
    if (body?.status === "approval_required") {
      return text({
        status: 202,
        cardId: body.cardId,
        approval: body.approval,
        note: body.note ?? "this card is waiting in the owner's approval inbox; call money_card_status after the owner decides",
      });
    }
    if (body?.status === "denied") {
      return text({ status, code: body.code, reason: body.reason, note: cardDenialNote(body.code) });
    }
    if (body?.status !== "active" || !body.card) {
      return text({ status, error: "card request failed", decision: body });
    }
    return text({
      status: "active",
      cardId: body.card.id,
      last4: body.card.last4,
      expMonth: body.card.expMonth,
      expYear: body.card.expYear,
      cap: fmt(body.card.capMicros),
      merchant: body.card.merchantHint,
      singleUse: body.card.singleUse,
      expiresAt: body.card.expiresAt,
      receiptId: body.receiptId,
      ...(body.checkoutToken ? {
        checkoutToken: body.checkoutToken,
        note: "hand the checkoutToken to the host runtime's fill step; the card number itself never enters this conversation",
      } : {}),
    });
  }
);

server.tool(
  "money_card_status",
  "Check one reserved card: its state, cap, what has cleared at the merchant, and whether the owner has approved it yet.",
  {
    card_id: z.string().min(1).describe("the card id returned by money_card_create"),
  },
  async ({ card_id }) => {
    const { status, body } = await api(`/cards/${encodeURIComponent(card_id)}`);
    if (status === 404 && body?.error !== "card_not_found") return cardsUnsupported(status);
    if (status !== 200) return text({ status, ...body });
    return text({ status, card: body.card, authorizations: body.authorizations });
  }
);

server.tool(
  "money_card_close",
  "Close a reserved card. The unspent remainder of its cap returns to the agent's funds; mandate authority already used is not restored.",
  {
    card_id: z.string().min(1).describe("the card id returned by money_card_create"),
  },
  async ({ card_id }) => {
    const { status, body } = await api(`/cards/${encodeURIComponent(card_id)}/close`, {
      method: "POST",
      body: "{}",
    });
    if (status === 404 && body?.error !== "card_not_found") return cardsUnsupported(status);
    return text({ status, ...body });
  }
);

server.tool(
  "money_feed",
  "Recent receipts on the money network (the hash-chained evidence feed).",
  {
    limit: z.number().int().min(1).max(100).default(10),
  },
  async ({ limit }) => {
    const { body } = await api(`/agent/state?limit=${limit}`);
    return text(body.feed ?? body);
  }
);

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
