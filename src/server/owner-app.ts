/**
 * The owner app: "a private ledger you can hold."
 *
 * Self-contained owner surface for the Postgres product API. No third-party
 * scripts, fonts, styles, or images — every glyph is text or CSS-drawn — so
 * payment data and the short-lived bearer token stay same-origin. The page
 * renders exclusively from GET /dashboard/state (ownerSnapshot) and writes
 * through the existing owner routes; when `sessionOwnerWrites` is false the
 * funding/allocation/mandate sheets render a signature panel instead of a
 * submit button, because those routes accept only owner-signed requests.
 *
 * Only the two config booleans are interpolated (via JSON.stringify, plus a
 * conditional static sandbox strip chosen by them), so the template has zero
 * injection surface.
 */

export interface OwnerAppConfig {
  /** Owner sessions may call /fund, /allocate, /mandates* (sandbox only). */
  sessionOwnerWrites: boolean;
  /** The sandbox funding rail (POST /fund) is enabled on this API. */
  developmentFunding: boolean;
}

const SANDBOX_SENTENCE = "SANDBOX — no real funds; nothing here is a bank, card, or deposit account.";

export function ownerAppHtml(config: OwnerAppConfig): string {
  const sandbox = Boolean(config.sessionOwnerWrites || config.developmentFunding);
  const configJson = JSON.stringify({
    sessionOwnerWrites: Boolean(config.sessionOwnerWrites),
    developmentFunding: Boolean(config.developmentFunding),
  });
  const sandboxStrip = sandbox
    ? `<div id="sandboxStrip" class="sandbox-strip" role="note">${SANDBOX_SENTENCE}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentmoney · owner</title>
<style>
  :root {
    color-scheme: dark;
    --bg:#07100D; --glow1:#0E2A1E; --glow2:#0B241A;
    --panel:rgba(18,32,26,.72); --panel-solid:#12201A; --inner:rgba(9,19,15,.55);
    --border:rgba(151,199,176,.14); --border-strong:rgba(151,199,176,.28);
    --ink:#F2F7F2; --dim:#93A89C; --faint:#5E7168;
    --approve:#4ADE87; --on-approve:#052014; --approve-dim:rgba(74,222,135,.12);
    --decline:#ED5A6E; --decline-dim:rgba(237,90,110,.10);
    --pending:#EFC368; --pending-dim:rgba(239,195,104,.10);
    --rail:rgba(151,199,176,.18); --rule:rgba(151,199,176,.05);
    --shadow:0 12px 40px rgba(0,0,0,.35);
    --spring:cubic-bezier(.34,1.3,.4,1);
    --mono:ui-monospace,'Cascadia Mono','Segoe UI Mono',SFMono-Regular,Menlo,Consolas,monospace;
    --sans:ui-sans-serif,'Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,'SF Pro Text',Roboto,sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme=dark]) {
      color-scheme: light;
      --bg:#F4F7F5; --glow1:#E3EFE8; --glow2:#E8F1EB;
      --panel:rgba(255,255,255,.82); --panel-solid:#FFFFFF; --inner:rgba(11,42,28,.04);
      --border:rgba(11,42,28,.12); --border-strong:rgba(11,42,28,.26);
      --ink:#0B1A13; --dim:#5C6E64; --faint:#93A398;
      --approve:#0E8F4D; --on-approve:#FFFFFF; --approve-dim:rgba(14,143,77,.10);
      --decline:#C4314F; --decline-dim:rgba(196,49,79,.08);
      --pending:#8F6408; --pending-dim:rgba(143,100,8,.10);
      --rail:rgba(11,42,28,.16); --rule:rgba(11,42,28,.05);
      --shadow:0 12px 32px rgba(11,26,19,.12);
    }
  }
  :root[data-theme=light] {
    color-scheme: light;
    --bg:#F4F7F5; --glow1:#E3EFE8; --glow2:#E8F1EB;
    --panel:rgba(255,255,255,.82); --panel-solid:#FFFFFF; --inner:rgba(11,42,28,.04);
    --border:rgba(11,42,28,.12); --border-strong:rgba(11,42,28,.26);
    --ink:#0B1A13; --dim:#5C6E64; --faint:#93A398;
    --approve:#0E8F4D; --on-approve:#FFFFFF; --approve-dim:rgba(14,143,77,.10);
    --decline:#C4314F; --decline-dim:rgba(196,49,79,.08);
    --pending:#8F6408; --pending-dim:rgba(143,100,8,.10);
    --rail:rgba(11,42,28,.16); --rule:rgba(11,42,28,.05);
    --shadow:0 12px 32px rgba(11,26,19,.12);
  }
  :root[data-theme=dark] {
    color-scheme: dark;
    --bg:#07100D; --glow1:#0E2A1E; --glow2:#0B241A;
    --panel:rgba(18,32,26,.72); --panel-solid:#12201A; --inner:rgba(9,19,15,.55);
    --border:rgba(151,199,176,.14); --border-strong:rgba(151,199,176,.28);
    --ink:#F2F7F2; --dim:#93A89C; --faint:#5E7168;
    --approve:#4ADE87; --on-approve:#052014; --approve-dim:rgba(74,222,135,.12);
    --decline:#ED5A6E; --decline-dim:rgba(237,90,110,.10);
    --pending:#EFC368; --pending-dim:rgba(239,195,104,.10);
    --rail:rgba(151,199,176,.18); --rule:rgba(151,199,176,.05);
    --shadow:0 12px 40px rgba(0,0,0,.35);
  }

  * { box-sizing:border-box; }
  html, body { margin:0; }
  body {
    min-height:100vh; color:var(--ink);
    font:13px/1.45 var(--sans);
    background:
      radial-gradient(120% 90% at 18% -12%, var(--glow1) 0%, transparent 52%),
      radial-gradient(80% 60% at 105% 110%, var(--glow2) 0%, transparent 45%),
      var(--bg);
  }
  button, input, select { font:inherit; color:inherit; }
  code { font:12px var(--mono); color:var(--approve); }
  .hidden { display:none !important; }
  .mono { font-family:var(--mono); font-variant-numeric:tabular-nums; }
  .label { color:var(--dim); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; }

  .ruled {
    background:repeating-linear-gradient(180deg, transparent 0 27px, var(--rule) 27px 28px);
  }

  /* ---- header ---- */
  header {
    display:flex; align-items:center; justify-content:space-between; gap:8px 16px; flex-wrap:wrap;
    min-height:64px; max-width:1200px; margin:0 auto; padding:10px 24px;
  }
  .brand { display:flex; align-items:center; gap:11px; min-width:0; }
  .mark {
    flex:none; width:34px; height:34px; display:grid; place-items:center;
    border-radius:10px; background:var(--approve); color:var(--on-approve);
    font:800 19px var(--mono); box-shadow:0 0 26px rgba(74,222,135,.22);
  }
  h1 { margin:0; font-size:19px; letter-spacing:-.02em; font-weight:750; }
  .sub { color:var(--dim); font-size:12px; margin-top:1px; }
  .top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
  .pill {
    border:1px solid var(--border); border-radius:999px; padding:6px 10px;
    color:var(--dim); font:11px var(--mono); white-space:nowrap;
  }
  .pill.ok { color:var(--approve); border-color:var(--border-strong); }
  .pill.warn { color:var(--pending); }
  .pill.fail { color:var(--decline); border-color:var(--decline); background:var(--decline-dim); font-weight:700; }
  .pill .dot { display:inline-block; width:6px; height:6px; border-radius:99px; background:currentColor; margin-right:6px; vertical-align:1px; }

  .sandbox-strip {
    min-height:28px; display:flex; align-items:center; justify-content:center;
    padding:4px 14px; text-align:center;
    background:var(--pending-dim); color:var(--pending); font-size:12px;
    border-top:1px solid var(--border); border-bottom:1px solid var(--border);
  }

  main { max-width:1200px; margin:0 auto; padding:18px 24px 64px; }

  /* ---- buttons & inputs ---- */
  button { border:1px solid var(--border); border-radius:9px; background:var(--inner); color:var(--ink); padding:9px 13px; cursor:pointer; min-height:36px;
    transition:border-color 160ms var(--spring), background-color 160ms var(--spring), transform 90ms ease; }
  button:hover { border-color:var(--border-strong); }
  button:active { transform:scale(.98); }
  button:disabled { opacity:.45; cursor:default; transform:none; }
  button.primary { background:var(--approve); border-color:var(--approve); color:var(--on-approve); font-weight:750; }
  button.ghost { background:transparent; }
  button.danger-ghost { background:transparent; color:var(--decline); border-color:var(--decline); }
  button.textbtn { border:0; background:transparent; padding:8px 6px; color:var(--dim); min-height:40px; }
  button.textbtn:hover { color:var(--ink); }
  button.textbtn.crimson, button.text-danger { color:var(--decline); }
  button.big { width:100%; padding:13px; font-size:14px; border-radius:11px; }
  button.small { min-height:30px; padding:4px 9px; font-size:11px; }
  input, select {
    min-width:0; padding:10px 11px; border:1px solid var(--border); border-radius:9px;
    background:var(--inner); color:var(--ink); outline:none;
  }
  input:focus, select:focus { border-color:var(--approve); }
  input::placeholder { color:var(--faint); }

  .chip {
    display:inline-flex; align-items:center; gap:5px; border:1px solid var(--border);
    border-radius:999px; padding:2px 8px; font:11px var(--mono); color:var(--dim); white-space:nowrap;
  }
  .chip.approve { color:var(--approve); border-color:var(--approve); }
  .chip.amber { color:var(--pending); border-color:var(--pending); }
  .chip.crimson { color:var(--decline); border-color:var(--decline); }
  .chip.faint { color:var(--faint); }

  /* ---- panels & sections ---- */
  .panel {
    border:1px solid var(--border); border-radius:18px; background:var(--panel-solid);
    min-width:0; overflow:hidden;
    transition:border-color 160ms var(--spring), transform 160ms var(--spring), box-shadow 160ms var(--spring);
  }
  /* Large blurred panels repaint badly on weak GPUs and embedded renderers;
     panels stay near-opaque and only the small dialog sheet gets real glass. */
  .pad { padding:20px; }
  .sec-head { display:flex; align-items:baseline; justify-content:space-between; margin:22px 2px 10px; }
  .sec-head:first-child { margin-top:4px; }
  h2 { margin:0; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); }
  .count { color:var(--faint); font:11px var(--mono); }
  .empty { padding:26px 20px; color:var(--dim); text-align:center; line-height:1.6; }
  .panel-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px; border-top:1px solid var(--border); min-width:0; }
  .panel-row:first-child { border-top:0; }
  .meta { color:var(--dim); font:11px var(--mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px; }
  .amount { flex:none; font:700 13px var(--mono); font-variant-numeric:tabular-nums; }
  .amount.in { color:var(--approve); }
  .amount.declined { color:var(--decline); }
  .amount .minus { color:var(--dim); }

  /* ---- layout ---- */
  .cols { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(320px,.9fr); gap:16px; align-items:start; }
  .stack { display:grid; gap:16px; align-content:start; min-width:0; }

  /* ---- approval prompt ---- */
  .appr-panel { border-left:3px solid var(--pending); }
  .appr-head { display:flex; align-items:center; gap:9px; padding:14px 18px 4px; font-size:14px; font-weight:750; }
  .badge { background:var(--pending-dim); color:var(--pending); border-radius:999px; font:700 11px var(--mono); padding:2px 8px; }
  .appr { display:flex; gap:16px; justify-content:space-between; align-items:flex-start; padding:14px 18px 16px; border-top:1px solid var(--border); flex-wrap:wrap; }
  .appr:first-of-type { border-top:0; }
  .appr-main { min-width:220px; flex:1; }
  .appr-sentence { font-size:15px; font-weight:650; }
  .appr-memo { color:var(--dim); margin-top:4px; line-height:1.5; }
  .appr-tuple { color:var(--faint); font:11px var(--mono); margin-top:7px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:52ch; }
  .appr-side { display:grid; gap:10px; justify-items:end; }
  .appr-amount { font:800 24px var(--mono); font-variant-numeric:tabular-nums; }
  .appr-actions { display:flex; gap:8px; }

  /* ---- agents ---- */
  .agent-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:16px; }
  .agent-card { padding:20px; display:grid; gap:12px; align-content:start; }
  .agent-card:hover { transform:translateY(-1px); border-color:var(--border-strong); box-shadow:var(--shadow); }
  .agent-top { display:flex; align-items:center; justify-content:space-between; gap:10px; }
  .agent-id { display:flex; align-items:center; gap:10px; min-width:0; }
  .avatar { flex:none; width:28px; height:28px; display:grid; place-items:center; border-radius:9px; color:var(--approve); font:700 13px var(--mono); border:1px solid var(--border); }
  .agent-name { font-size:15px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .agent-handle { color:var(--dim); font:11px var(--mono); margin-top:1px; }
  .status-dot { display:inline-block; width:6px; height:6px; border-radius:99px; background:var(--faint); margin-left:6px; vertical-align:1px; }
  .status-dot.on { background:var(--approve); }
  .funds-figure { font:700 28px var(--mono); font-variant-numeric:tabular-nums; letter-spacing:-.01em; }
  .meter { height:6px; border-radius:99px; background:rgba(151,199,176,.12); overflow:hidden; }
  .meter > i { display:block; height:100%; border-radius:99px; background:var(--approve); transition:width 400ms ease-out; }
  .meter > i.warn { background:var(--pending); }
  .meter > i.over { background:var(--decline); }
  .meter-caption { color:var(--dim); font:11px var(--mono); margin-top:6px; line-height:1.6; }
  .no-mandate { padding:12px; border:1px dashed var(--border); border-radius:12px; color:var(--dim); display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
  .card-chips { display:flex; flex-wrap:wrap; gap:6px; }
  .cardglyph { display:inline-block; width:22px; height:14px; border-radius:3px; border:1px solid var(--border-strong); background:linear-gradient(135deg, rgba(151,199,176,.16), transparent); vertical-align:-2px; margin-right:2px; }
  .last-act { color:var(--dim); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .agent-foot { display:flex; gap:4px; border-top:1px solid var(--border); margin:2px -20px -20px; padding:2px 12px; }

  /* ---- feed: the ledger ---- */
  .feed { position:relative; }
  .feed::before { content:""; position:absolute; left:16px; top:14px; bottom:14px; width:2px; background:var(--rail); }
  .frow { position:relative; display:flex; gap:12px; align-items:flex-start; justify-content:space-between; padding:12px 16px 12px 34px; border-top:1px solid var(--border); cursor:pointer; min-width:0; }
  .frow:first-child { border-top:0; }
  .frow::before {
    content:""; position:absolute; left:13px; top:18px; width:7px; height:7px;
    transform:rotate(45deg); background:var(--approve); border-radius:1px;
  }
  .frow.declined { background:linear-gradient(90deg, var(--decline-dim), transparent 45%); box-shadow:inset 2px 0 0 var(--decline); }
  .frow.declined::before { background:transparent; border:1.5px solid var(--decline); }
  .frow.expired::before { background:transparent; border:1.5px solid var(--faint); }
  .frow.new { animation:rowin 240ms var(--spring); }
  @keyframes rowin { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
  .frow-main { min-width:0; flex:1; }
  .frow-title { font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .frow-title .chip { margin-left:7px; }
  .frow-reason { color:var(--dim); font-size:12px; margin-top:3px; line-height:1.5; }
  .frow-detail { margin-top:9px; padding:10px 12px; border:1px solid var(--border); border-radius:10px; background:var(--inner); display:grid; gap:6px; font:11px var(--mono); color:var(--dim); overflow-wrap:anywhere; }
  .frow-detail .k { color:var(--faint); margin-right:6px; text-transform:uppercase; letter-spacing:.06em; font-size:10px; }
  .hash-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }

  /* ---- reserved cards ---- */
  .crow { display:flex; align-items:center; gap:12px; padding:12px 16px; border-top:1px solid var(--border); min-width:0; }
  .crow:first-child { border-top:0; }
  .card-face {
    flex:none; position:relative; width:44px; height:28px; border-radius:5px;
    background:linear-gradient(135deg,#0E241B,#173626); border:1px solid var(--border-strong);
  }
  .card-face::before { content:""; position:absolute; left:5px; top:5px; width:5px; height:5px; transform:rotate(45deg); background:var(--rail); border-radius:1px; }
  .card-face .cf4 { position:absolute; right:4px; bottom:2px; color:rgba(242,247,242,.8); font:600 8px var(--mono); letter-spacing:.04em; }
  .crow-main { min-width:0; flex:1; display:grid; gap:5px; }
  .crow-line { display:flex; align-items:center; gap:7px; flex-wrap:wrap; font:600 13px var(--mono); }
  .micro-meter { height:4px; border-radius:99px; background:rgba(151,199,176,.12); overflow:hidden; max-width:180px; }
  .micro-meter > i { display:block; height:100%; background:var(--approve); border-radius:99px; transition:width 400ms ease-out; }
  .closing { color:var(--dim); font:11px var(--mono); }

  /* ---- owner funds / treasury ---- */
  .big-figure { font:700 30px var(--mono); font-variant-numeric:tabular-nums; margin-top:6px; letter-spacing:-.01em; }
  .dim-line { color:var(--dim); font-size:12px; margin-top:6px; line-height:1.55; }
  .funds-actions { margin-top:12px; display:flex; gap:8px; flex-wrap:wrap; }
  .breaker { padding:11px 16px; background:var(--decline-dim); color:var(--decline); border-top:1px solid var(--border); font-size:12px; line-height:1.5; }
  .payout-form { display:grid; grid-template-columns:minmax(0,1fr) 108px auto; gap:8px; padding:12px 16px; border-top:1px solid var(--border); }
  .decline-strip { margin:10px 16px; padding:10px 12px; border-radius:10px; background:var(--decline-dim); color:var(--decline); font-size:12px; line-height:1.5; box-shadow:inset 2px 0 0 var(--decline); }
  dialog .decline-strip { margin:12px 0 0; }
  .comp-row { display:flex; justify-content:flex-end; padding:2px 4px; }

  /* ---- sheets ---- */
  dialog.sheet {
    width:min(440px, calc(100vw - 32px)); border:1px solid var(--border-strong); border-radius:18px;
    background:var(--panel-solid); color:var(--ink); padding:0; box-shadow:var(--shadow);
  }
  @supports (backdrop-filter: blur(1px)) { dialog.sheet { background:var(--panel); backdrop-filter:blur(14px) saturate(1.15); } }
  dialog.sheet::backdrop { background:rgba(4,10,8,.6); backdrop-filter:blur(2px); animation:bfade 150ms ease-out; }
  dialog.sheet[open] { animation:sheetin 200ms var(--spring); }
  @keyframes sheetin { from { opacity:0; transform:translateY(10px) scale(.98); } to { opacity:1; transform:none; } }
  @keyframes bfade { from { opacity:0; } to { opacity:1; } }
  .sheet-body { padding:20px; display:grid; gap:12px; }
  .sheet-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
  .sheet-title { margin:0; font-size:16px; font-weight:750; letter-spacing:-.01em; }
  .sheet-sub { color:var(--dim); font-size:12px; }
  .xbtn { border:0; background:transparent; color:var(--dim); font-size:15px; min-height:36px; min-width:36px; border-radius:9px; }
  .xbtn:hover { color:var(--ink); }
  .preset-row { display:flex; gap:8px; flex-wrap:wrap; }
  .chipbtn { border-radius:999px; font:600 12px var(--mono); padding:7px 13px; }
  .chipbtn[aria-pressed=true] { border-color:var(--approve); color:var(--approve); }
  .amount-preview { text-align:center; font:700 34px var(--mono); font-variant-numeric:tabular-nums; padding:4px 0 2px; letter-spacing:-.01em; }
  .sheet-foot { color:var(--dim); font-size:11px; text-align:center; line-height:1.5; }
  .field-grid { display:grid; gap:11px; }
  .field-grid label { display:grid; gap:4px; font-size:12px; font-weight:650; }
  .cap { color:var(--dim); font-size:11px; font-weight:400; }
  .allow-wrap { display:grid; gap:8px; }
  .allow-chips { display:flex; flex-wrap:wrap; gap:6px; }
  .allow-chips .chip button { border:0; background:transparent; color:inherit; padding:0 0 0 4px; min-height:0; font-size:12px; cursor:pointer; }
  .allow-row { display:flex; gap:8px; }
  .sig-panel { border:1px solid var(--border); border-radius:12px; padding:14px; display:grid; gap:9px; background:var(--inner); }
  .sig-row { display:flex; align-items:center; gap:9px; font-weight:700; }
  .keyglyph { flex:none; width:16px; height:16px; border:2px solid var(--approve); border-radius:99px; position:relative; }
  .keyglyph::after { content:""; position:absolute; left:11px; top:4px; width:10px; height:2px; background:var(--approve); box-shadow:6px 3px 0 -1px var(--approve), 3px 3px 0 -1px var(--approve); }
  .sig-copy { margin:0; color:var(--dim); font-size:12px; line-height:1.55; }
  .code-row { display:flex; align-items:center; justify-content:space-between; gap:8px; border:1px solid var(--border); border-radius:9px; padding:7px 7px 7px 11px; }

  /* ---- lock ---- */
  .lock { display:grid; place-items:start center; padding-top:8vh; }
  .lock-card { width:min(480px, 100%); padding:26px; display:grid; gap:13px; }
  .lock-card h2 { font-size:22px; font-weight:750; text-transform:none; letter-spacing:-.01em; color:var(--ink); }
  .lock-card p { margin:0; color:var(--dim); line-height:1.6; }
  .token-row { display:flex; gap:8px; }
  .token-row input { flex:1; }
  .lock-error { color:var(--decline); font-size:12px; }

  .toast {
    position:fixed; right:18px; bottom:18px; z-index:40; max-width:320px;
    background:var(--panel-solid); border:1px solid var(--border-strong); border-radius:12px;
    padding:11px 14px; box-shadow:var(--shadow); font-size:12.5px;
    opacity:0; transform:translateY(6px); pointer-events:none;
    transition:opacity 200ms var(--spring), transform 200ms var(--spring);
  }
  .toast.show { opacity:1; transform:none; }

  @media (max-width:980px) {
    .cols { grid-template-columns:1fr; }
  }
  @media (max-width:520px) {
    header, main { padding-left:14px; padding-right:14px; }
    .funds-figure { font-size:24px; }
    .big-figure { font-size:26px; }
    .payout-form { grid-template-columns:1fr; }
    .appr-side { justify-items:start; }
    dialog.sheet { width:100vw; max-width:100vw; margin:0; inset:auto 0 0 0; border-radius:18px 18px 0 0; border-left:0; border-right:0; border-bottom:0; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation:none !important; transition:none !important; }
  }
</style>
</head>
<body>
<header>
  <div class="brand">
    <div class="mark" aria-hidden="true">a</div>
    <div><h1>agentmoney</h1><div class="sub">owner control · closed loop</div></div>
  </div>
  <div class="top">
    <span id="netPill" class="pill"><span class="dot" aria-hidden="true"></span><span id="netText">locked</span></span>
    <span id="integrityChip" class="pill hidden"></span>
    <span id="modeChip" class="pill hidden"></span>
    <button id="themeBtn" class="ghost small" aria-label="Switch color theme">theme</button>
    <button id="logoutBtn" class="ghost hidden">Log out</button>
  </div>
</header>
${sandboxStrip}
<main>
  <div id="lock" class="lock hidden">
    <div class="panel lock-card">
      <div class="brand"><div class="mark" aria-hidden="true">a</div><div><h1>agentmoney</h1><div class="sub">owner control · closed loop</div></div></div>
      <h2>Open your owner app</h2>
      <p>Your funds and agent activity are private. Run <code>npm run dashboard:login</code> and open the link it prints, or paste the one-session token below.</p>
      <div id="lockSandbox" class="chip amber hidden">sandbox</div>
      <div class="token-row">
        <input id="tokenInput" type="password" autocomplete="off" placeholder="Owner session token" aria-label="Owner session token">
        <button id="connectBtn" class="primary">Connect</button>
      </div>
      <div id="lockError" class="lock-error hidden"></div>
    </div>
  </div>

  <div id="app" class="hidden">
    <section id="approvalSection" class="hidden">
      <div class="panel appr-panel">
        <div class="appr-head">Needs your approval <span id="apprCount" class="badge"></span></div>
        <div id="apprList"></div>
      </div>
    </section>

    <div class="sec-head"><h2>Your agents</h2><span id="agentCount" class="count"></span></div>
    <div id="agentGrid" class="agent-grid"></div>

    <div class="cols" style="margin-top:22px">
      <section>
        <div class="sec-head" style="margin-top:0"><h2>Live feed</h2><span id="feedCount" class="count"></span></div>
        <div class="panel"><div id="feedList" class="feed"></div></div>
      </section>

      <div class="stack">
        <section class="panel pad">
          <div class="label">Owner funds</div>
          <div id="ownerFigure" class="big-figure mono">$0.00</div>
          <div id="setAside" class="dim-line"></div>
          <div id="fundsHint" class="dim-line"></div>
          <div id="ownerActions" class="funds-actions"></div>
        </section>

        <section>
          <div class="sec-head" style="margin-top:0"><h2>Reserved cards</h2><span id="cardCount" class="count"></span></div>
          <div class="panel"><div id="cardList"></div></div>
        </section>

        <section>
          <div class="sec-head" style="margin-top:0"><h2>Treasury &amp; payouts</h2><span id="treasuryStatus" class="count"></span></div>
          <div class="panel">
            <div id="treasuryStrip"></div>
            <div id="payoutForm" class="payout-form hidden">
              <select id="payoutDestination" aria-label="Payout destination"></select>
              <input id="payoutAmount" inputmode="decimal" autocomplete="off" placeholder="Amount (USD)" aria-label="Payout amount in dollars">
              <button class="primary" data-action="payout">Cash out</button>
            </div>
            <div id="payoutError" class="decline-strip hidden"></div>
            <div id="treasuryRows"></div>
          </div>
        </section>

        <section>
          <div class="sec-head" style="margin-top:0"><h2>Your services</h2><span id="serviceCount" class="count"></span></div>
          <div class="panel"><div id="serviceList"></div></div>
        </section>

        <div id="complianceRow" class="comp-row hidden"></div>
      </div>
    </div>
  </div>
</main>

<dialog id="fundsSheet" class="sheet" aria-labelledby="fundsTitle">
  <div class="sheet-body">
    <div class="sheet-head"><h3 id="fundsTitle" class="sheet-title">Add funds</h3><button class="xbtn" data-action="sheet-close" aria-label="Close">&#10005;</button></div>
    <div id="fundsSource" class="sheet-sub"></div>
    <div class="preset-row" id="presetRow">
      <button class="chipbtn" data-preset="5">$5</button>
      <button class="chipbtn" data-preset="20">$20</button>
      <button class="chipbtn" data-preset="50">$50</button>
      <button class="chipbtn" data-preset="100">$100</button>
    </div>
    <input id="fundsAmount" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-label="Amount in dollars">
    <div id="fundsPreview" class="amount-preview">$0.00</div>
    <div id="fundsError" class="decline-strip hidden"></div>
    <div id="fundsCta"></div>
    <div id="fundsFoot" class="sheet-foot"></div>
  </div>
</dialog>

<dialog id="mandateSheet" class="sheet" aria-labelledby="mandateTitle">
  <div class="sheet-body">
    <div class="sheet-head"><h3 id="mandateTitle" class="sheet-title">Spend mandate</h3><button class="xbtn" data-action="sheet-close" aria-label="Close">&#10005;</button></div>
    <div class="field-grid">
      <label>Budget <input id="mBudget" inputmode="decimal" autocomplete="off" placeholder="0.00"><span class="cap">total this agent may spend under this mandate</span></label>
      <label>Per-payment cap <input id="mPerTx" inputmode="decimal" autocomplete="off" placeholder="0.00"><span class="cap">largest single payment</span></label>
      <label>Daily cap <input id="mDaily" inputmode="decimal" autocomplete="off" placeholder="0.00"><span class="cap">most in one day</span></label>
      <label>Escalate above <input id="mEscalate" inputmode="decimal" autocomplete="off" placeholder="0.00"><span class="cap">payments above this wait for your approval</span></label>
      <label>New-payee cap <input id="mNewPayee" inputmode="decimal" autocomplete="off" placeholder="0.00"><span class="cap">largest first payment to someone new</span></label>
      <label>Expires <input id="mExpiry" type="date"><span class="cap">the mandate ends on this date</span></label>
    </div>
    <div class="allow-wrap">
      <div class="label" style="font-size:10px">Payee allowlist</div>
      <div id="allowChips" class="allow-chips"></div>
      <div id="allowEmpty" class="cap">Any payee, within the caps above.</div>
      <div class="allow-row">
        <input id="allowInput" autocomplete="off" placeholder="@handle or account id" aria-label="Add allowed payee" style="flex:1">
        <button data-action="allow-add">Add</button>
      </div>
    </div>
    <div id="mandateError" class="decline-strip hidden"></div>
    <div id="mandateCta"></div>
    <div style="display:flex;justify-content:center"><button id="revokeBtn" class="textbtn crimson hidden" data-action="mandate-revoke">Revoke mandate</button></div>
  </div>
</dialog>

<template id="sigTpl">
  <div class="sig-panel">
    <div class="sig-row"><span class="keyglyph" aria-hidden="true"></span><span class="sig-head">This change is owner-signed.</span></div>
    <p class="sig-copy">A session can view, approve, and decline &mdash; it can never move funds. From your terminal:</p>
    <div class="code-row"><code>npm run onboard</code><button class="ghost small" data-action="copy" data-value="npm run onboard">Copy</button></div>
  </div>
</template>

<div id="toast" class="toast" role="status" aria-live="polite"></div>

<script>
(() => {
  "use strict";
  const CONFIG = ${configJson};
  const SANDBOX = Boolean(CONFIG.sessionOwnerWrites || CONFIG.developmentFunding);
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const big = (value) => { try { return BigInt(String(value ?? 0)); } catch { return 0n; } };
  const fmt = (value) => {
    const n = big(value); const sign = n < 0n ? "\\u2212" : ""; const abs = n < 0n ? -n : n;
    const dollars = (abs / 1000000n).toLocaleString("en-US");
    const fraction = (abs % 1000000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
    return sign + "$" + dollars + "." + fraction;
  };
  const dollarsToMicros = (value) => {
    const match = /^(0|[1-9][0-9]*)(?:\\.([0-9]{1,6}))?$/.exec(String(value ?? "").trim());
    if (!match) return null;
    return (BigInt(match[1]) * 1000000n + BigInt((match[2] || "").padEnd(6, "0") || "0")).toString();
  };
  const microsToInput = (value) => {
    /* full-precision round-trip: a CLI-granted sub-cent cap (e.g. 505000
       micros, $0.505) must prefill exactly, or a save would silently narrow
       it to the whole cent */
    const n = big(value); const abs = n < 0n ? 0n : n;
    const dollars = (abs / 1000000n).toString();
    const fraction = (abs % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
    if (!fraction) return dollars;
    return dollars + "." + (fraction.length < 2 ? fraction.padEnd(2, "0") : fraction);
  };
  const fmtDay = (ms) => new Date(Number(ms)).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const fmtClock = (ms) => new Date(Number(ms)).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const rel = (ms) => {
    const diff = Date.now() - Number(ms);
    if (diff < 45000) return "just now";
    if (diff < 5400000) return Math.max(1, Math.round(diff / 60000)) + "m ago";
    if (diff < 129600000) return Math.round(diff / 3600000) + "h ago";
    return fmtDay(ms);
  };
  const untilText = (ms) => {
    const left = Number(ms) - Date.now();
    if (left <= 0) return "now";
    if (left < 5400000) return "in " + Math.max(1, Math.ceil(left / 60000)) + "m";
    if (left < 172800000) return "in " + Math.ceil(left / 3600000) + "h";
    return "in " + Math.ceil(left / 86400000) + "d";
  };
  const hueOf = (id) => { let h = 0; const text = String(id); for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) % 360; return 95 + (h % 75); };
  const pctOf = (part, whole) => {
    const w = big(whole); if (w <= 0n) return 0;
    const p = big(part); if (p <= 0n) return 0;
    const pct = Number((p * 1000n) / w) / 10;
    return pct;
  };

  /* theme: system by default; an explicit choice is stored and wins */
  const themeKey = "money_theme";
  const readTheme = () => { try { return localStorage.getItem(themeKey) || ""; } catch { return ""; } };
  const applyTheme = () => {
    const mode = readTheme();
    if (mode === "dark" || mode === "light") document.documentElement.dataset.theme = mode;
    else delete document.documentElement.dataset.theme;
  };
  applyTheme();
  $("themeBtn").addEventListener("click", () => {
    const order = ["", "dark", "light"];
    const next = order[(order.indexOf(readTheme()) + 1) % order.length];
    try { next ? localStorage.setItem(themeKey, next) : localStorage.removeItem(themeKey); } catch {}
    applyTheme();
    toast(next ? "Theme: " + next : "Theme: system");
  });

  /* token flow: fragment -> sessionStorage -> stripped from the URL */
  const tokenKey = "money_owner_token";
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  if (fromHash) {
    try { sessionStorage.setItem(tokenKey, fromHash); } catch {}
    history.replaceState(null, "", location.pathname + location.search);
  }
  let token = "";
  try { token = sessionStorage.getItem(tokenKey) || ""; } catch {}
  const auth = () => ({ Authorization: "Bearer " + token });

  let s = null;                 /* latest ownerSnapshot */
  let busy = false;
  let pollDelay = 1500;
  let pollTimer = null;
  let expandedRow = "";
  let armed = null;             /* two-tap confirm: { kind, id, until } */
  let seenRows = null;          /* feed row keys already shown (for entry animation) */
  let toastTimer = null;

  const toast = (text) => {
    const el = $("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
  };

  const netPill = (state) => {
    const pill = $("netPill");
    pill.classList.remove("ok", "warn");
    if (state === "live") { pill.classList.add("ok"); $("netText").textContent = "live · private"; }
    else if (state === "reconnecting") { pill.classList.add("warn"); $("netText").textContent = "reconnecting"; }
    else $("netText").textContent = "locked";
  };

  const showLock = (message) => {
    $("lock").classList.remove("hidden");
    $("app").classList.add("hidden");
    $("logoutBtn").classList.add("hidden");
    $("integrityChip").classList.add("hidden");
    $("modeChip").classList.add("hidden");
    $("lockSandbox").classList.toggle("hidden", !SANDBOX);
    netPill("locked");
    $("lockError").textContent = message || "";
    $("lockError").classList.toggle("hidden", !message);
  };
  const showApp = () => {
    $("tokenInput").value = "";
    $("lock").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("logoutBtn").classList.remove("hidden");
    const mode = $("modeChip");
    mode.classList.remove("hidden");
    mode.textContent = SANDBOX ? "sandbox" : "owner-signed";
    mode.classList.toggle("warn", SANDBOX);
    netPill("live");
  };
  const lockOut = (message) => {
    try { sessionStorage.removeItem(tokenKey); } catch {}
    token = "";
    s = null;
    closeSheets();
    showLock(message);
  };

  async function refresh() {
    if (!token) return;
    try {
      const res = await fetch("/dashboard/state", { headers: auth(), cache: "no-store" });
      if (res.status === 401) { lockOut("That session has ended. Mint a fresh link with npm run dashboard:login."); return; }
      if (!res.ok) throw new Error("state " + res.status);
      s = await res.json();
      pollDelay = 1500;
      render();
      showApp();
    } catch {
      pollDelay = 5000;
      if (token) netPill("reconnecting");
    }
  }
  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (token && !document.hidden) await refresh();
      schedule();
    }, pollDelay);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && token) { pollDelay = 1500; refresh(); }
  });

  async function post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) { lockOut("That session has ended. Mint a fresh link with npm run dashboard:login."); throw new Error("session ended"); }
    let json = {};
    try { json = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, body: json };
  }

  /* durable idempotency per attempt, keyed by exact terms */
  const attemptFor = (op, terms) => {
    const storageKey = "money_dash_attempt_" + op;
    let attempt = null;
    try { attempt = JSON.parse(sessionStorage.getItem(storageKey) || "null"); } catch {}
    if (!attempt || attempt.terms !== terms || typeof attempt.key !== "string") {
      attempt = { terms, key: "dash-" + op + "-" + crypto.randomUUID() };
      try { sessionStorage.setItem(storageKey, JSON.stringify(attempt)); } catch {}
    }
    return { key: attempt.key, clear: () => { try { sessionStorage.removeItem(storageKey); } catch {} } };
  };

  /* ---- snapshot lenses (render only ownerSnapshot fields) ---- */
  const accounts = () => (s && s.accounts) || [];
  const owner = () => accounts().find((a) => a.kind === "user");
  const agents = () => accounts().filter((a) => a.kind === "agent");
  const profile = (id) => accounts().find((a) => a.id === id)
    || ((s && s.feed) || []).flatMap((r) => [r.fromAccount, r.toAccount]).find((a) => a && a.id === id)
    || { id, name: id };
  const display = (a) => !a ? "unknown"
    : a.handle ? "@" + a.handle
    : a.id === "external:funding" ? "funding rail"
    : (a.name || a.id);
  const displayId = (id) => display(profile(id));
  const mandateFor = (agentId) => ((s && s.mandates) || [])
    .filter((m) => m.agentId === agentId && !m.revoked && Number(m.expiresAt) > Date.now())
    .sort((left, right) => Number(right.createdAt) - Number(left.createdAt))[0];
  const mineIds = () => new Set(accounts().map((a) => a.id));

  /* ---- render ---- */
  function render() {
    if (!s) return;
    renderIntegrity();
    renderApprovals();
    renderAgents();
    renderFeed();
    renderOwnerFunds();
    renderCards();
    renderTreasury();
    renderServices();
    renderCompliance();
  }

  function renderIntegrity() {
    const chip = $("integrityChip");
    chip.classList.remove("hidden", "ok", "fail");
    const integ = s.integrity;
    if (!integ) { chip.textContent = "awaiting ops verdict"; return; }
    if (integ.zeroSum && integ.receiptsOk) { chip.classList.add("ok"); chip.textContent = "ledger verified " + fmtClock(integ.verifiedAt); return; }
    chip.classList.add("fail");
    chip.textContent = "LEDGER CHECK FAILED";
  }

  function renderApprovals() {
    const pending = (s.approvals || []).filter((a) => a.status === "pending")
      .sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
    $("approvalSection").classList.toggle("hidden", pending.length === 0);
    $("apprCount").textContent = String(pending.length);
    $("apprList").innerHTML = pending.map((a) => {
      const agent = displayId(a.agentId);
      const payee = displayId(a.to);
      return '<div class="appr">'
        + '<div class="appr-main">'
        + '<div class="appr-sentence">' + esc(agent) + ' wants to pay ' + esc(payee) + '</div>'
        + (a.memo ? '<div class="appr-memo">&ldquo;' + esc(a.memo) + '&rdquo;</div>' : '')
        + '<div class="appr-tuple">' + esc(a.agentId) + ' &rarr; ' + esc(a.to) + ' · ' + esc(a.id) + ' · expires ' + esc(untilText(a.expiresAt)) + '</div>'
        + '</div>'
        + '<div class="appr-side">'
        + '<div class="appr-amount">' + fmt(a.amount) + '</div>'
        + '<div class="appr-actions">'
        + '<button class="primary" data-action="approve" data-id="' + esc(a.id) + '"' + (busy ? " disabled" : "") + '>Approve exact payment</button>'
        + '<button class="danger-ghost" data-action="reject" data-id="' + esc(a.id) + '"' + (busy ? " disabled" : "") + '>Decline</button>'
        + '</div></div></div>';
    }).join("");
  }

  function agentActivityLine(agentId) {
    const row = (s.feed || []).find((r) => r.from === agentId || r.to === agentId);
    if (!row) return "";
    const outbound = row.from === agentId;
    const other = displayId(outbound ? row.to : row.from);
    const verb = outbound ? "Paid " : "Received from ";
    return esc(verb + other + " ") + fmt(row.amount) + " · " + esc(rel(row.ts));
  }

  function renderAgents() {
    const list = agents();
    $("agentCount").textContent = list.length ? String(list.length) : "";
    if (!list.length) {
      $("agentGrid").innerHTML = '<div class="panel empty ruled" style="grid-column:1/-1">No agents yet. Create one from your terminal: <code>npm run onboard</code>.</div>';
      return;
    }
    $("agentGrid").innerHTML = list.map((agent) => {
      const m = mandateFor(agent.id);
      let mandateBlock;
      if (m) {
        const pct = pctOf(m.spent, m.budget);
        const fillClass = pct >= 100 ? "over" : pct >= 70 ? "warn" : "";
        mandateBlock = '<div>'
          + '<div class="meter"><i class="' + fillClass + '" style="width:' + Math.min(100, pct) + '%"></i></div>'
          + '<div class="meter-caption">spent ' + fmt(m.spent) + ' of ' + fmt(m.budget) + ' mandate · today ' + fmt(m.spentToday) + ' of ' + fmt(m.dailyCap) + '</div>'
          + '<div class="meter-caption">asks above ' + fmt(m.escalateAbove) + ' · expires ' + esc(fmtDay(m.expiresAt)) + '</div>'
          + '</div>';
      } else {
        mandateBlock = '<div class="no-mandate"><span>No spend mandate &mdash; this agent cannot spend.</span>'
          + '<button class="small" data-action="open-mandate" data-id="' + esc(agent.id) + '">Grant mandate</button></div>';
      }
      const chips = (s.cards || [])
        .filter((card) => card.agentId === agent.id && ["prepared", "approval_required", "pending"].includes(card.state))
        .map((card) => {
          const tone = card.state === "pending" ? "approve" : "amber";
          return '<span class="chip ' + tone + '"><span class="cardglyph" aria-hidden="true"></span>·· ' + esc(card.last4 || "----") + ' · ' + esc(card.capDisplay) + '</span>';
        }).join("");
      const activity = agentActivityLine(agent.id);
      return '<div class="agent-card panel">'
        + '<div class="agent-top"><div class="agent-id">'
        + '<div class="avatar" style="background:hsl(' + hueOf(agent.id) + ' 45% 22%)">' + esc((agent.name || agent.id).charAt(0).toUpperCase()) + '</div>'
        + '<div style="min-width:0"><div class="agent-name">' + esc(agent.name || agent.id) + '</div>'
        + '<div class="agent-handle">' + esc(agent.handle ? "@" + agent.handle : agent.id)
        + '<span class="status-dot' + (agent.status === "active" ? " on" : "") + '" aria-hidden="true"></span> ' + esc(agent.status) + '</div></div>'
        + '</div><button class="ghost small" data-action="open-funds" data-id="' + esc(agent.id) + '">Add funds</button></div>'
        + '<div><div class="label">Funds</div><div class="funds-figure">' + fmt(agent.balanceMicros) + '</div></div>'
        + mandateBlock
        + (chips ? '<div class="card-chips">' + chips + '</div>' : '')
        + (activity ? '<div class="last-act">' + activity + '</div>' : '')
        + '<div class="agent-foot">'
        + '<button class="textbtn" data-action="open-funds" data-id="' + esc(agent.id) + '">Add funds</button>'
        + '<button class="textbtn" data-action="open-mandate" data-id="' + esc(agent.id) + '">' + (m ? "Edit mandate" : "Grant mandate") + '</button>'
        + '</div></div>';
    }).join("");
  }

  function feedRows() {
    const mine = mineIds();
    const rows = [];
    for (const r of (s.feed || [])) {
      rows.push({ key: "r" + r.id, ts: Number(r.ts), kind: "receipt", r, outbound: mine.has(r.from) });
    }
    for (const a of (s.approvals || [])) {
      if (a.status !== "rejected" && a.status !== "expired") continue;
      rows.push({ key: "a" + a.id, ts: Number(a.resolvedAt ?? a.expiresAt), kind: a.status, a });
    }
    for (const x of (s.external || [])) {
      if (x.state !== "reversed") continue;
      rows.push({ key: "x" + x.id, ts: Number(x.updatedAt), kind: "external", x });
    }
    rows.sort((left, right) => right.ts - left.ts);
    return rows;
  }

  function renderFeed() {
    const rows = feedRows();
    $("feedCount").textContent = rows.length ? rows.length + " entries" : "";
    if (!rows.length) {
      $("feedList").innerHTML = '<div class="empty ruled">No activity yet. Receipts and declines will appear here the moment an agent acts.</div>';
      seenRows = new Set();
      return;
    }
    const previous = seenRows;
    seenRows = new Set(rows.map((row) => row.key));
    $("feedList").innerHTML = rows.map((row) => {
      const fresh = previous && !previous.has(row.key) ? " new" : "";
      const open = expandedRow === row.key;
      if (row.kind === "receipt") {
        const r = row.r;
        const counterparty = displayId(row.outbound ? r.to : r.from);
        const meta = (row.outbound ? "to " : "from ") + counterparty;
        const seqTag = '#' + esc(String(r.seq)) + ' · ' + esc(String(r.hash || "").slice(0, 8));
        const amount = row.outbound
          ? '<span class="amount"><span class="minus">\\u2212</span>' + fmt(r.amount) + '</span>'
          : '<span class="amount in">+' + fmt(r.amount) + '</span>';
        const detail = !open ? "" : '<div class="frow-detail">'
          + '<div><span class="k">transfer</span>' + esc(r.transferId) + '</div>'
          + (r.mandateId ? '<div><span class="k">mandate</span>' + esc(r.mandateId) + '</div>' : '')
          + '<div class="hash-row"><span><span class="k">hash</span>' + esc(r.hash) + '</span>'
          + '<button class="ghost small" data-action="copy" data-value="' + esc(r.hash) + '">Copy</button></div>'
          + '<div><span class="k">receipt</span>' + esc(r.id) + '</div>'
          + '</div>';
        return '<div class="frow' + fresh + '" data-action="expand" data-id="' + esc(row.key) + '">'
          + '<div class="frow-main"><div class="frow-title">' + esc(r.memo || "Payment") + '</div>'
          + '<div class="meta">' + esc(meta) + ' · ' + esc(rel(r.ts)) + ' · <span style="color:var(--faint)">' + seqTag + '</span></div>'
          + detail + '</div>' + amount + '</div>';
      }
      if (row.kind === "external") {
        const x = row.x;
        const chip = '<span class="chip crimson">' + esc(x.state) + '</span>';
        const reason = "the external payment was reversed and the funds returned";
        const detail = !open ? "" : '<div class="frow-detail">'
          + '<div><span class="k">host</span>' + esc(x.host) + '</div>'
          + (x.transferId ? '<div><span class="k">transfer</span>' + esc(x.transferId) + '</div>' : '')
          + (x.receiptId ? '<div><span class="k">receipt</span>' + esc(x.receiptId) + '</div>' : '')
          + '</div>';
        return '<div class="frow declined' + fresh + '" data-action="expand" data-id="' + esc(row.key) + '">'
          + '<div class="frow-main"><div class="frow-title">' + esc(displayId(x.agentId)) + ' &rarr; ' + esc(x.host) + chip + '</div>'
          + '<div class="frow-reason">' + esc(reason) + '</div>'
          + '<div class="meta">' + esc(rel(row.ts)) + '</div>' + detail + '</div>'
          + '<span class="amount declined">' + fmt(x.amountMicros) + '</span></div>';
      }
      const a = row.a;
      const expired = row.kind === "expired";
      const chip = expired ? '<span class="chip faint">expired</span>' : '<span class="chip crimson">declined</span>';
      const reason = expired ? "approval expired before you answered" : (a.reason || "declined by owner");
      const detail = !open ? "" : '<div class="frow-detail">'
        + '<div><span class="k">approval</span>' + esc(a.id) + '</div>'
        + '<div><span class="k">mandate</span>' + esc(a.mandateId) + '</div>'
        + '</div>';
      return '<div class="frow ' + (expired ? "expired" : "declined") + fresh + '" data-action="expand" data-id="' + esc(row.key) + '">'
        + '<div class="frow-main"><div class="frow-title">' + esc(displayId(a.agentId)) + ' &rarr; ' + esc(displayId(a.to)) + chip + '</div>'
        + '<div class="frow-reason">' + esc(reason) + '</div>'
        + '<div class="meta">' + (a.memo ? '&ldquo;' + esc(a.memo) + '&rdquo; · ' : '') + esc(rel(row.ts)) + '</div>'
        + detail + '</div>'
        + '<span class="amount declined">' + fmt(a.amount) + '</span></div>';
    }).join("");
  }

  function renderOwnerFunds() {
    const me = owner();
    $("ownerFigure").textContent = fmt(me ? me.balanceMicros : 0);
    const setAside = agents().reduce((sum, agent) => sum + big(agent.balanceMicros), 0n);
    $("setAside").textContent = "Set aside for agents: " + fmt(setAside);
    const zero = !me || big(me.balanceMicros) === 0n;
    $("fundsHint").textContent = !zero ? ""
      : CONFIG.developmentFunding
        ? "Add sandbox funds to start allocating."
        : "Real funds arrive through the treasury rail once your funding route is live.";
    $("ownerActions").innerHTML = CONFIG.developmentFunding
      ? '<button data-action="open-owner-funds">Add sandbox funds</button>'
      : "";
  }

  function renderCards() {
    const cards = s.cards || [];
    $("cardCount").textContent = cards.length ? String(cards.length) : "";
    if (!cards.length) {
      $("cardList").innerHTML = '<div class="empty ruled">No reserved cards. An agent requests one against its spend mandate.</div>';
      return;
    }
    const stateLabel = { prepared: "pending", approval_required: "awaiting approval", pending: "active", confirmed: "settled", reversed: "closed", cancelled: "canceled" };
    const stateTone = { prepared: "amber", approval_required: "amber", pending: "approve", confirmed: "faint", reversed: "faint", cancelled: "faint" };
    $("cardList").innerHTML = cards.map((card) => {
      const openState = ["prepared", "approval_required", "pending"].includes(card.state);
      const used = big(card.heldMicros) + big(card.settledMicros);
      const pct = Math.min(100, pctOf(used, card.capMicros));
      const closing = card.closeRequestedAt && openState;
      const isArmed = armed && armed.kind === "card" && armed.id === card.id && armed.until > Date.now();
      const action = closing
        ? '<span class="closing">closing&hellip;</span>'
        : openState
          ? '<button class="' + (isArmed ? "danger-ghost" : "ghost") + ' small" data-action="card-close" data-id="' + esc(card.id) + '"' + (busy ? " disabled" : "") + '>' + (isArmed ? "Confirm close" : "Close") + '</button>'
          : "";
      return '<div class="crow">'
        + '<div class="card-face" aria-hidden="true"><span class="cf4">' + esc(card.last4 || "") + '</span></div>'
        + '<div class="crow-main">'
        + '<div class="crow-line">' + (card.last4 ? '·· ' + esc(card.last4) : '<span style="color:var(--dim)">not yet issued</span>')
        + '<span class="chip ' + (stateTone[card.state] || "faint") + '">' + esc(stateLabel[card.state] || card.state) + '</span>'
        + (card.singleUse ? '<span class="chip faint">single use</span>' : '')
        + '</div>'
        + '<div class="meta">reserved ' + esc(card.capDisplay) + ' · ' + esc(card.merchantHint) + (openState ? ' · expires ' + esc(untilText(card.expiresAt)) : '') + '</div>'
        + '<div class="micro-meter"><i style="width:' + pct + '%"></i></div>'
        + '</div>' + action + '</div>';
    }).join("");
  }

  function renderTreasury() {
    const t = s.treasury || { controls: {}, destinations: [], payouts: [], fundings: [], exposures: [] };
    const controls = t.controls || {};
    const open = (t.exposures || []).filter((e) => e.state === "open");
    const healthy = controls.fundingEnabled && controls.payoutsEnabled && controls.externalSpendEnabled && !open.length;
    $("treasuryStatus").textContent = healthy ? "rails available" : "attention required";
    $("treasuryStrip").innerHTML = healthy ? "" : '<div class="breaker">' + esc(
      controls.breakerReason || "Some treasury rails are paused. Funding, payouts, or external spend may be held for review."
    ) + '</div>';
    const verified = (t.destinations || []).filter((d) => d.status === "verified");
    const select = $("payoutDestination");
    const optionKey = verified.map((d) => d.id).join(",");
    if (select.dataset.key !== optionKey) {
      select.innerHTML = verified.map((d) => '<option value="' + esc(d.id) + '">' + esc(d.label) + ' (' + esc(d.provider) + ')</option>').join("");
      select.dataset.key = optionKey;
    }
    $("payoutForm").classList.toggle("hidden", !controls.payoutsEnabled || !verified.length);
    const payoutRows = (t.payouts || []).map((p) => {
      const label = (t.destinations || []).find((d) => d.id === p.destinationId);
      return '<div class="panel-row"><div style="min-width:0"><div>Cash out · ' + esc(label ? label.label : p.provider) + '</div>'
        + '<div class="meta">' + esc(p.state) + ' · ' + esc(rel(p.requestedAt)) + '</div></div>'
        + '<div style="display:flex;align-items:center;gap:8px"><span class="amount"><span class="minus">\\u2212</span>' + fmt(p.amountMicros) + '</span>'
        + (p.state === "queued" ? '<button class="ghost small" data-action="payout-cancel" data-id="' + esc(p.id) + '">Cancel</button>' : '')
        + '</div></div>';
    });
    const fundingRows = (t.fundings || []).map((f) => {
      const returned = f.state === "returned";
      return '<div class="panel-row"><div style="min-width:0"><div>' + (returned ? "Returned funding" : "Funding settled") + '</div>'
        + '<div class="meta">' + esc(f.provider) + ' · ' + esc(rel(f.settledAt)) + '</div></div>'
        + '<span class="amount' + (returned ? '' : ' in') + '">' + (returned ? '<span class="minus">\\u2212</span>' : '+') + fmt(f.amountMicros) + '</span></div>';
    });
    $("treasuryRows").innerHTML = [...payoutRows, ...fundingRows].join("")
      || '<div class="empty ruled">No treasury activity yet.</div>';
  }

  function renderServices() {
    const services = s.services || [];
    $("serviceCount").textContent = services.length ? String(services.length) : "";
    $("serviceList").innerHTML = services.map((svc) =>
      '<div class="panel-row"><div style="min-width:0"><div>' + esc(svc.address || svc.name) + '</div>'
      + '<div class="meta">' + esc(svc.endpointUrl) + '</div></div>'
      + '<span class="amount">' + esc(svc.priceDisplay) + '</span></div>'
    ).join("") || '<div class="empty ruled">No services yet.</div>';
  }

  function renderCompliance() {
    const row = $("complianceRow");
    const c = s.compliance;
    if (!c) { row.classList.add("hidden"); row.innerHTML = ""; return; }
    row.classList.remove("hidden");
    const verified = c.state === "approved" && c.screeningState === "clear";
    const restricted = ["rejected", "restricted", "closed"].includes(c.state) || c.screeningState === "blocked";
    const tone = verified ? "approve" : restricted ? "crimson" : "amber";
    const text = verified ? "identity verified" : restricted ? "account restricted" : "identity in review";
    row.innerHTML = '<span class="chip ' + tone + '"><span class="dot" style="width:6px;height:6px;border-radius:99px;background:currentColor;display:inline-block"></span>' + esc(text) + '</span>';
  }

  /* ---- sheets ---- */
  const fundsSheet = $("fundsSheet");
  const mandateSheet = $("mandateSheet");
  let fundsMode = null;     /* { mode: "allocate"|"fund", agentId, label } */
  let mandateMode = null;   /* { agentId, label, editingId, allowlist: [] } */
  const closeSheets = () => { try { fundsSheet.close(); } catch {} try { mandateSheet.close(); } catch {} };
  const sigPanel = (head) => {
    const node = $("sigTpl").content.firstElementChild.cloneNode(true);
    node.querySelector(".sig-head").textContent = head;
    return node;
  };
  const sandboxSentence = () => {
    const strip = $("sandboxStrip");
    return strip ? strip.textContent : "";
  };

  function openFunds(agentId) {
    if (!s) return;
    const me = owner();
    if (agentId) {
      const agent = profile(agentId);
      fundsMode = { mode: "allocate", agentId, label: display(agent) };
      $("fundsTitle").textContent = "Add funds to " + fundsMode.label;
      $("fundsSource").textContent = "From owner funds \\u2014 " + fmt(me ? me.balanceMicros : 0) + " available";
      $("fundsFoot").textContent = "";
    } else {
      fundsMode = { mode: "fund", agentId: null, label: "" };
      $("fundsTitle").textContent = "Add sandbox funds";
      $("fundsSource").textContent = "From the sandbox funding rail";
      $("fundsFoot").textContent = sandboxSentence();
    }
    $("fundsAmount").value = "";
    $("fundsError").classList.add("hidden");
    for (const btn of document.querySelectorAll("#presetRow .chipbtn")) btn.setAttribute("aria-pressed", "false");
    updateFundsCta();
    fundsSheet.showModal();
  }

  function updateFundsCta() {
    const cta = $("fundsCta");
    const micros = dollarsToMicros($("fundsAmount").value);
    $("fundsPreview").textContent = micros ? fmt(micros) : "$0.00";
    if (!CONFIG.sessionOwnerWrites) {
      cta.replaceChildren(sigPanel(fundsMode && fundsMode.mode === "fund" ? "Funding is owner-signed." : "Allocations are owner-signed."));
      return;
    }
    const valid = micros !== null && micros !== "0";
    const label = !fundsMode ? "" : fundsMode.mode === "allocate"
      ? "Move " + (valid ? fmt(micros) : "$0.00") + " to " + fundsMode.label
      : "Add " + (valid ? fmt(micros) : "$0.00") + " of sandbox funds";
    cta.innerHTML = '<button class="primary big" data-action="funds-submit"' + (valid && !busy ? "" : " disabled") + '>' + esc(label) + '</button>';
  }

  async function submitFunds() {
    if (!fundsMode || !s || busy) return;
    const micros = dollarsToMicros($("fundsAmount").value);
    if (micros === null || micros === "0") {
      $("fundsError").textContent = "Enter a positive amount with at most six decimals.";
      $("fundsError").classList.remove("hidden");
      return;
    }
    const me = owner();
    if (!me) return;
    const op = fundsMode.mode;
    const terms = op + "|" + (fundsMode.agentId || "owner") + "|" + micros;
    const attempt = attemptFor("funds", terms);
    busy = true;
    updateFundsCta();
    const button = $("fundsCta").querySelector("button");
    if (button) button.disabled = true;
    try {
      const res = op === "allocate"
        ? await post("/allocate", { userId: me.id, agentId: fundsMode.agentId, amountMicros: micros, idempotencyKey: attempt.key })
        : await post("/fund", { userId: me.id, amountMicros: micros, idempotencyKey: attempt.key });
      if (res.ok && res.body && res.body.status === "posted") {
        attempt.clear();
        $("fundsError").classList.add("hidden");
        if (button) button.textContent = "\\u2713";
        setTimeout(() => { try { fundsSheet.close(); } catch {} }, 300);
        await refresh();
        return;
      }
      attempt.clear();
      const body = res.body || {};
      if (body.code === "insufficient_funds" && body.fromBalanceMicros !== undefined) {
        $("fundsError").textContent = "Owner funds " + fmt(body.fromBalanceMicros) + " \\u2014 not enough for " + fmt(micros) + ".";
      } else {
        $("fundsError").textContent = body.reason || "The transfer was not posted.";
      }
      $("fundsError").classList.remove("hidden");
    } catch {} finally {
      busy = false;
      updateFundsCta();
    }
  }

  function renderAllowChips() {
    if (!mandateMode) return;
    const chips = mandateMode.allowlist;
    $("allowEmpty").classList.toggle("hidden", chips.length > 0);
    $("allowChips").innerHTML = chips.map((id, index) =>
      '<span class="chip">' + esc(displayId(id))
      + '<button type="button" data-action="allow-remove" data-id="' + index + '" aria-label="Remove payee">&#10005;</button></span>'
    ).join("");
  }

  function updateMandateCta() {
    const cta = $("mandateCta");
    if (!CONFIG.sessionOwnerWrites) {
      cta.replaceChildren(sigPanel("Spend mandates are owner-signed."));
      $("revokeBtn").classList.add("hidden");
      return;
    }
    const budget = dollarsToMicros($("mBudget").value);
    const label = "Grant spend mandate up to " + (budget !== null ? fmt(budget) : "$0.00");
    cta.innerHTML = '<button class="primary big" data-action="mandate-save"' + (busy ? " disabled" : "") + '>' + esc(label) + '</button>';
    $("revokeBtn").classList.toggle("hidden", !(mandateMode && mandateMode.editingId));
  }

  function openMandate(agentId) {
    if (!s) return;
    const agent = profile(agentId);
    const m = mandateFor(agentId);
    mandateMode = {
      agentId,
      label: display(agent),
      editingId: m ? m.id : null,
      allowlist: m && m.payeeAllowlist ? [...m.payeeAllowlist] : [],
    };
    $("mandateTitle").textContent = "Spend mandate for " + mandateMode.label;
    $("mBudget").value = m ? microsToInput(m.budget) : "";
    $("mPerTx").value = m ? microsToInput(m.perTxCap) : "";
    $("mDaily").value = m ? microsToInput(m.dailyCap) : "";
    $("mEscalate").value = m ? microsToInput(m.escalateAbove) : "";
    $("mNewPayee").value = m ? microsToInput(m.newPayeeCap) : "";
    const expiry = m ? new Date(Number(m.expiresAt)) : new Date(Date.now() + 30 * 86400000);
    $("mExpiry").value = expiry.toISOString().slice(0, 10);
    $("allowInput").value = "";
    $("mandateError").classList.add("hidden");
    const revoke = $("revokeBtn");
    revoke.textContent = "Revoke mandate";
    armed = null;
    renderAllowChips();
    updateMandateCta();
    mandateSheet.showModal();
  }

  async function addAllowPayee() {
    if (!mandateMode) return;
    const raw = $("allowInput").value.trim();
    if (!raw) return;
    let id = raw;
    if (raw.startsWith("@")) {
      try {
        const res = await fetch("/handles/" + encodeURIComponent(raw.slice(1)), { cache: "no-store" });
        if (!res.ok) throw new Error("unknown");
        id = (await res.json()).id;
      } catch {
        $("mandateError").textContent = "Unknown handle " + raw + ".";
        $("mandateError").classList.remove("hidden");
        return;
      }
    }
    $("mandateError").classList.add("hidden");
    if (!mandateMode.allowlist.includes(id)) mandateMode.allowlist.push(id);
    $("allowInput").value = "";
    renderAllowChips();
  }

  async function saveMandate() {
    if (!mandateMode || !s || busy) return;
    const me = owner();
    if (!me) return;
    const fields = [
      ["budgetMicros", $("mBudget").value],
      ["perTxCapMicros", $("mPerTx").value],
      ["dailyCapMicros", $("mDaily").value],
      ["escalateAboveMicros", $("mEscalate").value],
      ["newPayeeCapMicros", $("mNewPayee").value],
    ];
    const body = { userId: me.id, agentId: mandateMode.agentId };
    for (const [key, value] of fields) {
      const micros = dollarsToMicros(value);
      if (micros === null) {
        $("mandateError").textContent = "Every cap needs a dollar amount with at most six decimals (0 is allowed).";
        $("mandateError").classList.remove("hidden");
        return;
      }
      body[key] = micros;
    }
    const expiresAt = Date.parse($("mExpiry").value + "T23:59:00");
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      $("mandateError").textContent = "Pick an expiry date in the future.";
      $("mandateError").classList.remove("hidden");
      return;
    }
    body.expiresAt = expiresAt;
    if (mandateMode.allowlist.length) body.payeeAllowlist = [...mandateMode.allowlist];
    const terms = JSON.stringify([mandateMode.agentId, fields.map(([, v]) => v), $("mExpiry").value, mandateMode.allowlist]);
    const attempt = attemptFor("mandate", terms);
    body.idempotencyKey = attempt.key;
    busy = true;
    updateMandateCta();
    try {
      /* fail-closed edit: revoke FIRST, then grant. A no-spend gap is
         acceptable; a double-envelope window is not. */
      if (mandateMode.editingId) {
        const revoked = await post("/mandates/" + encodeURIComponent(mandateMode.editingId) + "/revoke", {});
        if (!revoked.ok) {
          $("mandateError").textContent = (revoked.body && revoked.body.reason) || "The old mandate could not be revoked.";
          $("mandateError").classList.remove("hidden");
          return;
        }
        mandateMode.editingId = null;
      }
      const granted = await post("/mandates", body);
      if (!granted.ok) {
        attempt.clear();
        $("mandateError").textContent = "Old mandate revoked; the new grant failed: "
          + ((granted.body && granted.body.reason) || "request failed") + ". "
          + mandateMode.label + " cannot spend until you grant again.";
        $("mandateError").classList.remove("hidden");
        await refresh();
        return;
      }
      attempt.clear();
      try { mandateSheet.close(); } catch {}
      toast("Spend mandate granted for " + mandateMode.label);
      await refresh();
    } catch {} finally {
      busy = false;
      updateMandateCta();
    }
  }

  async function revokeMandate() {
    if (!mandateMode || busy) return;
    const revoke = $("revokeBtn");
    const isArmed = armed && armed.kind === "revoke" && armed.id === mandateMode.agentId && armed.until > Date.now();
    if (!isArmed) {
      armed = { kind: "revoke", id: mandateMode.agentId, until: Date.now() + 6000 };
      revoke.textContent = "Confirm \\u2014 " + mandateMode.label + " can no longer spend";
      return;
    }
    armed = null;
    if (!mandateMode.editingId) return;
    busy = true;
    try {
      const res = await post("/mandates/" + encodeURIComponent(mandateMode.editingId) + "/revoke", {});
      if (!res.ok) {
        $("mandateError").textContent = (res.body && res.body.reason) || "The mandate could not be revoked.";
        $("mandateError").classList.remove("hidden");
        return;
      }
      try { mandateSheet.close(); } catch {}
      toast("Mandate revoked \\u2014 " + mandateMode.label + " can no longer spend");
      await refresh();
    } catch {} finally {
      busy = false;
    }
  }

  /* ---- actions ---- */
  async function resolveApproval(id, action) {
    if (busy) return;
    busy = true;
    renderApprovals();
    try {
      const res = await post("/owner/approvals/" + encodeURIComponent(id) + "/" + action,
        action === "reject" ? { reason: "Declined in owner app" } : {});
      if (res.ok) {
        if (action === "approve" && res.body && res.body.card && res.body.card.last4) {
          toast("Reserved card ·· " + res.body.card.last4 + " issued");
        } else {
          toast(action === "approve" ? "Approved \\u2014 the exact payment posted" : "Declined");
        }
      } else if (res.status === 409) {
        /* replayed, already resolved, or denied on the atomic recheck: the
           refresh below shows the truth; surface the reason when there is one */
        if (res.body && res.body.reason) toast(res.body.reason);
      } else {
        toast((res.body && res.body.reason) || "The approval could not be resolved.");
      }
    } catch {} finally {
      busy = false;
      await refresh();
    }
  }

  async function closeCard(id) {
    const isArmed = armed && armed.kind === "card" && armed.id === id && armed.until > Date.now();
    if (!isArmed) {
      armed = { kind: "card", id, until: Date.now() + 6000 };
      renderCards();
      return;
    }
    armed = null;
    if (busy) return;
    busy = true;
    renderCards();
    try {
      const res = await post("/owner/cards/" + encodeURIComponent(id) + "/close", { reason: "Closed in owner app" });
      if (!res.ok) toast((res.body && res.body.reason) || "The card could not be closed.");
    } catch {} finally {
      busy = false;
      await refresh();
    }
  }

  async function requestPayout() {
    if (!s || busy) return;
    const destinationId = $("payoutDestination").value;
    const amountMicros = dollarsToMicros($("payoutAmount").value);
    const error = $("payoutError");
    if (!destinationId || amountMicros === null || amountMicros === "0") {
      error.textContent = "Choose a verified destination and enter a positive amount with at most six decimals.";
      error.classList.remove("hidden");
      return;
    }
    const attempt = attemptFor("payout", destinationId + "|" + amountMicros);
    busy = true;
    error.classList.add("hidden");
    try {
      const res = await post("/owner/payouts", { destinationId, amountMicros, idempotencyKey: attempt.key });
      attempt.clear();
      if (!res.ok) {
        error.textContent = (res.body && res.body.reason) || "The payout could not be requested.";
        error.classList.remove("hidden");
      } else {
        $("payoutAmount").value = "";
        toast("Cash out requested");
      }
    } catch {} finally {
      busy = false;
      await refresh();
    }
  }

  async function cancelPayout(id) {
    if (busy) return;
    busy = true;
    try {
      const res = await post("/owner/payouts/" + encodeURIComponent(id) + "/cancel", {});
      if (!res.ok) {
        $("payoutError").textContent = "The payout can no longer be cancelled.";
        $("payoutError").classList.remove("hidden");
      }
    } catch {} finally {
      busy = false;
      await refresh();
    }
  }

  const copyText = async (value) => {
    try { await navigator.clipboard.writeText(value); toast("Copied"); }
    catch { toast("Copy is unavailable in this browser context"); }
  };

  /* one delegated click handler; controls carry data-action/data-id */
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-action],[data-preset]") : null;
    if (!target) return;
    const preset = target.getAttribute("data-preset");
    if (preset) {
      $("fundsAmount").value = preset;
      for (const btn of document.querySelectorAll("#presetRow .chipbtn")) {
        btn.setAttribute("aria-pressed", btn === target ? "true" : "false");
      }
      updateFundsCta();
      return;
    }
    const action = target.getAttribute("data-action");
    const id = target.getAttribute("data-id") || "";
    if (action === "expand") {
      if (event.target instanceof Element && event.target.closest("button")) return;
      expandedRow = expandedRow === id ? "" : id;
      renderFeed();
    }
    else if (action === "approve") resolveApproval(id, "approve");
    else if (action === "reject") resolveApproval(id, "reject");
    else if (action === "open-funds") openFunds(id);
    else if (action === "open-owner-funds") openFunds(null);
    else if (action === "open-mandate") openMandate(id);
    else if (action === "funds-submit") submitFunds();
    else if (action === "mandate-save") saveMandate();
    else if (action === "mandate-revoke") revokeMandate();
    else if (action === "allow-add") addAllowPayee();
    else if (action === "allow-remove") { if (mandateMode) { mandateMode.allowlist.splice(Number(id), 1); renderAllowChips(); } }
    else if (action === "card-close") closeCard(id);
    else if (action === "payout") requestPayout();
    else if (action === "payout-cancel") cancelPayout(id);
    else if (action === "copy") copyText(target.getAttribute("data-value") || "");
    else if (action === "sheet-close") closeSheets();
  });

  $("fundsAmount").addEventListener("input", () => {
    for (const btn of document.querySelectorAll("#presetRow .chipbtn")) btn.setAttribute("aria-pressed", "false");
    updateFundsCta();
  });
  $("mBudget").addEventListener("input", updateMandateCta);
  $("allowInput").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addAllowPayee(); } });
  $("connectBtn").addEventListener("click", () => {
    const value = $("tokenInput").value.trim();
    if (!value) return;
    token = value;
    try { sessionStorage.setItem(tokenKey, value); } catch {}
    refresh();
  });
  $("tokenInput").addEventListener("keydown", (event) => { if (event.key === "Enter") $("connectBtn").click(); });
  $("logoutBtn").addEventListener("click", async () => {
    try { await fetch("/owner/sessions/current", { method: "DELETE", headers: auth() }); } catch {}
    lockOut("");
  });

  if (token) refresh(); else showLock("");
  schedule();
})();
</script>
</body>
</html>`;
}
