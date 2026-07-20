import { createHash } from "node:crypto";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runComplianceOnboardingBatch } from "../src/compliance/onboarding-worker.ts";
import { ComplianceProviderClient } from "../src/compliance/provider.ts";
import { createComplianceSessionKeyring } from "../src/compliance/session-cipher.ts";
import { generateAgentKeypair, signedHeaders } from "../src/core/identity.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createPostgresApi } from "../src/server/postgres-api.ts";

class EmbeddedPostgres implements TransactionalDatabase {
  constructor(readonly pg: PGliteInterface) {}
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string, values: readonly unknown[] = []
  ): Promise<QueryRows<T>> {
    const result = await this.pg.query<T>(text, [...values]);
    return { rows: result.rows, affectedRows: result.affectedRows };
  }
  async executeScript(text: string) { await this.pg.exec(text); }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (transaction: Transaction) => work({
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(
        text: string, values: readonly unknown[] = []
      ) => {
        const result = await transaction.query<R>(text, [...values]);
        return { rows: result.rows, affectedRows: result.affectedRows };
      },
      executeScript: async (text: string) => { await transaction.exec(text); },
    }));
  }
  async close() { await this.pg.close(); }
}

describe("signed compliance product API", () => {
  let db: EmbeddedPostgres;
  let api: ReturnType<typeof createPostgresApi>;
  const sessionKeyring = createComplianceSessionKeyring("test-key", {
    "test-key": Buffer.alloc(32, 11),
  });

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    api = createPostgresApi(db, {
      complianceSessionKeyring: sessionKeyring,
      complianceProviderName: "fixture",
    });
  }, 30_000);
  afterEach(async () => { await db.close(); });

  async function request(
    path: string,
    accountId: string,
    privateKey: string,
    method: "GET" | "POST",
    body: unknown = {}
  ) {
    const encoded = method === "POST" ? JSON.stringify(body) : "";
    return api.app.request(path, {
      method,
      headers: {
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        ...signedHeaders(accountId, privateKey, { method, path, body: encoded }, "x-user-id"),
      },
      ...(method === "POST" ? { body: encoded } : {}),
    });
  }

  it("lets only the owner submit a non-PII profile and exposes sanitized status", async () => {
    const keys = generateAgentKeypair();
    const signup = await api.app.request("/users", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Compliance Owner", handle: "compliance-owner", publicKey: keys.publicKey }),
    });
    const owner = await signup.json() as { id: string };

    const initial = await request("/owner/compliance", owner.id, keys.privateKey, "GET");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual(expect.objectContaining({
      accountId: owner.id, state: "unverified", screeningState: "pending",
    }));

    const invalid = await request("/owner/compliance", owner.id, keys.privateKey, "POST", {
      subjectType: "individual", countryCode: "US",
      expectedSingleMicros: 2_000_000, expectedMonthlyMicros: 1_000_000,
    });
    expect(invalid.status).toBe(400);

    const profile = {
      subjectType: "individual", countryCode: "US",
      expectedSingleMicros: 2_000_000, expectedMonthlyMicros: 20_000_000,
    };
    const submitted = await request("/owner/compliance", owner.id, keys.privateKey, "POST", profile);
    expect(submitted.status).toBe(202);
    expect(await submitted.json()).toEqual(expect.objectContaining({
      accountId: owner.id, state: "pending", countryCode: "US",
    }));
    const replay = await request("/owner/compliance", owner.id, keys.privateKey, "POST", profile);
    expect(replay.status).toBe(202);
    expect((await db.query<{ count: number }>(
      "select count(*)::integer as count from money.compliance_subject_events where subject_account_id = $1",
      [owner.id]
    )).rows[0]?.count).toBe(2);

    const observedAt = new Date(Date.now() - 1_000);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    await api.compliance.recordEvidence({
      subjectAccountId: owner.id, kind: "identity", provider: "fixture",
      providerResultRef: "identity-api-owner", decision: "clear",
      evidenceHash: createHash("sha256").update("identity-api-owner").digest(),
      observedAt, expiresAt,
    });
    await api.compliance.recordEvidence({
      subjectAccountId: owner.id, kind: "sanctions", provider: "fixture",
      providerResultRef: "sanctions-api-owner", decision: "clear",
      evidenceHash: createHash("sha256").update("sanctions-api-owner").digest(),
      observedAt, expiresAt,
    });
    await api.compliance.approveSubject({
      subjectAccountId: owner.id, riskTier: "standard",
      nextReviewAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      reviewReference: "CASE-API-001", reason: "provider evidence reviewed",
    });
    const approved = await request("/owner/compliance", owner.id, keys.privateKey, "GET");
    const approvedJson = await approved.json() as Record<string, unknown>;
    expect(approvedJson).toEqual(expect.objectContaining({ state: "approved", screeningState: "clear" }));
    expect(approvedJson).not.toHaveProperty("provider");
    expect(approvedJson).not.toHaveProperty("providerSubjectRef");
    expect(approvedJson).not.toHaveProperty("evidenceHash");
    expect(approvedJson).not.toHaveProperty("reason");
  });

  it("returns a hosted inquiry only to its authenticated owner after the isolated worker is ready", async () => {
    const keys = generateAgentKeypair();
    const signup = await api.app.request("/users", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Inquiry Owner", handle: "inquiry-owner", publicKey: keys.publicKey }),
    });
    const owner = await signup.json() as { id: string };
    expect((await request("/owner/compliance", owner.id, keys.privateKey, "POST", {
      subjectType: "individual", countryCode: "US",
      expectedSingleMicros: 2_000_000, expectedMonthlyMicros: 20_000_000,
    })).status).toBe(202);
    const requested = await request(
      "/owner/compliance/inquiries", owner.id, keys.privateKey, "POST",
      { idempotencyKey: "owner-inquiry-0001" },
    );
    expect(requested.status).toBe(202);
    const requestedJson = await requested.json() as { id: string; state: string; replayed: boolean };
    expect(requestedJson).toEqual(expect.objectContaining({ state: "requested", replayed: false }));

    const hostedUrl = `https://verify.example/start/${requestedJson.id}?token=only-owner`;
    const provider = new ComplianceProviderClient({
      provider: "fixture", apiKey: "provider-key",
      baseUrl: "https://provider.example", hostedOrigins: ["https://verify.example"],
      fetch: (async () => new Response(JSON.stringify({
        id: "inq_product_001", hostedUrl,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }), { status: 201 })) as typeof fetch,
    });
    expect(await runComplianceOnboardingBatch(
      api.compliance, provider, sessionKeyring, "product-test-worker", 1,
    )).toEqual({ claimed: 1, completed: 1, failed: 0, expired: 0 });

    const readyPath = `/owner/compliance/inquiries/${requestedJson.id}`;
    const ready = await request(readyPath, owner.id, keys.privateKey, "GET");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual(expect.objectContaining({
      id: requestedJson.id, state: "ready", hostedUrl,
    }));

    const otherKeys = generateAgentKeypair();
    const otherSignup = await api.app.request("/users", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Other", handle: "inquiry-other", publicKey: otherKeys.publicKey }),
    });
    const other = await otherSignup.json() as { id: string };
    expect((await request(readyPath, other.id, otherKeys.privateKey, "GET")).status).toBe(404);
    expect((await api.app.request(readyPath)).status).toBe(401);
  });
});
