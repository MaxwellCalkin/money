import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { signedHeaders } from "../core/identity.ts";
import { fmt, usd } from "../core/types.ts";

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

const server = new McpServer({ name: "money", version: "0.1.0" });

server.tool(
  "money_balance",
  "Check this agent's spendable balance on the money network.",
  {},
  async () => {
    const { body } = await api(`/balance/${AGENT_ID}`);
    return text(body);
  }
);

server.tool(
  "money_pay",
  "Pay another account on the money network (an agent, a provider, or a user). Spends from this agent's balance under its owner's mandate; may be denied or escalated by policy.",
  {
    to: z.string().describe("destination account id, e.g. agt_1a2b3c4d or prv_9f8e7d6c"),
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

async function fetchWithReceipt(url: string, challengeId: string, receiptId: string): Promise<Response> {
  return fetch(url, {
    headers: {
      "x-agent-id": AGENT_ID!,
      "x-payment-challenge": challengeId,
      "x-payment-receipt": receiptId,
    },
  });
}

server.tool(
  "money_fetch",
  "Fetch a URL. If the server responds 402 Payment Required with a money-network challenge, pay it from this agent's mandate and retry automatically. Retry-safe: if a previous call paid but failed to retrieve the resource, this resumes with the existing receipt instead of paying again. Returns the resource plus what was actually paid (from the receipt).",
  {
    url: z.string().url().describe("the URL to fetch"),
  },
  async ({ url }) => {
    // Resume path: we already paid for this URL but never got the resource.
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

    const first = await fetch(url, { headers: { "x-agent-id": AGENT_ID! } });
    if (first.status !== 402) {
      const body = await first.text();
      return text({ status: first.status, paid: "$0.00", body: safeJson(body) });
    }

    const challenge = (await first.json().catch(() => null)) as {
      challengeId?: string;
      amountMicros?: number;
      payTo?: string;
    } | null;
    if (!challenge?.challengeId) {
      return text({ status: 402, error: "server demanded payment but sent no money-network challenge", body: challenge });
    }

    const payment = await api("/pay-challenge", {
      method: "POST",
      body: JSON.stringify({ challengeId: challenge.challengeId }),
    });
    if (payment.body?.status !== "paid") {
      return text({ status: 402, error: "payment was not authorized by policy", decision: payment.body });
    }

    // Amount comes from the receipt (authoritative), never from the 402 body
    // (attacker-controlled: a malicious page could advertise a lower price).
    const paidMicros: number = payment.body.receipt.amount;
    const receiptId: string = payment.body.receipt.id;
    const advertised = challenge.amountMicros ?? 0;
    pendingRedemptions.set(url, { challengeId: challenge.challengeId, receiptId });

    let retry: Response;
    try {
      retry = await fetchWithReceipt(url, challenge.challengeId, receiptId);
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
);

server.tool(
  "money_feed",
  "Recent receipts on the money network (the hash-chained evidence feed).",
  {
    limit: z.number().int().min(1).max(100).default(10),
  },
  async ({ limit }) => {
    const { body } = await api(`/feed?limit=${limit}`);
    return text(body);
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
