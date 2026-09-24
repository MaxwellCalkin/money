import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signIssuerWebhook } from "../src/cards/issuer.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createVercelBetaApp, type VercelBetaDatabases } from "../src/deploy/vercel-beta.ts";
import { createVercelMetricsApp } from "../src/deploy/vercel-metrics.ts";
import {
  betaPoolOptions,
  readBetaPosture,
  sweepKeyMatches,
  withConnectionRetry,
} from "../src/deploy/vercel-shared.ts";

class EmbeddedPostgres implements TransactionalDatabase {
  constructor(readonly pg: PGliteInterface) {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryRows<T>> {
    const result = await this.pg.query<T>(text, [...values]);
    return { rows: result.rows, affectedRows: result.affectedRows };
  }

  async executeScript(text: string): Promise<void> {
    await this.pg.exec(text);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (transaction: Transaction) => work({
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = []
      ): Promise<QueryRows<R>> => {
        const result = await transaction.query<R>(text, [...values]);
        return { rows: result.rows, affectedRows: result.affectedRows };
      },
      executeScript: async (text: string) => {
        await transaction.exec(text);
      },
    }));
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

const CA = "-----BEGIN CERTIFICATE-----\nMIIBbetaTestCertificate\n-----END CERTIFICATE-----";
const SWEEP_KEY = `sweep-${"0123456789abcdef".repeat(3)}`;
const WEBHOOK_SECRET = "whsec_beta_test_secret_0000000000001";
const INVITE = "pilot-invite-code-0001";

type Env = Record<string, string | undefined>;

function mainEnv(overrides: Env = {}): Env {
  return {
    MONEY_POSTURE: "sandbox-beta",
    NODE_ENV: "development",
    MONEY_DB_SSL: "verify-full",
    MONEY_DB_SSL_CA: CA,
    PG_POOL_MAX: "2",
    MONEY_ALLOW_DEV_FUNDING: "true",
    MONEY_ALLOW_SESSION_OWNER_WRITES: "true",
    MONEY_SIGNUP_INVITES: JSON.stringify([INVITE]),
    MONEY_CARD_PROVIDER: "mock",
    MONEY_CARD_REVEAL_MODE: "none",
    MONEY_CARD_WEBHOOK_SECRETS: JSON.stringify([WEBHOOK_SECRET]),
    MONEY_CARD_WEBHOOK_ENDPOINT_ID: "beta-mock-card-endpoint",
    MONEY_SWEEP_KEY: SWEEP_KEY,
    ...overrides,
  };
}

function metricsEnv(overrides: Env = {}): Env {
  return {
    MONEY_POSTURE: "sandbox-beta",
    NODE_ENV: "development",
    MONEY_DB_SSL: "verify-full",
    MONEY_DB_SSL_CA: CA,
    MONEY_METRICS_SANDBOX_LABEL: "true",
    ...overrides,
  };
}

/** A database double for the failure-path tests: every query runs `impl`. */
function stubDatabase(impl: (text: string, values: readonly unknown[]) => Promise<QueryRows<never>>): TransactionalDatabase {
  return {
    query: impl as TransactionalDatabase["query"],
    executeScript: async () => undefined,
    transaction: async () => { throw new Error("stub database has no transactions"); },
    close: async () => undefined,
  };
}

function jsonPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://beta.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function formPost(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`http://beta.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

function internalPost(path: string, key: string | undefined, contentType = "application/json") {
  return new Request(`http://beta.test${path}`, {
    method: "POST",
    headers: {
      ...(contentType ? { "content-type": contentType } : {}),
      ...(key !== undefined ? { "x-sweep-key": key } : {}),
    },
    body: "{}",
  });
}

describe("vercel main composer", () => {
  let db: EmbeddedPostgres;
  let databases: VercelBetaDatabases;
  let offsetMs: number;
  const now = () => Date.now() + offsetMs;
  const output: string[] = [];

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    databases = { app: db, worker: db, cardIngress: db, ops: db };
    offsetMs = 0;
    output.length = 0;
    const capture = (...args: unknown[]) => { output.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  const boot = (env: Env = mainEnv(), deps: Partial<VercelBetaDatabases> = {}) =>
    createVercelBetaApp(env, { databases: { ...databases, ...deps }, now });

  it("refuses every posture drift at boot, naming variables and never values", () => {
    const refusals: Array<[Env, RegExp]> = [
      [mainEnv({ NODE_ENV: "production" }), /NODE_ENV/],
      [mainEnv({ MONEY_POSTURE: undefined }), /MONEY_POSTURE/],
      [mainEnv({ MONEY_POSTURE: "production" }), /MONEY_POSTURE/],
      [mainEnv({ MONEY_DB_SSL: "require" }), /MONEY_DB_SSL/],
      [mainEnv({ MONEY_DB_SSL: "off" }), /MONEY_DB_SSL/],
      [mainEnv({ MONEY_DB_SSL_CA: undefined }), /MONEY_DB_SSL_CA/],
      [mainEnv({ MONEY_EVM_PRIVATE_KEY: `0x${"1".repeat(64)}` }), /MONEY_EVM_PRIVATE_KEY must not be present/],
      [mainEnv({ MONEY_METRICS_DATABASE_URL: "postgresql://m:p@db.invalid/x" }), /MONEY_METRICS_DATABASE_URL/],
      [mainEnv({ MONEY_CARD_WORKER_DATABASE_URL: "postgresql://w:p@db.invalid/x" }), /MONEY_CARD_WORKER_DATABASE_URL/],
      [mainEnv({ MONEY_OPS_TOKEN: "ops-token-with-at-least-32-characters-x" }), /MONEY_OPS_TOKEN/],
      [mainEnv({ MONEY_AUTO_MIGRATE: "true" }), /MONEY_AUTO_MIGRATE/],
      [mainEnv({ MONEY_EXTERNAL_MOCK: "true" }), /MONEY_EXTERNAL_MOCK/],
      [mainEnv({ MONEY_CARD_PROVIDER: "stripe-issuing" }), /MONEY_CARD_PROVIDER/],
      [mainEnv({ MONEY_CARD_PROVIDER: undefined }), /MONEY_CARD_PROVIDER/],
      [mainEnv({ MONEY_CARD_REVEAL_MODE: "token" }), /MONEY_CARD_REVEAL_MODE/],
      [mainEnv({ MONEY_ALLOW_DEV_FUNDING: "false" }), /MONEY_ALLOW_DEV_FUNDING/],
      [mainEnv({ MONEY_SIGNUP_INVITES: "[]" }), /MONEY_SIGNUP_INVITES/],
      [mainEnv({ MONEY_SIGNUP_INVITES: undefined }), /MONEY_SIGNUP_INVITES/],
      [mainEnv({ MONEY_CARD_WEBHOOK_SECRETS: undefined }), /MONEY_CARD_WEBHOOK_SECRETS/],
      [mainEnv({ MONEY_CARD_WEBHOOK_ENDPOINT_ID: undefined }), /MONEY_CARD_WEBHOOK_ENDPOINT_ID/],
    ];
    for (const [env, pattern] of refusals) {
      let message = "";
      try {
        boot(env);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, `expected a refusal matching ${pattern}`).toMatch(pattern);
      expect(message).not.toContain(CA);
      expect(message).not.toContain(SWEEP_KEY);
      expect(message).not.toContain(WEBHOOK_SECRET);
      expect(message).not.toContain(INVITE);
    }
    expect(() => boot(mainEnv({ MONEY_CARD_AUTH_TTL_SECONDS: "1" }))).toThrow(/MONEY_CARD_AUTH_TTL_SECONDS/);
  });

  it("boots the sandbox posture, logs it once, and disarms /internal/* without a long enough key", async () => {
    const armed = boot();
    expect(output).toEqual([
      "posture=sandbox-beta provider=mock reveal=none devFunding=true sessionOwnerWrites=true invites=1 x402=off sweep=armed",
    ]);
    expect((await armed.request("/health/live")).status).toBe(200);

    output.length = 0;
    const disarmed = boot(mainEnv({ MONEY_SWEEP_KEY: undefined }));
    expect(output.some((line) => /MONEY_SWEEP_KEY/.test(line) && /disarmed|503/.test(line))).toBe(true);
    expect(output.join("\n")).toMatch(/sweep=disarmed/);
    const response = await disarmed.request(internalPost("/internal/sweep", SWEEP_KEY));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "disarmed" });

    const short = boot(mainEnv({ MONEY_SWEEP_KEY: "too-short" }));
    expect((await short.request(internalPost("/internal/ledger-health", "too-short"))).status).toBe(503);
  });

  it("guards /internal/* by method, media type, and a constant-time key check", async () => {
    const app = boot();
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const response = await app.request("/internal/sweep", { method, headers: { "x-sweep-key": SWEEP_KEY } });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    expect((await app.request(internalPost("/internal/sweep", SWEEP_KEY, ""))).status).toBe(415);
    expect((await app.request(internalPost("/internal/sweep", SWEEP_KEY, "text/plain"))).status).toBe(415);
    const wrong = await app.request(internalPost("/internal/sweep", `${SWEEP_KEY.slice(0, -1)}x`));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ ok: false, error: "unauthorized" });
    expect((await app.request(internalPost("/internal/sweep", "short"))).status).toBe(401);
    expect((await app.request(internalPost("/internal/sweep", `${SWEEP_KEY}${SWEEP_KEY}`))).status).toBe(401);
    expect((await app.request(internalPost("/internal/sweep", undefined))).status).toBe(401);
    expect((await app.request(internalPost("/internal/ledger-health", "short"))).status).toBe(401);
    // A wrong key never reaches the database: nothing was recorded.
    expect((await db.query<{ n: number }>("select count(*)::int as n from money.ledger_health_reports")).rows[0]!.n).toBe(0);
  });

  it("sweeps under the mock issuer with counts only and never runs the card-worker steps", async () => {
    const app = boot();
    const response = await app.request(internalPost("/internal/sweep", SWEEP_KEY));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      provider: "mock",
      externalReversed: 0,
      cardAuthorizationsExpired: 0,
      cardsFinalized: 0,
      cardEvents: "skipped",
      issuerCloses: "skipped",
      reason: "mock issuer has no cross-instance state",
    });
    const line = output.find((entry) => entry.includes("internal/sweep"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toEqual({
      route: "internal/sweep", ok: true, externalReversed: 0, cardAuthorizationsExpired: 0, cardsFinalized: 0,
    });
  });

  it("answers 503 with a code-only log line when a sweep pool fails", async () => {
    const failing = stubDatabase(async () => {
      throw Object.assign(new Error("permission denied for function sweep_external_payments (secret-ish detail)"), { code: "42501" });
    });
    const app = boot(mainEnv(), { worker: failing });
    const response = await app.request(internalPost("/internal/sweep", SWEEP_KEY));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "sweep_failed" });
    const line = output.find((entry) => entry.includes("internal/sweep"));
    expect(JSON.parse(line!)).toEqual({ route: "internal/sweep", ok: false, code: "42501" });
    expect(output.join("\n")).not.toContain("secret-ish");
  });

  it("records ledger health at most once per half hour", async () => {
    const app = boot();
    const first = await app.request(internalPost("/internal/ledger-health", SWEEP_KEY));
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { ok: boolean; zeroSum: boolean; receiptsOk: boolean; verifiedAt: string };
    expect(firstBody).toEqual({ ok: true, zeroSum: true, receiptsOk: true, verifiedAt: expect.any(String) });

    offsetMs = 10 * 60_000;
    const second = await app.request(internalPost("/internal/ledger-health", SWEEP_KEY));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, skipped: "recent", verifiedAt: firstBody.verifiedAt });
    expect((await db.query<{ n: number }>("select count(*)::int as n from money.ledger_health_reports")).rows[0]!.n).toBe(1);

    offsetMs = 31 * 60_000;
    const third = await app.request(internalPost("/internal/ledger-health", SWEEP_KEY));
    expect(await third.json()).toEqual(expect.objectContaining({ ok: true, zeroSum: true, receiptsOk: true }));
    expect((await db.query<{ n: number }>("select count(*)::int as n from money.ledger_health_reports")).rows[0]!.n).toBe(2);
  });

  it("accepts waitlist JSON, validates before the database, and never echoes input", async () => {
    const app = boot();
    const ok = await app.request(jsonPost("/waitlist", { email: "Pilot@Example.com", note: "buy datasets\r\nand compute" }));
    expect(ok.status).toBe(202);
    expect(await ok.text()).toBe(JSON.stringify({ ok: true }));
    const again = await app.request(jsonPost("/waitlist", { email: "pilot@example.com" }));
    expect(again.status).toBe(202);
    const rows = await db.query<{ email: string; note: string | null }>("select email, note from money.beta_waitlist");
    expect(rows.rows).toEqual([{ email: "Pilot@Example.com", note: "buy datasets\nand compute" }]);

    const invalid: unknown[] = [
      { email: "not-an-email" },
      { email: "" },
      { email: "a@b@c.example" },
      { email: "sp ace@example.com" },
      { email: `${"x".repeat(250)}@example.com` },
      { email: "ok@example.com", note: "x".repeat(501) },
      { email: "ok@example.com", note: "bad\u0007bell" },
      { email: "ok@example.com", note: 42 },
      { note: "no email" },
      ["ok@example.com"],
      "{not json",
      "null",
    ];
    for (const body of invalid) {
      const response = await app.request(jsonPost("/waitlist", body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "invalid_request" });
    }
    expect((await db.query<{ n: number }>("select count(*)::int as n from money.beta_waitlist")).rows[0]!.n).toBe(1);

    const wrongType = await app.request(new Request("http://beta.test/waitlist", {
      method: "POST", headers: { "content-type": "text/plain" }, body: "pilot@example.com",
    }));
    expect(wrongType.status).toBe(415);
    const oversize = await app.request(jsonPost("/waitlist", { email: "ok@example.com", note: "x".repeat(5_000) }));
    expect(oversize.status).toBe(413);
    expect((await app.request("/waitlist")).status).toBe(404);
    expect(output.join("\n")).not.toMatch(/example\.com/);
  });

  it("rate-limits the waitlist per client address and answers forms with 303 redirects", async () => {
    const app = boot();
    const ip = { "x-real-ip": "203.0.113.9" };
    for (let i = 0; i < 10; i += 1) {
      const response = await app.request(jsonPost("/waitlist", { email: `pilot${i}@example.com` }, ip));
      expect(response.status, `request ${i}`).toBe(202);
    }
    const limited = await app.request(jsonPost("/waitlist", { email: "pilot11@example.com" }, ip));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ ok: false, error: "rate_limited" });
    // Another client is unaffected; validation still precedes the bucket.
    expect((await app.request(jsonPost("/waitlist", { email: "other@example.com" }, { "x-real-ip": "198.51.100.4" }))).status).toBe(202);
    expect((await app.request(jsonPost("/waitlist", { email: "nope" }, ip))).status).toBe(400);

    const busy = await app.request(formPost("/waitlist", { email: "form@example.com" }, ip));
    expect(busy.status).toBe(303);
    expect(busy.headers.get("location")).toBe("/?waitlist=busy#invite");

    offsetMs = 60_000;
    const okForm = await app.request(formPost("/waitlist", { email: "form@example.com", note: "line one\r\nline two" }, ip));
    expect(okForm.status).toBe(303);
    expect(okForm.headers.get("location")).toBe("/?waitlist=ok#invite");
    expect(await okForm.text()).toBe("");
    const invalidForm = await app.request(formPost("/waitlist", { email: "not-an-email" }, ip));
    expect(invalidForm.status).toBe(303);
    expect(invalidForm.headers.get("location")).toBe("/?waitlist=invalid#invite");
    const stored = await db.query<{ note: string | null }>("select note from money.beta_waitlist where email_normalized = 'form@example.com'");
    expect(stored.rows).toEqual([{ note: "line one\nline two" }]);
    expect(output.join("\n")).not.toMatch(/example\.com/);
  });

  it("maps database outcomes to 202/400/503 without leaking Postgres error text", async () => {
    const duplicate = stubDatabase(async () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint "beta_waitlist_email_normalized_key"'), {
        code: "23505",
        detail: "Key (email_normalized)=(leak@example.com) already exists.",
      });
    });
    const dup = boot(mainEnv(), { app: duplicate });
    const accepted = await dup.request(jsonPost("/waitlist", { email: "leak@example.com" }));
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ ok: true });
    expect(output.join("\n")).not.toContain("leak@example.com");
    expect(output.join("\n")).not.toContain("email_normalized");

    const invalidByDb = stubDatabase(async () => {
      throw Object.assign(new Error("invalid email"), { code: "22023", where: "PL/pgSQL function join_waitlist(text,text) with input leak@example.com" });
    });
    const inv = boot(mainEnv(), { app: invalidByDb });
    const rejected = await inv.request(jsonPost("/waitlist", { email: "leak@example.com" }));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ ok: false, error: "invalid_request" });

    const down = stubDatabase(async () => { throw new Error("Connection terminated unexpectedly leak@example.com"); });
    const unavailable = boot(mainEnv(), { app: down });
    const json = await unavailable.request(jsonPost("/waitlist", { email: "leak@example.com" }));
    expect(json.status).toBe(503);
    expect(await json.json()).toEqual({ ok: false, error: "waitlist_unavailable" });
    const form = await unavailable.request(formPost("/waitlist", { email: "leak@example.com" }));
    expect(form.status).toBe(303);
    expect(form.headers.get("location")).toBe("/?waitlist=unavailable#invite");

    const lines = output.filter((line) => line.includes("waitlist")).map((line) => JSON.parse(line) as unknown);
    expect(lines).toEqual([
      { route: "waitlist", code: "22023" },
      { route: "waitlist", code: "unknown" },
      { route: "waitlist", code: "unknown" },
    ]);
    expect(output.join("\n")).not.toContain("leak@example.com");
  });

  it("delegates /webhooks/* to the card app by raw request, keeping its fail-closed handling", async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const body = JSON.stringify({
      id: "evt_beta_0001", object: "event", created: nowSeconds, type: "issuing_authorization.request",
      data: {
        object: {
          id: "iauth_beta_0001", object: "issuing.authorization", approved: false, currency: "usd",
          card: { id: "ic_beta_0001" },
          merchant_data: { category_code: "5734", name: "MOCK SHOP EXAMPLE", country: "US" },
          pending_request: { amount: 2_900, currency: "usd" },
          status: "pending",
        },
      },
    });
    const signed = (secret: string) => ({
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signIssuerWebhook(body, secret, nowSeconds) },
      body,
    });

    const app = boot();
    const forged = await app.request("/webhooks/mock/authorization", signed("whsec_wrong_secret_000000000001"));
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: "invalid_signature" });
    const unknownProvider = await app.request("/webhooks/stripe-issuing/authorization", signed(WEBHOOK_SECRET));
    expect(unknownProvider.status).toBe(404);
    expect(await unknownProvider.json()).toEqual({ error: "unknown_provider" });
    // A genuine request for a card this database never issued is declined,
    // never approved, and carries the issuer version header the card app sets.
    const unknownCard = await app.request("/webhooks/mock/authorization", signed(WEBHOOK_SECRET));
    expect(unknownCard.status).toBe(200);
    expect(await unknownCard.json()).toEqual(expect.objectContaining({ approved: false }));
    expect(unknownCard.headers.get("stripe-version")).toBeTruthy();

    // Ingress database failure: the card app's own catch answers approved:false
    // and its own onError answers 503 on the event path — neither reaches the
    // composer's error handler.
    const broken = boot(mainEnv(), {
      cardIngress: stubDatabase(async () => { throw Object.assign(new Error("ingress pool is gone"), { code: "57P01" }); }),
    });
    const declined = await broken.request("/webhooks/mock/authorization", signed(WEBHOOK_SECRET));
    expect(declined.status).toBe(200);
    expect(await declined.json()).toEqual({
      approved: false,
      metadata: { agentmoney_decision: "declined", agentmoney_decline_code: "system" },
    });
    const eventBody = JSON.stringify({ id: "evt_beta_0002", object: "event", created: nowSeconds, type: "issuing_authorization.updated", data: { object: { id: "iauth_beta_0002" } } });
    const events = await broken.request("/webhooks/mock/events", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signIssuerWebhook(eventBody, WEBHOOK_SECRET, nowSeconds) },
      body: eventBody,
    });
    expect(events.status).toBe(503);
    expect(await events.json()).toEqual({ error: "webhook_unavailable" });
    expect(output.some((line) => line.includes('"route":"beta"'))).toBe(false);
  });

  it("serves readiness through the product API plus a once-per-instance authority probe", async () => {
    let probes = 0;
    const counting: TransactionalDatabase = {
      query: async (text, values) => {
        if (text.includes("has_function_privilege")) probes += 1;
        return db.query(text, values);
      },
      executeScript: (text) => db.executeScript(text),
      transaction: (work) => db.transaction(work),
      close: async () => undefined,
    };
    const app = boot(mainEnv(), { worker: counting });
    const live = await app.request("/health/live");
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ ok: true });

    const ready = await app.request("/health/ready");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ok: true, schemaVersion: "0014" });
    expect(probes).toBe(1);
    expect((await app.request("/health/ready")).status).toBe(200);
    expect(probes).toBe(1);

    const denied = stubDatabase(async () => ({ rows: [{ ok: false }] as never[] }));
    const mismatch = boot(mainEnv(), { ops: denied });
    const refused = await mismatch.request("/health/ready");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ ok: false, error: "authority_mismatch" });
    const line = output.find((entry) => entry.includes("authority_mismatch"));
    expect(JSON.parse(line!)).toEqual({ route: "health/ready", error: "authority_mismatch", pool: "ops" });

    const unreachable = boot(mainEnv(), {
      cardIngress: stubDatabase(async () => { throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }); }),
    });
    const down = await unreachable.request("/health/ready");
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ ok: false, error: "database_unavailable" });
  });

  it("routes everything else to the product API without a route prefix", async () => {
    const app = boot();
    const users = await app.request(jsonPost("/users", {}));
    expect(users.status).not.toBe(405);
    expect(users.status).not.toBe(404);
    expect(users.status).toBe(400);
    const invited = await app.request(jsonPost("/users", { name: "Pilot", publicKey: "x".repeat(44) }));
    expect([400, 403]).toContain(invited.status);
    const dashboard = await app.request("/dashboard");
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get("content-type")).toMatch(/text\/html/);
    expect((await app.request("/metrics.json")).status).toBe(404);
    expect((await app.request("/no-such-route")).status).toBe(404);
  });
});

