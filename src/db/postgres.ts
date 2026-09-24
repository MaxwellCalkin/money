import pg from "pg";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "./database.ts";

const { Pool } = pg;

export type PostgresSsl = boolean | { rejectUnauthorized: boolean; ca?: string };

export interface PostgresOptions {
  connectionString?: string;
  maxConnections?: number;
  idleTimeoutMs?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
  ssl?: PostgresSsl;
}

/** Query parameters pg-connection-string turns into an `ssl` object. When the
 * caller passes an explicit `ssl` option we strip them: pg merges the parsed
 * URL over the explicit config, so an in-URL `sslmode=require` would silently
 * replace a verify-full CA pin with a MITM-tolerant empty object. */
const URL_TLS_PARAMETERS = ["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl"] as const;

/** MONEY_DB_SSL → the pg `ssl` option. Unset or `off` leaves pg's default
 * (plaintext unless the URL says otherwise); `require` encrypts without
 * verifying the peer; `verify-full` pins the CA from MONEY_DB_SSL_CA (PEM)
 * and verifies the hostname — the only mode the hosted beta accepts. */
export function resolvePostgresSsl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PostgresSsl | undefined {
  const mode = env.MONEY_DB_SSL?.trim();
  if (!mode || mode === "off") return undefined;
  if (mode === "require") return { rejectUnauthorized: false };
  if (mode === "verify-full") {
    const ca = env.MONEY_DB_SSL_CA?.trim();
    if (!ca) throw new Error("MONEY_DB_SSL_CA (PEM) is required when MONEY_DB_SSL=verify-full");
    return { ca, rejectUnauthorized: true };
  }
  throw new Error("MONEY_DB_SSL must be one of off, require, verify-full");
}

function stripUrlTlsParameters(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return connectionString;
  }
  const original = url.search;
  if (!original) return connectionString;
  let changed = false;
  for (const name of URL_TLS_PARAMETERS) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  if (!changed) return connectionString;
  const query = url.searchParams.toString();
  // Replace only the query segment so the rest of the string (credentials,
  // host, database) reaches pg byte-for-byte as configured.
  const index = connectionString.indexOf(original);
  if (index < 0) {
    url.search = query;
    return url.toString();
  }
  return `${connectionString.slice(0, index)}${query ? `?${query}` : ""}${connectionString.slice(index + original.length)}`;
}

/** Production database adapter. One Pool per process; deployments should put
 * PgBouncer in transaction mode in front of Postgres rather than opening a
 * connection per HTTP request. */
export class PostgresDatabase implements TransactionalDatabase {
  readonly pool: pg.Pool;
  private readonly statementTimeoutMs: number;

  constructor(options: PostgresOptions = {}) {
    const configured = options.connectionString ?? process.env.DATABASE_URL;
    if (!configured) throw new Error("DATABASE_URL is required for Postgres mode");
    const connectionString = options.ssl !== undefined ? stripUrlTlsParameters(configured) : configured;
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
