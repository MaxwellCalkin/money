import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { streamSSE } from "hono/streaming";
import { pathToFileURL } from "node:url";
import { verifyRequest } from "../core/identity.ts";
import { MoneyNetwork } from "../core/network.ts";
import { serializeMandate } from "../core/store.ts";
import { fmt, usd, type Micros, type PayResult } from "../core/types.ts";
import { dashboardHtml } from "./dashboard.ts";

/** Signed requests must be fresher than this (and nonces are remembered this long). */
const AUTH_WINDOW_MS = 2 * 60_000;
/** Small allowance for client clocks running ahead — a far-future timestamp
 *  would otherwise pre-extend a captured request's replay life. */
const CLOCK_SKEW_MS = 30_000;
/** Signed routes hash the body before the signature is known-good — cap what
 *  an unauthenticated caller can make us buffer. */
const MAX_SIGNED_BODY_BYTES = 256 * 1024;

type ApiEnv = { Variables: { agentId: string; userId: string } };

export const DEFAULT_PORT = 4021; // 402 + 1
export const DEFAULT_DATA = "data/events.jsonl";

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
 * Spend routes (/pay, /pay-challenge) require agent-signed requests; admin
 * routes (/fund, /agents, /allocate, /mandates, revoke) require owner-signed
 * requests — both Ed25519 over method+path+sha256(body)+ts+nonce, verified
 * against the key registered at account creation. /providers and the read
 * routes stay open in v0. In-process callers (tests, the demo driving
 * `network` directly) bypass HTTP auth by construction — the policy envelope
 * still governs every spend; production splits policy and signing into
 * separate trust domains per the design brief.
 */
