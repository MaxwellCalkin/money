import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { pathToFileURL } from "node:url";
import { MoneyNetwork } from "../core/network.ts";
import { fmt, usd, type Micros, type PayResult } from "../core/types.ts";

export const DEFAULT_PORT = 4021; // 402 + 1 node

/** Map a PayResult to an HTTP status: client errors are 4xx, "pay up" is 402. */
function payStatus(result: PayResult): 200 | 400 | 402 | 409 {
  if (result.status === "paid") return 200;
  if (result.status === "escalate") return 402;
  if (result.code === "idempotency_conflict") return 409;
  if (result.code === "invalid_amount") return 400;
  return 402;
}

/**
 * The HTTP surface of the network. Two kinds of routes:
 *
 *   1. The network API — accounts, funding, mandates, /pay (agent → anyone).
 *   2. Demo *paid* endpoints gated by the `paid()` middleware, which speaks
 *      an x402-shaped HTTP 402 flow: no payment → 402 + challenge;
 *      pay the challenge → retry with receipt headers → 200.
 *
 * v0 auth is a bare `x-agent-id` header — a placeholder, not authentication.
 * Production replaces it with signed requests (Web Bot Auth / mTLS) and the
 * policy/signing split described in the design brief.
 */
export function createApi(network: MoneyNetwork) {
  const app = new Hono();

  // Core throws are bugs or unknown-account errors — return structured JSON,
  // never a bare stack trace.
  app.onError((err, c) => c.json({ error: "internal_error", message: err.message }, 500));

  // Demo provider that owns the paid endpoints on this server.
  const provider = network.createProvider("quote-api");

  const agentId = (c: Context): string | undefined => c.req.header("x-agent-id") ?? undefined;

  const readBody = async <T>(c: Context): Promise<T | null> =>
    c.req.json<T>().catch(() => null);

  const isPositiveMicros = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n > 0;

  /** Client keys must not squat the namespaces the network reserves internally. */
  const validClientKey = (key: unknown): key is string =>
    typeof key === "string" && key.length > 0 && !key.startsWith("chl_") && !key.startsWith("rev_");

  /** x402-shaped payment gate. */
  const paid = (price: Micros, resource: string) => async (c: Context, next: Next) => {
    const receiptId = c.req.header("x-payment-receipt");
    const challengeId = c.req.header("x-payment-challenge");

    if (receiptId && challengeId) {
      // Bind redemption to THIS endpoint's resource and price — otherwise a
      // cheap challenge unlocks an expensive resource.
      const redemption = network.redeemChallenge(challengeId, receiptId, { resource, amount: price });
      if (redemption.ok) {
        await next();
        return;
      }
      return c.json({ error: "payment_rejected", reason: redemption.reason }, 402);
    }

    const challenge = network.createChallenge(provider.id, price, resource);
    return c.json(
      {
        error: "payment_required",
        resource,
        amountMicros: challenge.amount,
        amountDisplay: fmt(challenge.amount),
        payTo: provider.id,
        challengeId: challenge.id,
        howTo:
          "POST /pay-challenge with header x-agent-id and body {challengeId}, then retry this request with headers x-payment-challenge and x-payment-receipt.",
      },
      402
    );
  };

  // ── Network API ─────────────────────────────────────────────────────────

  app.post("/users", async (c) => {
    const { name } = await c.req.json<{ name: string }>();
    return c.json(network.createUser(name));
  });

  app.post("/agents", async (c) => {
    const { name, ownerId } = await c.req.json<{ name: string; ownerId: string }>();
    return c.json(network.createAgent(name, ownerId));
  });

  app.post("/providers", async (c) => {
    const { name } = await c.req.json<{ name: string }>();
    return c.json(network.createProvider(name));
  });

  app.post("/fund", async (c) => {
    const body = await readBody<{ userId: string; amountMicros: number; idempotencyKey: string }>(c);
    if (!body || typeof body.userId !== "string" || !isPositiveMicros(body.amountMicros) || !validClientKey(body.idempotencyKey)) {
      return c.json({ error: "invalid_request", reason: "need userId, positive integer amountMicros, and idempotencyKey (retries must reuse it)" }, 400);
    }
    return c.json(network.fund(body.userId, body.amountMicros, body.idempotencyKey));
  });

  app.post("/allocate", async (c) => {
    const body = await readBody<{ userId: string; agentId: string; amountMicros: number; idempotencyKey: string }>(c);
    if (
      !body ||
      typeof body.userId !== "string" ||
      typeof body.agentId !== "string" ||
      !isPositiveMicros(body.amountMicros) ||
      !validClientKey(body.idempotencyKey)
    ) {
      return c.json({ error: "invalid_request", reason: "need userId, agentId, positive integer amountMicros, and idempotencyKey (retries must reuse it)" }, 400);
    }
    return c.json(network.allocate(body.userId, body.agentId, body.amountMicros, body.idempotencyKey));
  });

  app.post("/mandates", async (c) => {
    const body = await c.req.json<{
      userId: string;
      agentId: string;
      budgetMicros: number;
      perTxCapMicros: number;
      dailyCapMicros: number;
      escalateAboveMicros: number;
      newPayeeCapMicros: number;
      payeeAllowlist?: string[];
      expiresAt?: number;
    }>();
    const mandate = network.grantMandate({
      userId: body.userId,
      agentId: body.agentId,
      budget: body.budgetMicros,
      perTxCap: body.perTxCapMicros,
      dailyCap: body.dailyCapMicros,
      escalateAbove: body.escalateAboveMicros,
      newPayeeCap: body.newPayeeCapMicros,
      payeeAllowlist: body.payeeAllowlist,
      expiresAt: body.expiresAt,
    });
    // Sets serialize poorly; expose what matters.
    return c.json({ ...mandate, seenPayees: [...mandate.seenPayees] });
  });

  app.post("/pay", async (c) => {
    const from = agentId(c);
    if (!from) return c.json({ error: "missing x-agent-id header" }, 401);
    const body = await readBody<{ to: string; amountMicros: number; memo?: string; idempotencyKey: string }>(c);
    if (!body || typeof body.to !== "string" || !isPositiveMicros(body.amountMicros) || !validClientKey(body.idempotencyKey)) {
      return c.json({ error: "invalid_request", reason: "need to, positive integer amountMicros, and idempotencyKey (not starting with chl_/rev_)" }, 400);
    }
    const result = network.pay({ from, to: body.to, amount: body.amountMicros, memo: body.memo ?? "", idempotencyKey: body.idempotencyKey });
    return c.json(result, payStatus(result));
  });

  app.post("/pay-challenge", async (c) => {
    const from = agentId(c);
    if (!from) return c.json({ error: "missing x-agent-id header" }, 401);
    const body = await readBody<{ challengeId: string }>(c);
    if (!body || typeof body.challengeId !== "string") {
      return c.json({ error: "invalid_request", reason: "need challengeId" }, 400);
    }
    const result = network.payChallenge(from, body.challengeId);
    return c.json(result, payStatus(result));
  });

  app.get("/balance/:id", (c) => {
    const id = c.req.param("id");
    if (!network.account(id)) return c.json({ error: `unknown account ${id}` }, 404);
    const micros = network.balanceOf(id);
    return c.json({ accountId: id, balanceMicros: micros, balanceDisplay: fmt(micros) });
  });

  app.get("/feed", (c) => {
    const limit = Number(c.req.query("limit") ?? 20);
    return c.json(network.feed(limit));
  });

  app.get("/verify", (c) => c.json(network.verifyReceipts()));

  // ── Demo paid endpoints (what an agent actually buys) ───────────────────

  app.get("/paid/quote", paid(usd(0.02), "/paid/quote"), (c) =>
    c.json({
      resource: "/paid/quote",
      quote: "The agentic economy settles in micros.",
      price: fmt(usd(0.02)),
      served: new Date().toISOString(),
    })
  );

  app.get("/paid/search", paid(usd(0.05), "/paid/search"), (c) =>
    c.json({
      resource: "/paid/search",
      results: [
        { title: "x402 Foundation launches with 40 members", url: "https://www.x402.org" },
        { title: "Closed-loop ledgers and the agent economy", url: "https://example.com/closed-loop" },
      ],
      price: fmt(usd(0.05)),
    })
  );

  return { app, provider };
}

export function startServer(network = new MoneyNetwork(), port = Number(process.env.PORT ?? DEFAULT_PORT)) {
  const { app, provider } = createApi(network);
  // Bind IPv4 explicitly: Node 18's fetch resolves "localhost" to ::1 first,
  // so clients should use http://127.0.0.1:<port>.
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  console.log(`money network listening on http://127.0.0.1:${port} (demo provider: ${provider.id})`);
  return { server, network, provider, port };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startServer();