describe("vercel metrics composer", () => {
  let db: EmbeddedPostgres;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  it("refuses the main profile's authority and a removed sandbox label", () => {
    expect(() => createVercelMetricsApp(metricsEnv({ DATABASE_URL: "postgresql://a:p@db.invalid/x" }), { database: db }))
      .toThrow(/metrics profile: DATABASE_URL/);
    expect(() => createVercelMetricsApp(metricsEnv({ MONEY_CARD_WEBHOOK_SECRETS: JSON.stringify([WEBHOOK_SECRET]) }), { database: db }))
      .toThrow(/MONEY_CARD_WEBHOOK_SECRETS/);
    expect(() => createVercelMetricsApp(metricsEnv({ MONEY_METRICS_SANDBOX_LABEL: "false" }), { database: db }))
      .toThrow(/MONEY_METRICS_SANDBOX_LABEL/);
    expect(() => createVercelMetricsApp(metricsEnv({ NODE_ENV: "production" }), { database: db })).toThrow(/NODE_ENV/);
    expect(() => createVercelMetricsApp(metricsEnv({ MONEY_DB_SSL: "require" }), { database: db })).toThrow(/MONEY_DB_SSL/);
    expect(() => createVercelMetricsApp(metricsEnv(), {})).toThrow(/MONEY_METRICS_DATABASE_URL is required/);
  });

  it("serves the metrics surface with CDN cache and hardening headers, sandbox forced on", async () => {
    const app = createVercelMetricsApp(metricsEnv({ MONEY_METRICS_SANDBOX_LABEL: undefined }), { database: db });
    const json = await app.request("/metrics.json");
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual(expect.objectContaining({ sandbox: true }));
    expect(json.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    expect(json.headers.get("content-security-policy")).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
    expect(json.headers.get("x-content-type-options")).toBe("nosniff");
    expect(json.headers.get("referrer-policy")).toBe("no-referrer");

    const page = await app.request("/metrics");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(page.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    expect((await app.request("/")).status).toBe(200);

    const live = await app.request("/health/live");
    expect(live.status).toBe(200);
    expect(live.headers.get("cache-control")).toBe("no-store");
    expect(live.headers.get("content-security-policy")).toContain("default-src 'none'");

    expect((await app.request("/receipts/not-a-uuid/verify")).status).toBe(404);
    expect((await app.request("/users")).status).toBe(404);
    expect((await app.request("/metrics", { method: "POST" })).status).toBe(405);
  });
});

describe("vercel shared helpers", () => {
  it("compares sweep keys in constant time regardless of length", () => {
    expect(sweepKeyMatches(SWEEP_KEY, SWEEP_KEY)).toBe(true);
    expect(sweepKeyMatches(SWEEP_KEY, "short")).toBe(false);
    expect(sweepKeyMatches(SWEEP_KEY, `${SWEEP_KEY}x`)).toBe(false);
    expect(sweepKeyMatches(SWEEP_KEY, "")).toBe(false);
  });

  it("retries exactly once on an idle-disconnect signature and never otherwise", async () => {
    for (const failure of [
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
      Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }),
      new Error("Connection terminated unexpectedly"),
      new Error("wrapped", { cause: Object.assign(new Error("x"), { code: "57P01" }) }),
    ]) {
      let calls = 0;
      const value = await withConnectionRetry(async () => {
        calls += 1;
        if (calls === 1) throw failure;
        return "ok";
      });
      expect(value).toBe("ok");
      expect(calls).toBe(2);
    }
    let twice = 0;
    await expect(withConnectionRetry(async () => {
      twice += 1;
      throw Object.assign(new Error("still down"), { code: "ECONNRESET" });
    })).rejects.toThrow(/still down/);
    expect(twice).toBe(2);
    let once = 0;
    await expect(withConnectionRetry(async () => {
      once += 1;
      throw Object.assign(new Error("permission denied"), { code: "42501" });
    })).rejects.toThrow(/permission denied/);
    expect(once).toBe(1);
  });

  it("builds tiny pinned-CA pools", () => {
    expect(betaPoolOptions(mainEnv(), {
      connectionString: "postgresql://u:p@db.invalid:6543/postgres",
      applicationName: "money-beta-api",
      statementTimeoutMs: 5_000,
    })).toEqual({
      connectionString: "postgresql://u:p@db.invalid:6543/postgres",
      applicationName: "money-beta-api",
      statementTimeoutMs: 5_000,
      maxConnections: 2,
      idleTimeoutMs: 5_000,
      ssl: { ca: CA, rejectUnauthorized: true },
    });
    expect(betaPoolOptions(mainEnv({ PG_POOL_MAX: undefined }), {
      connectionString: "x", applicationName: "y", statementTimeoutMs: 1,
    }).maxConnections).toBe(2);
    expect(() => betaPoolOptions(mainEnv({ PG_POOL_MAX: "0" }), {
      connectionString: "x", applicationName: "y", statementTimeoutMs: 1,
    })).toThrow(/PG_POOL_MAX/);
  });

  it("applies the per-profile authority allowlists", () => {
    expect(() => readBetaPosture(mainEnv({
      DATABASE_URL: "postgresql://a:p@db.invalid/x",
      MONEY_WORKER_DATABASE_URL: "postgresql://w:p@db.invalid/x",
      MONEY_CARD_INGRESS_DATABASE_URL: "postgresql://i:p@db.invalid/x",
      MONEY_OPS_DATABASE_URL: "postgresql://o:p@db.invalid/x",
    }), "main")).not.toThrow();
    expect(() => readBetaPosture(mainEnv({ MONEY_OWNER_KEY: "owner-key" }), "main")).toThrow(/main profile: MONEY_OWNER_KEY/);
    expect(() => readBetaPosture(metricsEnv({ MONEY_METRICS_DATABASE_URL: "postgresql://m:p@db.invalid/x" }), "metrics")).not.toThrow();
    expect(() => readBetaPosture(metricsEnv({ MONEY_WORKER_DATABASE_URL: "postgresql://w:p@db.invalid/x" }), "metrics"))
      .toThrow(/metrics profile: MONEY_WORKER_DATABASE_URL/);
    expect(() => readBetaPosture(mainEnv({ NODE_ENV: undefined }), "main")).not.toThrow();
    expect(() => readBetaPosture(mainEnv({ NODE_ENV: "test" }), "main")).toThrow(/NODE_ENV/);
  });
});

describe("vercel entry", () => {
  const saved = process.env.MONEY_POSTURE;
  afterEach(() => {
    if (saved === undefined) delete process.env.MONEY_POSTURE;
    else process.env.MONEY_POSTURE = saved;
    vi.restoreAllMocks();
  });

  it("answers 503 on every request after a refused boot and logs the reason once", async () => {
    delete process.env.MONEY_POSTURE;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const entry = (await import("../src/deploy/vercel-entry.ts")).default;
    expect(typeof entry.fetch).toBe("function");
    const first = await entry.fetch(new Request("http://beta.test/health/live"));
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ ok: false, error: "boot_failed" });
    const second = await entry.fetch(new Request("http://beta.test/health/live"));
    expect(second.status).toBe(503);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[1])).toMatch(/MONEY_POSTURE/);
  });
});
