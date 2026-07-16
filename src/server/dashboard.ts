/**
 * The live dashboard: one self-contained page (inline CSS/JS, no external
 * CDNs) showing balances, mandates, and the receipt feed in real time over
 * Server-Sent Events. Read-only, and served on 127.0.0.1 — it is the owner's
 * window into the loop, not an admin surface.
 *
 * Everything interpolated into the DOM goes through esc(): memos and names
 * are agent-controlled strings, and a payment memo must never be able to
 * script the owner's dashboard.
 */
export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>money · live</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #11151f; --border: #1f2633;
    --text: #e2e8f0; --dim: #8b93a7; --accent: #4ade80;
    --red: #f87171; --amber: #fbbf24; --blue: #60a5fa; --purple: #c084fc;
    --mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; padding: 20px; }
  header { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
  .brand { font-size: 20px; font-weight: 700; letter-spacing: .02em; }
  .brand .sub { font-size: 13px; font-weight: 400; color: var(--dim); margin-left: 10px; }
  .badges { display: flex; gap: 8px; }
  .badge { font: 12px var(--mono); padding: 3px 10px; border: 1px solid var(--border); border-radius: 99px; color: var(--dim); }
  .badge.ok { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
  .badge.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); }
  main { display: grid; grid-template-columns: minmax(340px, 5fr) minmax(340px, 6fr); gap: 20px; }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; } }
  section h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .12em; color: var(--dim); margin: 18px 0 8px; }
  section h2:first-child { margin-top: 0; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 8px 12px; border-top: 1px solid var(--border); vertical-align: baseline; }
  tr:first-child td { border-top: none; }
  .kind { font: 11px var(--mono); padding: 1px 8px; border-radius: 99px; border: 1px solid var(--border); }
  .kind.user { color: var(--blue); } .kind.agent { color: var(--accent); }
  .kind.provider { color: var(--purple); } .kind.external { color: var(--dim); }
  .id { font: 12px var(--mono); color: var(--dim); }
  .amt { font: 13px var(--mono); text-align: right; white-space: nowrap; }
  .amt.neg { color: var(--red); }
  .mandate { padding: 12px; border-top: 1px solid var(--border); }
  .mandate:first-child { border-top: none; }
  .mandate .row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .mandate .caps { font: 12px var(--mono); color: var(--dim); margin-top: 6px; }
  .bar { height: 6px; background: #1a2030; border-radius: 99px; margin: 6px 0 2px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); border-radius: 99px; transition: width .4s; }
  .bar i.warn { background: var(--amber); } .bar i.full { background: var(--red); }
  .bar-label { display: flex; justify-content: space-between; font: 11px var(--mono); color: var(--dim); }
  .receipt { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 12px; padding: 10px 12px; border-top: 1px solid var(--border); }
  .receipt:first-child { border-top: none; }
  .receipt.fresh { animation: flash 1.6s ease-out; }
  @keyframes flash { from { background: rgba(74, 222, 128, .14); } to { background: transparent; } }
  .receipt .time { font: 12px var(--mono); color: var(--dim); }
  .receipt .route { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .receipt .route .arrow { color: var(--dim); padding: 0 4px; }
  .receipt .memo { grid-column: 2; font-size: 12px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .receipt .seq { grid-column: 3; font: 11px var(--mono); color: var(--dim); text-align: right; }
  .empty { padding: 16px; color: var(--dim); font-size: 13px; }
  footer { margin-top: 16px; font: 12px var(--mono); color: var(--dim); }
</style>
</head>
<body>
<header>
  <div class="brand">money<span class="sub">closed-loop agent payment network · live</span></div>
  <div class="badges">
    <span id="conn" class="badge">connecting…</span>
    <span id="zerosum" class="badge">zero-sum</span>
    <span id="chain" class="badge">receipt chain</span>
  </div>
</header>
<main>
  <section>
    <h2>Balances</h2>
    <div class="panel"><table><tbody id="accounts"><tr><td class="empty">no accounts yet</td></tr></tbody></table></div>
    <h2>Mandates</h2>
    <div class="panel" id="mandates"><div class="empty">no mandates yet</div></div>
  </section>
  <section>
    <h2>Live receipts <span id="count"></span></h2>
    <div class="panel" id="feed"><div class="empty">waiting for payments…</div></div>
  </section>
</main>
<footer id="foot"></footer>
<script>
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function fmt(micros) {
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  const dollars = Math.floor(abs / 1_000_000);
  const frac = abs % 1_000_000;
  if (frac === 0) return sign + "$" + dollars + ".00";
  let f = String(frac).padStart(6, "0").replace(/0+$/, "");
  if (f.length < 2) f = f.padEnd(2, "0");
  return sign + "$" + dollars + "." + f;
}

const KIND_ORDER = { user: 0, agent: 1, provider: 2, external: 3 };
let lastSeq = -1;

function bar(spent, cap) {
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 100;
  const cls = pct >= 100 ? "full" : pct >= 75 ? "warn" : "";
  return '<div class="bar"><i class="' + cls + '" style="width:' + pct.toFixed(1) + '%"></i></div>';
}

function render(s) {
  const name = (id) => { const a = s.accounts.find((x) => x.id === id); return a ? a.name : id; };
  setBadge("zerosum", s.zeroSum, "zero-sum ✓", "ZERO-SUM BROKEN");
  setBadge("chain", s.receiptsOk, "receipt chain ✓", "RECEIPT CHAIN BROKEN");

  const accounts = [...s.accounts].sort((a, b) =>
    (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.name.localeCompare(b.name));
  $("accounts").innerHTML = accounts.map((a) =>
    "<tr><td><span class=\\"kind " + esc(a.kind) + "\\">" + esc(a.kind) + "</span></td>" +
    "<td>" + esc(a.name) + " <span class=\\"id\\">" + esc(a.id) + "</span></td>" +
    "<td class=\\"amt" + (a.balanceMicros < 0 ? " neg" : "") + "\\">" + fmt(a.balanceMicros) + "</td></tr>"
  ).join("") || '<tr><td class="empty">no accounts yet</td></tr>';

  const mandates = [...s.mandates].reverse();
  $("mandates").innerHTML = mandates.map((m) => {
    const expired = s.now > m.expiresAt;
    const status = m.revoked ? '<span class="badge bad">revoked</span>'
      : expired ? '<span class="badge bad">expired</span>'
      : '<span class="badge ok">active</span>';
    return '<div class="mandate"><div class="row"><div><b>' + esc(name(m.agentId)) +
      '</b> <span class="id">granted by ' + esc(name(m.userId)) + "</span></div>" + status + "</div>" +
      bar(m.spent, m.budget) +
      '<div class="bar-label"><span>budget ' + fmt(m.spent) + " / " + fmt(m.budget) + "</span>" +
      "<span>today " + fmt(m.spentToday) + " / " + fmt(m.dailyCap) + "</span></div>" +
      '<div class="caps">per-tx ' + fmt(m.perTxCap) + " · ask above " + fmt(m.escalateAbove) +
      " · new-payee " + fmt(m.newPayeeCap) + " · payees seen " + m.seenPayees.length + "</div></div>";
  }).join("") || '<div class="empty">no mandates yet</div>';

  const feed = [...s.feed].reverse();
  $("count").textContent = "· " + s.receiptCount + " total";
  $("feed").innerHTML = feed.map((r) =>
    '<div class="receipt' + (r.seq > lastSeq ? " fresh" : "") + '">' +
    '<span class="time">' + new Date(r.ts).toLocaleTimeString() + "</span>" +
    '<span class="route">' + esc(name(r.from)) + '<span class="arrow">→</span>' + esc(name(r.to)) + "</span>" +
    '<span class="amt">' + fmt(r.amount) + "</span>" +
    '<span class="memo">' + esc(r.memo || "—") + "</span>" +
    '<span class="seq">#' + r.seq + "</span></div>"
  ).join("") || '<div class="empty">waiting for payments…</div>';
  if (feed.length) lastSeq = Math.max(lastSeq, feed[0].seq);

  $("foot").textContent = "updated " + new Date(s.now).toLocaleTimeString();
}

function setBadge(id, ok, okText, badText) {
  const el = $(id);
  el.className = "badge " + (ok ? "ok" : "bad");
  el.textContent = ok ? okText : badText;
}

const es = new EventSource("/dashboard/events");
es.addEventListener("state", (e) => render(JSON.parse(e.data)));
es.onopen = () => setBadge("conn", true, "live", "");
es.onerror = () => setBadge("conn", false, "", "reconnecting…");
</script>
</body>
</html>
`;
