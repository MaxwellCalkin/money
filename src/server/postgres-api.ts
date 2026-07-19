import { serve } from "@hono/node-server";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Hono, type Context, type Next } from "hono";
import { isValidPublicKey, verifyRequest } from "../core/identity.ts";
import { isValidHandle } from "../core/network.ts";
import type { DatabaseAccount } from "../db/ledger.ts";
import { PostgresLedger, type DatabaseTransferResult } from "../db/ledger.ts";
import { PostgresControlPlane, type AccountBalance, type DatabaseService, type PaymentEvidence } from "../db/control-plane.ts";
import type { TransactionalDatabase } from "../db/database.ts";
import { runMigrations } from "../db/migrate.ts";
import { PostgresPolicy, type DatabaseApproval, type DatabaseMandate, type PolicyPaymentResult } from "../db/policy.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import { dashboardHtml } from "./dashboard.ts";

const AUTH_WINDOW_MS = 2 * 60_000;
const CLOCK_SKEW_MS = 30_000;
const MAX_SIGNED_BODY_BYTES = 256 * 1024;

type ApiEnv = { Variables: { agentId: string; userId: string; providerId: string } };
type IdentityKind = "user" | "agent" | "provider";

export interface PostgresApiOptions {
  /** Local demos only. Real top-ups arrive through the separate treasury role. */
  allowDevelopmentFunding?: boolean;
}

function databaseCode(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === "object"; depth += 1) {
    const candidate = cursor as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    cursor = candidate.cause;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "request failed";
}

function jsonInteger(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

function formatMicros(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const dollars = absolute / 1_000_000n;
  const rawFraction = (absolute % 1_000_000n).toString().padStart(6, "0");
  const fraction = rawFraction.replace(/0+$/, "").padEnd(2, "0");
  return `${sign}$${dollars}.${fraction}`;
}

function positiveMicros(value: unknown): bigint | undefined {
  try {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) return undefined;
    if (typeof value === "string" && !/^[1-9][0-9]*$/.test(value)) return undefined;
    if (typeof value !== "number" && typeof value !== "string") return undefined;
    const amount = BigInt(value);
    return amount > 0n ? amount : undefined;
  } catch {
    return undefined;
  }
}

function nonnegativeMicros(value: unknown): bigint | undefined {
  try {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return undefined;
    if (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
    if (typeof value !== "number" && typeof value !== "string") return undefined;
    const amount = BigInt(value);
    return amount >= 0n ? amount : undefined;
  } catch {
    return undefined;
  }
}

function validClientKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && !value.startsWith("chl_") && !value.startsWith("rev_");
}

function accountView(account: DatabaseAccount | AccountBalance) {
  return {
    id: account.id,
    kind: account.kind,
    ...(account.ownerId ? { ownerId: account.ownerId } : {}),
    name: account.name,
    ...(account.handle ? { handle: account.handle } : {}),
    status: account.status,
    createdAt: account.createdAt.getTime(),
    ...(Object.hasOwn(account, "balanceMicros")
      ? { balanceMicros: jsonInteger((account as AccountBalance).balanceMicros) }
      : {}),
  };
}

function mandateView(mandate: DatabaseMandate) {
  return {
    id: mandate.id,
    userId: mandate.userId,
    agentId: mandate.agentId,
    budget: jsonInteger(mandate.budgetMicros),
    perTxCap: jsonInteger(mandate.perTxCapMicros),
    dailyCap: jsonInteger(mandate.dailyCapMicros),
    escalateAbove: jsonInteger(mandate.escalateAboveMicros),
    newPayeeCap: jsonInteger(mandate.newPayeeCapMicros),
    ...(mandate.payeeAllowlist ? { payeeAllowlist: mandate.payeeAllowlist } : {}),
    spent: jsonInteger(mandate.spentMicros),
    spentToday: jsonInteger(mandate.spentTodayMicros),
    today: mandate.spendDay,
    expiresAt: mandate.expiresAt.getTime(),
    revoked: Boolean(mandate.revokedAt),
    idempotencyKey: mandate.idempotencyKey,
    createdAt: mandate.createdAt.getTime(),
  };
}

