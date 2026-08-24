import { serve } from "@hono/node-server";
import { pathToFileURL } from "node:url";
import { Hono, type Context } from "hono";
import { enforceProductionPreflight } from "../deploy/preflight.ts";
import type { TransactionalDatabase } from "../db/database.ts";
import { PostgresMetrics, type PublicMetricsDocument } from "../db/metrics.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import { listenHost } from "./listen.ts";

const RECEIPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Lowercased, format-validated receipt id or undefined. Verification is
 * lookup-by-exact-unguessable-uuid only; anything else is a uniform 404. */
export function parseReceiptId(raw: string | undefined): string | undefined {
  const candidate = raw?.trim().toLowerCase() ?? "";
  return RECEIPT_ID_PATTERN.test(candidate) ? candidate : undefined;
}

export function metricsSandboxLabelFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  // Honest labeling defaults ON; only an explicit "false" (a real-money
  // deployment decision) removes the banner.
  return env.MONEY_METRICS_SANDBOX_LABEL?.trim().toLowerCase() !== "false";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatUsd(micros: string): string {
  const value = BigInt(micros);
  const sign = value < 0n ? "-" : "";
  const magnitude = value < 0n ? -value : value;
  const dollars = magnitude / 1_000_000n;
  const cents = (magnitude % 1_000_000n) / 10_000n;
  return `${sign}$${dollars.toString()}.${cents.toString().padStart(2, "0")}`;
}

function lineageShare(part: string, whole: string): string {
  const partMicros = BigInt(part);
  const wholeMicros = BigInt(whole);
  if (wholeMicros <= 0n) return "—";
  return `${((Number(partMicros) / Number(wholeMicros)) * 100).toFixed(1)}%`;
}

const CLASS_DESCRIPTIONS: Record<string, string> = {
  internal: "closed-loop agent, allocation, and refund transfers",
  external: "x402 settlement debits and reversals",
  card: "reserved-card reserves, releases, and refunds",
  treasury: "provider-verified settlement and payout legs",
  funding: "development/sandbox funding credits",
};

/** The whole page is assembled from the aggregate document alone, so account
 * ids, handles, memos, payees, and merchant descriptors cannot appear in the
 * markup by construction. Self-contained: no external scripts, styles, or
 * fonts, and correct in both dark and light color schemes. */
