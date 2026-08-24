import { randomUUID } from "node:crypto";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { PostgresMetrics } from "../src/db/metrics.ts";
import { runMigrations } from "../src/db/migrate.ts";
import {
  createPublicMetricsApi,
  metricsSandboxLabelFromEnv,
  parseReceiptId,
} from "../src/server/metrics.ts";
import { approveComplianceFixture } from "./helpers/compliance-fixture.ts";

class EmbeddedPostgres implements TransactionalDatabase {
  constructor(readonly pg: PGliteInterface) {}
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryRows<T>> {
    const result = await this.pg.query<T>(text, [...values]);
    return { rows: result.rows, affectedRows: result.affectedRows };
  }
  async executeScript(text: string) { await this.pg.exec(text); }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (transaction: Transaction) => work({
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = []
      ) => {
        const result = await transaction.query<R>(text, [...values]);
        return { rows: result.rows, affectedRows: result.affectedRows };
      },
      executeScript: async (text: string) => { await transaction.exec(text); },
    }));
  }
  async close() { await this.pg.close(); }
}

const MEMO = "api metrics memo stays private";

describe("public metrics API", () => {
  let db: EmbeddedPostgres;
  let ledger: PostgresLedger;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    ledger = new PostgresLedger(db);
  }, 30_000);

  afterEach(async () => {
    await db.close();
  });

  async function seed() {
    const owner = await ledger.registerAccount({
      id: "usr_apimetric", kind: "user", name: "Api Owner", handle: "api-owner",
    });
    const agent = await ledger.registerAccount({
      id: "agt_apimetric", kind: "agent", name: "Api Agent", ownerId: owner.id, handle: "api-agent",
    });
    const peer = await ledger.registerAccount({
      id: "agt_apipeer1", kind: "agent", name: "Api Peer", ownerId: owner.id, handle: "api-peer",
    });
    await approveComplianceFixture(db, owner.id);
    await ledger.postTransfer({
      actorId: owner.id, operation: "fund", idempotencyKey: "api-fund",
      from: "external:funding", to: owner.id, amountMicros: 2_000_000n,
    });
    await ledger.postTransfer({
      actorId: owner.id, operation: "allocate", idempotencyKey: "api-allocate",
      from: owner.id, to: agent.id, amountMicros: 1_000_000n,
    });
    const paid = await ledger.postTransfer({
      actorId: agent.id, operation: "pay", idempotencyKey: "api-pay",
      from: agent.id, to: peer.id, amountMicros: 125_000n, memo: MEMO,
    });
    if (paid.status !== "posted") throw new Error("seed payment failed");
    return { owner, agent, peer, receiptId: paid.receiptId };
  }

  function app(sandbox = true) {
    return createPublicMetricsApi(db, new PostgresMetrics(db), sandbox, 0);
  }

  it("parses receipt ids strictly and reads the sandbox label from the environment", () => {
    const id = randomUUID();
    expect(parseReceiptId(id)).toBe(id);
    expect(parseReceiptId(id.toUpperCase())).toBe(id);
    for (const invalid of [
      undefined, "", "not-a-uuid", "123", `${randomUUID()}x`,
      "00000000-0000-0000-0000-00000000000g", "../../etc/passwd",
    ]) {
      expect(parseReceiptId(invalid)).toBeUndefined();
    }
    expect(metricsSandboxLabelFromEnv({})).toBe(true);
    expect(metricsSandboxLabelFromEnv({ MONEY_METRICS_SANDBOX_LABEL: "true" })).toBe(true);
    expect(metricsSandboxLabelFromEnv({ MONEY_METRICS_SANDBOX_LABEL: "FALSE" })).toBe(false);
  });

  it("serves the self-contained page on / and /metrics with the sandbox banner", async () => {
    await seed();
    const api = app(true);
    for (const path of ["/", "/metrics"]) {
      const response = await api.request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toBe("public, max-age=60");
      expect(response.headers.get("set-cookie")).toBeNull();
      const html = await response.text();
      expect(html).toContain("Sandbox, no real funds.");
      expect(html).toContain("nothing here is a bank, card, or deposit account");
      expect(html).toContain("tabular-nums");
      expect(html).toContain("prefers-color-scheme: dark");
      expect(html).toContain("Cumulative chain root");
      expect(html).toContain("Retention cohorts");
      expect(html).toMatch(/[0-9a-f]{64}/);
      expect(html).toContain("curl -s https://");
      expect(html).not.toContain("https://fonts");
      expect(html).not.toMatch(/<(script|link)[^>]*(src|href)="http/);
    }
    const unlabeled = await app(false).request("/");
    expect(await unlabeled.text()).not.toContain("Sandbox, no real funds.");
  });

  it("renders honest zeroes gracefully before any traffic exists", async () => {
    const response = await app().request("/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("No transfers yet");
    expect(html).toContain("$0.00");
    const json = await (await app().request("/metrics.json")).json() as Record<string, unknown>;
    expect(json).toEqual(expect.objectContaining({
      sandbox: true,
      distinctFundedAgents: 0,
      distinctPaidProviders: 0,
      weekly: [],
    }));
  });

  it("publishes cacheable aggregate JSON without any account-level strings", async () => {
    const seeded = await seed();
    const response = await app().request("/metrics.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await response.text();
    for (const forbidden of [
      seeded.owner.id, seeded.agent.id, seeded.peer.id,
      "api-owner", "api-agent", "api-peer", MEMO,
    ]) {
      expect(body).not.toContain(forbidden);
    }
    const document = JSON.parse(body) as {
      sandbox: boolean;
      distinctFundedAgents: number;
      operationClasses: Array<{ operationClass: string; transfers: number; volumeMicros: string }>;
      weekly: Array<{ transfers: number; chainRoot: string }>;
    };
    expect(document.sandbox).toBe(true);
    expect(document.distinctFundedAgents).toBe(1);
    expect(document.operationClasses.find((row) => row.operationClass === "internal"))
      .toEqual({ operationClass: "internal", transfers: 2, volumeMicros: "1125000" });
    expect(document.weekly).toHaveLength(1);
    expect(document.weekly[0]?.transfers).toBe(3);
    // The page itself must be equally clean.
    const html = await (await app().request("/")).text();
    for (const forbidden of [seeded.owner.id, seeded.agent.id, "api-agent", MEMO]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("verifies receipts by exact uuid and 404s unknown or malformed ids", async () => {
    const seeded = await seed();
    const found = await app().request(`/receipts/${seeded.receiptId}/verify`);
    expect(found.status).toBe(200);
    expect(found.headers.get("cache-control")).toBe("public, max-age=60");
    const body = await found.json() as Record<string, unknown>;
    expect(body).toEqual({
      exists: true,
      transferSeq: expect.stringMatching(/^\d+$/),
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      operationClass: "internal",
      weekBucket: expect.stringMatching(/^\d{4}-W\d{2}$/),
    });
    expect((await app().request(`/receipts/${randomUUID()}/verify`)).status).toBe(404);
    expect((await app().request("/receipts/not-a-uuid/verify")).status).toBe(404);
    expect((await app().request(`/receipts/${seeded.receiptId}x/verify`)).status).toBe(404);
  });

  it("answers 405 to every non-GET/HEAD and 404 to unknown paths, and stays alive", async () => {
    await seed();
    const api = app();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const path of ["/", "/metrics", "/metrics.json", "/receipts/x/verify", "/health/live"]) {
        const response = await api.request(path, { method, body: method === "POST" ? "{}" : undefined });
        expect(response.status, `${method} ${path}`).toBe(405);
        expect(response.headers.get("allow")).toBe("GET, HEAD");
      }
    }
    // HEAD is a safe method uptime monitors and cache validators rely on: it
    // must succeed everywhere GET does, with an empty body.
    for (const path of ["/", "/metrics", "/metrics.json", "/health/live"]) {
      const head = await api.request(path, { method: "HEAD" });
      expect(head.status, `HEAD ${path}`).toBe(200);
      expect(await head.text()).toBe("");
    }
    expect((await api.request("/unknown")).status).toBe(404);
    expect((await api.request("/receipts")).status).toBe(404);
    expect((await api.request("/receipts/abc")).status).toBe(404);
    const live = await api.request("/health/live");
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ ok: true });
  });

  const EMPTY_DOCUMENT = {
    generatedAt: "2026-08-23T00:00:00Z",
    distinctFundedAgents: 0,
    distinctPaidProviders: 0,
    operationClasses: [],
    fundingLineage: {
      devFundingMicros: "0", externalFundingMicros: "0", spendMicros: "0",
      devAttributedSpendMicros: "0", externalAttributedSpendMicros: "0",
    },
    weekly: [],
    cohorts: [],
  };

  it("shares a single in-flight aggregate refresh across concurrent requests", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stub = {
      publicMetrics: async () => { calls += 1; await gate; return EMPTY_DOCUMENT; },
      verifyReceipt: async () => ({ exists: false }),
    } as unknown as PostgresMetrics;
    const api = createPublicMetricsApi(db, stub, true, 0);
    const pending = Promise.all([
      api.request("/metrics.json"),
      api.request("/"),
      api.request("/metrics.json"),
    ]);
    // Let all three requests reach the loader (each is pure in-memory work up
    // to that point) while the single refresh is still in flight, then let it
    // finish.
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();
    const responses = await pending;
    for (const response of responses) expect(response.status).toBe(200);
    // Three concurrent public requests, one database refresh: the deliberate
    // no-auth surface must never multiply load onto the shared database.
    expect(calls).toBe(1);
  });

  it("negatively caches a failed refresh instead of re-querying per request", async () => {
    let calls = 0;
    const stub = {
      publicMetrics: async () => { calls += 1; throw new Error("statement timeout"); },
      verifyReceipt: async () => ({ exists: false }),
    } as unknown as PostgresMetrics;
    const api = createPublicMetricsApi(db, stub, true, 60_000);
    expect((await api.request("/metrics.json")).status).toBe(500);
    expect((await api.request("/metrics.json")).status).toBe(500);
    expect((await api.request("/")).status).toBe(500);
    expect(calls).toBe(1);
  });
});
