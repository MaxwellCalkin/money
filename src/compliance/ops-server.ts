import { serve } from "@hono/node-server";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { PostgresCompliance } from "../db/compliance.ts";
import type { TransactionalDatabase } from "../db/database.ts";
import { PostgresDatabase } from "../db/postgres.ts";

function sameToken(expected: string, authorization?: string): boolean {
  const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

function port(value: string | undefined): number {
  const parsed = value === undefined ? 4025 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("COMPLIANCE_OPS_PORT must be an integer from 1 to 65535");
  }
  return parsed;
}

export function createComplianceOpsApi(
  db: TransactionalDatabase,
  token: string,
  compliance = new PostgresCompliance(db)
) {
  const app = new Hono();
  app.onError((error, c) => {
    console.error("compliance ops API error", error);
    return c.json({ ok: false, error: "internal_error" }, 500);
  });
  app.get("/health/live", (c) => c.json({ ok: true }));
  app.get("/health/ready", async (c) => {
    try {
      const result = await db.query<{ ready: boolean }>(`
        select to_regprocedure('money_private.compliance_subject_state(text)') is not null
          and to_regclass('money.compliance_subjects') is not null
          and to_regclass('money.risk_decisions') is not null as ready
      `);
      return result.rows[0]?.ready
        ? c.json({ ok: true })
        : c.json({ ok: false, error: "schema_not_ready" }, 503);
    } catch {
      return c.json({ ok: false, error: "database_unavailable" }, 503);
    }
  });

  app.get("/ops/compliance", async (c) => {
    if (!token || !sameToken(token, c.req.header("authorization"))) {
      return c.json({ error: "not_found" }, 404);
    }
    const [subjectCounts, lifecycle, limits, cases, decisions] = await Promise.all([
      db.query<{ state: string; count: string | number }>(`
        select state, count(*) as count from money.compliance_subjects
        group by state order by state
      `),
      db.query<{
        expiring_evidence: string | number;
        open_restrictions: string | number;
        open_cases: string | number;
        dead_events: string | number;
        denied_last_hour: string | number;
      }>(`
        select
          (select count(*) from money.compliance_subjects
           where state = 'approved' and (
             identity_expires_at <= clock_timestamp() + interval '7 days' or
             screening_expires_at <= clock_timestamp() + interval '7 days' or
             next_review_at <= clock_timestamp() + interval '7 days'
           )) as expiring_evidence,
          (select count(*) from money.compliance_restrictions where released_at is null) as open_restrictions,
          (select count(*) from money.compliance_cases
           where status in ('open','in_review','escalated','restricted')) as open_cases,
          (select count(*) from money.compliance_event_inbox where state = 'dead') as dead_events,
          (select count(*) from money.risk_decisions
           where outcome <> 'allow' and created_at >= clock_timestamp() - interval '1 hour') as denied_last_hour
      `),
      db.query<{
        risk_tier: string; per_transfer_micros: string | number | bigint;
        daily_cross_user_micros: string | number | bigint;
        daily_external_micros: string | number | bigint;
        daily_payout_micros: string | number | bigint;
        rolling_30d_outflow_micros: string | number | bigint;
      }>("select * from money.risk_limits order by risk_tier"),
      compliance.listCases(100),
      compliance.listRiskDecisions(100),
    ]);
    const counts = Object.fromEntries(subjectCounts.rows.map((row) => [row.state, Number(row.count)]));
    const stats = lifecycle.rows[0];
    const openRestrictions = Number(stats?.open_restrictions ?? 0);
    const openCases = Number(stats?.open_cases ?? 0);
    const expiringEvidence = Number(stats?.expiring_evidence ?? 0);
    const deadEvents = Number(stats?.dead_events ?? 0);
    const ok = openRestrictions === 0 && openCases === 0
      && expiringEvidence === 0 && deadEvents === 0;
    c.header("cache-control", "no-store");
    return c.json({
      ok,
      subjects: counts,
      expiringEvidence,
      openRestrictions,
      openCases,
      deadEvents,
      deniedLastHour: Number(stats?.denied_last_hour ?? 0),
      limits: limits.rows.map((row) => ({
        riskTier: row.risk_tier,
        perTransferMicros: String(row.per_transfer_micros),
        dailyCrossUserMicros: String(row.daily_cross_user_micros),
        dailyExternalMicros: String(row.daily_external_micros),
        dailyPayoutMicros: String(row.daily_payout_micros),
        rolling30dOutflowMicros: String(row.rolling_30d_outflow_micros),
      })),
      recentCases: cases.map((item) => ({
        ...item,
        ...(item.transferSeq !== undefined ? { transferSeq: item.transferSeq.toString() } : {}),
        dueAt: item.dueAt?.toISOString(),
        closedAt: item.closedAt?.toISOString(),
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
      recentNonAllowDecisions: decisions
        .filter((decision) => decision.outcome !== "allow")
        .map((decision) => ({
          ...decision,
          amountMicros: decision.amountMicros.toString(),
          createdAt: decision.createdAt.toISOString(),
        })),
    }, ok ? 200 : 503);
  });
  return app;
}

export async function startComplianceOpsServer(
  listenPort = port(process.env.COMPLIANCE_OPS_PORT)
) {
  const connectionString = process.env.MONEY_COMPLIANCE_OPS_DATABASE_URL;
  const token = process.env.MONEY_COMPLIANCE_OPS_TOKEN;
  if (!connectionString || !token) {
    throw new Error("MONEY_COMPLIANCE_OPS_DATABASE_URL and MONEY_COMPLIANCE_OPS_TOKEN are required");
  }
  const db = new PostgresDatabase({
    connectionString,
    applicationName: "money-compliance-ops",
    maxConnections: 3,
  });
  const app = createComplianceOpsApi(db, token);
  const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: listenPort });
  console.log(`compliance operations listening on :${listenPort}`);
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
if (isMain) startComplianceOpsServer().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
