import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
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

/** Migration 0014: the hosted-beta waitlist. Validation runs inside the
 * SECURITY DEFINER function before any insert, dedupe is silent, the shared
 * cap is a silent no-op, and the product role can append but never read. */
describe("beta waitlist (migration 0014)", () => {
  let db: EmbeddedPostgres;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
  }, 30_000);

  afterEach(async () => {
    await db.close();
  });

  const join = (email: string | null, note: string | null) =>
    db.query("select money_private.join_waitlist($1, $2)", [email, note]);
  const count = async () =>
    (await db.query<{ n: number }>("select count(*)::int as n from money.beta_waitlist")).rows[0]!.n;

  it("stores one row per normalized email and ignores later case and whitespace variants", async () => {
    await join("Pilot@Example.com", "  what my agent would buy  ");
    await join("  pilot@example.com ", null);
    await join("PILOT@EXAMPLE.COM", "a different note");
    expect(await count()).toBe(1);
    const rows = await db.query<{ email: string; email_normalized: string; note: string | null; source: string }>(
      "select email, email_normalized, note, source from money.beta_waitlist",
    );
    expect(rows.rows).toEqual([{
      email: "Pilot@Example.com",
      email_normalized: "pilot@example.com",
      note: "what my agent would buy",
      source: "landing",
    }]);
  });

  it("stores a blank note as null and accepts a 254-character address", async () => {
    await join("blank@example.com", "   ");
    const longLocal = "x".repeat(254 - "@example.com".length);
    await join(`${longLocal}@example.com`, "n".repeat(500));
    const rows = await db.query<{ email_normalized: string; note: string | null }>(
      "select email_normalized, note from money.beta_waitlist order by email_normalized",
    );
    expect(rows.rows).toEqual([
      { email_normalized: "blank@example.com", note: null },
      { email_normalized: `${longLocal}@example.com`, note: "n".repeat(500) },
    ]);
  });

  it("raises 22023 for a bad email or an oversize note before touching the table", async () => {
    const bad = [
      null,
      "",
      "   ",
      "no-at-sign",
      "two@@at.example",
      "@example.com",
      "user@",
      "spaces in@example.com",
      "tab\t@example.com",
      "ctrl\u0001@example.com",
      `${"x".repeat(250)}@example.com`,
    ];
    for (const email of bad) {
      await expect(join(email, null), `email ${JSON.stringify(email)}`).rejects.toMatchObject({ code: "22023" });
    }
    await expect(join("ok@example.com", "n".repeat(501))).rejects.toMatchObject({ code: "22023" });
    expect(await count()).toBe(0);
  });

  it("silently no-ops past the shared hourly cap and resumes once the hour rolls over", async () => {
    await db.query(`
      insert into money.beta_waitlist (email, email_normalized, created_at)
      select 'cap' || i || '@example.com', 'cap' || i || '@example.com', now() - interval '10 minutes'
      from generate_series(1, 301) as i
    `);
    await join("late@example.com", "still polite");
    expect(await count()).toBe(301);
    await db.query("update money.beta_waitlist set created_at = now() - interval '2 hours'");
    await join("late@example.com", "still polite");
    expect(await count()).toBe(302);
  });

  it("grants money_app the append function and nothing on the table", async () => {
    await db.executeScript(readFileSync(resolve("db/roles.sql"), "utf8"));
    const privileges = (await db.query(`
      select
        has_function_privilege('money_app', 'money_private.join_waitlist(text,text)', 'execute') as app_join,
        has_table_privilege('money_app', 'money.beta_waitlist', 'select') as app_select,
        has_table_privilege('money_app', 'money.beta_waitlist', 'insert') as app_insert,
        has_table_privilege('money_ops', 'money.beta_waitlist', 'select') as ops_select,
        has_function_privilege('money_worker', 'money_private.join_waitlist(text,text)', 'execute') as worker_join,
        has_function_privilege('money_card_ingress', 'money_private.join_waitlist(text,text)', 'execute') as ingress_join,
        has_function_privilege('money_metrics', 'money_private.join_waitlist(text,text)', 'execute') as metrics_join
    `)).rows[0];
    expect(privileges).toEqual({
      app_join: true,
      app_select: false,
      app_insert: false,
      ops_select: false,
      worker_join: false,
      ingress_join: false,
      metrics_join: false,
    });

    await db.query("set role money_app");
    try {
      await join("role@example.com", null);
      await expect(db.query("select * from money.beta_waitlist")).rejects.toThrow(/permission denied/);
      await expect(db.query("select count(*) from money.beta_waitlist")).rejects.toThrow(/permission denied/);
      await expect(db.query("delete from money.beta_waitlist")).rejects.toThrow(/permission denied/);
    } finally {
      await db.query("reset role");
    }
    expect(await count()).toBe(1);
  });
});
