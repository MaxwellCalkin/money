import { Hono } from "hono";
import type { TransactionalDatabase } from "../db/database.ts";
import { PostgresMetrics } from "../db/metrics.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import { createPublicMetricsApi } from "../server/metrics.ts";
import { betaPoolOptions, readBetaPosture, requiredBetaVariable, type BetaEnvironment } from "./vercel-shared.ts";

const METRICS_CACHE_TTL_MS = 60_000;
const INNER_CACHE_CONTROL = "public, max-age=60";
const EDGE_CACHE_CONTROL = "public, max-age=60, s-maxage=60";
const METRICS_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'";

export interface VercelMetricsDependencies {
  database?: TransactionalDatabase;
}

/** The public wash-proof metrics surface as its own serverless function. It
 * holds exactly one credential (the money_metrics login) and shares no
 * process.env with any money-moving identity; the main origin rewrites
 * /metrics* and /receipts/* here. Responses are cacheable at the CDN for a
 * minute so a crawl never reaches the single-flight cache more than once
 * per instance per minute. The sandbox label is forced on. */
export function createVercelMetricsApp(env: BetaEnvironment, deps: VercelMetricsDependencies = {}) {
  readBetaPosture(env, "metrics");
  if (env.MONEY_METRICS_SANDBOX_LABEL?.trim().toLowerCase() === "false") {
    throw new Error("vercel metrics profile: MONEY_METRICS_SANDBOX_LABEL=false is refused (this beta is sandbox money only)");
  }
  const db = deps.database ?? new PostgresDatabase(betaPoolOptions(env, {
    connectionString: requiredBetaVariable(env, "MONEY_METRICS_DATABASE_URL", "metrics"),
    applicationName: "money-beta-metrics",
    statementTimeoutMs: 10_000,
  }));
  const metricsApp = createPublicMetricsApi(db, new PostgresMetrics(db), true, METRICS_CACHE_TTL_MS);

  const app = new Hono();
  app.all("/*", async (c) => {
    const inner = await metricsApp.fetch(c.req.raw);
    const headers = new Headers(inner.headers);
    if (headers.get("cache-control") === INNER_CACHE_CONTROL) headers.set("cache-control", EDGE_CACHE_CONTROL);
    headers.set("content-security-policy", METRICS_CSP);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    return new Response(inner.body, { status: inner.status, statusText: inner.statusText, headers });
  });
  return app;
}
