import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decodeSettlement } from "../bridge/x402.ts";
import { signedHeaders } from "../core/identity.ts";
import { fmt, usd } from "../core/types.ts";
import { parseExternalPaymentDemand, type ExternalPaymentDemand } from "./x402-demand.ts";

/**
 * The agent-facing surface: an MCP server any runtime (Claude Code, Cursor,
 * Codex) can mount with one config line. The agent gets four verbs:
 *
 *   money_balance — what can I spend?
 *   money_pay     — pay any account on the network (agent, provider, user)
 *   money_fetch   — GET a URL; if it answers 402, pay the challenge within
 *                   the mandate and retry (the x402-shaped loop)
 *   money_feed    — the receipt feed
 *
 * The agent never holds keys or balances — only its account id. Every spend
 * is policy-checked server-side against the owner's mandate.
 *
 * The agent's identity is its Ed25519 private key: every network API call is
 * signed, and the network verifies against the public key registered at
 * agent creation. Spend requests without a valid signature are rejected.
 *
 * Config:
 *   MONEY_API       base URL of the network API (default http://127.0.0.1:4021)
 *   MONEY_AGENT_ID  this agent's account id (required)
 *   MONEY_AGENT_KEY this agent's private key, base64 PKCS#8 (required; comes
 *                   from onboarding — treat it like a password)
 */
const API = process.env.MONEY_API ?? "http://127.0.0.1:4021";
const AGENT_ID = process.env.MONEY_AGENT_ID;
const AGENT_KEY = process.env.MONEY_AGENT_KEY;

if (!AGENT_ID || !AGENT_KEY) {
  console.error("MONEY_AGENT_ID and MONEY_AGENT_KEY are required (both come from onboarding: npm run onboard)");
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
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

const server = new McpServer({ name: "money", version: "0.9.0" });

server.tool(
  "money_balance",
  "Check this agent's spendable balance on the money network.",
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
  return fetch(url, {
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
  const body = await retry.text();
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
    res = await fetch(url, {
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
  const bodyText = await res.text();
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
    const recovered = await discoverExternal(url).catch(() => undefined);
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
    pendingExternal.delete(url);
    return text({ status: resumed.status, error: "durable external payment could not be resumed", decision: resumed.body });
  }
  pending.paymentHeader = resumed.body.paymentHeader;
  pending.paymentHeaderName = resumed.body.paymentHeaderName;
  pending.settlementHeaderName = resumed.body.settlementHeaderName;
  pending.paidMicros = resumed.body.receipt?.amount;
  return retryExternal(url, pending);
}

/** Rediscover an unresolved external purchase after this MCP process restarts. */
async function discoverExternal(url: string): Promise<PendingExternal | undefined> {
  const lookup = await api(`/pay-external/unresolved?resource=${encodeURIComponent(url)}`);
  return lookup.status === 200 && typeof lookup.body?.externalId === "string"
    ? { externalId: lookup.body.externalId }
    : undefined;
}

server.tool(
  "money_fetch",
  "Fetch a URL. If the server responds 402 Payment Required — either a money-network challenge or an external x402 seller (accepts[]) — pay it from this agent's mandate and retry automatically. External payments go through the network's x402 bridge: policy-checked, capped, and auto-reversed if the seller never delivers. Retry-safe: if a previous call paid but failed to retrieve the resource, this resumes with the existing receipt/header instead of paying again. Returns the resource plus what was actually paid (from the receipt).",
  {
    url: z.string().url().describe("the URL to fetch"),
  },
  async ({ url }) => {
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
    const recoveredExternal = await discoverExternal(url).catch(() => undefined);
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
          const body = await resumed.text();
          return text({ status: resumed.status, paid: "$0.00", note: "resumed with previously paid receipt", body: safeJson(body) });
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

    const first = await fetch(url, { headers: { "x-agent-id": AGENT_ID! } });
    if (first.status !== 402) {
      const body = await first.text();
      return text({ status: first.status, paid: "$0.00", body: safeJson(body) });
    }

    const challenge = (await first.json().catch(() => null)) as {
      challengeId?: string;
      amountMicros?: number;
      payTo?: string;
      accepts?: unknown[];
      x402Version?: number;
      resource?: unknown;
      extensions?: unknown;
    } | null;
    if (!challenge?.challengeId) {
      // Not our network's 402. If it speaks external x402 (accepts[]), pay it
      // through the bridge. The internal challengeId flow is deliberately
      // preferred when both are present — flow choice must not be steerable
      // by a malicious body.
      const demand = parseExternalPaymentDemand(first.headers.get("payment-required"), challenge);
      const paymentUrl = first.url || url;
      return demand.ok
        ? externalFetch(paymentUrl, demand.demand)
        : text({ status: 402, error: demand.reason, body: challenge });
    }

    // A fresh seller challenge may have been issued after this MCP process
    // restarted. Prefer any older durable, unredeemed approval for the same
    // resource and let the new unpaid challenge expire in memory.
    const recovered = await discoverApproval(url).catch(() => undefined);
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
