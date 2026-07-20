import { createHash } from "node:crypto";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createComplianceConsoleApi } from "../src/compliance/console-server.ts";
import { generateAgentKeypair, signedHeaders } from "../src/core/identity.ts";
import { PostgresCompliance } from "../src/db/compliance.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { runMigrations } from "../src/db/migrate.ts";

class EmbeddedPostgres implements TransactionalDatabase {
  constructor(readonly pg: PGliteInterface) {}
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string, values: readonly unknown[] = [],
  ): Promise<QueryRows<T>> {
    const result = await this.pg.query<T>(text, [...values]);
    return { rows: result.rows, affectedRows: result.affectedRows };
  }
  async executeScript(text: string) { await this.pg.exec(text); }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (transaction: Transaction) => work({
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(
        text: string, values: readonly unknown[] = [],
      ) => {
        const result = await transaction.query<R>(text, [...values]);
        return { rows: result.rows, affectedRows: result.affectedRows };
      },
      executeScript: async (text: string) => { await transaction.exec(text); },
    }));
  }
  async close() { await this.pg.close(); }
}

describe("compliance operator console", () => {
  let db: EmbeddedPostgres;
  let compliance: PostgresCompliance;
  let ledger: PostgresLedger;
  let app: ReturnType<typeof createComplianceConsoleApi>;
  const analystKeys = generateAgentKeypair();
  const supervisorKeys = generateAgentKeypair();
  const secondSupervisorKeys = generateAgentKeypair();
  const analystId = "cop_analyst0001";
  const supervisorId = "cop_supervisor01";
  const secondSupervisorId = "cop_supervisor02";
  const userId = "usr_consoleowner01";

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    compliance = new PostgresCompliance(db);
    ledger = new PostgresLedger(db);
    await ledger.registerAccount({ id: userId, kind: "user", name: "Console subject" });
    await compliance.beginVerification({
      userId, subjectType: "individual", countryCode: "US",
      expectedSingleMicros: 2_000_000n, expectedMonthlyMicros: 20_000_000n,
    });
    const observedAt = new Date(Date.now() - 1_000);
    const expiresAt = new Date(Date.now() + 30 * 86_400_000);
    await compliance.recordEvidence({
      subjectAccountId: userId, kind: "identity", provider: "fixture",
      providerResultRef: "console-identity", decision: "clear",
      evidenceHash: createHash("sha256").update("console-identity").digest(),
      observedAt, expiresAt,
    });
    await compliance.recordEvidence({
      subjectAccountId: userId, kind: "sanctions", provider: "fixture",
      providerResultRef: "console-sanctions", decision: "clear",
      evidenceHash: createHash("sha256").update("console-sanctions").digest(),
      observedAt, expiresAt,
    });
    for (const operator of [
      { id: analystId, name: "Avery Analyst", handle: "avery", role: "analyst" as const, keys: analystKeys },
      { id: supervisorId, name: "Sam Supervisor", handle: "sam", role: "supervisor" as const, keys: supervisorKeys },
      { id: secondSupervisorId, name: "Riley Supervisor", handle: "riley", role: "supervisor" as const, keys: secondSupervisorKeys },
    ]) {
      await compliance.registerOperator({
        id: operator.id, name: operator.name, handle: operator.handle,
        publicKey: operator.keys.publicKey, role: operator.role,
        reviewReference: "HR-ACCESS-001", reason: "approved reviewer access",
      });
    }
    app = createComplianceConsoleApi(db, compliance);
  }, 30_000);

  afterEach(async () => { await db.close(); });

  async function login(id: string, privateKey: string) {
    const path = "/operators/sessions";
    const body = "{}";
    const headers = {
      "content-type": "application/json",
      ...signedHeaders(id, privateKey, { method: "POST", path, body }, "x-operator-id"),
    };
    const response = await app.request(path, { method: "POST", headers, body });
    expect(response.status).toBe(201);
    const result = await response.json() as { token: string; consolePath: string; expiresAt: number };
    expect(result.consolePath).toContain("/console#token=");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    const replay = await app.request(path, { method: "POST", headers, body });
    expect(replay.status).toBe(401);
    return result.token;
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (path: string, token: string, body: unknown) => app.request(path, {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("authenticates named operators and executes subject approval through two-person control", async () => {
    const analystToken = await login(analystId, analystKeys.privateKey);
    const supervisorToken = await login(supervisorId, supervisorKeys.privateKey);
    expect((await app.request("/console/state")).status).toBe(401);
    const consolePage = await app.request("/console");
    expect(consolePage.status).toBe(200);
    expect(consolePage.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await consolePage.text()).toContain("two-person control");

    const initial = await app.request("/console/state", { headers: auth(analystToken) });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual(expect.objectContaining({
      operator: expect.objectContaining({ id: analystId, role: "analyst" }),
      subjects: [expect.objectContaining({ accountId: userId, state: "pending" })],
    }));

    expect((await post("/console/actions", analystToken, {
      actionType: "subject_approval",
      targetId: userId,
      payload: {
        riskTier: "standard",
        nextReviewAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
        fullName: "must not enter the database",
      },
      idempotencyKey: "subject-pii-00001",
      reviewReference: "CASE-KYC-PII",
      reason: "malformed client payload",
    })).status).toBe(400);

    const maker = await post("/console/actions", analystToken, {
      actionType: "subject_approval",
      targetId: userId,
      payload: {
        riskTier: "standard",
        nextReviewAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      },
      idempotencyKey: "subject-approval-0001",
      reviewReference: "CASE-KYC-001",
      reason: "identity and sanctions evidence independently reviewed",
    });
    expect(maker.status).toBe(201);
    const request = (await maker.json() as { request: { id: string } }).request;
    expect((await post(`/console/actions/${request.id}/approve`, analystToken, {
      reviewReference: "CHECK-KYC-001", reason: "attempted self approval",
    })).status).toBe(403);

    const executed = await post(`/console/actions/${request.id}/approve`, supervisorToken, {
      reviewReference: "CHECK-KYC-002",
      reason: "second reviewer confirmed current clear evidence",
    });
    expect(executed.status).toBe(200);
    expect(await executed.json()).toEqual({
      request: expect.objectContaining({
        id: request.id, state: "executed", requestedBy: analystId, approvedBy: supervisorId,
      }),
    });
    expect(await compliance.state(userId)).toEqual(expect.objectContaining({
      state: "approved", riskTier: "standard",
    }));
    expect((await post(`/console/actions/${request.id}/approve`, supervisorToken, {
      reviewReference: "CHECK-KYC-002", reason: "second reviewer confirmed current clear evidence",
    })).status).toBe(200);
    await expect(db.query("update money.compliance_operator_events set reason = 'tampered'"))
      .rejects.toThrow(/append-only/);
    await compliance.setOperatorStatus({
      operatorId: analystId, status: "suspended",
      reviewReference: "HR-SUSPEND-001", reason: "review access suspended",
    });
    expect((await app.request("/console/state", { headers: auth(analystToken) })).status).toBe(401);
  });

  it("supports urgent restriction, case work, and checker-gated release", async () => {
    await compliance.approveSubject({
      subjectAccountId: userId, riskTier: "standard",
      nextReviewAt: new Date(Date.now() + 365 * 86_400_000),
      reviewReference: "BOOTSTRAP-APPROVAL", reason: "fixture approval",
    });
    const opened = await compliance.openCase({
      subjectAccountId: userId, kind: "fraud", severity: "critical",
      alertCode: "fraud.account_takeover", summary: "High-confidence account takeover signal",
      reviewReference: "ALERT-001", reason: "automated signal escalated",
    });
    const analystToken = await login(analystId, analystKeys.privateKey);
    const supervisorToken = await login(supervisorId, supervisorKeys.privateKey);

    const claimed = await post(`/console/cases/${opened.id}/claim`, analystToken, {
      idempotencyKey: "claim-fraud-0001", reviewReference: "CASE-FRAUD-001",
      reason: "taking ownership of investigation",
    });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toEqual({ case: expect.objectContaining({ assignedTo: analystId, status: "in_review" }) });
    expect((await post(`/console/cases/${opened.id}/notes`, analystToken, {
      idempotencyKey: "note-fraud-00001", reviewReference: "CASE-FRAUD-001",
      reason: "provider evidence hash reconciled; no raw identity data copied",
      evidenceHash: createHash("sha256").update("case-evidence").digest("hex"),
    })).status).toBe(200);
    const restricted = await post(`/console/cases/${opened.id}/restrict`, analystToken, {
      subjectAccountId: userId, reasonCode: "account_takeover",
      idempotencyKey: "restrict-fraud-01", reviewReference: "CASE-FRAUD-001",
      reason: "stop movement while account takeover is investigated",
    });
    expect(restricted.status).toBe(200);
    expect(await compliance.state(userId)).toEqual(expect.objectContaining({ state: "restricted" }));
    expect((await db.query<{ status: string }>("select status from money.accounts where id = $1", [userId])).rows[0]?.status).toBe("frozen");

    const releaseRequest = await post("/console/actions", analystToken, {
      actionType: "restriction_release", targetId: userId, payload: {},
      idempotencyKey: "release-fraud-001", reviewReference: "CASE-FRAUD-001",
      reason: "request release after disposition",
    });
    const releaseId = (await releaseRequest.json() as { request: { id: string } }).request.id;
    expect((await post(`/console/actions/${releaseId}/approve`, supervisorToken, {
      reviewReference: "CHECK-FRAUD-001", reason: "premature release check",
    })).status).toBe(403);

    const resolutionRequest = await post("/console/actions", analystToken, {
      actionType: "case_resolution", targetId: opened.id,
      payload: { status: "closed_no_action" },
      idempotencyKey: "resolve-fraud-001", reviewReference: "CASE-FRAUD-001",
      reason: "account owner re-secured access and investigation found no loss",
    });
    const resolutionId = (await resolutionRequest.json() as { request: { id: string } }).request.id;
    expect((await post(`/console/actions/${resolutionId}/approve`, supervisorToken, {
      reviewReference: "CHECK-FRAUD-002", reason: "second reviewer confirmed disposition evidence",
    })).status).toBe(200);
    expect((await post(`/console/actions/${releaseId}/approve`, supervisorToken, {
      reviewReference: "CHECK-FRAUD-003", reason: "case is closed and evidence remains current",
    })).status).toBe(200);
    expect(await compliance.state(userId)).toEqual(expect.objectContaining({ state: "approved" }));
    expect((await db.query<{ status: string }>("select status from money.accounts where id = $1", [userId])).rows[0]?.status).toBe("active");

    const actions = await app.request(`/console/cases/${opened.id}/actions`, { headers: auth(analystToken) });
    expect(actions.status).toBe(200);
    expect((await actions.json() as { actions: Array<{ action: string }> }).actions.map((item) => item.action))
      .toEqual(expect.arrayContaining(["claimed", "note", "restricted", "closed_no_action"]));
    expect((await app.request("/operators/sessions/current", {
      method: "DELETE", headers: auth(analystToken),
    })).status).toBe(200);
    expect((await app.request("/console/state", { headers: auth(analystToken) })).status).toBe(401);
  });

  it("prevents a supervisor maker from checking their own terminal decision", async () => {
    const first = await login(supervisorId, supervisorKeys.privateKey);
    const second = await login(secondSupervisorId, secondSupervisorKeys.privateKey);
    const opened = await compliance.openCase({
      subjectAccountId: userId, kind: "other", severity: "low",
      alertCode: "manual.review", summary: "Manual disposition test",
      reviewReference: "CASE-SELF-001", reason: "test case",
    });
    const made = await post("/console/actions", first, {
      actionType: "case_resolution", targetId: opened.id,
      payload: { status: "closed_no_action" },
      idempotencyKey: "self-check-00001", reviewReference: "CASE-SELF-001",
      reason: "maker recommendation",
    });
    const requestId = (await made.json() as { request: { id: string } }).request.id;
    expect((await post(`/console/actions/${requestId}/approve`, first, {
      reviewReference: "CHECK-SELF-001", reason: "same person",
    })).status).toBe(403);
    expect((await post(`/console/actions/${requestId}/approve`, second, {
      reviewReference: "CHECK-SELF-002", reason: "different supervisor",
    })).status).toBe(200);

    const limits = await post("/console/actions", first, {
      actionType: "risk_limit_change", targetId: "high",
      payload: {
        perTransferMicros: "750000000",
        dailyCrossUserMicros: "1500000000",
        dailyExternalMicros: "1000000000",
        dailyPayoutMicros: "1000000000",
        rolling30dOutflowMicros: "5000000000",
      },
      idempotencyKey: "risk-limit-00001", reviewReference: "RISK-COMMITTEE-001",
      reason: "approved launch limit recommendation",
    });
    expect(limits.status).toBe(201);
    const limitsId = (await limits.json() as { request: { id: string } }).request.id;
    expect((await post(`/console/actions/${limitsId}/approve`, first, {
      reviewReference: "RISK-CHECK-001", reason: "self check must fail",
    })).status).toBe(403);
    const approvedLimits = await post(`/console/actions/${limitsId}/approve`, second, {
      reviewReference: "RISK-CHECK-002", reason: "second supervisor confirmed committee approval",
    });
    const approvedLimitsBody = await approvedLimits.json();
    expect({ status: approvedLimits.status, body: approvedLimitsBody }).toEqual({
      status: 200,
      body: { request: expect.objectContaining({ id: limitsId, state: "executed" }) },
    });
    expect((await db.query<{ per_transfer_micros: string | number }>(
      "select per_transfer_micros from money.risk_limits where risk_tier = 'high'",
    )).rows[0]?.per_transfer_micros).toBe(750000000);
  });
});
