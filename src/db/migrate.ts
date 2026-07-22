import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { enforceProductionPreflight } from "../deploy/preflight.ts";
import type { SqlExecutor, TransactionalDatabase } from "./database.ts";
import { PostgresDatabase } from "./postgres.ts";

export interface AppliedMigration {
  version: string;
  checksum: string;
  applied: boolean;
}

const DEFAULT_MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
const MIGRATION_LOCK = 4_021_000_004;

async function bootstrap(tx: SqlExecutor): Promise<void> {
  await tx.query("create schema if not exists money");
  await tx.query(`
    create table if not exists money.schema_migrations (
      version text primary key,
      checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz not null default clock_timestamp()
    )
  `);
}

/** Apply ordered SQL files once and refuse checksum drift. All pending files
 * run under one advisory-locked transaction, so two booting API instances can
 * never interleave DDL or mark a partial migration complete. */
export async function runMigrations(
  db: TransactionalDatabase,
  migrationsDir = DEFAULT_MIGRATIONS
): Promise<AppliedMigration[]> {
  if (!existsSync(migrationsDir)) throw new Error(`migration directory not found: ${migrationsDir}`);
  const files = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/.test(name))
    .sort();
  if (files.length === 0) throw new Error(`no migrations found in ${migrationsDir}`);

  return db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await bootstrap(tx);
    const result: AppliedMigration[] = [];
    for (const file of files) {
      const version = file.slice(0, 4);
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = await tx.query<{ checksum: string }>(
        "select checksum from money.schema_migrations where version = $1",
        [version]
      );
      if (prior.rows[0]) {
        if (prior.rows[0].checksum !== checksum) {
          throw new Error(`migration ${version} checksum changed after it was applied`);
        }
        result.push({ version, checksum, applied: false });
        continue;
      }
      try {
        await tx.executeScript(sql);
      } catch (error) {
        const detail = error as Error & { position?: string; detail?: string; where?: string };
        throw new Error(
          `migration ${file} failed${detail.position ? ` at character ${detail.position}` : ""}: ${detail.message}` +
          `${detail.detail ? ` (${detail.detail})` : ""}${detail.where ? ` [${detail.where}]` : ""}`,
          { cause: error }
        );
      }
      await tx.query(
        "insert into money.schema_migrations(version, checksum) values ($1, $2)",
        [version, checksum]
      );
      result.push({ version, checksum, applied: true });
    }
    return result;
  });
}

async function main() {
  enforceProductionPreflight("migrate");
  const db = new PostgresDatabase({ applicationName: "money-migrate", maxConnections: 1, statementTimeoutMs: 60_000 });
  try {
    const result = await runMigrations(db, process.env.MONEY_MIGRATIONS);
    for (const migration of result) {
      console.log(`${migration.version} ${migration.applied ? "applied" : "already current"} ${migration.checksum.slice(0, 12)}`);
    }
  } finally {
    await db.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
