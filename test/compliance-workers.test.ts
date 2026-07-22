import { createHash, createHmac } from "node:crypto";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runComplianceEventBatch } from "../src/compliance/event-worker.ts";
import { createComplianceOpsApi } from "../src/compliance/ops-server.ts";
import {
  ComplianceProviderClient,
  GenericComplianceWebhookCodec,
} from "../src/compliance/provider.ts";
import { createComplianceWebhookApp } from "../src/compliance/webhook-server.ts";
import { PostgresCompliance } from "../src/db/compliance.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { runMigrations } from "../src/db/migrate.ts";

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

const SECRET = "fixture-webhook-secret";
const ENDPOINT = "webh_fixture_01";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");

describe("compliance provider boundary and workers", () => {
  it("rejects ambiguous privileged provider configuration", () => {
    expect(() => new ComplianceProviderClient({
      provider: "fixture",
      apiKey: "provider-secret",
      baseUrl: "https://compliance.example/v1",
    })).toThrow(/bare origin/);
    expect(() => new ComplianceProviderClient({
      provider: "fixture",
      apiKey: " provider-secret ",
      baseUrl: "https://compliance.example",
    })).toThrow(/API key/);
  });

  let db: EmbeddedPostgres;
  let compliance: PostgresCompliance;
  let ledger: PostgresLedger;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    compliance = new PostgresCompliance(db);
    ledger = new PostgresLedger(db);
  }, 30_000);

  afterEach(async () => { await db.close(); });

  async function pendingSubject(id: string) {
    await ledger.registerAccount({ id, kind: "user", name: "Worker subject" });
    return compliance.beginVerification({
      userId: id,
      subjectType: "individual",
      countryCode: "US",
      expectedSingleMicros: 1_000_000n,
      expectedMonthlyMicros: 10_000_000n,
    });
  }

  it("authenticates exact webhook bytes and stores only a retry-safe result reference", async () => {
    const app = createComplianceWebhookApp(compliance, {
      codec: new GenericComplianceWebhookCodec({
        provider: "fixture",
        secret: SECRET,
        endpointId: ENDPOINT,
      }),
      maxBodyBytes: 1_024,
    });
    const body = JSON.stringify({ id: "event-001", resultRef: "result-001" });
    const send = (signature: string, endpointId = ENDPOINT) => app.request("/webhooks/compliance", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-compliance-signature": signature,
        "x-compliance-endpoint-id": endpointId,
      },
      body,
    });

    expect((await send(sign(`${body} `))).status).toBe(401);
    expect((await send(sign(body), "wrong-endpoint")).status).toBe(401);
    const accepted = await send(sign(body));
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ accepted: true, replayed: false });
    expect(await (await send(sign(body))).json()).toEqual({ accepted: true, replayed: true });

    const rows = await db.query<{
      provider_event_id: string;
      provider_result_ref: string;
      delivery_bytes: number;
      state: string;
    }>(`
      select provider_event_id, provider_result_ref,
        octet_length(delivery_hash)::integer as delivery_bytes, state
      from money.compliance_event_inbox
    `);
    expect(rows.rows).toEqual([{
      provider_event_id: "event-001",
      provider_result_ref: "result-001",
      delivery_bytes: 32,
      state: "queued",
    }]);

    const oversized = "x".repeat(1_025);
    const tooLarge = await app.request("/webhooks/compliance", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(oversized.length),
        "x-compliance-signature": sign(oversized),
        "x-compliance-endpoint-id": ENDPOINT,
      },
      body: oversized,
    });
    expect(tooLarge.status).toBe(413);
  });

  it("refetches authenticated provider results and records evidence outside ingress", async () => {
    const userId = "usr_worker0001";
    await pendingSubject(userId);
    await compliance.enqueueEvent({
      provider: "fixture", providerEventId: "event-identity",
      providerResultRef: "result-identity", endpointId: ENDPOINT,
      deliveryHash: Buffer.from(sha256("event-identity"), "hex"),
    });
    await compliance.enqueueEvent({
      provider: "fixture", providerEventId: "event-sanctions",
      providerResultRef: "result-sanctions", endpointId: ENDPOINT,
      deliveryHash: Buffer.from(sha256("event-sanctions"), "hex"),
    });
    const now = new Date(Date.now() - 1_000);
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-secret");
      expect(init?.redirect).toBe("error");
      const resultId = decodeURIComponent(new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      ).pathname.split("/").at(-1)!);
      const sanctions = resultId === "result-sanctions";
      return new Response(JSON.stringify({
        id: resultId,
        subjectAccountId: userId,
        kind: sanctions ? "sanctions" : "identity",
        decision: "clear",
        evidenceHash: sha256(resultId),
        listVersion: sanctions ? "ofac-fixture-v1" : "identity-fixture-v1",
        observedAt: now.toISOString(),
        expiresAt: expires.toISOString(),
        normalized: sanctions ? { matches: 0 } : { verified: true },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const provider = new ComplianceProviderClient({
      provider: "fixture",
      apiKey: "provider-secret",
      baseUrl: "https://compliance.example",
      fetch: fetcher,
    });

    expect(await runComplianceEventBatch(compliance, provider, "worker-a", 10)).toEqual({
      claimed: 2, completed: 2, failed: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await compliance.state(userId))).toEqual(expect.objectContaining({
      state: "pending", screeningState: "clear",
      identityExpiresAt: expect.any(Date), screeningExpiresAt: expect.any(Date),
    }));
    expect((await db.query<{ state: string; evidence_id: string | null }>(
      "select state, evidence_id from money.compliance_event_inbox order by id"
    )).rows).toEqual([
      { state: "completed", evidence_id: expect.any(String) },
      { state: "completed", evidence_id: expect.any(String) },
    ]);
    expect((await db.query<{ count: number }>(
      "select count(*)::integer as count from money.compliance_evidence"
    )).rows[0]?.count).toBe(2);
  });

  it("dead-letters provider responses that try to persist raw identity fields", async () => {
    const userId = "usr_worker0002";
    await pendingSubject(userId);
    await compliance.enqueueEvent({
      provider: "fixture", providerEventId: "event-pii",
      providerResultRef: "result-pii", endpointId: ENDPOINT,
      deliveryHash: Buffer.from(sha256("event-pii"), "hex"),
    });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      id: "result-pii",
      subjectAccountId: userId,
      kind: "identity",
      decision: "clear",
      evidenceHash: sha256("result-pii"),
      observedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      normalized: { fullName: "must never be stored" },
    }), { status: 200 })) as unknown as typeof fetch;
    const provider = new ComplianceProviderClient({
      provider: "fixture", apiKey: "provider-secret",
      baseUrl: "https://compliance.example", fetch: fetcher,
    });

    expect(await runComplianceEventBatch(compliance, provider, "worker-pii", 1)).toEqual({
      claimed: 1, completed: 0, failed: 1,
    });
    expect((await db.query<{ state: string; last_error: string; evidence_id: string | null }>(
      "select state, last_error, evidence_id from money.compliance_event_inbox"
    )).rows[0]).toEqual(expect.objectContaining({
      state: "dead", evidence_id: null,
      last_error: expect.stringContaining("raw identity field"),
    }));
    await expect(compliance.recordEvidence({
      subjectAccountId: userId,
      kind: "identity",
      provider: "fixture",
      providerResultRef: "direct-pii-attempt",
      decision: "clear",
      evidenceHash: Buffer.from(sha256("direct-pii-attempt"), "hex"),
      observedAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 86_400_000),
      normalized: { nested: { fullName: "must never be stored" } },
    })).rejects.toThrow(/invalid compliance evidence/);
    expect((await db.query<{ count: number }>(
      "select count(*)::integer as count from money.compliance_evidence"
    )).rows[0]?.count).toBe(0);
    expect(await ledger.postTransfer({
      actorId: userId,
      operation: "fund",
      idempotencyKey: "ops-non-allow-decision",
      from: "external:funding",
      to: userId,
      amountMicros: 1n,
    })).toEqual(expect.objectContaining({ status: "denied", code: "compliance_required" }));
    const ops = createComplianceOpsApi(db, "compliance-ops", compliance);
    expect((await ops.request("/health/ready")).status).toBe(200);
    expect((await ops.request("/ops/compliance")).status).toBe(404);
    const health = await ops.request("/ops/compliance", {
      headers: { authorization: "Bearer compliance-ops" },
    });
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual(expect.objectContaining({
      ok: false,
      deadEvents: 1,
      openCases: 0,
      openRestrictions: 0,
      deniedLastHour: 1,
      pendingVerifications: 0,
      failedVerifications: 0,
      pendingCheckerActions: 0,
      activeOperators: 0,
      recentNonAllowDecisions: [expect.objectContaining({ amountMicros: "1" })],
    }));
  });

  it("rolls back the whole provider evidence set when any item is invalid", async () => {
    const userId = "usr_workeratomic01";
    await pendingSubject(userId);
    await compliance.enqueueEvent({
      provider: "fixture",
      providerEventId: "event-atomic",
      providerResultRef: "result-atomic",
      endpointId: ENDPOINT,
      deliveryHash: Buffer.from(sha256("event-atomic"), "hex"),
    });
    const claim = (await compliance.claimEvents("worker-atomic", 1))[0]!;
    const observedAt = new Date(Date.now() - 1_000);
    const expiresAt = new Date(Date.now() + 86_400_000);

    await expect(compliance.recordEventEvidenceSet({
      workerId: "worker-atomic",
      inboxId: claim.inboxId,
      items: [
        {
          subjectAccountId: userId,
          kind: "identity",
          providerResultRef: "result-atomic",
          decision: "clear",
          evidenceHash: Buffer.from(sha256("result-atomic"), "hex"),
          observedAt,
          expiresAt,
          normalized: { verified: true },
        },
        {
          subjectAccountId: userId,
          kind: "sanctions",
          providerResultRef: "result-atomic:sanctions",
          decision: "clear",
          evidenceHash: Buffer.from(sha256("result-atomic:sanctions"), "hex"),
          observedAt,
          expiresAt,
          normalized: { fullName: "must roll back the first item" },
        },
      ],
    })).rejects.toThrow(/invalid compliance evidence/);

    expect((await db.query<{ evidence_count: number; link_count: number }>(`
      select
        (select count(*)::integer from money.compliance_evidence) as evidence_count,
        (select count(*)::integer from money.compliance_event_evidence) as link_count
    `)).rows).toEqual([{ evidence_count: 0, link_count: 0 }]);
    expect((await db.query<{ state: string; evidence_id: string | null }>(
      "select state, evidence_id from money.compliance_event_inbox",
    )).rows).toEqual([{ state: "processing", evidence_id: null }]);
  });

  it("requires an exact evidence-set replay, including the provider list version", async () => {
    const userId = "usr_workerreplay01";
    await pendingSubject(userId);
    await compliance.enqueueEvent({
      provider: "fixture",
      providerEventId: "event-replay",
      providerResultRef: "result-replay",
      endpointId: ENDPOINT,
      deliveryHash: Buffer.from(sha256("event-replay"), "hex"),
    });
    const claim = (await compliance.claimEvents("worker-replay", 1))[0]!;
    const item = {
      subjectAccountId: userId,
      providerSubjectRef: "provider-subject-replay-01",
      kind: "sanctions" as const,
      providerResultRef: "result-replay",
      decision: "clear" as const,
      evidenceHash: Buffer.from(sha256("result-replay"), "hex"),
      listVersion: "watchlist-v1",
      observedAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 86_400_000),
      normalized: { matches: 0 },
    };

    const recorded = await compliance.recordEventEvidenceSet({
      workerId: "worker-replay", inboxId: claim.inboxId, items: [item],
    });
    expect(recorded.replayed).toBe(false);
    await expect(compliance.recordEventEvidenceSet({
      workerId: "worker-replay", inboxId: claim.inboxId, items: [item],
    })).resolves.toEqual(expect.objectContaining({
      primaryEvidenceId: recorded.primaryEvidenceId,
      evidenceIds: [recorded.primaryEvidenceId],
      replayed: true,
    }));
    await expect(compliance.recordEventEvidenceSet({
      workerId: "worker-replay",
      inboxId: claim.inboxId,
      items: [{ ...item, listVersion: "watchlist-v2" }],
    })).rejects.toThrow(/reused with different evidence/);
    await expect(compliance.recordEventEvidenceSet({
      workerId: "worker-replay",
      inboxId: claim.inboxId,
      items: [{ ...item, providerSubjectRef: "provider-subject-replay-02" }],
    })).rejects.toThrow(/provider subject/);
    await expect(compliance.recordEventEvidenceSet({
      workerId: "worker-replay",
      inboxId: claim.inboxId,
      items: [
        item,
        {
          ...item,
          kind: "pep",
          providerResultRef: "result-replay:extra",
          evidenceHash: Buffer.from(sha256("result-replay:extra"), "hex"),
        },
      ],
    })).rejects.toThrow(/evidence set changed on replay/);

    expect((await db.query<{ list_version: string; evidence_count: number; link_count: number }>(`
      select evidence.list_version,
        (select count(*)::integer from money.compliance_evidence) as evidence_count,
        (select count(*)::integer from money.compliance_event_evidence) as link_count
      from money.compliance_evidence evidence
    `)).rows).toEqual([{
      list_version: "watchlist-v1", evidence_count: 1, link_count: 1,
    }]);
  });

  it("rejects oversized or identity-mismatched provider responses", async () => {
    const oversizedProvider = new ComplianceProviderClient({
      provider: "fixture", apiKey: "provider-secret",
      baseUrl: "https://compliance.example",
      fetch: (async () => new Response("x".repeat(256 * 1_024 + 1), {
        status: 200,
        headers: { "content-length": String(256 * 1_024 + 1) },
      })) as typeof fetch,
    });
    await expect(oversizedProvider.getResult("result-large")).rejects.toThrow(/too large/);

    const mismatchedProvider = new ComplianceProviderClient({
      provider: "fixture", apiKey: "provider-secret",
      baseUrl: "https://compliance.example",
      fetch: (async () => new Response(JSON.stringify({ id: "different-result" }), {
        status: 200,
      })) as typeof fetch,
    });
    await expect(mismatchedProvider.getResult("result-expected")).rejects.toThrow(/different result id/);
  });
});