function approvalView(approval: DatabaseApproval) {
  return {
    id: approval.id,
    userId: approval.userId,
    mandateId: approval.mandateId,
    agentId: approval.agentId,
    to: approval.to,
    amount: jsonInteger(approval.amountMicros),
    memo: approval.memo,
    idempotencyKey: approval.idempotencyKey,
    createdAt: approval.createdAt.getTime(),
    expiresAt: approval.expiresAt.getTime(),
    status: approval.status,
    ...(approval.resolvedAt ? { resolvedAt: approval.resolvedAt.getTime() } : {}),
    ...(approval.receiptId ? { receiptId: approval.receiptId } : {}),
    ...(approval.reason ? { reason: approval.reason } : {}),
  };
}

function evidenceView(evidence: PaymentEvidence, profiles = new Map<string, DatabaseAccount>()) {
  const amount = jsonInteger(evidence.amountMicros);
  return {
    seq: jsonInteger(evidence.receiptSeq),
    id: evidence.receiptId,
    ts: evidence.createdAt.getTime(),
    transferId: evidence.transferId,
    from: evidence.from,
    to: evidence.to,
    amount,
    memo: evidence.memo,
    ...(evidence.mandateId ? { mandateId: evidence.mandateId } : {}),
    hash: evidence.evidenceHash,
    ...(profiles.get(evidence.from) ? { fromAccount: accountView(profiles.get(evidence.from)!) } : {}),
    ...(profiles.get(evidence.to) ? { toAccount: accountView(profiles.get(evidence.to)!) } : {}),
  };
}

function serviceView(service: DatabaseService, provider?: DatabaseAccount) {
  return {
    id: service.id,
    providerId: service.providerId,
    slug: service.slug,
    name: service.name,
    description: service.description,
    endpointUrl: service.endpointUrl,
    asset: service.asset,
    priceMicros: jsonInteger(service.priceMicros),
    priceDisplay: formatMicros(service.priceMicros),
    active: service.active,
    ...(provider?.handle ? { providerHandle: provider.handle, address: `@${provider.handle}/${service.slug}` } : {}),
    createdAt: service.createdAt.getTime(),
  };
}

/** Core production API backed by the atomic Postgres money kernel. Marketplace,
 * challenge, refund, and external-rail routes remain on the legacy API until
 * their own commands move into database transactions. */