export function createApi(network: MoneyNetwork) {
  const app = new Hono<ApiEnv>();

  // Core throws are bugs or unknown-account errors — return structured JSON,
  // never a bare stack trace.
  app.onError((err, c) => c.json({ error: "internal_error", message: err.message }, 500));

  // Demo provider that owns the paid endpoints on this server. Reused across
  // restarts — a durable network must not mint a new provider every boot.
  const provider =
    network.listAccounts().find((a) => a.kind === "provider" && a.name === "quote-api") ??
    network.createProvider("quote-api");

  /** nonce → signed ts, remembered for the auth window to block replays. */
  const seenNonces = new Map<string, number>();

  /**
   * Signed-request authentication: an Ed25519 signature over
   * method+path+sha256(body)+ts+nonce, verified against the public key
   * registered on the account at creation. A request that is unsigned,
   * forged, stale, replayed, or from a keyless account is rejected before
   * any money moves. Agents sign spends (x-agent-id); owners sign admin
   * mutations (x-user-id) — same scheme, different trust domain.
   */
  const requireSignedAccount = (kind: "agent" | "user") => {
    const idHeader = kind === "agent" ? "x-agent-id" : "x-user-id";
    const ctxKey = kind === "agent" ? ("agentId" as const) : ("userId" as const);
    return async (c: Context<ApiEnv>, next: Next) => {
      const claimedId = c.req.header(idHeader);
      const ts = Number(c.req.header("x-signature-ts"));
      const nonce = c.req.header("x-signature-nonce");
      const signature = c.req.header("x-signature");
      const reject = (reason: string) => c.json({ error: "unauthenticated", reason }, 401);

      if (!claimedId || !nonce || !signature || !Number.isFinite(ts)) {
        return reject(`signed request required: ${idHeader}, x-signature-ts, x-signature-nonce, x-signature`);
      }
      const account = network.account(claimedId);
      if (!account || account.kind !== kind) return reject(`unknown ${kind} ${claimedId}`);
      if (!account.publicKey) return reject(`${kind} has no registered public key — recreate it with one`);
      const now = Date.now();
      if (now - ts > AUTH_WINDOW_MS || ts - now > CLOCK_SKEW_MS) {
        return reject("signature timestamp outside the accepted window");
      }
      if (seenNonces.has(nonce)) return reject("nonce already used — sign each request freshly (an idempotency key retry still needs a new signature)");

      const declaredLength = Number(c.req.header("content-length") ?? 0);
      if (declaredLength > MAX_SIGNED_BODY_BYTES) return reject("request body too large");
      const url = new URL(c.req.url);
      const body = await c.req.text(); // Hono caches the body; handlers can still read it
      if (body.length > MAX_SIGNED_BODY_BYTES) return reject("request body too large");
      const ok = verifyRequest(account.publicKey, signature, {
        method: c.req.method,
        path: url.pathname + url.search,
        body,
        ts,
        nonce,
      });
      if (!ok) return reject("signature verification failed");

      for (const [n, t] of seenNonces) {
        if (now - t > AUTH_WINDOW_MS) seenNonces.delete(n);
      }
      seenNonces.set(nonce, ts);
      c.set(ctxKey, claimedId);
      await next();
    };
  };
  const requireAgentSig = requireSignedAccount("agent");
  const requireOwnerSig = requireSignedAccount("user");

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

  // Signup = key registration: the owner key is what authorizes funding,
  // agents, and mandates from then on, so creating a user without one would
  // create an account nobody can ever administer.
  app.post("/users", async (c) => {
    const body = await readBody<{ name: string; publicKey: string }>(c);
    if (!body || typeof body.name !== "string" || !body.name) {
      return c.json({ error: "invalid_request", reason: "need name" }, 400);
    }
    if (typeof body.publicKey !== "string" || !body.publicKey) {
      return c.json({ error: "invalid_request", reason: "need publicKey (base64 SPKI Ed25519) — the owner key authorizes all admin operations" }, 400);
    }
    return c.json(network.createUser(body.name, body.publicKey));
  });

  app.post("/agents", requireOwnerSig, async (c) => {
    const owner = c.get("userId");
    const body = await readBody<{ name: string; ownerId: string; publicKey?: string }>(c);
    if (!body || typeof body.name !== "string" || !body.name) {
      return c.json({ error: "invalid_request", reason: "need name and ownerId" }, 400);
    }
    if (body.publicKey !== undefined && typeof body.publicKey !== "string") {
      return c.json({ error: "invalid_request", reason: "publicKey must be a base64 SPKI Ed25519 key" }, 400);
    }
    if (body.ownerId !== owner) {
      return c.json({ error: "forbidden", reason: "ownerId must be the signing user — you cannot create agents for someone else" }, 403);
    }
    return c.json(network.createAgent(body.name, owner, body.publicKey));
  });

  // No open /providers route: providers are created in-process (the demo one
  // above) until provider onboarding gets its own auth story. An open route
  // would let anyone append junk accounts to the durable event log forever.
  // (/users stays open — it IS signup — but writes durable state too;
  // production adds rate limiting there.)

  app.post("/fund", requireOwnerSig, async (c) => {
    const owner = c.get("userId");
    const body = await readBody<{ userId: string; amountMicros: number; idempotencyKey: string }>(c);
    if (!body || typeof body.userId !== "string" || !isPositiveMicros(body.amountMicros) || !validClientKey(body.idempotencyKey)) {
      return c.json({ error: "invalid_request", reason: "need userId, positive integer amountMicros, and idempotencyKey (retries must reuse it)" }, 400);
    }
    if (body.userId !== owner) {
      return c.json({ error: "forbidden", reason: "userId must be the signing user — you can only fund your own account" }, 403);
    }
    return c.json(network.fund(owner, body.amountMicros, body.idempotencyKey));
  });

  app.post("/allocate", requireOwnerSig, async (c) => {
    const owner = c.get("userId");
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
    if (body.userId !== owner) {
      return c.json({ error: "forbidden", reason: "userId must be the signing user — you can only allocate your own funds" }, 403);
    }
    return c.json(network.allocate(owner, body.agentId, body.amountMicros, body.idempotencyKey));
  });

  app.post("/mandates", requireOwnerSig, async (c) => {
    const owner = c.get("userId");
    const body = await readBody<{
      userId: string;
      agentId: string;
      budgetMicros: number;
      perTxCapMicros: number;
      dailyCapMicros: number;
      escalateAboveMicros: number;
      newPayeeCapMicros: number;
      payeeAllowlist?: string[];
      expiresAt?: number;
      idempotencyKey: string;
    }>(c);
    const caps = body && [body.budgetMicros, body.perTxCapMicros, body.dailyCapMicros, body.escalateAboveMicros, body.newPayeeCapMicros];
    if (!body || typeof body.agentId !== "string" || !caps || caps.some((n) => !Number.isSafeInteger(n) || n < 0) || !validClientKey(body.idempotencyKey)) {
      return c.json({ error: "invalid_request", reason: "need agentId, non-negative integer *Micros caps, and idempotencyKey (a replayed grant must not reset counters)" }, 400);
    }
    if (body.userId !== owner) {
      return c.json({ error: "forbidden", reason: "userId must be the signing user — only the owner signs mandates" }, 403);
    }
    const mandate = network.grantMandate({
      userId: owner,
      agentId: body.agentId,
      budget: body.budgetMicros,
      perTxCap: body.perTxCapMicros,
      dailyCap: body.dailyCapMicros,
      escalateAbove: body.escalateAboveMicros,
      newPayeeCap: body.newPayeeCapMicros,
      payeeAllowlist: body.payeeAllowlist,
      expiresAt: body.expiresAt,
      idempotencyKey: body.idempotencyKey,
    });
    // Sets serialize poorly; expose what matters.
    return c.json({ ...mandate, seenPayees: [...mandate.seenPayees] });
  });

  // Key rotation: the remediation path for a leaked key. The OWNER's current
  // key authorizes it — for their own account, or for an agent they own
  // (a compromised agent must not be able to re-key itself or its siblings).
  app.post("/accounts/:id/rotate-key", requireOwnerSig, async (c) => {
    const owner = c.get("userId");
    const targetId = c.req.param("id") ?? "";
    const target = network.account(targetId);
    if (!target) return c.json({ error: `unknown account ${targetId}` }, 404);
    const authorized = target.id === owner || (target.kind === "agent" && target.ownerId === owner);
    if (!authorized) {
      return c.json({ error: "forbidden", reason: "you can only rotate your own key or a key of an agent you own" }, 403);
    }
    const body = await readBody<{ publicKey: string }>(c);
    if (!body || typeof body.publicKey !== "string" || !body.publicKey) {
      return c.json({ error: "invalid_request", reason: "need publicKey (base64 SPKI Ed25519)" }, 400);
    }
    const account = network.rotateKey(targetId, body.publicKey);
    return c.json({ ok: true, accountId: account.id });
  });

  // The owner's kill switch — only the mandate's own signer may pull it.
  app.post("/mandates/:id/revoke", requireOwnerSig, (c) => {
    const owner = c.get("userId");
    const id = c.req.param("id") ?? "";
    const mandate = network.policy.get(id);
    if (!mandate) return c.json({ error: `unknown mandate ${id}` }, 404);
    if (mandate.userId !== owner) {
      return c.json({ error: "forbidden", reason: "only the user who granted a mandate can revoke it" }, 403);
    }
    network.revokeMandate(id);
    return c.json({ ok: true, mandateId: id });
  });

  app.post("/pay", requireAgentSig, async (c) => {
    const from = c.get("agentId");
    const body = await readBody<{ to: string; amountMicros: number; memo?: string; idempotencyKey: string }>(c);
    if (!body || typeof body.to !== "string" || !isPositiveMicros(body.amountMicros) || !validClientKey(body.idempotencyKey)) {
      return c.json({ error: "invalid_request", reason: "need to, positive integer amountMicros, and idempotencyKey (not starting with chl_/rev_)" }, 400);
    }
    const result = network.pay({ from, to: body.to, amount: body.amountMicros, memo: body.memo ?? "", idempotencyKey: body.idempotencyKey });
    return c.json(result, payStatus(result));
  });

  app.post("/pay-challenge", requireAgentSig, async (c) => {
    const from = c.get("agentId");
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

  // ── Dashboard (read-only owner view: balances, mandates, live receipts) ──

  const snapshot = () => ({
    now: Date.now(),
    zeroSum: network.ledger.zeroSum(),
    receiptsOk: network.verifyReceipts().ok,
    receiptCount: network.receipts.length,
    accounts: network.listAccounts().map((a) => ({ ...a, balanceMicros: network.balanceOf(a.id) })),
    mandates: network.listMandates().map(serializeMandate),
    feed: network.feed(25),
  });

  app.get("/dashboard", (c) => c.html(dashboardHtml));
  app.get("/dashboard/state", (c) => c.json(snapshot()));

  // SSE: push a fresh snapshot whenever money moves (coalesced to 250ms),
  // plus a heartbeat every ~15s so proxies don't kill the idle stream.
  app.get("/dashboard/events", (c) =>
    streamSSE(c, async (stream) => {
      let dirty = false;
      let alive = true;
      const unsubscribe = network.onEvent(() => {
        dirty = true;
      });
      stream.onAbort(() => {
        alive = false;
        unsubscribe();
      });
      const push = async (event: string, data: string) => {
        try {
          await stream.writeSSE({ event, data });
          return true;
        } catch {
          return false;
        }
      };
      alive = (await push("state", JSON.stringify(snapshot()))) && alive;
      let ticks = 0;
      while (alive && !stream.aborted) {
        await stream.sleep(250);
        ticks++;
        if (dirty) {
          dirty = false;
          if (!(await push("state", JSON.stringify(snapshot())))) break;
        } else if (ticks % 60 === 0) {
          if (!(await push("ping", String(Date.now())))) break;
        }
      }
      unsubscribe();
    })
  );

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

export function startServer(network?: MoneyNetwork, port = Number(process.env.PORT ?? DEFAULT_PORT)) {
  // Durable by default: state survives a restart via the JSONL event log.
  network ??= MoneyNetwork.open(process.env.MONEY_DATA ?? DEFAULT_DATA);
  const { app, provider } = createApi(network);
  // Bind IPv4 explicitly: Node 18's fetch resolves "localhost" to ::1 first,
  // so clients should use http://127.0.0.1:<port>.
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  console.log(`money network listening on http://127.0.0.1:${port} (demo provider: ${provider.id})`);
  console.log(`live dashboard at http://127.0.0.1:${port}/dashboard`);
  return { server, network, provider, port };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startServer();