export function renderMetricsPage(document: PublicMetricsDocument, sandbox: boolean): string {
  const totalTransfers = document.operationClasses.reduce((sum, row) => sum + row.transfers, 0);
  const classRows = document.operationClasses.map((row) => `
        <tr>
          <td><span class="tag tag-${escapeHtml(row.operationClass)}">${escapeHtml(row.operationClass)}</span>
            <span class="dim">${escapeHtml(CLASS_DESCRIPTIONS[row.operationClass] ?? "")}</span></td>
          <td class="num">${row.transfers}</td>
          <td class="num">${escapeHtml(formatUsd(row.volumeMicros))}</td>
          <td class="num dim">${escapeHtml(row.volumeMicros)}</td>
        </tr>`).join("");
  const weekRows = document.weekly.map((week) => `
        <tr>
          <td>${escapeHtml(week.week)}<span class="dim"> · ${escapeHtml(week.weekStart)}</span></td>
          <td class="num">${week.transfers}</td>
          <td class="num">${escapeHtml(formatUsd(week.volumeMicros))}</td>
          <td class="num">${week.activeAgents}</td>
          <td class="root"><code>${escapeHtml(week.chainRoot)}</code>
            <button type="button" class="copy" data-hex="${escapeHtml(week.chainRoot)}">copy</button></td>
        </tr>`).join("");
  const lineage = document.fundingLineage;
  const zeroState = document.weekly.length === 0;
  const cohortOffsets = document.cohorts.reduce(
    (max, cohort) => Math.max(max, cohort.activeByWeek.length), 0);
  const cohortHead = Array.from({ length: cohortOffsets }, (_, offset) =>
    `<th class="num">+${offset}w</th>`).join("");
  const cohortRows = document.cohorts.map((cohort) => `
        <tr>
          <td>${escapeHtml(cohort.cohortWeek)}<span class="dim"> · ${escapeHtml(cohort.weekStart)}</span></td>
          <td class="num">${cohort.cohortSize}</td>
          ${Array.from({ length: cohortOffsets }, (_, offset) => {
            const active = cohort.activeByWeek[offset];
            return active === undefined ? '<td class="num dim">·</td>' : `<td class="num">${active}</td>`;
          }).join("")}
        </tr>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>agentmoney · public metrics</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:#f6f8f7; --panel:#ffffff; --border:#d5ded9; --text:#14201a; --dim:#5d6f66;
    --accent:#0d7a4f; --warn-bg:#fff3cd; --warn-border:#e0c368; --warn-text:#5c4a08;
    --mono:ui-monospace,SFMono-Regular,Consolas,monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0b1512; --panel:#101d18; --border:#263a31; --text:#e9f4ee; --dim:#8fa79b;
      --accent:#5fe3a1; --warn-bg:#332905; --warn-border:#8a7420; --warn-text:#f3dd8f;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:960px; margin:auto; padding:28px 20px 64px; }
  h1 { margin:0; font-size:24px; letter-spacing:-.02em; }
  h2 { margin:34px 0 10px; font-size:16px; }
  p { margin:8px 0; }
  a { color:var(--accent); }
  .sub, .dim { color:var(--dim); font-size:13px; }
  .num, code, .metric-value { font-variant-numeric: tabular-nums; }
  .banner { margin:18px 0; padding:12px 16px; border:1px solid var(--warn-border);
    border-radius:10px; background:var(--warn-bg); color:var(--warn-text); font-weight:600; }
  .banner .detail { display:block; font-weight:400; font-size:13px; margin-top:4px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin:20px 0; }
  .tile { padding:14px 16px; border:1px solid var(--border); border-radius:12px; background:var(--panel); }
  .tile .label { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.07em; }
  .metric-value { margin-top:6px; font:700 22px var(--mono); }
  table { width:100%; border-collapse:collapse; background:var(--panel);
    border:1px solid var(--border); border-radius:12px; overflow:hidden; }
  th, td { padding:9px 12px; border-top:1px solid var(--border); text-align:left; vertical-align:top; }
  thead th { border-top:none; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); }
  td.num, th.num { text-align:right; font-family:var(--mono); font-size:13px; }
  .tag { display:inline-block; margin-right:8px; padding:2px 8px; border-radius:999px;
    border:1px solid var(--border); font:12px var(--mono); }
  code { font:12px var(--mono); word-break:break-all; }
  pre { padding:12px 14px; border:1px solid var(--border); border-radius:10px;
    background:var(--panel); overflow-x:auto; font:12.5px var(--mono); }
  .root { max-width:420px; }
  .copy { margin-left:8px; padding:2px 8px; border:1px solid var(--border); border-radius:7px;
    background:transparent; color:var(--dim); font:11px var(--mono); cursor:pointer; }
  .copy:hover { color:var(--accent); border-color:var(--accent); }
  .empty { padding:26px; border:1px dashed var(--border); border-radius:12px;
    color:var(--dim); text-align:center; background:var(--panel); }
  .scroll { overflow-x:auto; }
</style>
</head>
<body>
<main>
  <h1>agentmoney · public metrics</h1>
  <p class="sub">Generated ${escapeHtml(document.generatedAt)} · aggregates and chain evidence only ·
    <a href="/metrics.json">metrics.json</a></p>
${sandbox ? `  <div class="banner">Sandbox, no real funds.
    <span class="detail">This ledger runs on play dollars for the invite beta — nothing here is a bank, card, or deposit account.</span>
  </div>
` : ""}  <p>Every number below is derived from the hash-chained receipts journal.
  Honest zeroes are published as zeroes: nothing on this journal is faked,
  including the absence of traffic. The funding-lineage split labels
  founder/sandbox-funded volume instead of hiding it, and the weekly chain
  roots let anyone holding receipts re-derive inclusion offline.</p>

  <div class="tiles">
    <div class="tile"><div class="label">Funded agents</div>
      <div class="metric-value">${document.distinctFundedAgents}</div></div>
    <div class="tile"><div class="label">Paid sellers</div>
      <div class="metric-value">${document.distinctPaidProviders}</div></div>
    <div class="tile"><div class="label">Transfers</div>
      <div class="metric-value">${totalTransfers}</div></div>
    <div class="tile"><div class="label">Net spend</div>
      <div class="metric-value">${escapeHtml(formatUsd(lineage.spendMicros))}</div></div>
  </div>

  <h2>Transfers by operation class</h2>
  <table>
    <thead><tr><th>Class</th><th class="num">Transfers</th><th class="num">Volume</th><th class="num">Micros</th></tr></thead>
    <tbody>${classRows}
    </tbody>
  </table>

  <h2>Funding lineage</h2>
  <p class="sub">Where the money that gets spent ultimately came from. Spend that
  cannot be traced to provider-verified external settlement is counted as
  dev/sandbox-funded — conservative against ourselves, never the reverse.
  External funding is net of returns and payouts (recycled settlement counts
  once); spend is net of card releases, card refunds, and marketplace refunds
  (a fully released reservation or refunded purchase drops back out). Money an
  agent receives from another owner family's agent counts as dev/sandbox
  funding for the recipient — peer income can never manufacture external
  lineage — and each family's externally settled share is capped at the
  external settlement it actually received.</p>
  <table>
    <thead><tr><th>Lineage</th><th class="num">Spend</th><th class="num">Share</th><th class="num">Micros</th></tr></thead>
    <tbody>
      <tr><td>Dev/sandbox funded <span class="dim">founder-subsidized or play dollars</span></td>
        <td class="num">${escapeHtml(formatUsd(lineage.devAttributedSpendMicros))}</td>
        <td class="num">${escapeHtml(lineageShare(lineage.devAttributedSpendMicros, lineage.spendMicros))}</td>
        <td class="num dim">${escapeHtml(lineage.devAttributedSpendMicros)}</td></tr>
      <tr><td>Externally settled <span class="dim">provider-verified settlement lineage</span></td>
        <td class="num">${escapeHtml(formatUsd(lineage.externalAttributedSpendMicros))}</td>
        <td class="num">${escapeHtml(lineageShare(lineage.externalAttributedSpendMicros, lineage.spendMicros))}</td>
        <td class="num dim">${escapeHtml(lineage.externalAttributedSpendMicros)}</td></tr>
    </tbody>
  </table>
  <p class="dim">Funding credited to date — dev/sandbox: ${escapeHtml(formatUsd(lineage.devFundingMicros))}
  (${escapeHtml(lineage.devFundingMicros)} micros) · external settlement:
  ${escapeHtml(formatUsd(lineage.externalFundingMicros))} (${escapeHtml(lineage.externalFundingMicros)} micros).</p>

  <h2>Weekly activity and chain roots</h2>
${zeroState ? `  <div class="empty">No transfers yet. When the first receipt lands, its week
    appears here with a chain root anyone can re-derive.</div>
` : `  <table>
    <thead><tr><th>ISO week (UTC)</th><th class="num">Transfers</th><th class="num">Volume</th>
      <th class="num">Active agents</th><th>Cumulative chain root (sha256, hex)</th></tr></thead>
    <tbody>${weekRows}
    </tbody>
  </table>
`}
  <h2>Retention cohorts</h2>
  <p class="sub">Each row is the set of agents whose first active week was that
  ISO week; the +<i>k</i>w columns count how many of them were active again
  <i>k</i> weeks later. Counts only — never identities.</p>
${document.cohorts.length === 0 ? `  <div class="empty">No active agents yet. Cohorts appear with the first
    agent-sent transfer.</div>
` : `  <div class="scroll"><table>
    <thead><tr><th>Cohort (first active week)</th><th class="num">Agents</th>${cohortHead}</tr></thead>
    <tbody>${cohortRows}
    </tbody>
  </table></div>
`}
  <h2>Verify a receipt</h2>
  <p>Every transfer emits a signed receipt with a 32-byte evidence hash. If you
  hold a receipt id, verify its inclusion — no account required:</p>
  <pre>curl -s https://&lt;this-host&gt;/receipts/&lt;receipt-id&gt;/verify</pre>
  <p class="sub">The response is <code>{"exists":true,"transferSeq":…,"evidenceHash":"…",
  "operationClass":"…","weekBucket":"…"}</code> and nothing else — lookup is by exact
  unguessable id, and no listing endpoint exists. Chain roots are chained
  sha256: starting from the empty byte string, each receipt's 32 evidence-hash
  bytes are folded in <code>transferSeq</code> order
  (<code>root = sha256(root ‖ evidenceHash)</code>); a week's published root is the
  chain value at that week's end, so third parties holding receipts can
  re-derive inclusion offline. Derivation details: <code>docs/METRICS.md</code> in the
  agentmoney repo.</p>
</main>
<script>
  for (const button of document.querySelectorAll("button.copy")) {
    button.addEventListener("click", () => {
      const hex = button.getAttribute("data-hex") || "";
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(hex).then(() => {
          button.textContent = "copied";
          setTimeout(() => { button.textContent = "copy"; }, 1200);
        }, () => {});
      }
    });
  }
</script>
</body>
</html>
`;
}

/** Public wash-proof metrics surface. Deliberately unauthenticated: it serves
 * aggregates and chain evidence only, accepts no bodies or cookies, answers
 * GET alone, and its database identity can execute exactly two functions. */
export function createPublicMetricsApi(
  db: TransactionalDatabase,
  metrics = new PostgresMetrics(db),
  sandbox = metricsSandboxLabelFromEnv(),
  cacheTtlMs = 0,
  errorBackoffMs = cacheTtlMs > 0 ? Math.min(cacheTtlMs, 5_000) : 0,
) {
  const app = new Hono();
  let cached: { document: PublicMetricsDocument; expiresAt: number } | undefined;
  let inflight: Promise<PublicMetricsDocument> | undefined;
  let failedUntil = 0;

  // Single-flight with a short negative cache: however many public requests
  // arrive at once, at most one aggregate refresh is ever in flight, and a
  // failing database cannot be hammered with one refresh per request — the
  // unauthenticated surface must never become a database-DoS lever.
  const loadDocument = (): Promise<PublicMetricsDocument> => {
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.document);
    if (inflight) return inflight;
    if (failedUntil > Date.now()) {
      return Promise.reject(new Error("metrics refresh is backing off after a failure"));
    }
    inflight = metrics.publicMetrics()
      .then((document) => {
        if (cacheTtlMs > 0) cached = { document, expiresAt: Date.now() + cacheTtlMs };
        failedUntil = 0;
        return document;
      }, (error: unknown) => {
        if (errorBackoffMs > 0) failedUntil = Date.now() + errorBackoffMs;
        throw error;
      })
      .finally(() => { inflight = undefined; });
    return inflight;
  };

  app.onError((error, c) => {
    console.error("public metrics API error", error);
    return c.json({ ok: false, error: "internal_error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not_found" }, 404));

  // The surface is read-only by contract: GET and HEAD only (uptime monitors
  // and cache validators probe with HEAD; Hono serves it from the GET
  // handlers with an empty body), no bodies, no cookies.
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      c.header("allow", "GET, HEAD");
      return c.json({ error: "method_not_allowed" }, 405);
    }
    await next();
  });

  app.get("/health/live", (c) => {
    c.header("cache-control", "no-store");
    return c.json({ ok: true });
  });

  const page = async (c: Context) => {
    const document = await loadDocument();
    c.header("cache-control", "public, max-age=60");
    return c.html(renderMetricsPage(document, sandbox));
  };
  app.get("/", page);
  // Alias so the shared edge can route the whole surface on /metrics*.
  app.get("/metrics", page);

  app.get("/metrics.json", async (c) => {
    const document = await loadDocument();
    c.header("cache-control", "public, max-age=60");
    return c.json({ sandbox, ...document });
  });

  app.get("/receipts/:id/verify", async (c) => {
    const receiptId = parseReceiptId(c.req.param("id"));
    if (!receiptId) return c.json({ error: "not_found" }, 404);
    const verification = await metrics.verifyReceipt(receiptId);
    if (!verification.exists) return c.json({ error: "not_found" }, 404);
    c.header("cache-control", "public, max-age=60");
    return c.json({
      exists: true,
      transferSeq: verification.transferSeq,
      evidenceHash: verification.evidenceHash,
      operationClass: verification.operationClass,
      weekBucket: verification.weekBucket,
    });
  });

  return app;
}

export async function startPublicMetricsServer(
  port = Number(process.env.MONEY_METRICS_PORT ?? 4028),
) {
  enforceProductionPreflight("public-metrics");
  const db = new PostgresDatabase({
    connectionString: process.env.MONEY_METRICS_DATABASE_URL,
    applicationName: "money-public-metrics",
    statementTimeoutMs: 10_000,
  });
  // The in-process cache matches the public cache-control window, bounding a
  // hostile crawl at one aggregate query per minute.
  const app = createPublicMetricsApi(db, new PostgresMetrics(db), metricsSandboxLabelFromEnv(), 60_000);
  const server = serve({ fetch: app.fetch, hostname: listenHost("127.0.0.1"), port });
  console.log(`public metrics listening on :${port}`);

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
if (isMain) startPublicMetricsServer().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
