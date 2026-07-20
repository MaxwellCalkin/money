import { serve } from "@hono/node-server";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import type { TransactionalDatabase } from "../db/database.ts";
import { PostgresLedger } from "../db/ledger.ts";
import { runMigrations } from "../db/migrate.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import { PostgresTreasury } from "../db/treasury.ts";

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
  opsToken = process.env.MONEY_OPS_TOKEN ?? "",
  treasury = new PostgresTreasury(db)
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
          to_regprocedure('money_private.request_agent_payment(text,text,text,text,bigint,text)') is not null
          and to_regprocedure('money_private.treasury_health()') is not null
          and to_regprocedure('money_private.compliance_subject_state(text)') is not null as posting_ready
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

  app.get("/ops/treasury", async (c) => {
    if (!opsToken || !sameToken(opsToken, c.req.header("authorization"))) {
      return c.json({ error: "not_found" }, 404);
    }
    const [health, controls, lifecycle, controlEvents, eventReviews, payoutReviews] = await Promise.all([
      treasury.health(),
      treasury.controlState(),
      db.query<{ dead_events: string | number; manual_payouts: string | number; blocked_payouts: string | number }>(`
        select
          (select count(*) from money.treasury_event_inbox where state = 'dead') as dead_events,
          (select count(*) from money.treasury_payouts where state = 'manual_review') as manual_payouts,
          (select count(*) from money.treasury_payouts p
             join money.treasury_destinations d on d.id = p.destination_id
           where p.state = 'queued' and d.status <> 'verified') as blocked_payouts
      `),
      db.query<{
        id: string | number; action: string; funding_enabled: boolean; payouts_enabled: boolean;
        external_spend_enabled: boolean; reason: string; database_actor: string;
        created_at: Date | string;
      }>(`
        select id, action, funding_enabled, payouts_enabled, external_spend_enabled,
          reason, database_actor, created_at
        from money.treasury_control_events
        order by id desc limit 20
      `),
      db.query<{
        id: string; inbox_id: string | number; resolution: string; prior_error: string | null;
        review_reference: string; reason: string; database_actor: string; created_at: Date | string;
      }>(`
        select id, inbox_id, resolution, prior_error, review_reference, reason,
          database_actor, created_at
        from money.treasury_event_reviews
        order by created_at desc, id desc limit 20
      `),
      db.query<{
        id: string; payout_id: string; resolved_state: string; provider_transfer_id: string | null;
        review_reference: string; reason: string; created_at: Date | string;
      }>(`
        select id, payout_id, resolved_state, provider_transfer_id,
          review_reference, reason, created_at
        from money.treasury_payout_reviews
        order by created_at desc, id desc limit 20
      `),
    ]);
    const deadEvents = Number(lifecycle.rows[0]?.dead_events ?? 0);
    const manualPayouts = Number(lifecycle.rows[0]?.manual_payouts ?? 0);
    const blockedPayouts = Number(lifecycle.rows[0]?.blocked_payouts ?? 0);
    const configured = health.some((row) => row.activeAssetAccounts > 0);
    const ok = configured && health.every((row) => row.withinTolerance)
      && controls.fundingEnabled && controls.payoutsEnabled && controls.externalSpendEnabled
      && deadEvents === 0 && manualPayouts === 0 && blockedPayouts === 0;
    c.header("cache-control", "no-store");
    return c.json({
      ok,
      configured,
      deadEvents,
      manualPayouts,
      blockedPayouts,
      controls: {
        fundingEnabled: controls.fundingEnabled,
        payoutsEnabled: controls.payoutsEnabled,
        externalSpendEnabled: controls.externalSpendEnabled,
        maxPayoutMicros: controls.maxPayoutMicros.toString(),
        maxPendingPayoutMicros: controls.maxPendingPayoutMicros.toString(),
        ...(controls.maxOpenExposureMicros !== undefined
          ? { maxOpenExposureMicros: controls.maxOpenExposureMicros.toString() } : {}),
        ...(controls.maxReconciliationVarianceMicros !== undefined
          ? { maxReconciliationVarianceMicros: controls.maxReconciliationVarianceMicros.toString() } : {}),
        ...(controls.breakerReason ? { breakerReason: controls.breakerReason } : {}),
        updatedAt: controls.updatedAt.toISOString(),
      },
      recentControlEvents: controlEvents.rows.map((event) => ({
        id: String(event.id), action: event.action,
        fundingEnabled: event.funding_enabled,
        payoutsEnabled: event.payouts_enabled,
        externalSpendEnabled: event.external_spend_enabled,
        reason: event.reason, databaseActor: event.database_actor,
        createdAt: new Date(event.created_at).toISOString(),
      })),
      recentEventReviews: eventReviews.rows.map((review) => ({
        id: review.id, inboxId: String(review.inbox_id), resolution: review.resolution,
        ...(review.prior_error ? { priorError: review.prior_error } : {}),
        reviewReference: review.review_reference, reason: review.reason,
        databaseActor: review.database_actor,
        createdAt: new Date(review.created_at).toISOString(),
      })),
      recentPayoutReviews: payoutReviews.rows.map((review) => ({
        id: review.id, payoutId: review.payout_id, resolvedState: review.resolved_state,
        ...(review.provider_transfer_id ? { providerTransferId: review.provider_transfer_id } : {}),
        reviewReference: review.review_reference, reason: review.reason,
        createdAt: new Date(review.created_at).toISOString(),
      })),
      assets: health.map((row) => ({
        asset: row.asset,
        expectedAssetMicros: row.expectedAssetMicros.toString(),
        observedAssetMicros: row.observedAssetMicros.toString(),
        uncertainOutflowMicros: row.uncertainOutflowMicros.toString(),
        shortfallMicros: row.shortfallMicros.toString(),
        excessMicros: row.excessMicros.toString(),
        openExposureMicros: row.openExposureMicros.toString(),
        activeAssetAccounts: row.activeAssetAccounts,
        observedAssetAccounts: row.observedAssetAccounts,
        snapshotComplete: row.snapshotComplete,
        withinTolerance: row.withinTolerance,
        ...(row.oldestObservedAt ? { oldestObservedAt: row.oldestObservedAt.toISOString() } : {}),
      })),
    }, ok ? 200 : 503);
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
