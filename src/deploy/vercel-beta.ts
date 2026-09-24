import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createCardAuthorizationApp } from "../cards/authorization-server.ts";
import {
  parseCardWebhookSecrets,
  readCardAuthTtlSeconds,
  readCardRevealMode,
  readCardWebhookToleranceSeconds,
} from "../cards/runtime.ts";
import { PostgresCards } from "../db/cards.ts";
import type { TransactionalDatabase } from "../db/database.ts";
import { PostgresExternal } from "../db/external.ts";
import { sweepCardsOnce, sweepExternalOnce } from "../db/external-worker.ts";
import { PostgresLedger } from "../db/ledger.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import { createPostgresApi, parseSignupInvites, postgresApiOptionsFromEnv } from "../server/postgres-api.ts";
import {
  betaPoolOptions,
  readBetaPosture,
  requiredBetaVariable,
  sweepKeyMatches,
  withConnectionRetry,
  type BetaEnvironment,
} from "./vercel-shared.ts";

const SWEEP_KEY_MIN_LENGTH = 32;
const SWEEP_BATCH = 50;
const LEDGER_HEALTH_MIN_INTERVAL_MS = 30 * 60_000;
const WAITLIST_BODY_LIMIT_BYTES = 4096;
const WAITLIST_BUCKET_CAPACITY = 10;
const WAITLIST_BUCKET_WINDOW_MS = 60_000;
const WAITLIST_BUCKET_MAX_KEYS = 10_000;
const WAITLIST_EMAIL_MAX = 254;
const WAITLIST_NOTE_MAX = 500;
/** Mirrors the SQL check in money_private.join_waitlist: one `@`, no
 * whitespace or control characters on either side. */
const WAITLIST_EMAIL = /^[^@\s\p{Cc}]+@[^@\s\p{Cc}]+$/u;
/** Control characters other than tab and newline (CR is normalised away). */
const WAITLIST_NOTE_FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const INTERNAL_NON_POST_METHODS = ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export interface VercelBetaDatabases {
  /** money_app: the product API, the waitlist append, latest_ledger_health. */
  app: TransactionalDatabase;
  /** money_worker: sweeps only. */
  worker: TransactionalDatabase;
  /** money_card_ingress: /webhooks/* decisions and enqueues. */
  cardIngress: TransactionalDatabase;
  /** money_ops: record_ledger_health. */
  ops: TransactionalDatabase;
}

export interface VercelBetaDependencies {
  /** Tests inject embedded databases; production opens one pool per identity. */
  databases?: VercelBetaDatabases;
  now?: () => number;
}

/** Function-privilege probes proving each pool logged in as the identity it
 * was configured for. A 42501 after a deploy therefore surfaces on
 * /health/ready within one monitor interval instead of at the first sweep. */
const AUTHORITY_PROBES: ReadonlyArray<{ pool: keyof VercelBetaDatabases; fn: string }> = [
  { pool: "worker", fn: "money_private.sweep_external_payments(integer)" },
  {
    pool: "cardIngress",
    fn: "money_private.decide_card_authorization(text,text,text,text,bigint,text,text,text,text,integer)",
  },
  { pool: "ops", fn: "money_private.record_ledger_health()" },
  { pool: "app", fn: "money_private.latest_ledger_health()" },
];

function sqlState(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === "object"; depth += 1) {
    const candidate = cursor as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    cursor = candidate.cause;
  }
  return undefined;
}

/** Per-instance token bucket keyed by client address. Honest about its
 * limits: Fluid instances do not share it, so the database-side cap inside
 * join_waitlist is the real ceiling; this only keeps one chatty client from
 * spending an instance's connection on nothing. */
class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly refillPerMs: number;

  constructor(
    private readonly capacity: number,
    windowMs: number,
    private readonly now: () => number,
  ) {
    this.refillPerMs = capacity / windowMs;
  }

  take(key: string): boolean {
    const at = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= WAITLIST_BUCKET_MAX_KEYS) this.prune(at);
      bucket = { tokens: this.capacity, updatedAt: at };
      this.buckets.set(key, bucket);
    } else {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + Math.max(0, at - bucket.updatedAt) * this.refillPerMs);
      bucket.updatedAt = at;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private prune(at: number): void {
    for (const [key, bucket] of this.buckets) {
      if (at - bucket.updatedAt >= WAITLIST_BUCKET_WINDOW_MS) this.buckets.delete(key);
    }
    if (this.buckets.size >= WAITLIST_BUCKET_MAX_KEYS) this.buckets.clear();
  }
}

