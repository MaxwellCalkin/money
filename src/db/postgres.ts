import pg from "pg";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "./database.ts";

const { Pool } = pg;

export interface PostgresOptions {
  connectionString?: string;
  maxConnections?: number;
  idleTimeoutMs?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

/** Production database adapter. One Pool per process; deployments should put
 * PgBouncer in transaction mode in front of Postgres rather than opening a
 * connection per HTTP request. */
export class PostgresDatabase implements TransactionalDatabase {
  readonly pool: pg.Pool;
  private readonly statementTimeoutMs: number;

  constructor(options: PostgresOptions = {}) {
    const connectionString = options.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required for Postgres mode");
    this.statementTimeoutMs = options.statementTimeoutMs ?? Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 5_000);
    this.pool = new Pool({
      connectionString,
      max: options.maxConnections ?? Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: options.applicationName ?? "money-api",
      ssl: options.ssl,
    });
    this.pool.on("error", (error) => console.error("idle Postgres connection failed", error));
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryRows<T>> {
    const result = await this.pool.query(text, [...values]);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  }

  async executeScript(text: string): Promise<void> {
    await this.pool.query(text);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('statement_timeout', $1, true)", [`${this.statementTimeoutMs}ms`]);
      await client.query("set local lock_timeout = '2s'");
      const tx: SqlExecutor = {
        query: async <R extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          values: readonly unknown[] = []
        ) => {
          const result = await client.query(text, [...values]);
          return { rows: result.rows as R[], rowCount: result.rowCount };
        },
        executeScript: async (text: string) => {
          await client.query(text);
        },
      };
      const value = await work(tx);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async ready(): Promise<{ ok: true; latencyMs: number }> {
    const started = performance.now();
    await this.pool.query("select 1 from money.schema_migrations limit 1");
    return { ok: true, latencyMs: Math.round((performance.now() - started) * 10) / 10 };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
