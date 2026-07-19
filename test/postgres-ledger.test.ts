import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createDatabaseOpsApi } from "../src/server/database-ops.ts";

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
    return { owner, agent, peer };
  }

  it("applies checksum-locked migrations idempotently", async () => {
    const replay = await runMigrations(db);
    expect(replay).toEqual([
      expect.objectContaining({ version: "0001", applied: false }),
      expect.objectContaining({ version: "0002", applied: false }),
      expect.objectContaining({ version: "0003", applied: false }),
    ]);
    const rows = await db.query<{ version: string; checksum: string }>("select version, checksum from money.schema_migrations");
    expect(rows.rows).toEqual([
      expect.objectContaining({ version: "0001", checksum: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ version: "0002", checksum: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ version: "0003", checksum: expect.stringMatching(/^[0-9a-f]{64}$/) }),
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
    expect(await ready.json()).toEqual(expect.objectContaining({ ok: true, schemaVersion: "0003" }));
    expect((await app.request("/ops/reconcile")).status).toBe(404);
    const reconciled = await app.request("/ops/reconcile", { headers: { authorization: "Bearer ops-secret" } });
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toEqual({ ok: true, checked: 5, mismatches: [] });
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
      app_fund: boolean;
      app_generic: boolean;
      app_balances: boolean;
      app_approvals: boolean;
      app_mandates: boolean;
      app_nonces: boolean;
      app_sessions: boolean;
      treasury_fund: boolean;
      worker_outbox: boolean;
      worker_ledger: boolean;
      ops_ledger: boolean;
      ops_global_health: boolean;
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
        has_function_privilege('money_app', 'money_private.post_confirmed_funding(text,text,text,bigint,jsonb)', 'EXECUTE') as app_fund,
        has_function_privilege('money_app', 'money_private.post_transfer(text,text,text,text,text,text,bigint,text,jsonb)', 'EXECUTE') as app_generic,
        has_table_privilege('money_app', 'money.balances', 'SELECT') as app_balances,
        has_table_privilege('money_app', 'money.approvals', 'SELECT') as app_approvals,
        has_table_privilege('money_app', 'money.mandates', 'SELECT') as app_mandates,
        has_table_privilege('money_app', 'money.signed_request_nonces', 'SELECT') as app_nonces,
        has_table_privilege('money_app', 'money.owner_sessions', 'SELECT') as app_sessions,
        has_function_privilege('money_treasury', 'money_private.post_confirmed_funding(text,text,text,bigint,jsonb)', 'EXECUTE') as treasury_fund,
        has_table_privilege('money_worker', 'money.outbox_events', 'UPDATE') as worker_outbox,
        has_table_privilege('money_worker', 'money.ledger_entries', 'SELECT') as worker_ledger,
        has_table_privilege('money_ops', 'money.ledger_entries', 'SELECT') as ops_ledger,
        has_function_privilege('money_ops', 'money_private.ledger_health()', 'EXECUTE') as ops_global_health
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
      app_fund: false,
      app_generic: false,
      app_balances: false,
      app_approvals: false,
      app_mandates: false,
      app_nonces: false,
      app_sessions: false,
      treasury_fund: true,
      worker_outbox: true,
      worker_ledger: false,
      ops_ledger: true,
      ops_global_health: true,
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
      expect((await db.query("select max(version) as version from money.schema_migrations")).rows[0]).toEqual({ version: "0003" });
      await expect(db.query(
        "select * from money_private.register_account('usr_bypass01', 'user', 'Bypass', null, null, $1)",
        [`bypass-public-key-${"x".repeat(40)}`]
      )).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from money.balances")).rejects.toThrow(/permission denied/);
    } finally {
      await db.query("reset role");
    }
  });
});
