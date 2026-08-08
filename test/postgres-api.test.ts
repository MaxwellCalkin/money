import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAgentKeypair, signRequest, signedHeaders } from "../src/core/identity.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createPostgresApi, parseSignupInvites } from "../src/server/postgres-api.ts";
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

type IdHeader = "x-user-id" | "x-agent-id" | "x-provider-id";

function signedRequest(
  app: ReturnType<typeof createPostgresApi>["app"],
  path: string,
  method: "GET" | "POST" | "DELETE",
  value: unknown,
  accountId: string,
  privateKey: string,
  idHeader: IdHeader
) {
  const body = method === "GET" ? "" : JSON.stringify(value);
  return app.request(path, {
    method,
    headers: {
      ...(method !== "GET" ? { "content-type": "application/json" } : {}),
      ...signedHeaders(accountId, privateKey, { method, path, body }, idHeader),
    },
    ...(method !== "GET" ? { body } : {}),
  });
}

describe("Postgres signed product API", () => {
  let db: EmbeddedPostgres;
  let api: ReturnType<typeof createPostgresApi>;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    api = createPostgresApi(db, { allowDevelopmentFunding: true });
  }, 30_000);

  afterEach(async () => {
    await db.close();
  });

  async function signup(name: string, handle: string) {
    const keys = generateAgentKeypair();
    const response = await api.app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, handle, publicKey: keys.publicKey }),
    });
    expect(response.status).toBe(200);
    const user = await response.json() as { id: string; replayed: boolean };
    await approveComplianceFixture(db, user.id);
    return { user, keys };
  }

  async function createAgent(
    owner: { id: string },
    ownerPrivateKey: string,
    name: string,
    handle: string
  ) {
    const keys = generateAgentKeypair();
    const response = await signedRequest(
      api.app,
      "/agents",
      "POST",
      { name, handle, ownerId: owner.id, publicKey: keys.publicKey },
      owner.id,
      ownerPrivateKey,
      "x-user-id"
    );
    expect(response.status).toBe(200);
    return { agent: await response.json() as { id: string; replayed: boolean }, keys };
  }

  async function fund(userId: string, privateKey: string, amountMicros = 20_000_000) {
    return signedRequest(
      api.app, "/fund", "POST",
      { userId, amountMicros, idempotencyKey: `fund-${userId}` },
      userId, privateKey, "x-user-id"
    );
  }

  async function session(userId: string, privateKey: string) {
    const response = await signedRequest(api.app, "/owner/sessions", "POST", {}, userId, privateKey, "x-user-id");
    expect(response.status).toBe(200);
    return (await response.json() as { token: string }).token;
  }

  it("runs signup, funding, allocation, mandate, escalation, owner approval, replay, and state end to end", async () => {
    const { user, keys: ownerKeys } = await signup("Max", "max");
    const { agent: scout, keys: scoutKeys } = await createAgent(user, ownerKeys.privateKey, "Scout", "scout");
    const { agent: writer } = await createAgent(user, ownerKeys.privateKey, "Writer", "writer");
    expect((await fund(user.id, ownerKeys.privateKey)).status).toBe(200);

    const allocated = await signedRequest(
      api.app, "/allocate", "POST",
      { userId: user.id, agentId: scout.id, amountMicros: 10_000_000, idempotencyKey: "allocate-scout" },
      user.id, ownerKeys.privateKey, "x-user-id"
    );
    expect(allocated.status).toBe(200);
    const mandate = await signedRequest(
      api.app, "/mandates", "POST",
      {
        userId: user.id, agentId: scout.id, budgetMicros: 10_000_000,
        perTxCapMicros: 1_000_000, dailyCapMicros: 10_000_000,
        escalateAboveMicros: 2_000_000, newPayeeCapMicros: 100_000,
        idempotencyKey: "mandate-scout",
      },
      user.id, ownerKeys.privateKey, "x-user-id"
    );
    expect(mandate.status).toBe(200);

    const payBody = { to: "@writer", amountMicros: 3_000_000, memo: "large research job", idempotencyKey: "large-job" };
    const requested = await signedRequest(api.app, "/pay", "POST", payBody, scout.id, scoutKeys.privateKey, "x-agent-id");
    expect(requested.status).toBe(202);
    const pending = await requested.json() as any;
    expect(pending).toEqual(expect.objectContaining({
      status: "approval_required",
      approval: expect.objectContaining({ agentId: scout.id, to: writer.id, amount: 3_000_000, status: "pending" }),
    }));

    const token = await session(user.id, ownerKeys.privateKey);
    const state = await api.app.request("/owner/state", { headers: { authorization: `Bearer ${token}` } });
    expect(state.status).toBe(200);
    // Integrity is honest: null until the ops role has recorded a verdict,
    // then the latest stored verdict — never a hardcoded constant.
    expect(await state.json()).toEqual(expect.objectContaining({
      integrity: null,
      approvals: [expect.objectContaining({ id: pending.approval.id, status: "pending" })],
    }));
    await db.query("select * from money_private.record_ledger_health()");
    const verified = await api.app.request("/owner/state", { headers: { authorization: `Bearer ${token}` } });
    expect(await verified.json()).toEqual(expect.objectContaining({
      integrity: { zeroSum: true, receiptsOk: true, verifiedAt: expect.any(Number) },
    }));

    const approved = await api.app.request(`/owner/approvals/${pending.approval.id}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(approved.status).toBe(200);
    const paid = await approved.json() as any;
    expect(paid).toEqual(expect.objectContaining({
      approval: expect.objectContaining({ status: "approved" }),
      payment: expect.objectContaining({ status: "paid", receipt: expect.objectContaining({ amount: 3_000_000 }) }),
    }));

    const retry = await signedRequest(api.app, "/pay", "POST", payBody, scout.id, scoutKeys.privateKey, "x-agent-id");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(expect.objectContaining({
      status: "paid", replayed: true, receipt: expect.objectContaining({ id: paid.payment.receipt.id }),
    }));
    const agentStatePath = "/agent/state?limit=100";
    const agentState = await signedRequest(api.app, agentStatePath, "GET", undefined, scout.id, scoutKeys.privateKey, "x-agent-id");
    expect(await agentState.json()).toEqual(expect.objectContaining({
      account: expect.objectContaining({ id: scout.id, balanceMicros: 7_000_000 }),
      approvals: [expect.objectContaining({ id: pending.approval.id, status: "approved" })],
      feed: [expect.objectContaining({ id: paid.payment.receipt.id, to: writer.id, amount: 3_000_000 }), expect.anything()],
    }));

    const loggedOut = await api.app.request("/owner/sessions/current", {
      method: "DELETE", headers: { authorization: `Bearer ${token}` },
    });
    expect(loggedOut.status).toBe(200);
    expect((await api.app.request("/owner/state", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("rejects unsigned, forged, tampered, stale, and replayed signed requests across API replicas", async () => {
    const { user, keys } = await signup("Max", "max");
    const body = JSON.stringify({ userId: user.id, amountMicros: 1_000_000, idempotencyKey: "fund-auth" });
    expect((await api.app.request("/fund", { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(401);

    const thief = generateAgentKeypair();
    expect((await signedRequest(api.app, "/fund", "POST", JSON.parse(body), user.id, thief.privateKey, "x-user-id")).status).toBe(401);

    const ts = Date.now();
    const nonce = "nonce-api-replay-0001";
    const headers = {
      "content-type": "application/json",
      "x-user-id": user.id,
      "x-signature-ts": String(ts),
      "x-signature-nonce": nonce,
      "x-signature": signRequest(keys.privateKey, { method: "POST", path: "/fund", body, ts, nonce }),
    };
    const first = await api.app.request("/fund", { method: "POST", headers, body });
    expect(first.status).toBe(200);
    const replica = createPostgresApi(db, { allowDevelopmentFunding: true });
    const replay = await replica.app.request("/fund", { method: "POST", headers, body });
    expect(replay.status).toBe(401);
    expect((await replay.json() as any).reason).toMatch(/nonce already used/);

    const tampered = JSON.stringify({ userId: user.id, amountMicros: 2_000_000, idempotencyKey: "fund-auth" });
    const tamperHeaders = signedHeaders(user.id, keys.privateKey, { method: "POST", path: "/fund", body }, "x-user-id");
    expect((await api.app.request("/fund", { method: "POST", headers: { "content-type": "application/json", ...tamperHeaders }, body: tampered })).status).toBe(401);

    const oldTs = Date.now() - 10 * 60_000;
    const oldNonce = "nonce-api-stale-0001";
    const staleHeaders = {
      "content-type": "application/json",
      "x-user-id": user.id,
      "x-signature-ts": String(oldTs),
      "x-signature-nonce": oldNonce,
      "x-signature": signRequest(keys.privateKey, { method: "POST", path: "/fund", body, ts: oldTs, nonce: oldNonce }),
    };
    expect((await api.app.request("/fund", { method: "POST", headers: staleHeaders, body })).status).toBe(401);
    const transfers = await db.query<{ count: string }>("select count(*)::text as count from money.transfers where operation = 'fund'");
    expect(transfers.rows[0]?.count).toBe("1");
  });

  it("isolates owner state and approval actions across tenants", async () => {
    const { user: alice, keys: aliceKeys } = await signup("Alice", "alice");
    const { agent: aliceAgent, keys: aliceAgentKeys } = await createAgent(alice, aliceKeys.privateKey, "Alice agent", "alice-agent");
    const { user: bob, keys: bobKeys } = await signup("Bob", "bob");
    const { agent: bobAgent } = await createAgent(bob, bobKeys.privateKey, "Bob agent", "bob-agent");
    await fund(alice.id, aliceKeys.privateKey);
    await signedRequest(api.app, "/allocate", "POST", {
      userId: alice.id, agentId: aliceAgent.id, amountMicros: 10_000_000, idempotencyKey: "alice-allocate",
    }, alice.id, aliceKeys.privateKey, "x-user-id");
    await signedRequest(api.app, "/mandates", "POST", {
      userId: alice.id, agentId: aliceAgent.id, budgetMicros: 10_000_000,
      perTxCapMicros: 10_000_000, dailyCapMicros: 10_000_000,
      escalateAboveMicros: 0, newPayeeCapMicros: 10_000_000, idempotencyKey: "alice-mandate",
    }, alice.id, aliceKeys.privateKey, "x-user-id");
    const requested = await signedRequest(api.app, "/pay", "POST", {
      to: bobAgent.id, amountMicros: 1_000_000, idempotencyKey: "alice-to-bob",
    }, aliceAgent.id, aliceAgentKeys.privateKey, "x-agent-id");
    const approvalId = (await requested.json() as any).approval.id as string;

    const bobToken = await session(bob.id, bobKeys.privateKey);
    const bobState = await api.app.request("/owner/state", { headers: { authorization: `Bearer ${bobToken}` } });
    const bobJson = await bobState.json() as any;
    expect(bobJson.approvals).toEqual([]);
    expect(bobJson.accounts.map((account: any) => account.id)).toEqual(expect.arrayContaining([bob.id, bobAgent.id]));
    expect(bobJson.accounts.map((account: any) => account.id)).not.toContain(aliceAgent.id);
    expect((await api.app.request(`/owner/approvals/${approvalId}/approve`, {
      method: "POST", headers: { authorization: `Bearer ${bobToken}`, "content-type": "application/json" }, body: "{}",
    })).status).toBe(404);
    expect((await signedRequest(api.app, `/accounts/${aliceAgent.id}/rotate-key`, "POST", {
      publicKey: generateAgentKeypair().publicKey,
    }, bob.id, bobKeys.privateKey, "x-user-id")).status).toBe(403);
    expect((await api.app.request(`/balance/${alice.id}`)).status).toBe(404);
    expect((await api.app.request("/feed")).status).toBe(404);
  });

  it("kills old keys immediately and revokes owner sessions on owner rotation", async () => {
    const { user, keys: oldOwnerKeys } = await signup("Max", "max");
    const { agent, keys: oldAgentKeys } = await createAgent(user, oldOwnerKeys.privateKey, "Scout", "scout");
    await fund(user.id, oldOwnerKeys.privateKey);
    await signedRequest(api.app, "/allocate", "POST", {
      userId: user.id, agentId: agent.id, amountMicros: 2_000_000, idempotencyKey: "allocate",
    }, user.id, oldOwnerKeys.privateKey, "x-user-id");
    await signedRequest(api.app, "/mandates", "POST", {
      userId: user.id, agentId: agent.id, budgetMicros: 2_000_000,
      perTxCapMicros: 2_000_000, dailyCapMicros: 2_000_000,
      escalateAboveMicros: 2_000_000, newPayeeCapMicros: 2_000_000, idempotencyKey: "mandate",
    }, user.id, oldOwnerKeys.privateKey, "x-user-id");
    const token = await session(user.id, oldOwnerKeys.privateKey);

    const newAgentKeys = generateAgentKeypair();
    expect((await signedRequest(api.app, `/accounts/${agent.id}/rotate-key`, "POST", {
      publicKey: newAgentKeys.publicKey,
    }, user.id, oldOwnerKeys.privateKey, "x-user-id")).status).toBe(200);
    const pay = { to: user.id, amountMicros: 500_000, idempotencyKey: "pay-after-rotate" };
    expect((await signedRequest(api.app, "/pay", "POST", pay, agent.id, oldAgentKeys.privateKey, "x-agent-id")).status).toBe(401);
    expect((await signedRequest(api.app, "/pay", "POST", pay, agent.id, newAgentKeys.privateKey, "x-agent-id")).status).toBe(200);

    const newOwnerKeys = generateAgentKeypair();
    expect((await signedRequest(api.app, `/accounts/${user.id}/rotate-key`, "POST", {
      publicKey: newOwnerKeys.publicKey,
    }, user.id, oldOwnerKeys.privateKey, "x-user-id")).status).toBe(200);
    expect((await api.app.request("/owner/state", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await signedRequest(api.app, "/owner/sessions", "POST", {}, user.id, oldOwnerKeys.privateKey, "x-user-id")).status).toBe(401);
    expect((await signedRequest(api.app, "/owner/sessions", "POST", {}, user.id, newOwnerKeys.privateKey, "x-user-id")).status).toBe(200);
  });

  it("makes signup and child onboarding retry-safe by public key", async () => {
    const keys = generateAgentKeypair();
    const body = { name: "Max", handle: "max", publicKey: keys.publicKey };
    const first = await api.app.request("/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const firstUser = await first.json() as any;
    const replay = await api.app.request("/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(await replay.json()).toEqual({ ...firstUser, replayed: true });
    const conflict = await api.app.request("/users", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, name: "Changed" }),
    });
    expect(conflict.status).toBe(409);

    const agentKeys = generateAgentKeypair();
    const childBody = { name: "Scout", handle: "scout", ownerId: firstUser.id, publicKey: agentKeys.publicKey };
    const child = await signedRequest(api.app, "/agents", "POST", childBody, firstUser.id, keys.privateKey, "x-user-id");
    const childJson = await child.json() as any;
    const childReplay = await signedRequest(api.app, "/agents", "POST", childBody, firstUser.id, keys.privateKey, "x-user-id");
    expect(await childReplay.json()).toEqual({ ...childJson, replayed: true });
  });

  it("gates signup behind invite codes when the hosted beta configures them", async () => {
    const gated = createPostgresApi(db, { signupInvites: ["pilot-invite-001", "pilot-invite-002"] });
    const keys = generateAgentKeypair();
    const attempt = (inviteCode?: string) => gated.app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "pilot", publicKey: keys.publicKey, ...(inviteCode ? { inviteCode } : {}) }),
    });
    expect((await attempt()).status).toBe(403);
    expect(await (await attempt("wrong-code-entirely")).json()).toEqual(
      expect.objectContaining({ error: "invite_required" }),
    );
    expect((await attempt("pilot-invite-002")).status).toBe(200);
    // The default api (no invites configured) stays open for local development.
    const open = await api.app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "local", publicKey: generateAgentKeypair().publicKey }),
    });
    expect(open.status).toBe(200);
    // Env parsing is strict: fail loudly rather than silently opening signup.
    expect(parseSignupInvites(undefined)).toEqual([]);
    expect(parseSignupInvites('["pilot-invite-001"]')).toEqual(["pilot-invite-001"]);
    expect(() => parseSignupInvites("not-json")).toThrow(/JSON array/);
    expect(() => parseSignupInvites('["short"]')).toThrow(/8-128/);
  });

  it("keeps owner-signed development funding disabled by default", async () => {
    const { user, keys } = await signup("Max", "max");
    const productionApi = createPostgresApi(db);
    const response = await signedRequest(
      productionApi.app, "/fund", "POST",
      { userId: user.id, amountMicros: 1_000_000, idempotencyKey: "forbidden-fund" },
      user.id, keys.privateKey, "x-user-id"
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "treasury_required" }));
    expect((await db.query("select * from money.transfers")).rows).toHaveLength(0);
  });
});