interface WaitlistInput {
  email: string;
  note: string | null;
}

/** TypeScript validation runs before any database call so malformed input
 * never reaches Postgres (whose error text would echo it). */
function parseWaitlistInput(raw: Record<string, unknown>): WaitlistInput | undefined {
  if (typeof raw.email !== "string") return undefined;
  const email = raw.email.trim();
  if (email.length < 1 || email.length > WAITLIST_EMAIL_MAX || !WAITLIST_EMAIL.test(email)) return undefined;
  if (raw.note !== undefined && raw.note !== null && typeof raw.note !== "string") return undefined;
  const note = typeof raw.note === "string" ? raw.note.replace(/\r\n?/g, "\n").trim() : "";
  if (note.length > WAITLIST_NOTE_MAX || WAITLIST_NOTE_FORBIDDEN.test(note)) return undefined;
  return { email, note: note.length ? note : null };
}

function clientAddress(c: Context): string {
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

function openPools(env: BetaEnvironment): VercelBetaDatabases {
  const open = (name: string, applicationName: string, statementTimeoutMs: number) => new PostgresDatabase(
    betaPoolOptions(env, {
      connectionString: requiredBetaVariable(env, name, "main"),
      applicationName,
      statementTimeoutMs,
    }),
  );
  return {
    app: open("DATABASE_URL", "money-beta-api", 5_000),
    worker: open("MONEY_WORKER_DATABASE_URL", "money-beta-sweep", 30_000),
    cardIngress: open("MONEY_CARD_INGRESS_DATABASE_URL", "money-beta-card-ingress", 2_000),
    ops: open("MONEY_OPS_DATABASE_URL", "money-beta-ops", 50_000),
  };
}

/** The hosted sandbox beta as one serverless function: waitlist, card webhook
 * ingress, the pg_cron-driven /internal/* jobs, an authority-checked readiness
 * probe, and the product API. Boot refuses anything but the sandbox posture
 * (mock issuer, play dollars, invite-only, no reveal surface, no real-money
 * authority in the environment). Per-instance state is limited to the
 * waitlist bucket, the authority-probe cache, and the mock issuer inside the
 * product API; nonces, idempotency keys, and owner sessions live in Postgres. */
export function createVercelBetaApp(env: BetaEnvironment, deps: VercelBetaDependencies = {}) {
  readBetaPosture(env, "main");
  if (env.MONEY_CARD_PROVIDER?.trim() !== "mock") {
    throw new Error("vercel main profile: MONEY_CARD_PROVIDER must be mock (any other issuer is a different profile)");
  }
  if (readCardRevealMode(env) !== "none") {
    throw new Error("vercel main profile: MONEY_CARD_REVEAL_MODE must be none (no reveal surface in the beta)");
  }
  if (env.MONEY_ALLOW_DEV_FUNDING !== "true") {
    throw new Error("vercel main profile: MONEY_ALLOW_DEV_FUNDING must be true (play dollars are the only funding)");
  }
  const invites = parseSignupInvites(env.MONEY_SIGNUP_INVITES);
  if (invites.length < 1) {
    throw new Error("vercel main profile: MONEY_SIGNUP_INVITES must hold at least one invite code (signup is invite-only)");
  }
  const webhookSecrets = parseCardWebhookSecrets(env.MONEY_CARD_WEBHOOK_SECRETS);
  const webhookEndpointId = requiredBetaVariable(env, "MONEY_CARD_WEBHOOK_ENDPOINT_ID", "main");
  const sweepKey = env.MONEY_SWEEP_KEY ?? "";
  const sweepArmed = sweepKey.length >= SWEEP_KEY_MIN_LENGTH;
  if (!sweepArmed) {
    console.warn(
      `vercel main profile: MONEY_SWEEP_KEY is unset or shorter than ${SWEEP_KEY_MIN_LENGTH} characters; /internal/* answers 503`,
    );
  }
  const sessionOwnerWrites = env.MONEY_ALLOW_SESSION_OWNER_WRITES === "true";
  const now = deps.now ?? Date.now;

  const databases = deps.databases ?? openPools(env);
  const productApp = createPostgresApi(databases.app, postgresApiOptionsFromEnv(env)).app;
  const cardApp = createCardAuthorizationApp(new PostgresCards(databases.cardIngress), {
    provider: "mock",
    secrets: webhookSecrets,
    endpointId: webhookEndpointId,
    toleranceSeconds: readCardWebhookToleranceSeconds(env),
    authTtlSeconds: readCardAuthTtlSeconds(env),
  });
  const waitlistBucket = new TokenBucket(WAITLIST_BUCKET_CAPACITY, WAITLIST_BUCKET_WINDOW_MS, now);
  let authorityVerified = false;

  console.log(
    `posture=sandbox-beta provider=mock reveal=none devFunding=true sessionOwnerWrites=${sessionOwnerWrites} ` +
    `invites=${invites.length} x402=off sweep=${sweepArmed ? "armed" : "disarmed"}`,
  );

  const app = new Hono();
  app.onError((error, c) => {
    console.error(JSON.stringify({ route: "beta", error: error instanceof Error ? error.name : "unknown" }));
    return c.json({ ok: false, error: "internal_error" }, 500);
  });

  // 1. Waitlist. JSON from the landing page script, form-encoded without JS.
  app.post(
    "/waitlist",
    bodyLimit({
      maxSize: WAITLIST_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ ok: false, error: "payload_too_large" }, 413),
    }),
    async (c) => {
      const contentType = (c.req.header("content-type") ?? "").toLowerCase();
      const isForm = contentType.startsWith("application/x-www-form-urlencoded");
      const isJson = contentType.startsWith("application/json");
      if (!isForm && !isJson) return c.json({ ok: false, error: "unsupported_media_type" }, 415);
      const reply = (
        status: 202 | 400 | 429 | 503,
        body: Record<string, unknown>,
        formState: "ok" | "invalid" | "busy" | "unavailable",
      ) => (isForm ? c.redirect(`/?waitlist=${formState}#invite`, 303) : c.json(body, status));

      let raw: Record<string, unknown> | undefined;
      if (isJson) {
        try {
          const parsed: unknown = await c.req.json();
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
        } catch {
          raw = undefined;
        }
      } else {
        const params = new URLSearchParams(await c.req.text());
        raw = { email: params.get("email") ?? undefined, note: params.get("note") ?? undefined };
      }
      const input = raw ? parseWaitlistInput(raw) : undefined;
      if (!input) return reply(400, { ok: false, error: "invalid_request" }, "invalid");
      if (!waitlistBucket.take(clientAddress(c))) {
        c.header("retry-after", "60");
        return reply(429, { ok: false, error: "rate_limited" }, "busy");
      }
      // Own try/catch: the shared onError would log the error object, and a
      // Postgres error's text can echo the submitted address.
      try {
        await databases.app.query("select money_private.join_waitlist($1, $2)", [input.email, input.note]);
        return reply(202, { ok: true }, "ok");
      } catch (error) {
        const code = sqlState(error);
        if (code === "23505") return reply(202, { ok: true }, "ok");
        console.error(JSON.stringify({ route: "waitlist", code: code ?? "unknown" }));
        if (code === "22023") return reply(400, { ok: false, error: "invalid_request" }, "invalid");
        return reply(503, { ok: false, error: "waitlist_unavailable" }, "unavailable");
      }
    },
  );

  // 2. Card webhook ingress, delegated by raw Request so the card app keeps
  // its absolute paths and its fail-closed onError.
  app.all("/webhooks/*", (c) => cardApp.fetch(c.req.raw));

  // 3. pg_cron-driven jobs.
  app.on(INTERNAL_NON_POST_METHODS, "/internal/*", (c) => {
    c.header("allow", "POST");
    return c.json({ ok: false, error: "method_not_allowed" }, 405);
  });
  const refuseInternal = (c: Context): Response | undefined => {
    if (!sweepArmed) return c.json({ ok: false, error: "disarmed" }, 503);
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return c.json({ ok: false, error: "unsupported_media_type" }, 415);
    }
    if (!sweepKeyMatches(sweepKey, c.req.header("x-sweep-key") ?? "")) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    return undefined;
  };

  app.post("/internal/sweep", async (c) => {
    const refused = refuseInternal(c);
    if (refused) return refused;
    try {
      const external = await withConnectionRetry(
        () => sweepExternalOnce(new PostgresExternal(databases.worker), SWEEP_BATCH),
      );
      const cards = await withConnectionRetry(
        () => sweepCardsOnce(new PostgresCards(databases.worker), SWEEP_BATCH),
      );
      const counts = {
        externalReversed: external.length,
        cardAuthorizationsExpired: cards.expiredAuthorizations.length,
        cardsFinalized: cards.finalizedCards.length,
      };
      console.log(JSON.stringify({ route: "internal/sweep", ok: true, ...counts }));
      // The mock issuer is per-process memory: a worker instance knows none of
      // the API instance's cards, so the card-event batch and issuer-close
      // drain never run here. Flipping this profile to a real issuer is a new
      // spec, not an env edit.
      return c.json({
        ok: true,
        provider: "mock",
        ...counts,
        cardEvents: "skipped",
        issuerCloses: "skipped",
        reason: "mock issuer has no cross-instance state",
      });
    } catch (error) {
      console.error(JSON.stringify({ route: "internal/sweep", ok: false, code: sqlState(error) ?? "unknown" }));
      return c.json({ ok: false, error: "sweep_failed" }, 503);
    }
  });

  app.post("/internal/ledger-health", async (c) => {
    const refused = refuseInternal(c);
    if (refused) return refused;
    try {
      const latest = await withConnectionRetry(() => databases.app.query<{
        zero_sum: boolean; receipts_ok: boolean; verified_at: Date | string;
      }>("select * from money_private.latest_ledger_health()"));
      const recent = latest.rows[0];
      if (recent) {
        const verifiedAt = new Date(recent.verified_at);
        if (now() - verifiedAt.getTime() < LEDGER_HEALTH_MIN_INTERVAL_MS) {
          return c.json({ ok: true, skipped: "recent", verifiedAt: verifiedAt.toISOString() });
        }
      }
      const verdict = await withConnectionRetry(() => new PostgresLedger(databases.ops).recordLedgerHealth());
      const ok = verdict.zeroSum && verdict.receiptsOk;
      const line = JSON.stringify({
        route: "internal/ledger-health", ok, zeroSum: verdict.zeroSum, receiptsOk: verdict.receiptsOk,
      });
      if (ok) console.log(line);
      else console.error(line);
      return c.json({
        ok,
        zeroSum: verdict.zeroSum,
        receiptsOk: verdict.receiptsOk,
        verifiedAt: verdict.verifiedAt.toISOString(),
      });
    } catch (error) {
      console.error(JSON.stringify({ route: "internal/ledger-health", ok: false, code: sqlState(error) ?? "unknown" }));
      return c.json({ ok: false, error: "ledger_health_failed" }, 503);
    }
  });

  // 4. Readiness: the product schema check plus a once-per-instance proof
  // that every pool holds the authority its identity was granted.
  app.get("/health/ready", async (c) => {
    const inner = await productApp.fetch(c.req.raw);
    if (inner.status !== 200) return inner;
    if (!authorityVerified) {
      for (const probe of AUTHORITY_PROBES) {
        let granted: boolean | undefined;
        try {
          const result = await databases[probe.pool].query<{ ok: boolean }>(
            "select has_function_privilege(current_user, $1, 'execute') as ok",
            [probe.fn],
          );
          granted = result.rows[0]?.ok === true;
        } catch {
          granted = undefined;
        }
        if (granted === undefined) {
          console.error(JSON.stringify({ route: "health/ready", error: "database_unavailable", pool: probe.pool }));
          return c.json({ ok: false, error: "database_unavailable" }, 503);
        }
        if (!granted) {
          console.error(JSON.stringify({ route: "health/ready", error: "authority_mismatch", pool: probe.pool }));
          return c.json({ ok: false, error: "authority_mismatch" }, 503);
        }
      }
      authorityVerified = true;
    }
    return inner;
  });

  // 5. Everything else is the product API (health/live, dashboard, signed
  // routes). No preflight, no migrations, no treasury or compliance apps.
  app.all("/*", (c) => productApp.fetch(c.req.raw));

  return app;
}
