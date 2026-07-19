/**
 * Self-contained owner control plane. No third-party scripts, fonts, or
 * styles: payment data and the short-lived bearer token stay same-origin.
 */
export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>money · agent control plane</title>
<style>
  :root { color-scheme: dark; --bg:#08110e; --panel:#0f1b17; --panel2:#14231d; --border:#263c33; --text:#edf7f1; --dim:#91a99e; --green:#61e6a0; --yellow:#f7ca72; --red:#ff7f7f; --blue:#8cc8ff; --mono:ui-monospace,SFMono-Regular,Consolas,monospace; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; background:radial-gradient(circle at 15% -10%,#17372a 0,transparent 35%),var(--bg); color:var(--text); font:14px Inter,ui-sans-serif,system-ui,sans-serif; }
  button,input { font:inherit; }
  header { display:flex; align-items:center; justify-content:space-between; gap:20px; max-width:1180px; margin:auto; padding:28px 24px 18px; }
  .brand { display:flex; align-items:center; gap:12px; }
  .mark { width:36px; height:36px; display:grid; place-items:center; border-radius:11px; background:var(--green); color:#052014; font:900 20px var(--mono); box-shadow:0 0 30px #61e6a033; }
  h1 { margin:0; font-size:19px; letter-spacing:-.02em; }
  .sub { color:var(--dim); font-size:12px; margin-top:2px; }
  .top-actions { display:flex; align-items:center; gap:10px; }
  .pill { border:1px solid var(--border); border-radius:999px; padding:7px 10px; color:var(--dim); font:11px var(--mono); }
  .pill.ok { color:var(--green); border-color:#2d6348; }
  main { max-width:1180px; margin:auto; padding:8px 24px 60px; }
  .login { max-width:520px; margin:8vh auto; padding:28px; border:1px solid var(--border); border-radius:18px; background:linear-gradient(145deg,var(--panel2),var(--panel)); box-shadow:0 30px 80px #0006; }
  .login h2 { margin:0 0 8px; font-size:24px; }
  .login p { color:var(--dim); line-height:1.55; }
  code { font:12px var(--mono); color:var(--green); }
  .token-row { display:flex; gap:8px; margin-top:18px; }
  input { min-width:0; flex:1; padding:11px 12px; border:1px solid var(--border); border-radius:9px; color:var(--text); background:#09130f; outline:none; }
  input:focus { border-color:var(--green); }
  button { border:1px solid var(--border); border-radius:9px; padding:9px 12px; color:var(--text); background:#17271f; cursor:pointer; }
  button:hover { border-color:#49705e; background:#1b3026; }
  button.primary { color:#052014; border-color:var(--green); background:var(--green); font-weight:750; }
  button.danger { color:#ffc0c0; border-color:#693d3d; background:#2a1818; }
  button:disabled { opacity:.5; cursor:wait; }
  .summary { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin:10px 0 24px; }
  .metric { padding:16px; border:1px solid var(--border); border-radius:13px; background:linear-gradient(145deg,var(--panel2),var(--panel)); }
  .metric .label { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
  .metric .value { margin-top:8px; font:700 21px var(--mono); }
  .metric .value.green { color:var(--green); }
  .grid { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(300px,.75fr); gap:18px; }
  .stack { display:grid; gap:18px; align-content:start; }
  section { min-width:0; }
  .section-head { display:flex; justify-content:space-between; align-items:baseline; margin:0 2px 9px; }
  h2 { margin:0; font-size:13px; letter-spacing:.03em; }
  .count { color:var(--dim); font:11px var(--mono); }
  .panel { overflow:hidden; border:1px solid var(--border); border-radius:13px; background:var(--panel); }
  .empty { padding:22px; color:var(--dim); text-align:center; }
  .row { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:13px 15px; border-top:1px solid var(--border); }
  .row:first-child { border-top:0; }
  .name { min-width:0; font-weight:650; }
  .meta { overflow:hidden; margin-top:3px; color:var(--dim); font:11px var(--mono); text-overflow:ellipsis; white-space:nowrap; }
  .amount { flex:none; font:700 13px var(--mono); }
  .amount.in { color:var(--green); } .amount.out { color:var(--yellow); }
  .kind { display:inline-block; margin-right:7px; border:1px solid var(--border); border-radius:5px; padding:2px 5px; color:var(--dim); font:9px var(--mono); text-transform:uppercase; }
  .approval { padding:16px; border-top:1px solid var(--border); }
  .approval:first-child { border-top:0; }
  .approval-top { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
  .approval-amount { color:var(--yellow); font:800 18px var(--mono); }
  .memo { margin:10px 0 12px; color:#cbdcd3; line-height:1.4; }
  .approval-actions { display:flex; gap:8px; }
  .status { border-radius:999px; padding:4px 7px; font:10px var(--mono); text-transform:uppercase; }
  .status.pending { color:var(--yellow); background:#3b2e16; }
  .status.approved { color:var(--green); background:#143425; }
  .status.rejected,.status.failed,.status.expired { color:#ffaaaa; background:#351b1b; }
  .caps { padding:9px 15px 13px; color:var(--dim); font:11px/1.6 var(--mono); border-top:1px dashed var(--border); }
  .hidden { display:none !important; }
  .error { margin-top:12px; color:var(--red); }
  @media (max-width:850px) { .summary { grid-template-columns:repeat(2,1fr); } .grid { grid-template-columns:1fr; } }
  @media (max-width:520px) { header,main { padding-left:14px; padding-right:14px; } .summary { grid-template-columns:1fr 1fr; } .token-row { flex-direction:column; } }
</style>
</head>
<body>
<header>
  <div class="brand"><div class="mark">m</div><div><h1>money</h1><div class="sub">closed-loop agent payment network</div></div></div>
  <div class="top-actions"><span id="health" class="pill">locked</span><button id="logout" class="hidden">Log out</button></div>
</header>
<main>
  <div id="login" class="login">
    <h2>Open your control plane</h2>
    <p>Your balances and agent activity are private. Run <code>npm run dashboard:login</code>, then open the link it prints. You can also paste that one-session token below.</p>
    <div class="token-row"><input id="tokenInput" type="password" autocomplete="off" placeholder="Owner session token"><button id="connect" class="primary">Connect</button></div>
    <div id="loginError" class="error hidden"></div>
  </div>

  <div id="app" class="hidden">
    <div class="summary">
      <div class="metric"><div class="label">Set aside</div><div id="totalBalance" class="value green">$0.00</div></div>
      <div class="metric"><div class="label">Agents</div><div id="agentCount" class="value">0</div></div>
      <div class="metric"><div class="label">Needs approval</div><div id="pendingCount" class="value">0</div></div>
      <div class="metric"><div class="label">Paid services</div><div id="serviceCount" class="value">0</div></div>
    </div>
    <div class="grid">
      <div class="stack">
        <section><div class="section-head"><h2>Approval inbox</h2><span id="approvalCount" class="count"></span></div><div id="approvals" class="panel"></div></section>
        <section><div class="section-head"><h2>Recent activity</h2><span id="feedCount" class="count"></span></div><div id="feed" class="panel"></div></section>
      </div>
      <div class="stack">
        <section><div class="section-head"><h2>Balances</h2></div><div id="accounts" class="panel"></div></section>
        <section><div class="section-head"><h2>Mandates</h2></div><div id="mandates" class="panel"></div></section>
        <section><div class="section-head"><h2>Your services</h2></div><div id="services" class="panel"></div></section>
      </div>
    </div>
  </div>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[ch]);
  const fmt = (micros) => { const sign=micros<0?"-":""; const n=Math.abs(micros||0); const d=Math.floor(n/1e6); const f=String(n%1e6).padStart(6,"0").replace(/0+$/,""); return sign+"$"+d.toLocaleString()+"."+(f||"00").padEnd(2,"0"); };
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("token");
  if (fromHash) { sessionStorage.setItem("money_owner_token", fromHash); history.replaceState(null,"",location.pathname+location.search); }
  let token = sessionStorage.getItem("money_owner_token") || "";
  let busy = false;

  const profile = (s,id) => s.accounts.find((a)=>a.id===id) || s.feed.flatMap((r)=>[r.fromAccount,r.toAccount]).find((a)=>a&&a.id===id) || {id,name:id};
  const display = (a) => a ? (a.handle ? "@"+a.handle : a.name || a.id) : "unknown";
  const auth = () => ({ Authorization: "Bearer "+token });
  const showLogin = (message="") => { $("login").classList.remove("hidden"); $("app").classList.add("hidden"); $("logout").classList.add("hidden"); $("health").textContent="locked"; $("health").classList.remove("ok"); $("loginError").textContent=message; $("loginError").classList.toggle("hidden",!message); };
  const showApp = () => { $("tokenInput").value=""; $("login").classList.add("hidden"); $("app").classList.remove("hidden"); $("logout").classList.remove("hidden"); $("health").textContent="live · private"; $("health").classList.add("ok"); };

  async function state() {
    if (!token || busy) return;
    try {
      const res = await fetch("/dashboard/state", { headers: auth(), cache:"no-store" });
      if (res.status===401) { sessionStorage.removeItem("money_owner_token"); token=""; showLogin("That session expired. Generate a fresh dashboard link."); return; }
      if (!res.ok) throw new Error("control plane returned "+res.status);
      render(await res.json()); showApp();
    } catch (err) { $("health").textContent="reconnecting"; $("health").classList.remove("ok"); }
  }

  async function resolve(id, action) {
    busy=true; document.querySelectorAll("button[data-action]").forEach((b)=>b.disabled=true);
    const init={method:"POST",headers:{...auth(),"content-type":"application/json"},body:action==="reject"?JSON.stringify({reason:"Rejected in owner control plane"}):"{}"};
    try { const res=await fetch("/owner/approvals/"+encodeURIComponent(id)+"/"+action,init); if(!res.ok&&res.status!==409) throw new Error("request failed"); }
    finally { busy=false; await state(); }
  }

  function render(s) {
    const agents=s.accounts.filter((a)=>a.kind==="agent"); const pending=s.approvals.filter((a)=>a.status==="pending");
    $("totalBalance").textContent=fmt(s.accounts.reduce((n,a)=>a.kind==="external"?n:n+a.balanceMicros,0));
    $("agentCount").textContent=agents.length; $("pendingCount").textContent=pending.length; $("serviceCount").textContent=s.services.length;
    $("approvalCount").textContent=s.approvals.length+" total";
    $("approvals").innerHTML=[...s.approvals].reverse().map((a)=>{ const agent=profile(s,a.agentId),payee=profile(s,a.to); const actions=a.status==="pending"?'<div class="approval-actions"><button class="primary" data-action="approve" data-id="'+esc(a.id)+'">Approve exact payment</button><button class="danger" data-action="reject" data-id="'+esc(a.id)+'">Reject</button></div>':""; return '<div class="approval"><div class="approval-top"><div><div class="name">'+esc(display(agent))+' → '+esc(display(payee))+'</div><div class="meta">'+esc(a.agentId)+' → '+esc(a.to)+' · '+esc(a.id)+'</div></div><div><div class="approval-amount">'+fmt(a.amount)+'</div><span class="status '+esc(a.status)+'">'+esc(a.status)+'</span></div></div><div class="memo">'+esc(a.memo||"No memo")+'</div>'+actions+(a.reason?'<div class="meta">'+esc(a.reason)+'</div>':"")+'</div>'; }).join("")||'<div class="empty">No approval requests yet</div>';
    document.querySelectorAll("button[data-action]").forEach((b)=>b.addEventListener("click",()=>resolve(b.dataset.id,b.dataset.action)));
    $("feedCount").textContent=s.feed.length+" receipts";
    $("feed").innerHTML=[...s.feed].reverse().map((r)=>{ const mine=s.accounts.some((a)=>a.id===r.from),other=mine?r.toAccount:r.fromAccount; return '<div class="row"><div class="name">'+esc(r.memo||"Payment")+'<div class="meta">'+esc(mine?"to "+display(other):"from "+display(other))+' · '+new Date(r.ts).toLocaleString()+'</div></div><div class="amount '+(mine?"out":"in")+'">'+(mine?"−":"+")+fmt(r.amount)+'</div></div>'; }).join("")||'<div class="empty">No payments yet</div>';
    $("accounts").innerHTML=s.accounts.map((a)=>'<div class="row"><div class="name"><span class="kind">'+esc(a.kind)+'</span>'+esc(display(a))+'<div class="meta">'+esc(a.id)+'</div></div><div class="amount">'+fmt(a.balanceMicros)+'</div></div>').join("")||'<div class="empty">No accounts</div>';
    $("mandates").innerHTML=s.mandates.map((m)=>'<div><div class="row"><div class="name">'+esc(display(profile(s,m.agentId)))+'<div class="meta">'+(m.revoked?"revoked":"active")+'</div></div><div class="amount">'+fmt(m.spent)+' / '+fmt(m.budget)+'</div></div><div class="caps">per payment '+fmt(m.perTxCap)+' · daily '+fmt(m.dailyCap)+' · ask above '+fmt(m.escalateAbove)+'</div></div>').join("")||'<div class="empty">No mandates</div>';
    $("services").innerHTML=s.services.map((svc)=>'<div class="row"><div class="name">'+esc(svc.address||svc.name)+'<div class="meta">'+esc(svc.endpointUrl)+'</div></div><div class="amount">'+fmt(svc.priceMicros)+'</div></div>').join("")||'<div class="empty">No services</div>';
  }

  $("connect").addEventListener("click",()=>{ token=$("tokenInput").value.trim(); if(!token)return; sessionStorage.setItem("money_owner_token",token); state(); });
  $("tokenInput").addEventListener("keydown",(e)=>{if(e.key==="Enter")$("connect").click();});
  $("logout").addEventListener("click",async()=>{ try{await fetch("/owner/sessions/current",{method:"DELETE",headers:auth()});}catch{} sessionStorage.removeItem("money_owner_token");token="";showLogin(); });
  if(token) state(); else showLogin(); setInterval(state,1500);
})();
</script>
</body>
</html>`;