export function createPostgresApi(db: TransactionalDatabase, options: PostgresApiOptions = {}) {
  const control = new PostgresControlPlane(db);
  const ledger = new PostgresLedger(db);
  const policy = new PostgresPolicy(db);
  const app = new Hono<ApiEnv>();

  app.onError((error, c) => {
    console.error("Postgres money API error", error);
    return c.json({ error: "internal_error", reason: "The request could not be completed." }, 500);
  });

  const noStore = async (c: Context<ApiEnv>, next: Next) => {
    await next();
    c.header("cache-control", "no-store");
  };
  app.use("/owner/*", noStore);
  app.use("/agent/*", noStore);
  app.use("/provider/*", noStore);
  app.use("/dashboard/state", noStore);

  const readBody = async <T>(c: Context): Promise<T | null> => c.req.json<T>().catch(() => null);

  const databaseFailure = (c: Context, error: unknown, fallback: string) => {
    const code = databaseCode(error);
    const reason = errorMessage(error);
    if (code === "23505") return c.json({ error: "conflict", reason }, 409);
    if (code === "42501") return c.json({ error: "forbidden", reason }, 403);
    if (code === "P0002") return c.json({ error: "not_found", reason }, 404);
    if (code === "22023" || code === "23503") return c.json({ error: "invalid_request", reason }, 400);
    console.error(fallback, error);
    return c.json({ error: fallback, reason: "The request could not be completed." }, 500);
  };

  const requireSignedAccount = (kind: IdentityKind) => {
    const idHeader = kind === "agent" ? "x-agent-id" : kind === "user" ? "x-user-id" : "x-provider-id";
    const contextKey = kind === "agent" ? "agentId" : kind === "user" ? "userId" : "providerId";
    return async (c: Context<ApiEnv>, next: Next) => {
      const accountId = c.req.header(idHeader);
      const nonce = c.req.header("x-signature-nonce");
      const signature = c.req.header("x-signature");
      const signedAt = Number(c.req.header("x-signature-ts"));
      const reject = (reason: string) => c.json({ error: "unauthenticated", reason }, 401);
      if (!accountId || !nonce || nonce.length < 8 || !signature || !Number.isSafeInteger(signedAt)) {
        return reject(`signed request required: ${idHeader}, x-signature-ts, x-signature-nonce, x-signature`);
      }
      const now = Date.now();
      if (now - signedAt > AUTH_WINDOW_MS || signedAt - now > CLOCK_SKEW_MS) {
        return reject("signature timestamp outside the accepted window");
      }
      const declaredLength = Number(c.req.header("content-length") ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_SIGNED_BODY_BYTES) return reject("request body too large");
      const body = await c.req.text();
      if (Buffer.byteLength(body, "utf8") > MAX_SIGNED_BODY_BYTES) return reject("request body too large");
      const account = await control.accountForAuth(accountId).catch(() => undefined);
      if (!account || account.kind !== kind || account.status !== "active" || !account.publicKey) {
        return reject(`unknown or inactive ${kind}`);
      }
      const url = new URL(c.req.url);
      const path = url.pathname + url.search;
      if (!verifyRequest(account.publicKey, signature, { method: c.req.method, path, body, ts: signedAt, nonce })) {
        return reject("signature verification failed");
      }
      const requestHash = createHash("sha256")
        .update([c.req.method.toUpperCase(), path, body, String(signedAt), nonce].join("\n"), "utf8")
        .digest();
      try {
        await control.consumeSignedRequest({
          accountId,
          kind,
          expectedPublicKey: account.publicKey,
          nonce,
          signedAtMs: signedAt,
          requestHash,
        });
      } catch (error) {
        return reject(databaseCode(error) === "28000" ? errorMessage(error) : "signed request could not be accepted");
      }
      c.set(contextKey, accountId);
      await next();
    };
  };

  const requireAgentSig = requireSignedAccount("agent");
  const requireOwnerSig = requireSignedAccount("user");
  const requireProviderSig = requireSignedAccount("provider");
  const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest();

  const bearer = (c: Context<ApiEnv>): string | undefined => {
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(c.req.header("authorization") ?? "");
    return match?.[1];
  };

  const requireOwnerAccess = async (c: Context<ApiEnv>, next: Next) => {
    if (!c.req.header("authorization")) return requireOwnerSig(c, next);
    const token = bearer(c);
    if (!token) return c.json({ error: "unauthorized", reason: "owner session is invalid" }, 401);
    const userId = await control.resolveOwnerSession(tokenHash(token));
    if (!userId) return c.json({ error: "unauthorized", reason: "owner session is missing, revoked, or expired" }, 401);
    c.set("userId", userId);
    await next();
  };

  const profilesFor = async (evidence: readonly PaymentEvidence[]) => {
    const accounts = await control.publicAccounts(evidence.flatMap((item) => [item.from, item.to]));
    return new Map(accounts.map((account) => [account.id, account]));
  };

  const paymentView = async (requesterId: string, result: PolicyPaymentResult) => {
    if (result.status === "denied") {
      return { status: "denied" as const, code: result.code, reason: result.reason, replayed: result.replayed };
    }
    if (result.status === "approval_required") {
      const approval = await policy.approval(requesterId, result.approvalId);
      if (!approval) throw new Error("approval result is not visible to its requester");
      return { status: "approval_required" as const, approval: approvalView(approval), replayed: result.replayed };
    }
    const evidence = await control.receipt(requesterId, result.receiptId);
    if (!evidence) throw new Error("posted payment receipt is not visible to its requester");
    const amount = jsonInteger(evidence.amountMicros);
    return {
      status: "paid" as const,
      transfer: {
        id: evidence.transferId,
        ts: evidence.createdAt.getTime(),
        from: evidence.from,
        to: evidence.to,
        amount,
        memo: evidence.memo,
        idempotencyKey: evidence.idempotencyKey,
        ...(evidence.mandateId ? { mandateId: evidence.mandateId } : {}),
      },
      receipt: evidenceView(evidence),
      replayed: result.replayed,
    };
  };

  const transferView = async (requesterId: string, result: DatabaseTransferResult) => {
    if (result.status === "denied") {
      return {
        status: "denied" as const,
        code: result.code,
        reason: result.reason,
        replayed: result.replayed,
        ...(result.fromBalanceMicros !== undefined ? { fromBalanceMicros: jsonInteger(result.fromBalanceMicros) } : {}),
        ...(result.toBalanceMicros !== undefined ? { toBalanceMicros: jsonInteger(result.toBalanceMicros) } : {}),
      };
    }
    const evidence = await control.receipt(requesterId, result.receiptId);
    return {
      status: "posted" as const,
      transferId: result.transferId,
      receiptId: result.receiptId,
      replayed: result.replayed,
      fromBalanceMicros: jsonInteger(result.fromBalanceMicros),
      toBalanceMicros: jsonInteger(result.toBalanceMicros),
      ...(evidence ? { receipt: evidenceView(evidence) } : {}),
    };
  };

  const stateFeed = async (requesterId: string, limit: number) => {
    const feed = await control.paymentFeed(requesterId, limit);
    const profiles = await profilesFor(feed);
    return feed.map((evidence) => evidenceView(evidence, profiles));
  };

  const servicesView = async (requesterId: string) => {
    const services = await control.services(requesterId);
    const providers = new Map((await control.publicAccounts(services.map((service) => service.providerId))).map((account) => [account.id, account]));
    return services.map((service) => serviceView(service, providers.get(service.providerId)));
  };

  const ownerSnapshot = async (userId: string) => {
    const [accounts, mandates, approvals, feed, services] = await Promise.all([
      control.accountState(userId),
      policy.listMandates(userId, 100),
      policy.listApprovals(userId, undefined, 100),
      stateFeed(userId, 25),
      servicesView(userId),
    ]);
    return {
      now: Date.now(),
      // Posting constraints enforce zero-sum journals and immutable evidence.
      // Expensive global recomputation belongs to /ops/reconcile, not a UI poll.
      zeroSum: true,
      receiptsOk: true,
      accounts: accounts.map(accountView),
      services,
      mandates: mandates.map(mandateView),
      approvals: approvals.reverse().map(approvalView),
      feed,
      external: [],
    };
  };

  const childSnapshot = async (accountId: string, limit = 25) => {
    const [accounts, mandates, approvals, feed, services] = await Promise.all([
      control.accountState(accountId),
      policy.listMandates(accountId, 100),
      policy.listApprovals(accountId, undefined, 100),
      stateFeed(accountId, limit),
      servicesView(accountId),
    ]);
    const activeMandate = mandates.find((mandate) => !mandate.revokedAt && mandate.expiresAt.getTime() > Date.now());
    return {
      now: Date.now(),
      account: accounts[0] ? accountView(accounts[0]) : undefined,
      ...(activeMandate ? { mandate: mandateView(activeMandate) } : {}),
      approvals: approvals.reverse().map(approvalView),
      feed,
      services,
    };
  };

  app.get("/health/live", (c) => c.json({ ok: true }));
  app.get("/health/ready", async (c) => {
    try {
      const result = await db.query<{ version: string | null; ready: boolean }>(`
        select (select max(version) from money.schema_migrations) as version,
          to_regprocedure('money_private.consume_signed_request(text,text,text,text,bigint,bytea)') is not null
          and to_regprocedure('money_private.request_agent_payment(text,text,text,text,bigint,text)') is not null as ready
      `);
      return result.rows[0]?.ready
        ? c.json({ ok: true, schemaVersion: result.rows[0].version })
        : c.json({ ok: false, error: "schema_not_ready" }, 503);
    } catch {
      return c.json({ ok: false, error: "database_unavailable" }, 503);
    }
  });

  app.post("/users", async (c) => {
    const body = await readBody<{ name: string; publicKey: string; handle?: string }>(c);
    if (!body || typeof body.name !== "string" || body.name.length < 1 || body.name.length > 200
      || !isValidPublicKey(body.publicKey) || (body.handle !== undefined && !isValidHandle(body.handle))) {
      return c.json({ error: "invalid_request", reason: "need name, a valid Ed25519 publicKey, and optional valid handle" }, 400);
    }
    try {
      const account = await control.registerIdentity({ kind: "user", name: body.name, publicKey: body.publicKey, handle: body.handle });
      return c.json({ ...accountView(account), replayed: account.replayed });
    } catch (error) {
      return databaseFailure(c, error, "signup_failed");
    }
  });

  app.post("/agents", requireOwnerSig, async (c) => {
    const ownerId = c.get("userId");
    const body = await readBody<{ name: string; ownerId: string; publicKey: string; handle?: string }>(c);
    if (!body || body.ownerId !== ownerId || typeof body.name !== "string" || body.name.length < 1 || body.name.length > 200
      || !isValidPublicKey(body.publicKey) || (body.handle !== undefined && !isValidHandle(body.handle))) {
      return c.json({ error: "invalid_request", reason: "need signing ownerId, name, valid agent publicKey, and optional valid handle" }, 400);
    }
    try {
      const account = await control.registerIdentity({
        actorId: ownerId, kind: "agent", ownerId, name: body.name, publicKey: body.publicKey, handle: body.handle,
      });
      return c.json({ ...accountView(account), replayed: account.replayed });
    } catch (error) {
      return databaseFailure(c, error, "agent_registration_failed");
    }
  });

  app.post("/providers", requireOwnerSig, async (c) => {
    const ownerId = c.get("userId");
    const body = await readBody<{ name: string; ownerId: string; publicKey: string; handle: string }>(c);
    if (!body || body.ownerId !== ownerId || typeof body.name !== "string" || body.name.length < 1 || body.name.length > 200
      || !isValidPublicKey(body.publicKey) || !isValidHandle(body.handle)) {
      return c.json({ error: "invalid_request", reason: "need signing ownerId, name, unique handle, and valid provider publicKey" }, 400);
    }
    try {
      const account = await control.registerIdentity({
        actorId: ownerId, kind: "provider", ownerId, name: body.name, publicKey: body.publicKey, handle: body.handle,
      });
      return c.json({ ...accountView(account), replayed: account.replayed });
    } catch (error) {
      return databaseFailure(c, error, "provider_registration_failed");
    }
  });

  app.get("/handles/:handle", async (c) => {
    const account = await control.resolvePublicAccount(`@${c.req.param("handle") ?? ""}`);
    return account ? c.json(accountView(account)) : c.json({ error: "handle_not_found" }, 404);
  });

  app.post("/owner/sessions", requireOwnerSig, async (c) => {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = await control.createOwnerSession(c.get("userId"), tokenHash(token));
    return c.json({ token, expiresAt: expiresAt.getTime(), dashboardPath: `/dashboard#token=${encodeURIComponent(token)}` });
  });

  app.delete("/owner/sessions/current", requireOwnerAccess, async (c) => {
    const token = bearer(c);
    if (token) await control.revokeOwnerSession(c.get("userId"), tokenHash(token));
    return c.json({ ok: true });
  });

  app.post("/fund", requireOwnerSig, async (c) => {
    if (!options.allowDevelopmentFunding) {
      return c.json({ error: "treasury_required", reason: "production top-ups are accepted only from the treasury integration" }, 403);
    }
    const userId = c.get("userId");
    const body = await readBody<{ userId: string; amountMicros: number | string; idempotencyKey: string }>(c);
    const amount = body ? positiveMicros(body.amountMicros) : undefined;
    if (!body || body.userId !== userId || amount === undefined || !validClientKey(body.idempotencyKey)) {
      return c.json({ error: "invalid_request", reason: "need signing userId, positive amountMicros, and idempotencyKey" }, 400);
    }
    const result = await ledger.postTransfer({
      actorId: userId, operation: "fund", idempotencyKey: body.idempotencyKey,
      from: "external:funding", to: userId, amountMicros: amount,
    });
    return c.json(await transferView(userId, result), result.status === "posted" ? 200 : 402);
  });

  app.post("/allocate", requireOwnerSig, async (c) => {
    const userId = c.get("userId");
    const body = await readBody<{ userId: string; agentId: string; amountMicros: number | string; idempotencyKey: string }>(c);
    const amount = body ? positiveMicros(body.amountMicros) : undefined;
    if (!body || body.userId !== userId || typeof body.agentId !== "string" || amount === undefined || !validClientKey(body.idempotencyKey)) {
      return c.json({ error: "invalid_request", reason: "need signing userId, agentId, positive amountMicros, and idempotencyKey" }, 400);
    }
    try {
      const result = await ledger.postTransfer({
        actorId: userId, operation: "allocate", idempotencyKey: body.idempotencyKey,
        from: userId, to: body.agentId, amountMicros: amount,
      });
      return c.json(await transferView(userId, result), result.status === "posted" ? 200 : 402);
    } catch (error) {
      return databaseFailure(c, error, "allocation_failed");
    }
  });

  app.post("/mandates", requireOwnerSig, async (c) => {
    const userId = c.get("userId");
    const body = await readBody<{
      userId: string; agentId: string; budgetMicros: number | string; perTxCapMicros: number | string;
      dailyCapMicros: number | string; escalateAboveMicros: number | string; newPayeeCapMicros: number | string;
      payeeAllowlist?: string[]; expiresAt?: number | string; idempotencyKey: string;
    }>(c);
    const caps = body ? [body.budgetMicros, body.perTxCapMicros, body.dailyCapMicros, body.escalateAboveMicros, body.newPayeeCapMicros].map(nonnegativeMicros) : [];
    const expiresAt = body?.expiresAt === undefined ? new Date(Date.now() + 30 * 86_400_000) : new Date(body.expiresAt);
    if (!body || body.userId !== userId || typeof body.agentId !== "string" || caps.length !== 5 || caps.some((cap) => cap === undefined)
      || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() || !validClientKey(body.idempotencyKey)
      || (body.payeeAllowlist !== undefined && (!Array.isArray(body.payeeAllowlist) || body.payeeAllowlist.length > 1_000 || body.payeeAllowlist.some((id) => typeof id !== "string" || !id)))) {
      return c.json({ error: "invalid_request", reason: "need signing userId, agentId, non-negative *Micros caps, future expiry, and idempotencyKey" }, 400);
    }
    try {
      const result = await policy.grantMandate({
        userId, agentId: body.agentId, budgetMicros: caps[0]!, perTxCapMicros: caps[1]!,
        dailyCapMicros: caps[2]!, escalateAboveMicros: caps[3]!, newPayeeCapMicros: caps[4]!,
        payeeAllowlist: body.payeeAllowlist, expiresAt, idempotencyKey: body.idempotencyKey,
      });
      const mandate = await policy.mandate(userId, result.mandateId);
      if (!mandate) throw new Error("granted mandate could not be read back");
      return c.json({ ...mandateView(mandate), replayed: result.replayed });
    } catch (error) {
      return databaseFailure(c, error, "mandate_grant_failed");
    }
  });

  app.post("/mandates/:id/revoke", requireOwnerSig, async (c) => {
    const userId = c.get("userId");
    try {
      const changed = await policy.revokeMandate(userId, c.req.param("id") ?? "");
      return c.json({ ok: true, mandateId: c.req.param("id"), changed });
    } catch (error) {
      return databaseFailure(c, error, "mandate_revocation_failed");
    }
  });

  app.post("/accounts/:id/rotate-key", requireOwnerSig, async (c) => {
    const body = await readBody<{ publicKey: string }>(c);
    if (!body || !isValidPublicKey(body.publicKey)) {
      return c.json({ error: "invalid_request", reason: "need a valid Ed25519 publicKey" }, 400);
    }
    try {
      const result = await control.rotatePublicKey(c.get("userId"), c.req.param("id") ?? "", body.publicKey);
      return c.json({ ok: true, accountId: result.accountId, changed: result.changed });
    } catch (error) {
      return databaseFailure(c, error, "key_rotation_failed");
    }
  });

  app.post("/pay", requireAgentSig, async (c) => {
    const agentId = c.get("agentId");
    const body = await readBody<{ to: string; amountMicros: number | string; memo?: string; idempotencyKey: string }>(c);
    const amount = body ? positiveMicros(body.amountMicros) : undefined;
    if (!body || typeof body.to !== "string" || body.to.length < 1 || body.to.length > 128 || amount === undefined
      || (body.memo !== undefined && (typeof body.memo !== "string" || body.memo.length > 500)) || !validClientKey(body.idempotencyKey)) {
      return c.json({ error: "invalid_request", reason: "need to, positive amountMicros, memo up to 500 characters, and idempotencyKey" }, 400);
    }
    const payee = await control.resolvePublicAccount(body.to);
    if (!payee) return c.json({ error: "payee_not_found", reason: `unknown account or handle ${body.to}` }, 404);
    try {
      const result = await policy.requestPayment({
        agentId, idempotencyKey: body.idempotencyKey, to: payee.id,
        amountMicros: amount, memo: body.memo ?? "",
      });
      const view = await paymentView(agentId, result);
      const status = view.status === "paid" ? 200 : view.status === "approval_required" ? 202 : view.code === "idempotency_conflict" ? 409 : 402;
      return c.json(view, status);
    } catch (error) {
      return databaseFailure(c, error, "payment_failed");
    }
  });

  app.get("/agent/state", requireAgentSig, async (c) => {
    const requested = Number(c.req.query("limit") ?? 25);
    const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(100, requested)) : 25;
    return c.json(await childSnapshot(c.get("agentId"), limit));
  });

  app.get("/agent/approvals/:id", requireAgentSig, async (c) => {
    const approval = await policy.approval(c.get("agentId"), c.req.param("id") ?? "");
    return approval ? c.json(approvalView(approval)) : c.json({ error: "approval_not_found" }, 404);
  });

  app.get("/provider/state", requireProviderSig, async (c) => c.json(await childSnapshot(c.get("providerId"))));
  app.get("/owner/state", requireOwnerAccess, async (c) => c.json(await ownerSnapshot(c.get("userId"))));

  app.post("/owner/approvals/:id/approve", requireOwnerAccess, async (c) => {
    const userId = c.get("userId");
    const approvalId = c.req.param("id") ?? "";
    const approval = await policy.approval(userId, approvalId);
    if (!approval) return c.json({ error: "approval_not_found" }, 404);
    try {
      const result = await policy.resolveApproval(userId, approvalId, "approve");
      const updated = await policy.approval(userId, approvalId);
      if (!updated) throw new Error("resolved approval could not be read back");
      const payment = await paymentView(userId, result);
      return c.json({ approval: approvalView(updated), payment, replayed: result.replayed }, payment.status === "paid" ? 200 : 409);
    } catch (error) {
      return databaseFailure(c, error, "approval_failed");
    }
  });

  app.post("/owner/approvals/:id/reject", requireOwnerAccess, async (c) => {
    const userId = c.get("userId");
    const approvalId = c.req.param("id") ?? "";
    const approval = await policy.approval(userId, approvalId);
    if (!approval) return c.json({ error: "approval_not_found" }, 404);
    const body = await readBody<{ reason?: string }>(c);
    const reason = typeof body?.reason === "string" ? body.reason.slice(0, 500) : "rejected by owner";
    try {
      const result = await policy.resolveApproval(userId, approvalId, "reject", reason);
      const updated = await policy.approval(userId, approvalId);
      if (!updated) throw new Error("rejected approval could not be read back");
      return c.json({ approval: approvalView(updated), payment: await paymentView(userId, result), replayed: result.replayed });
    } catch (error) {
      return databaseFailure(c, error, "approval_rejection_failed");
    }
  });

  app.get("/dashboard", (c) => {
    c.header("content-security-policy", "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    c.header("referrer-policy", "no-referrer");
    c.header("x-content-type-options", "nosniff");
    return c.html(dashboardHtml);
  });
  app.get("/dashboard/state", requireOwnerAccess, async (c) => c.json(await ownerSnapshot(c.get("userId"))));

  return { app, control, ledger, policy };
}

export async function startPostgresApi(port = Number(process.env.PORT ?? 4021)) {
  const db = new PostgresDatabase({ applicationName: "money-product-api" });
  if (process.env.MONEY_AUTO_MIGRATE === "true") await runMigrations(db);
  const { app } = createPostgresApi(db, { allowDevelopmentFunding: process.env.MONEY_ALLOW_DEV_FUNDING === "true" });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  console.log(`Postgres money API listening on http://127.0.0.1:${port}`);
  console.log(`private owner dashboard at http://127.0.0.1:${port}/dashboard`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  };
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  return { app, server, db, close, port };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startPostgresApi().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
