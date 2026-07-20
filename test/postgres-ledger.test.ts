import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createDatabaseOpsApi } from "../src/server/database-ops.ts";
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

describe("Postgres ledger kernel", () => {
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

  async function world() {
    const owner = await ledger.registerAccount({ id: "usr_12345678", kind: "user", name: "Max", handle: "max" });
    const agent = await ledger.registerAccount({ id: "agt_12345678", kind: "agent", name: "Scout", ownerId: owner.id, handle: "scout" });
    const peer = await ledger.registerAccount({ id: "agt_abcdefgh", kind: "agent", name: "Writer", ownerId: owner.id, handle: "writer" });
    await approveComplianceFixture(db, owner.id);
    return { owner, agent, peer };
  }

  it("applies checksum-locked migrations idempotently", async () => {
    const replay = await runMigrations(db);
    expect(replay).toEqual([
      expect.objectContaining({ version: "0001", applied: false }),
      expect.objectContaining({ version: "0002", applied: false }),
      expect.objectContaining({ version: "0003", applied: false }),
      expect.objectContaining({ version: "0004", applied: false }),
      expect.objectContaining({ version: "0005", applied: false }),
      expect.objectContaining({ version: "0006", applied: false }),
      expect.objectContaining({ version: "0007", applied: false }),
      expect.objectContaining({ version: "0008", applied: false }),
    ]);
    const rows = await db.query<{ version: string; checksum: string }>("select version, checksum from money.schema_migrations");
    expect(rows.rows).toEqual([
      expect.objectContaining({ version: "0001", checksum: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ version: "0002", checksum: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ version: "0003", checksum: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ version: "0004", checksum: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ version: "0005", checksum: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ version: "0006", checksum: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ version: "0007", checksum: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ version: "0008", checksum: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]);
    await db.query("update money.schema_migrations set checksum = repeat('0', 64) where version = '0001'");
    await expect(runMigrations(db)).rejects.toThrow(/checksum changed/);
  });

  it("posts fund, allocation, and agent payment as atomic double-entry transfers", async () => {
    const { owner, agent, peer } = await world();
    const funded = await ledger.postTransfer({
      actorId: owner.id,
      operation: "fund",
      idempotencyKey: "fund-1",
      from: "external:funding",
      to: owner.id,
      amountMicros: 10_000_000n,
      memo: "bank top-up",
    });
    expect(funded).toEqual(expect.objectContaining({ status: "posted", replayed: false, toBalanceMicros: 10_000_000n }));

    await ledger.postTransfer({
      actorId: owner.id,
      operation: "allocate",
      idempotencyKey: "allocate-1",
      from: owner.id,
      to: agent.id,
      amountMicros: 5_000_000n,
    });
    const paid = await ledger.postTransfer({
      actorId: agent.id,
      operation: "pay",
      idempotencyKey: "pay-1",
      from: agent.id,
      to: peer.id,
      amountMicros: 125_000n,
      memo: "research subtask",
      metadata: { taskId: "task-42" },
    });
    expect(paid).toEqual(expect.objectContaining({
      status: "posted",
      replayed: false,
      fromBalanceMicros: 4_875_000n,
      toBalanceMicros: 125_000n,
    }));

    const entries = await db.query<{ transfer_seq: string; total: string; entries: string }>(`
      select transfer_seq, sum(amount_micros)::text as total, count(*)::text as entries
      from money.ledger_entries group by transfer_seq order by transfer_seq
    `);
    expect(entries.rows).toHaveLength(3);
    expect(entries.rows.every((row) => row.total === "0" && row.entries === "2")).toBe(true);
    expect((await ledger.reconcile()).every((row) => row.matches)).toBe(true);
  });

  it("returns the original receipt on exact retry and rejects changed terms", async () => {
    const { owner, agent, peer } = await world();
    await ledger.postTransfer({ actorId: owner.id, operation: "fund", idempotencyKey: "f", from: "external:funding", to: owner.id, amountMicros: 10n });
    await ledger.postTransfer({ actorId: owner.id, operation: "allocate", idempotencyKey: "a", from: owner.id, to: agent.id, amountMicros: 10n });
    const request = { actorId: agent.id, operation: "pay" as const, idempotencyKey: "same", from: agent.id, to: peer.id, amountMicros: 3n, memo: "one call" };
    const first = await ledger.postTransfer(request);
    const replay = await ledger.postTransfer(request);
    expect(first.status).toBe("posted");
    expect(replay).toEqual({ ...first, replayed: true });

    const conflict = await ledger.postTransfer({ ...request, amountMicros: 4n });
    expect(conflict).toEqual(expect.objectContaining({ status: "denied", replayed: true, code: "idempotency_conflict" }));
    expect(await ledger.balance(agent.id)).toBe(7n);
    expect(await ledger.balance(peer.id)).toBe(3n);
  });

  it("makes insufficient-funds outcomes stable for retry middleware", async () => {
    const { agent, peer } = await world();
    const request = { actorId: agent.id, operation: "pay" as const, idempotencyKey: "too-big", from: agent.id, to: peer.id, amountMicros: 1n };
    expect(await ledger.postTransfer(request)).toEqual(expect.objectContaining({ status: "denied", replayed: false, code: "insufficient_funds" }));
    expect(await ledger.postTransfer(request)).toEqual(expect.objectContaining({ status: "denied", replayed: true, code: "insufficient_funds" }));
    expect((await db.query("select * from money.transfers")).rows).toHaveLength(0);
  });

  it("enforces operation authority inside the database", async () => {
    const { owner, agent } = await world();
    await expect(ledger.postTransfer({
      actorId: owner.id,
      operation: "pay",
      idempotencyKey: "owner-cannot-pay",
      from: owner.id,
      to: agent.id,
      amountMicros: 1n,
    })).rejects.toThrow(/pay requires/);
    await expect(ledger.postTransfer({
      actorId: agent.id,
      operation: "pay",
      idempotencyKey: "no-boundary",
      from: agent.id,
      to: "external:x402",
      amountMicros: 1n,
    })).rejects.toThrow(/internal recipient/);
  });

  it("supports bigint micros beyond JavaScript's safe-number range", async () => {
    const { owner, agent } = await world();
    const huge = 10_000_000_000_000_000n;
    await ledger.postTransfer({ actorId: owner.id, operation: "fund", idempotencyKey: "huge-fund", from: "external:funding", to: owner.id, amountMicros: huge });
    await ledger.postTransfer({ actorId: owner.id, operation: "allocate", idempotencyKey: "huge-allocate", from: owner.id, to: agent.id, amountMicros: huge });
    expect(await ledger.balance(agent.id)).toBe(huge);
    expect((await ledger.reconcile()).every((row) => row.matches)).toBe(true);
  });

  it("rejects incomplete journal writes and mutations of settled evidence", async () => {
    const { owner, agent } = await world();
    await expect(db.query(`
      with t as (
        insert into money.transfers (
          actor_id, operation, idempotency_key, request_hash,
          from_account_id, to_account_id, asset_code, amount_micros
        ) values ($1, 'allocate', 'bad-journal', digest('bad', 'sha256'), $1, $2, 'USD', 1)
        returning seq
      )
      insert into money.ledger_entries(transfer_seq, account_id, asset_code, amount_micros)
      select seq, $1, 'USD', -1 from t
    `, [owner.id, agent.id])).rejects.toThrow(/exactly two zero-sum entries/);

    await ledger.postTransfer({ actorId: owner.id, operation: "fund", idempotencyKey: "good", from: "external:funding", to: owner.id, amountMicros: 2n });
    await expect(db.query("update money.transfers set memo = 'tampered'")).rejects.toThrow(/append-only/);
    await expect(db.query("delete from money.receipts")).rejects.toThrow(/append-only/);
  });

  it("claims outbox work once and requires the claiming worker to acknowledge it", async () => {
    await world();
    const first = await ledger.claimOutbox("worker-a", 2);
    expect(first).toHaveLength(2);
    const second = await ledger.claimOutbox("worker-b", 10);
    expect(second.map((event) => event.id)).not.toEqual(expect.arrayContaining(first.map((event) => event.id)));
    await expect(ledger.markOutboxPublished("worker-b", first.map((event) => event.id))).rejects.toThrow(/did not own/);
    await ledger.markOutboxPublished("worker-a", first.map((event) => event.id));
    const published = await db.query<{ count: string }>("select count(*)::text as count from money.outbox_events where published_at is not null");
    expect(published.rows[0]?.count).toBe("2");
  });

  it("serves public health separately from token-gated reconciliation", async () => {
    const { owner } = await world();
    await ledger.postTransfer({ actorId: owner.id, operation: "fund", idempotencyKey: "health-fund", from: "external:funding", to: owner.id, amountMicros: 5n });
    const app = createDatabaseOpsApi(db, ledger, "ops-secret");
    expect((await app.request("/health/live")).status).toBe(200);
    const ready = await app.request("/health/ready");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual(expect.objectContaining({ ok: true, schemaVersion: "0008" }));
    expect((await app.request("/ops/reconcile")).status).toBe(404);
    expect((await app.request("/ops/treasury")).status).toBe(404);
    const reconciled = await app.request("/ops/reconcile", { headers: { authorization: "Bearer ops-secret" } });
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toEqual({ ok: true, checked: 6, mismatches: [] });
    const treasuryHealth = await app.request("/ops/treasury", { headers: { authorization: "Bearer ops-secret" } });
    expect(treasuryHealth.status).toBe(503);
    expect(await treasuryHealth.json()).toEqual(expect.objectContaining({
      ok: false, configured: false, deadEvents: 0, manualPayouts: 0, blockedPayouts: 0,
      controls: expect.objectContaining({
        fundingEnabled: false, payoutsEnabled: false, externalSpendEnabled: false,
        breakerReason: "initial treasury reconciliation and review required",
      }),
      recentControlEvents: [],
      recentEventReviews: [],
      recentPayoutReviews: [],
    }));
  });

  it("keeps application, treasury, worker, and operations privileges separate", async () => {
    await db.executeScript(readFileSync(resolve("db/roles.sql"), "utf8"));
    const privileges = await db.query<{
      app_pay: boolean;
      app_safe_pay: boolean;
      app_grant_mandate: boolean;
      app_policy_read: boolean;
      app_register_raw: boolean;
      app_register_safe: boolean;
      app_signed_auth: boolean;
      app_session: boolean;
      app_global_health: boolean;
      app_market_register: boolean;
      app_market_challenge: boolean;
      app_market_refund: boolean;
      app_market_kernel: boolean;
      app_challenges: boolean;
      app_external_prepare: boolean;
      app_external_activate: boolean;
      app_external_resolve: boolean;
      app_external_rotate: boolean;
      app_external_confirm: boolean;
      app_external_secret: boolean;
      app_external_lookup: boolean;
      app_external_reverse: boolean;
      app_external_sweep: boolean;
      app_external_table: boolean;
      app_fund: boolean;
      app_generic: boolean;
      app_balances: boolean;
      app_approvals: boolean;
      app_mandates: boolean;
      app_nonces: boolean;
      app_sessions: boolean;
      treasury_fund: boolean;
      treasury_register: boolean;
      treasury_controls: boolean;
      treasury_resolve_review: boolean;
      treasury_resolve_event: boolean;
      treasury_restore: boolean;
      app_treasury_payout: boolean;
      app_treasury_get: boolean;
      app_treasury_settle: boolean;
      app_treasury_table: boolean;
      treasury_settle: boolean;
      treasury_payout_claim: boolean;
      treasury_worker_settle: boolean;
      treasury_worker_register: boolean;
      treasury_worker_controls: boolean;
      treasury_worker_trip: boolean;
      treasury_worker_resolve_review: boolean;
      treasury_worker_resolve_event: boolean;
      treasury_worker_restore: boolean;
      treasury_worker_table: boolean;
      ingress_enqueue: boolean;
      ingress_settle: boolean;
      ingress_table: boolean;
      payout_claim: boolean;
      payout_funding: boolean;
      payout_table: boolean;
      reconciler_snapshot: boolean;
      reconciler_payout: boolean;
      reconciler_table: boolean;
      worker_outbox: boolean;
      worker_external_sweep: boolean;
      worker_external_table: boolean;
      worker_ledger: boolean;
      key_rotation_list: boolean;
      key_rotation_reencrypt: boolean;
      key_rotation_table: boolean;
      ops_ledger: boolean;
      ops_global_health: boolean;
      ops_challenges: boolean;
      ops_treasury_health: boolean;
      ops_treasury_table: boolean;
      ops_treasury_reviews: boolean;
      ops_control_events: boolean;
      ops_event_reviews: boolean;
      app_compliance_begin: boolean;
      app_compliance_state: boolean;
      app_compliance_approve: boolean;
      app_compliance_table: boolean;
      compliance_admin_approve: boolean;
      compliance_admin_evidence: boolean;
      compliance_worker_evidence: boolean;
      compliance_worker_approve: boolean;
      compliance_worker_enqueue: boolean;
      compliance_worker_table: boolean;
      compliance_ingress_enqueue: boolean;
      compliance_ingress_evidence: boolean;
      compliance_ingress_table: boolean;
      risk_sweep: boolean;
      risk_release: boolean;
      risk_table: boolean;
      compliance_ops_table: boolean;
      compliance_ops_state: boolean;
      compliance_ops_approve: boolean;
      ops_compliance_table: boolean;
    }>(`
      select
        has_function_privilege('money_app', 'money_private.post_agent_payment(text,text,text,text,bigint,text,jsonb)', 'EXECUTE') as app_pay,
        has_function_privilege('money_app', 'money_private.request_agent_payment(text,text,text,text,bigint,text)', 'EXECUTE') as app_safe_pay,
        has_function_privilege('money_app', 'money_private.grant_mandate(text,text,text,bigint,bigint,bigint,bigint,bigint,text[],timestamptz,text)', 'EXECUTE') as app_grant_mandate,
        has_function_privilege('money_app', 'money_private.list_approvals(text,text,integer)', 'EXECUTE') as app_policy_read,
        has_function_privilege('money_app', 'money_private.register_account(text,text,text,text,text,text)', 'EXECUTE') as app_register_raw,
        has_function_privilege('money_app', 'money_private.register_public_identity(text,text,text,text,text,text,text)', 'EXECUTE') as app_register_safe,
        has_function_privilege('money_app', 'money_private.consume_signed_request(text,text,text,text,bigint,bytea)', 'EXECUTE') as app_signed_auth,
        has_function_privilege('money_app', 'money_private.create_owner_session(text,bytea)', 'EXECUTE') as app_session,
        has_function_privilege('money_app', 'money_private.ledger_health()', 'EXECUTE') as app_global_health,
        has_function_privilege('money_app', 'money_private.register_service(text,text,text,text,text,text,bigint,text)', 'EXECUTE') as app_market_register,
        has_function_privilege('money_app', 'money_private.request_challenge_payment(text,uuid)', 'EXECUTE') as app_market_challenge,
        has_function_privilege('money_app', 'money_private.issue_refund(text,uuid,bigint,text,text)', 'EXECUTE') as app_market_refund,
        has_function_privilege('money_app', 'money_private.post_transfer_kernel(text,text,text,text,text,text,bigint,text,jsonb,uuid)', 'EXECUTE') as app_market_kernel,
        has_table_privilege('money_app', 'money.challenges', 'SELECT') as app_challenges,
        has_function_privilege('money_app', 'money_private.prepare_external_payment(uuid,text,text,text,text,text,text,text,text,bigint,smallint,jsonb)', 'EXECUTE') as app_external_prepare,
        has_function_privilege('money_app', 'money_private.activate_external_payment(text,uuid,bytea,bytea,text,timestamptz,timestamptz)', 'EXECUTE') as app_external_activate,
        has_function_privilege('money_app', 'money_private.resolve_external_approval_v2(text,uuid,text,text,bytea,bytea,text,timestamptz,timestamptz)', 'EXECUTE') as app_external_resolve,
        has_function_privilege('money_app', 'money_private.replace_external_authorization_ciphertext(uuid,bytea,bytea,text)', 'EXECUTE') as app_external_rotate,
        has_function_privilege('money_app', 'money_private.confirm_external_payment(text,uuid,text)', 'EXECUTE') as app_external_confirm,
        has_function_privilege('money_app', 'money_private.get_external_payment_secret(text,uuid)', 'EXECUTE') as app_external_secret,
        has_function_privilege('money_app', 'money_private.get_unresolved_external_payment_by_resource(text,text)', 'EXECUTE') as app_external_lookup,
        has_function_privilege('money_app', 'money_private.reverse_external_payment(uuid)', 'EXECUTE') as app_external_reverse,
        has_function_privilege('money_app', 'money_private.sweep_external_payments(integer)', 'EXECUTE') as app_external_sweep,
        has_table_privilege('money_app', 'money.external_payments', 'SELECT') as app_external_table,
        has_function_privilege('money_app', 'money_private.post_confirmed_funding(text,text,text,bigint,jsonb)', 'EXECUTE') as app_fund,
        has_function_privilege('money_app', 'money_private.post_transfer(text,text,text,text,text,text,bigint,text,jsonb)', 'EXECUTE') as app_generic,
        has_table_privilege('money_app', 'money.balances', 'SELECT') as app_balances,
        has_table_privilege('money_app', 'money.approvals', 'SELECT') as app_approvals,
        has_table_privilege('money_app', 'money.mandates', 'SELECT') as app_mandates,
        has_table_privilege('money_app', 'money.signed_request_nonces', 'SELECT') as app_nonces,
        has_table_privilege('money_app', 'money.owner_sessions', 'SELECT') as app_sessions,
        has_function_privilege('money_treasury', 'money_private.post_confirmed_funding(text,text,text,bigint,jsonb)', 'EXECUTE') as treasury_fund,
        has_function_privilege('money_treasury', 'money_private.register_treasury_deposit_route(text,text,text,text)', 'EXECUTE') as treasury_register,
        has_function_privilege('money_treasury', 'money_private.configure_treasury_controls(boolean,boolean,boolean,bigint,bigint,bigint,bigint,text)', 'EXECUTE') as treasury_controls,
        has_function_privilege('money_treasury', 'money_private.resolve_treasury_payout_review(uuid,text,text,text,text)', 'EXECUTE') as treasury_resolve_review,
        has_function_privilege('money_treasury', 'money_private.resolve_treasury_event_review(bigint,text,text,text)', 'EXECUTE') as treasury_resolve_event,
        has_function_privilege('money_treasury', 'money_private.restore_treasury_controls(text)', 'EXECUTE') as treasury_restore,
        has_function_privilege('money_app', 'money_private.request_treasury_payout(text,text,uuid,text,bigint)', 'EXECUTE') as app_treasury_payout,
        has_function_privilege('money_app', 'money_private.get_treasury_payout(text,uuid)', 'EXECUTE') as app_treasury_get,
        has_function_privilege('money_app', 'money_private.settle_treasury_funding(text,text,text,text,text,text,bigint,timestamptz,bytea,jsonb)', 'EXECUTE') as app_treasury_settle,
        has_table_privilege('money_app', 'money.treasury_payouts', 'SELECT') as app_treasury_table,
        has_function_privilege('money_treasury', 'money_private.settle_treasury_funding(text,text,text,text,text,text,bigint,timestamptz,bytea,jsonb)', 'EXECUTE') as treasury_settle,
        has_function_privilege('money_treasury', 'money_private.claim_treasury_payouts(text,integer)', 'EXECUTE') as treasury_payout_claim,
        has_function_privilege('money_treasury_worker', 'money_private.settle_treasury_funding(text,text,text,text,text,text,bigint,timestamptz,bytea,jsonb)', 'EXECUTE') as treasury_worker_settle,
        has_function_privilege('money_treasury_worker', 'money_private.register_treasury_deposit_route(text,text,text,text)', 'EXECUTE') as treasury_worker_register,
        has_function_privilege('money_treasury_worker', 'money_private.configure_treasury_controls(boolean,boolean,boolean,bigint,bigint,bigint,bigint,text)', 'EXECUTE') as treasury_worker_controls,
        has_function_privilege('money_treasury_worker', 'money_private.trip_treasury_breaker(text)', 'EXECUTE') as treasury_worker_trip,
        has_function_privilege('money_treasury_worker', 'money_private.resolve_treasury_payout_review(uuid,text,text,text,text)', 'EXECUTE') as treasury_worker_resolve_review,
        has_function_privilege('money_treasury_worker', 'money_private.resolve_treasury_event_review(bigint,text,text,text)', 'EXECUTE') as treasury_worker_resolve_event,
        has_function_privilege('money_treasury_worker', 'money_private.restore_treasury_controls(text)', 'EXECUTE') as treasury_worker_restore,
        has_table_privilege('money_treasury_worker', 'money.treasury_event_inbox', 'SELECT') as treasury_worker_table,
        has_function_privilege('money_treasury_ingress', 'money_private.enqueue_treasury_provider_event(text,text,text,bytea)', 'EXECUTE') as ingress_enqueue,
        has_function_privilege('money_treasury_ingress', 'money_private.settle_treasury_funding(text,text,text,text,text,text,bigint,timestamptz,bytea,jsonb)', 'EXECUTE') as ingress_settle,
        has_table_privilege('money_treasury_ingress', 'money.treasury_event_inbox', 'SELECT') as ingress_table,
        has_function_privilege('money_payout_worker', 'money_private.claim_treasury_payouts(text,integer)', 'EXECUTE') as payout_claim,
        has_function_privilege('money_payout_worker', 'money_private.settle_treasury_funding(text,text,text,text,text,text,bigint,timestamptz,bytea,jsonb)', 'EXECUTE') as payout_funding,
        has_table_privilege('money_payout_worker', 'money.treasury_payouts', 'SELECT') as payout_table,
        has_function_privilege('money_reconciler', 'money_private.record_treasury_asset_snapshot(text,text,text,bigint,bigint,bigint,bigint,bigint,text,timestamptz)', 'EXECUTE') as reconciler_snapshot,
        has_function_privilege('money_reconciler', 'money_private.request_treasury_payout(text,text,uuid,text,bigint)', 'EXECUTE') as reconciler_payout,
        has_table_privilege('money_reconciler', 'money.treasury_asset_snapshots', 'SELECT') as reconciler_table,
        has_table_privilege('money_worker', 'money.outbox_events', 'UPDATE') as worker_outbox,
        has_function_privilege('money_worker', 'money_private.sweep_external_payments(integer)', 'EXECUTE') as worker_external_sweep,
        has_table_privilege('money_worker', 'money.external_payments', 'SELECT') as worker_external_table,
        has_table_privilege('money_worker', 'money.ledger_entries', 'SELECT') as worker_ledger,
        has_function_privilege('money_key_rotation', 'money_private.list_external_authorizations_for_rotation(text,integer)', 'EXECUTE') as key_rotation_list,
        has_function_privilege('money_key_rotation', 'money_private.replace_external_authorization_ciphertext(uuid,bytea,bytea,text)', 'EXECUTE') as key_rotation_reencrypt,
        has_table_privilege('money_key_rotation', 'money.external_payments', 'SELECT') as key_rotation_table,
        has_table_privilege('money_ops', 'money.ledger_entries', 'SELECT') as ops_ledger,
        has_function_privilege('money_ops', 'money_private.ledger_health()', 'EXECUTE') as ops_global_health,
        has_table_privilege('money_ops', 'money.challenges', 'SELECT') as ops_challenges,
        has_function_privilege('money_ops', 'money_private.treasury_health()', 'EXECUTE') as ops_treasury_health,
        has_table_privilege('money_ops', 'money.treasury_payouts', 'SELECT') as ops_treasury_table,
        has_table_privilege('money_ops', 'money.treasury_payout_reviews', 'SELECT') as ops_treasury_reviews,
        has_table_privilege('money_ops', 'money.treasury_control_events', 'SELECT') as ops_control_events,
        has_table_privilege('money_ops', 'money.treasury_event_reviews', 'SELECT') as ops_event_reviews,
        has_function_privilege('money_app', 'money_private.begin_compliance_verification(text,text,text,bigint,bigint)', 'EXECUTE') as app_compliance_begin,
        has_function_privilege('money_app', 'money_private.compliance_subject_state(text)', 'EXECUTE') as app_compliance_state,
        has_function_privilege('money_app', 'money_private.approve_compliance_subject(text,text,timestamptz,text,text)', 'EXECUTE') as app_compliance_approve,
        has_table_privilege('money_app', 'money.compliance_subjects', 'SELECT') as app_compliance_table,
        has_function_privilege('money_compliance_admin', 'money_private.approve_compliance_subject(text,text,timestamptz,text,text)', 'EXECUTE') as compliance_admin_approve,
        has_function_privilege('money_compliance_admin', 'money_private.record_compliance_evidence(text,text,text,text,text,bytea,text,timestamptz,timestamptz,jsonb)', 'EXECUTE') as compliance_admin_evidence,
        has_function_privilege('money_compliance_worker', 'money_private.record_compliance_evidence(text,text,text,text,text,bytea,text,timestamptz,timestamptz,jsonb)', 'EXECUTE') as compliance_worker_evidence,
        has_function_privilege('money_compliance_worker', 'money_private.approve_compliance_subject(text,text,timestamptz,text,text)', 'EXECUTE') as compliance_worker_approve,
        has_function_privilege('money_compliance_worker', 'money_private.enqueue_compliance_event(text,text,text,text,bytea)', 'EXECUTE') as compliance_worker_enqueue,
        has_table_privilege('money_compliance_worker', 'money.compliance_evidence', 'SELECT') as compliance_worker_table,
        has_function_privilege('money_compliance_ingress', 'money_private.enqueue_compliance_event(text,text,text,text,bytea)', 'EXECUTE') as compliance_ingress_enqueue,
        has_function_privilege('money_compliance_ingress', 'money_private.record_compliance_evidence(text,text,text,text,text,bytea,text,timestamptz,timestamptz,jsonb)', 'EXECUTE') as compliance_ingress_evidence,
        has_table_privilege('money_compliance_ingress', 'money.compliance_event_inbox', 'SELECT') as compliance_ingress_table,
        has_function_privilege('money_risk_worker', 'money_private.sweep_expired_compliance(integer)', 'EXECUTE') as risk_sweep,
        has_function_privilege('money_risk_worker', 'money_private.release_compliance_restriction(text,text,text)', 'EXECUTE') as risk_release,
        has_table_privilege('money_risk_worker', 'money.risk_decisions', 'SELECT') as risk_table,
        has_table_privilege('money_compliance_ops', 'money.compliance_cases', 'SELECT') as compliance_ops_table,
        has_function_privilege('money_compliance_ops', 'money_private.compliance_subject_state(text)', 'EXECUTE') as compliance_ops_state,
        has_function_privilege('money_compliance_ops', 'money_private.approve_compliance_subject(text,text,timestamptz,text,text)', 'EXECUTE') as compliance_ops_approve,
        has_table_privilege('money_ops', 'money.compliance_cases', 'SELECT') as ops_compliance_table
    `);
    expect(privileges.rows[0]).toEqual({
      app_pay: false,
      app_safe_pay: true,
      app_grant_mandate: true,
      app_policy_read: true,
      app_register_raw: false,
      app_register_safe: true,
      app_signed_auth: true,
      app_session: true,
      app_global_health: false,
      app_market_register: true,
      app_market_challenge: true,
      app_market_refund: true,
      app_market_kernel: false,
      app_challenges: false,
      app_external_prepare: true,
      app_external_activate: true,
      app_external_resolve: true,
      app_external_rotate: false,
      app_external_confirm: true,
      app_external_secret: true,
      app_external_lookup: true,
      app_external_reverse: false,
      app_external_sweep: false,
      app_external_table: false,
      app_fund: false,
      app_generic: false,
      app_balances: false,
      app_approvals: false,
      app_mandates: false,
      app_nonces: false,
      app_sessions: false,
      treasury_fund: false,
      treasury_register: true,
      treasury_controls: true,
      treasury_resolve_review: true,
      treasury_resolve_event: true,
      treasury_restore: true,
      app_treasury_payout: true,
      app_treasury_get: true,
      app_treasury_settle: false,
      app_treasury_table: false,
      treasury_settle: false,
      treasury_payout_claim: false,
      treasury_worker_settle: true,
      treasury_worker_register: false,
      treasury_worker_controls: false,
      treasury_worker_trip: true,
      treasury_worker_resolve_review: false,
      treasury_worker_resolve_event: false,
      treasury_worker_restore: false,
      treasury_worker_table: false,
      ingress_enqueue: true,
      ingress_settle: false,
      ingress_table: false,
      payout_claim: true,
      payout_funding: false,
      payout_table: false,
      reconciler_snapshot: true,
      reconciler_payout: false,
      reconciler_table: false,
      worker_outbox: true,
      worker_external_sweep: true,
      worker_external_table: false,
      worker_ledger: false,
      key_rotation_list: true,
      key_rotation_reencrypt: true,
      key_rotation_table: false,
      ops_ledger: true,
      ops_global_health: true,
      ops_challenges: true,
      ops_treasury_health: true,
      ops_treasury_table: true,
      ops_treasury_reviews: true,
      ops_control_events: true,
      ops_event_reviews: true,
      app_compliance_begin: true,
      app_compliance_state: true,
      app_compliance_approve: false,
      app_compliance_table: false,
      compliance_admin_approve: true,
      compliance_admin_evidence: false,
      compliance_worker_evidence: true,
      compliance_worker_approve: false,
      compliance_worker_enqueue: false,
      compliance_worker_table: false,
      compliance_ingress_enqueue: true,
      compliance_ingress_evidence: false,
      compliance_ingress_table: false,
      risk_sweep: true,
      risk_release: false,
      risk_table: false,
      compliance_ops_table: true,
      compliance_ops_state: true,
      compliance_ops_approve: false,
      ops_compliance_table: false,
    });
  });

  it("runs the signed control-plane path under money_app while database bypasses fail", async () => {
    await db.executeScript(readFileSync(resolve("db/roles.sql"), "utf8"));
    await db.query("set role money_app");
    try {
      const registered = await db.query<{ id: string }>(
        "select id from money_private.register_public_identity(null, $1, 'user', 'Role owner', null, 'role-owner', $2)",
        ["usr_role0001", `role-public-key-${"x".repeat(40)}`]
      );
      expect(registered.rows[0]?.id).toBe("usr_role0001");
      await db.query(
        "select money_private.consume_signed_request($1, 'user', $2, 'role-nonce-0001', $3::bigint, $4::bytea)",
        ["usr_role0001", `role-public-key-${"x".repeat(40)}`, String(Date.now()), Buffer.alloc(32, 1)]
      );
      expect((await db.query("select * from money_private.account_state('usr_role0001', 'USD')")).rows).toHaveLength(1);
      expect((await db.query("select * from money_private.list_public_services(10, null, null)")).rows).toEqual([]);
      expect((await db.query("select max(version) as version from money.schema_migrations")).rows[0]).toEqual({ version: "0008" });
      await expect(db.query(
        "select * from money_private.register_account('usr_bypass01', 'user', 'Bypass', null, null, $1)",
        [`bypass-public-key-${"x".repeat(40)}`]
      )).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from money.balances")).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from money.challenges")).rejects.toThrow(/permission denied/);
      await expect(db.query(
        "select * from money_private.post_transfer_kernel('usr_role0001', 'refund', 'bypass', 'usr_role0001', 'external:funding', 'USD', 1, '', '{}'::jsonb, null)"
      )).rejects.toThrow(/permission denied/);
    } finally {
      await db.query("reset role");
    }
  });
});
