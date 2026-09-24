import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { PostgresPolicy } from "../src/db/policy.ts";
import { approveComplianceFixture } from "./helpers/compliance-fixture.ts";

function executor(transaction: Transaction): SqlExecutor {
  return {
    query: async <R extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = []
    ) => {
      const result = await transaction.query<R>(text, [...values]);
      return { rows: result.rows, affectedRows: result.affectedRows };
    },
    executeScript: async (text: string) => { await transaction.exec(text); },
  };
}

/** The superuser harness the other PGlite suites use: migrations and fixtures. */
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
    return this.pg.transaction(async (transaction) => work(executor(transaction)));
  }
  async close() { await this.pg.close(); }
}

/** Every call commits under `set local role`, so the ledger's DEFERRED balance
 * trigger fires at COMMIT as that role — after the SECURITY DEFINER posting
 * function has returned — exactly as a least-privilege login sees it through
 * the product API. Superuser suites never exercise this path. */
class AsRole implements TransactionalDatabase {
  constructor(private readonly pg: PGliteInterface, private readonly role: string) {}
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryRows<T>> {
    return this.transaction((tx) => tx.query<T>(text, values));
  }
  async executeScript(text: string) {
    await this.transaction((tx) => tx.executeScript(text));
  }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (transaction) => {
      await transaction.query(`set local role ${this.role}`);
      return work(executor(transaction));
    });
  }
  async close() {}
}

describe("postings committed under least-privilege roles", () => {
  let db: EmbeddedPostgres;
  let ledger: PostgresLedger;
  const ownerId = "usr_role_commit";
  const agentId = "agt_role_payer";
  const peerId = "agt_role_payee";

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    await db.executeScript(readFileSync(resolve("db/roles.sql"), "utf8"));
    ledger = new PostgresLedger(db);
    await ledger.registerAccount({ id: ownerId, kind: "user", name: "Role owner" });
    await ledger.registerAccount({ id: agentId, kind: "agent", name: "Role payer", ownerId });
    await ledger.registerAccount({ id: peerId, kind: "agent", name: "Role payee", ownerId });
    await approveComplianceFixture(db, ownerId);
    await ledger.postTransfer({
      actorId: ownerId, operation: "fund", idempotencyKey: "role-fund",
      from: "external:funding", to: ownerId, amountMicros: 10n,
    });
    await ledger.postTransfer({
      actorId: ownerId, operation: "allocate", idempotencyKey: "role-allocate",
      from: ownerId, to: agentId, amountMicros: 10n,
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it("runs every deferred constraint trigger as its owner (PostgreSQL 17 semantics, migration 0015)", async () => {
    // PostgreSQL 17 and earlier run a DEFERRED trigger as the role active at
    // COMMIT (the least-privilege login), not the definer that queued the event;
    // 18 changed that. PGlite and CI both run 18, so the hosted beta's Supabase
    // 17 is guarded only by this structural check: each such function must be
    // SECURITY DEFINER, and a new deferred trigger must be added here on purpose.
    const deferred = await db.query<{ trigger: string; fn: string; definer: boolean }>(`
      select t.tgname as trigger, p.oid::regprocedure::text as fn, p.prosecdef as definer
      from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where t.tginitdeferred and not t.tgisinternal
      order by 1
    `);
    expect(deferred.rows).toEqual([
      { trigger: "ledger_entries_balanced", fn: "money_private.assert_balanced_transfer()", definer: true },
    ]);
  });

  it("commits an agent payment requested as money_app", async () => {
    await new PostgresPolicy(db).grantMandate({
      userId: ownerId,
      agentId,
      budgetMicros: 5n,
      dailyCapMicros: 5n,
      perTxCapMicros: 5n,
      escalateAboveMicros: 5n,
      newPayeeCapMicros: 5n,
      expiresAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: "role-mandate",
    });
    const asApp = new PostgresPolicy(new AsRole(db.pg, "money_app"));
    const result = await asApp.requestPayment({
      agentId, to: peerId, amountMicros: 4n, idempotencyKey: "role-pay",
    });
    expect(result.status).toBe("posted");
    expect(await ledger.balance(agentId)).toBe(6n);
    expect(await ledger.balance(peerId)).toBe(4n);
    expect((await ledger.reconcile()).every((row) => row.matches)).toBe(true);
  });

  it("commits play-dollar funding as the beta app login, which money_app alone cannot post", async () => {
    // deploy/vercel/logins.sql: the grant lands on the LOGIN, never the role.
    await db.executeScript(`
      create role money_app_login nologin;
      grant money_app to money_app_login;
      grant execute on function
        money_private.post_confirmed_funding(text, text, text, bigint, jsonb)
        to money_app_login;
    `);
    const funding = {
      actorId: ownerId, operation: "fund" as const, idempotencyKey: "role-play-dollars",
      from: "external:funding", to: ownerId, amountMicros: 5n,
    };
    await expect(new PostgresLedger(new AsRole(db.pg, "money_app")).postTransfer(funding))
      .rejects.toThrow(/permission denied for function post_confirmed_funding/);
    const posted = await new PostgresLedger(new AsRole(db.pg, "money_app_login")).postTransfer(funding);
    expect(posted.status).toBe("posted");
    expect(await ledger.balance(ownerId)).toBe(5n);
  });
});
