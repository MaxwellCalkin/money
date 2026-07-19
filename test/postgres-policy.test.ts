import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { PostgresPolicy } from "../src/db/policy.ts";

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

describe("Postgres mandate and approval policy", () => {
  let db: EmbeddedPostgres;
  let ledger: PostgresLedger;
  let policy: PostgresPolicy;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    ledger = new PostgresLedger(db);
    policy = new PostgresPolicy(db);
  }, 30_000);

  afterEach(async () => {
    await db.close();
  });

  async function world(balance = 100n) {
    const owner = await ledger.registerAccount({ id: "usr_owner0001", kind: "user", name: "Owner", handle: "owner" });
    const agent = await ledger.registerAccount({ id: "agt_agent0001", kind: "agent", name: "Scout", ownerId: owner.id, handle: "scout" });
    const peer = await ledger.registerAccount({ id: "agt_peer00001", kind: "agent", name: "Owned peer", ownerId: owner.id, handle: "owned-peer" });
    const otherOwner = await ledger.registerAccount({ id: "usr_other0001", kind: "user", name: "Other owner", handle: "other-owner" });
    const stranger = await ledger.registerAccount({ id: "agt_stranger1", kind: "agent", name: "Stranger", ownerId: otherOwner.id, handle: "stranger" });
    if (balance > 0n) {
      await ledger.postTransfer({ actorId: owner.id, operation: "fund", idempotencyKey: "fund", from: "external:funding", to: owner.id, amountMicros: balance });
      await ledger.postTransfer({ actorId: owner.id, operation: "allocate", idempotencyKey: "allocate", from: owner.id, to: agent.id, amountMicros: balance });
    }
    return { owner, agent, peer, otherOwner, stranger };
  }

  function mandateInput(ownerId: string, agentId: string, overrides: Partial<{
    budgetMicros: bigint;
    perTxCapMicros: bigint;
    dailyCapMicros: bigint;
    escalateAboveMicros: bigint;
    newPayeeCapMicros: bigint;
    payeeAllowlist: string[] | null;
    expiresAt: Date;
    idempotencyKey: string;
  }> = {}) {
    return {
      userId: ownerId,
      agentId,
      budgetMicros: 100n,
      perTxCapMicros: 25n,
      dailyCapMicros: 50n,
      escalateAboveMicros: 10n,
      newPayeeCapMicros: 2n,
      expiresAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: "mandate-1",
      ...overrides,
    };
  }

  it("grants mandates idempotently and supersedes the prior active mandate", async () => {
    const { owner, agent } = await world();
    const input = mandateInput(owner.id, agent.id);
    const first = await policy.grantMandate(input);
    const replay = await policy.grantMandate(input);
    expect(replay).toEqual({ ...first, replayed: true });

    await expect(policy.grantMandate({ ...input, budgetMicros: 101n })).rejects.toThrow(/different terms/);

    const replacement = await policy.grantMandate({ ...input, idempotencyKey: "mandate-2" });
    expect(replacement.mandateId).not.toBe(first.mandateId);
    expect((await policy.mandate(owner.id, first.mandateId))?.revokedAt).toBeInstanceOf(Date);
    expect((await policy.mandate(owner.id, replacement.mandateId))?.revokedAt).toBeUndefined();
    expect(await policy.mandate("usr_not_the_owner", replacement.mandateId)).toBeUndefined();
    expect(await policy.listMandates(agent.id)).toHaveLength(2);
    const active = await db.query<{ count: string }>("select count(*)::text as count from money.mandates where agent_id = $1 and revoked_at is null", [agent.id]);
    expect(active.rows[0]?.count).toBe("1");
  });

  it("atomically posts an autonomous payment, policy evidence, counters, and exact replay", async () => {
    const { owner, agent, peer } = await world();
    const grant = await policy.grantMandate(mandateInput(owner.id, agent.id));
    const request = { agentId: agent.id, idempotencyKey: "pay-1", to: peer.id, amountMicros: 3n, memo: "research" };
    const paid = await policy.requestPayment(request);
    expect(paid).toEqual(expect.objectContaining({ status: "posted", replayed: false, fromBalanceMicros: 97n, toBalanceMicros: 3n }));
    const replay = await policy.requestPayment(request);
    expect(replay).toEqual({ ...paid, replayed: true });
    expect(await policy.requestPayment({ ...request, amountMicros: 4n })).toEqual(expect.objectContaining({
      status: "denied", replayed: true, code: "idempotency_conflict",
    }));

    expect(await policy.mandate(owner.id, grant.mandateId)).toEqual(expect.objectContaining({ spentMicros: 3n, spentTodayMicros: 3n }));
    const evidence = await db.query<{ decision: string; approval_id: string | null; bytes: number }>(`
      select decision, approval_id, octet_length(evidence_hash) as bytes
      from money.transfer_authorizations
    `);
    expect(evidence.rows).toEqual([{ decision: "autonomous", approval_id: null, bytes: 32 }]);
    expect((await db.query("select * from money.mandate_seen_payees where mandate_id = $1", [grant.mandateId])).rows).toHaveLength(1);
    expect((await ledger.reconcile()).every((row) => row.matches)).toBe(true);
  });

  it("enforces mandate existence, allowlist, total, daily, per-transaction, and new-payee caps", async () => {
    const { owner, agent, peer, stranger } = await world();
    expect(await policy.requestPayment({ agentId: agent.id, idempotencyKey: "none", to: peer.id, amountMicros: 1n })).toEqual(expect.objectContaining({ code: "no_mandate" }));

    await policy.grantMandate(mandateInput(owner.id, agent.id, { idempotencyKey: "allow", payeeAllowlist: [peer.id] }));
    expect(await policy.requestPayment({ agentId: agent.id, idempotencyKey: "blocked-payee", to: stranger.id, amountMicros: 1n })).toEqual(expect.objectContaining({ code: "payee_not_allowed" }));

    await policy.grantMandate(mandateInput(owner.id, agent.id, { idempotencyKey: "budget", budgetMicros: 2n, dailyCapMicros: 10n }));
    expect(await policy.requestPayment({ agentId: agent.id, idempotencyKey: "over-budget", to: peer.id, amountMicros: 3n })).toEqual(expect.objectContaining({ code: "budget" }));

    await policy.grantMandate(mandateInput(owner.id, agent.id, { idempotencyKey: "daily", dailyCapMicros: 2n }));
    expect(await policy.requestPayment({ agentId: agent.id, idempotencyKey: "over-daily", to: peer.id, amountMicros: 3n })).toEqual(expect.objectContaining({ code: "daily_cap" }));

    await policy.grantMandate(mandateInput(owner.id, agent.id, { idempotencyKey: "per-tx", perTxCapMicros: 2n, escalateAboveMicros: 100n, newPayeeCapMicros: 100n }));
    expect(await policy.requestPayment({ agentId: agent.id, idempotencyKey: "over-per-tx", to: peer.id, amountMicros: 3n })).toEqual(expect.objectContaining({ code: "per_tx_cap" }));

    await policy.grantMandate(mandateInput(owner.id, agent.id, { idempotencyKey: "new-payee", perTxCapMicros: 100n, escalateAboveMicros: 100n, newPayeeCapMicros: 2n }));
    expect(await policy.requestPayment({ agentId: agent.id, idempotencyKey: "over-new", to: stranger.id, amountMicros: 3n })).toEqual(expect.objectContaining({ code: "new_payee_cap" }));
    expect(await ledger.balance(agent.id)).toBe(100n);
    expect(await ledger.balance(peer.id)).toBe(0n);
    expect(await ledger.balance(stranger.id)).toBe(0n);
  });

  it("deduplicates durable approval intents and settles the exact stored tuple once", async () => {
    const { owner, agent, otherOwner, stranger } = await world();
    const grant = await policy.grantMandate(mandateInput(owner.id, agent.id, {
      perTxCapMicros: 1n,
      escalateAboveMicros: 2n,
      newPayeeCapMicros: 0n,
    }));
    const request = { agentId: agent.id, idempotencyKey: "approval-1", to: stranger.id, amountMicros: 3n, memo: "buy data" };
    const pending = await policy.requestPayment(request);
    expect(pending).toEqual(expect.objectContaining({ status: "approval_required", replayed: false }));
    if (pending.status !== "approval_required") throw new Error("expected approval");
    expect((await db.query("select * from money.transfers where operation = 'pay'")).rows).toHaveLength(0);

    const alias = await policy.requestPayment({ ...request, idempotencyKey: "approval-alias" });
    expect(alias).toEqual({ status: "approval_required", replayed: true, approvalId: pending.approvalId });
    expect(await policy.listApprovals(owner.id, "pending")).toHaveLength(1);
    expect(await policy.listApprovals(agent.id, "pending")).toHaveLength(1);
    expect(await policy.approval(otherOwner.id, pending.approvalId)).toBeUndefined();
    await expect(policy.resolveApproval(otherOwner.id, pending.approvalId, "approve")).rejects.toThrow(/another owner/);

    const approved = await policy.resolveApproval(owner.id, pending.approvalId, "approve");
    expect(approved).toEqual(expect.objectContaining({
      status: "posted", replayed: false, approvalId: pending.approvalId,
      fromBalanceMicros: 97n, toBalanceMicros: 3n,
    }));
    if (approved.status !== "posted") throw new Error("expected posted payment");
    const ownerReplay = await policy.resolveApproval(owner.id, pending.approvalId, "approve");
    expect(ownerReplay).toEqual({ ...approved, replayed: true });
    expect(await policy.requestPayment(request)).toEqual({ ...approved, replayed: true });
    expect(await policy.requestPayment({ ...request, idempotencyKey: "approval-alias" })).toEqual({ ...approved, replayed: true });

    expect(await policy.mandate(owner.id, grant.mandateId)).toEqual(expect.objectContaining({ spentMicros: 3n, spentTodayMicros: 3n }));
    expect(await policy.approval(owner.id, pending.approvalId)).toEqual(expect.objectContaining({ status: "approved", receiptId: approved.receiptId }));
    const evidence = await db.query<{ decision: string; approval_id: string }>("select decision, approval_id from money.transfer_authorizations");
    expect(evidence.rows).toEqual([{ decision: "human_approved", approval_id: pending.approvalId }]);
    const approvalEvents = await db.query<{ topic: string }>(
      "select topic from money.outbox_events where aggregate_id = $1 order by id",
      [pending.approvalId]
    );
    expect(approvalEvents.rows.map((row) => row.topic)).toEqual(["approval.requested", "approval.approved"]);
    expect((await db.query("select * from money.transfers where operation = 'pay'")).rows).toHaveLength(1);
  });

  it("makes rejection and expiration terminal and rate-limits repeated approval prompts", async () => {
    const { owner, agent, stranger } = await world();
    await policy.grantMandate(mandateInput(owner.id, agent.id, { escalateAboveMicros: 0n }));
    const intent = { agentId: agent.id, idempotencyKey: "reject-me", to: stranger.id, amountMicros: 1n, memo: "risky" };
    const pending = await policy.requestPayment(intent);
    if (pending.status !== "approval_required") throw new Error("expected approval");
    expect(await policy.resolveApproval(owner.id, pending.approvalId, "reject", "not in scope")).toEqual(expect.objectContaining({
      status: "denied", replayed: false, code: "approval_rejected", reason: "not in scope",
    }));
    expect(await policy.resolveApproval(owner.id, pending.approvalId, "reject")).toEqual(expect.objectContaining({
      status: "denied", replayed: true, code: "approval_rejected",
    }));
    expect(await policy.requestPayment({ ...intent, idempotencyKey: "cooldown" })).toEqual(expect.objectContaining({
      status: "denied", code: "approval_rejected", reason: expect.stringContaining("cooldown"),
    }));

    const expiring = await policy.requestPayment({ ...intent, idempotencyKey: "expire-me", memo: "different intent" });
    if (expiring.status !== "approval_required") throw new Error("expected expiring approval");
    await db.query("update money.approvals set expires_at = clock_timestamp() - interval '1 second' where id = $1", [expiring.approvalId]);
    expect(await policy.requestPayment({ ...intent, idempotencyKey: "expire-me", memo: "different intent" })).toEqual(expect.objectContaining({
      status: "denied", replayed: true, code: "approval_expired",
    }));
    expect(await ledger.balance(agent.id)).toBe(100n);
  });

  it("caps each agent at twenty pending approvals", async () => {
    const { owner, agent, stranger } = await world(0n);
    await policy.grantMandate(mandateInput(owner.id, agent.id, {
      budgetMicros: 1_000n,
      dailyCapMicros: 1_000n,
      escalateAboveMicros: 0n,
    }));
    for (let index = 0; index < 20; index += 1) {
      expect(await policy.requestPayment({
        agentId: agent.id,
        idempotencyKey: `pending-${index}`,
        to: stranger.id,
        amountMicros: 1n,
        memo: `intent ${index}`,
      })).toEqual(expect.objectContaining({ status: "approval_required" }));
    }
    expect(await policy.requestPayment({
      agentId: agent.id,
      idempotencyKey: "pending-20",
      to: stranger.id,
      amountMicros: 1n,
      memo: "intent 20",
    })).toEqual(expect.objectContaining({ status: "denied", code: "approval_limit" }));
    expect(await policy.listApprovals(owner.id, "pending")).toHaveLength(20);
  });

  it("fails pending approvals when their mandate is revoked or superseded", async () => {
    const { owner, agent, stranger } = await world();
    const firstGrant = await policy.grantMandate(mandateInput(owner.id, agent.id, { escalateAboveMicros: 0n }));
    const first = await policy.requestPayment({ agentId: agent.id, idempotencyKey: "before-revoke", to: stranger.id, amountMicros: 1n });
    if (first.status !== "approval_required") throw new Error("expected approval");
    expect(await policy.revokeMandate(owner.id, firstGrant.mandateId)).toBe(true);
    expect(await policy.revokeMandate(owner.id, firstGrant.mandateId)).toBe(false);
    expect(await policy.resolveApproval(owner.id, first.approvalId, "approve")).toEqual(expect.objectContaining({
      status: "denied", replayed: true, code: "approval_failed", reason: "mandate revoked by owner",
    }));

    await policy.grantMandate(mandateInput(owner.id, agent.id, { idempotencyKey: "replacement", escalateAboveMicros: 0n }));
    const second = await policy.requestPayment({
      agentId: agent.id,
      idempotencyKey: "before-supersede",
      to: stranger.id,
      amountMicros: 1n,
      memo: "distinct supersession intent",
    });
    if (second.status !== "approval_required") throw new Error("expected approval");
    await policy.grantMandate(mandateInput(owner.id, agent.id, { idempotencyKey: "replacement-2", escalateAboveMicros: 0n }));
    expect(await policy.approval(owner.id, second.approvalId)).toEqual(expect.objectContaining({
      status: "failed", reason: "mandate superseded by owner",
    }));
  });

  it("serializes concurrent requests so caps cannot be overspent", async () => {
    const { owner, agent, peer } = await world(10n);
    const grant = await policy.grantMandate(mandateInput(owner.id, agent.id, {
      budgetMicros: 5n,
      dailyCapMicros: 5n,
      perTxCapMicros: 5n,
      escalateAboveMicros: 5n,
      newPayeeCapMicros: 5n,
    }));
    const results = await Promise.all([
      policy.requestPayment({ agentId: agent.id, idempotencyKey: "race-a", to: peer.id, amountMicros: 4n }),
      policy.requestPayment({ agentId: agent.id, idempotencyKey: "race-b", to: peer.id, amountMicros: 4n }),
    ]);
    expect(results.filter((result) => result.status === "posted")).toHaveLength(1);
    expect(results.filter((result) => result.status === "denied")).toEqual([
      expect.objectContaining({ code: "budget" }),
    ]);
    expect(await policy.mandate(owner.id, grant.mandateId)).toEqual(expect.objectContaining({ spentMicros: 4n, spentTodayMicros: 4n }));
    expect(await ledger.balance(agent.id)).toBe(6n);
    expect(await ledger.balance(peer.id)).toBe(4n);
  });

  it("keeps insufficient-funds denial stable without consuming mandate counters", async () => {
    const { owner, agent, peer } = await world(2n);
    const grant = await policy.grantMandate(mandateInput(owner.id, agent.id, {
      perTxCapMicros: 10n,
      dailyCapMicros: 10n,
      escalateAboveMicros: 10n,
      newPayeeCapMicros: 10n,
    }));
    const request = { agentId: agent.id, idempotencyKey: "no-funds", to: peer.id, amountMicros: 3n };
    expect(await policy.requestPayment(request)).toEqual(expect.objectContaining({
      status: "denied", replayed: false, code: "insufficient_funds", fromBalanceMicros: 2n,
    }));
    expect(await policy.requestPayment(request)).toEqual(expect.objectContaining({
      status: "denied", replayed: true, code: "insufficient_funds", fromBalanceMicros: 2n,
    }));
    expect(await policy.mandate(owner.id, grant.mandateId)).toEqual(expect.objectContaining({ spentMicros: 0n, spentTodayMicros: 0n }));
    expect((await db.query("select * from money.transfer_authorizations")).rows).toHaveLength(0);
  });

  it("makes transfer authorization evidence append-only", async () => {
    const { owner, agent, peer } = await world();
    await policy.grantMandate(mandateInput(owner.id, agent.id));
    expect(await policy.requestPayment({ agentId: agent.id, idempotencyKey: "evidence", to: peer.id, amountMicros: 1n })).toEqual(expect.objectContaining({ status: "posted" }));
    await expect(db.query("update money.transfer_authorizations set decision = 'human_approved'")).rejects.toThrow(/append-only/);
    await expect(db.query("delete from money.transfer_authorizations")).rejects.toThrow(/append-only/);
  });
});
