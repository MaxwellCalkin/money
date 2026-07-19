import { serve } from "@hono/node-server";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import type { TransactionalDatabase } from "../db/database.ts";
import { PostgresLedger } from "../db/ledger.ts";
import { runMigrations } from "../db/migrate.ts";
import { PostgresDatabase } from "../db/postgres.ts";

function sameToken(expected: string, authorization?: string): boolean {
  const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Operational surface for the database-backed kernel. Payment APIs live in
 * the signed product control plane; this process exposes only probes and
 * token-gated reconciliation. */
export function createDatabaseOpsApi(
  db: TransactionalDatabase,
  ledger = new PostgresLedger(db),
  opsToken = process.env.MONEY_OPS_TOKEN ?? ""
) {
  const app = new Hono();
  app.onError((error, c) => {
    console.error("database ops API error", error);
    return c.json({ ok: false, error: "internal_error" }, 500);
  });

  app.get("/health/live", (c) => c.json({ ok: true }));

  app.get("/health/ready", async (c) => {
    const started = performance.now();
    try {
      const result = await db.query<{
        version: string | null;
        posting_ready: boolean;
      }>(`
        select
          (select max(version) from money.schema_migrations) as version,
          to_regprocedure('money_private.request_agent_payment(text,text,text,text,bigint,text)') is not null as posting_ready
      `);
      const row = result.rows[0];
      if (!row?.version || !row.posting_ready) {
        return c.json({ ok: false, error: "schema_not_ready" }, 503);
      }
      c.header("cache-control", "no-store");
      return c.json({
        ok: true,
        schemaVersion: row.version,
        latencyMs: Math.round((performance.now() - started) * 10) / 10,
      });
    } catch {
      return c.json({ ok: false, error: "database_unavailable" }, 503);
    }
  });

  app.get("/ops/reconcile", async (c) => {
    if (!opsToken || !sameToken(opsToken, c.req.header("authorization"))) {
      return c.json({ error: "not_found" }, 404);
    }
    const rows = await ledger.reconcile();
    const mismatches = rows.filter((row) => !row.matches);
    c.header("cache-control", "no-store");
    return c.json({
      ok: mismatches.length === 0,
      checked: rows.length,
      mismatches: mismatches.map((row) => ({
        accountId: row.accountId,
        asset: row.asset,
        cachedMicros: row.cachedMicros.toString(),
        journalMicros: row.journalMicros.toString(),
      })),
    }, mismatches.length === 0 ? 200 : 503);
  });

  return app;
}

export async function startDatabaseOpsServer(port = Number(process.env.OPS_PORT ?? 4022)) {
  const db = new PostgresDatabase({ applicationName: "money-ops" });
  if (process.env.MONEY_AUTO_MIGRATE === "true") await runMigrations(db);
  const app = createDatabaseOpsApi(db);
  const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port });
  console.log(`database health and reconciliation listening on :${port}`);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  };
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  return { app, server, db, close };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startDatabaseOpsServer().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
