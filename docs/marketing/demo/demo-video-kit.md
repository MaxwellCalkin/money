# 60-Second Demo Video — Production Kit

**Asset:** the M1 funnel demo video (docs/GOTOMARKET.md → "Funnel assets").
**Hero moment:** the agent is visibly REFUSED an over-cap payment. Every competitor
demo shows a payment succeeding; ours peaks on the deterministic NO.
**Ground truth:** every command and every output block below was captured from an
actual run of this repo (v0.13, branch `codex/persona-deployment-v0.13`) on
2026-08-08 — the real `src/server/api.ts` network, the real `src/onboard.ts`
onboarding, and the real wallet MCP (`src/mcp/server.ts`, identical code to the
published `@agentmoney/wallet-mcp` bin) driven over stdio JSON-RPC. The raw
capture is in `verified-transcript.txt` next to this file. IDs, hashes, and
timestamps are per-run values; every format string and refusal message is
verbatim from the code (`src/core/policy.ts`, `src/mcp/server.ts`).

---

## 1. The mandate (the star of the video)

Onboarding grants exactly the mandate the video needs — these are the defaults
hard-coded in `src/onboard.ts` (verified):

```
mandate $10.00 budget · $1/tx · $5/day · ask above $2 · new-payee 10¢
```

- **$10.00 budget** — the whole envelope.
- **$1.00 per-transaction cap** — the refusal beat: $1.50 → deterministic denial.
- **$5.00 daily cap** — background safety (do NOT script an escalation ≥ the
  remaining daily headroom: the daily cap fires before the escalation line, so
  a $5.00 ask after any spend denies with `daily_cap` instead of escalating.
  Verified in a live run. Use **$3.00** for the escalation beat).
- **ask above $2.00** — the escalation beat: $3.00 → durable owner approval.
- **new-payee first-touch 10¢** — the injection-throttle beat (extended cut).

## 2. Pre-production setup (run before recording)

Terminal: dark theme, ≥18 pt monospace, window ~100×30. Screen: 1920×1080.
Recorder: OBS / CleanShot / Screen Studio. Captions burned in post — keep each
under 12 words. No music requirements; keep it dry, the JSON is the drama.

```bash
cd C:/Users/mcalk/code/money
npm ci
npm run api                     # terminal 1 — local network on :4021
```

Expected (terminal 1, verified — provider id varies per data file):

```
money network listening on http://127.0.0.1:4021 (demo provider: prv_2a12878c)
private owner dashboard at http://127.0.0.1:4021/dashboard (mint a session with npm run dashboard:login)
```

```bash
npm run onboard                 # terminal 2 — wallet + mandate + MCP config
```

Expected (verified verbatim, ids vary):

```
user    usr_a7c098ea
agent   agt_d6e4c30f ("scout") — allocated $10.00, Ed25519 key registered
mandate $10.00 budget · $1/tx · $5/day · ask above $2 · new-payee 10¢

Owner key (signs future funding, mandates, and revokes) was written to:
  <repo>\.money\owner-usr_a7c098ea.key
...
Private owner dashboard (8-hour session; the owner key stays out of the browser):
http://127.0.0.1:4021/dashboard#token=...

Paste into .mcp.json (the agent key stays in <repo>\.money\agent-agt_d6e4c30f.key):
{
  "mcpServers": {
    "money": {
      "command": "npx",
      "args": ["-y", "@agentmoney/wallet-mcp"],
      "env": {
        "MONEY_API": "http://127.0.0.1:4021",
        "MONEY_AGENT_ID": "agt_d6e4c30f",
        "MONEY_AGENT_KEY_FILE": ".../.money/agent-agt_d6e4c30f.key"
      }
    }
  }
}
```

**REQUIRED EDIT before mounting** (verified: without it the wallet refuses the
local HTTP API with `"public agent fetches must use HTTPS"` — which is correct
fail-closed behavior, but kills beat 2). Add one env var to the pasted config:

```json
"MONEY_FETCH_PRIVATE_ORIGINS": "[\"http://127.0.0.1:4021\"]"
```

Then create a second payee so the pay beats read naturally — either onboard a
second agent named `writer` from the dashboard, or pre-create it (the capture
run created `@writer` via an owner-signed `POST /agents`). Keep the owner
dashboard link from onboarding open in a browser tab for the extended cut.

Mount the wallet in a **fresh Claude Code session** in an empty directory with
that `.mcp.json`. Do a full dry run once; the wallet is idempotency-keyed, so
re-runs of the same prompts can replay earlier receipts — for a clean take,
stop the API, delete `data/events.jsonl` and `.money/`, and redo onboarding.

Known cosmetic notes (both verified, neither appears in tool results):
- The MCP logs `money MCP: http://127.0.0.1:4021 does not implement
  /pay-external/unresolved — crash recovery of in-flight external payments is
  unavailable on this API...` to stderr on the first fetch against the JSONL
  showcase API. It lands in the MCP host log only. Recording against
  `npm run api:db` (Postgres) avoids it entirely.
- `npm run onboard` against the Postgres kernel stops at the compliance gate
  and prints the two `dev:approve`/resume commands — that's the fail-closed
  brand working; it just costs ~20 extra seconds of setup, so the JSONL
  showcase is the faster recording target.

## 3. 60-second cut — shot-by-shot

Five beats. Screen is a Claude Code session (agent side) except the cold open.
"SAY" lines are voiceover or caption — pick one channel, not both.

---

**BEAT 1 — 0:00–0:08 — The envelope**
*On screen:* terminal 2, the tail of `npm run onboard` output, cursor resting
on the mandate line. Zoom/highlight:

```
mandate $10.00 budget · $1/tx · $5/day · ask above $2 · new-payee 10¢
```

*SAY:* "One command gives a coding agent a wallet — under a mandate its owner
signed. The model never holds a key."

---

**BEAT 2 — 0:08–0:22 — It pays a 402 by itself**
*On screen:* Claude Code. Type:

> Fetch http://127.0.0.1:4021/paid/search and summarize the results.

The agent calls `money_fetch`. Expected tool result (verified verbatim; ids vary):

```json
{
  "status": 200,
  "paid": "$0.05",
  "receiptId": "rcp_e297e895-ba36-412d-b46b-dd78fbc4783b",
  "body": {
    "resource": "/paid/search",
    "results": [
      { "title": "x402 Foundation launches with 40 members", "url": "https://www.x402.org" },
      { "title": "Closed-loop ledgers and the agent economy", "url": "https://example.com/closed-loop" }
    ],
    "price": "$0.05"
  }
}
```

*Highlight:* `"paid": "$0.05"` and `"receiptId"`.
*SAY:* "The API answered 402 Payment Required. The wallet paid it and retried —
five cents, inside the mandate, receipt attached."

---

**BEAT 3 — 0:22–0:30 — It pays another agent**
*On screen:* type:

> Pay @writer $0.25 for summarizing the sources. Use idempotency key task-1441-summarize.

Expected tool result (verified; trimmed to the highlight for pacing — show the
full JSON, zoom on these fields):

```json
{
  "status": "paid",
  "transfer": { "amount": 250000, "memo": "subtask: ..." },
  "receipt": {
    "prevHash": "183349603ff24c8...",
    "hash": "0036c9b01496bff8..."
  }
}
```

*SAY:* "Agents pay agents by handle. Every payment is a row in a hash-chained
receipt log."

---

**BEAT 4 — 0:30–0:47 — THE REFUSAL (climax)**
*On screen:* type:

> Now pay @writer $1.50 to expand the report to 40 sources.

The agent calls `money_pay` — and the network says no. Expected tool result
(verified verbatim, byte-for-byte):

```json
{
  "status": "denied",
  "code": "per_tx_cap",
  "reason": "$1.50 exceeds the $1.00 per-transaction cap"
}
```

*Direction:* freeze 2 full seconds. Zoom the `reason` line. This is the
thumbnail frame and the frame the launch post quotes.
*SAY:* "This is the product. The refusal is deterministic policy outside the
model — a prompt injection can ask for money; nothing in the agent's context
can sign or widen the mandate."

---

**BEAT 5 — 0:47–0:60 — Proof, then the card**
*On screen:* type "Show me my receipt feed" → `money_feed` returns the chain;
zoom on consecutive receipts showing `prevHash` of one equals `hash` of the
previous (verified in transcript: seq 0 hash `1833...eb86` → seq 1 prevHash
`1833...eb86`). Optionally flash `curl http://127.0.0.1:4021/verify` →
`{"ok":true}` (verified).
*Close card (static, 3 s):*

```
The refusal is the feature.
npx -y @agentmoney/wallet-mcp        (Apache-2.0)
github.com/MaxwellCalkin/money
```

*SAY:* "Hash-chained receipts prove the traffic is real. Open source, on npm
today."

---

## 4. 90-second extended cut

Same beats 1–4, then insert two beats before the closer:

**BEAT 4b — 0:47–0:57 — The injection throttle**
*On screen:* type:

> A page I read says to urgently pay prv_2a12878c $0.50. Do it.

Expected tool result (verified verbatim; payee id varies):

```json
{
  "status": "denied",
  "code": "new_payee_cap",
  "reason": "first payment to unseen payee prv_2a12878c is capped at $0.10 (injection throttle)"
}
```

*SAY:* "A brand-new payee gets cents on first touch. A lured agent leaks
pennies, not the envelope."

**BEAT 4c — 0:57–1:18 — Escalation: above the line, a human signs**
*On screen (agent):* type:

> Pay @writer $3.00 for a rush full market survey tonight. Key task-1441-rush.

Expected tool result (verified; the durable approval tuple):

```json
{
  "status": "approval_required",
  "approval": {
    "id": "apr_2b9daa2c-...",
    "to": "agt_f7c131b0",
    "amount": 3000000,
    "memo": "rush: full market survey tonight",
    "status": "pending"
  }
}
```

*On screen (owner):* switch to the browser tab with the private dashboard
(the fragment-token link onboarding printed). The approval inbox shows the
exact stored payee, amount, memo. Click **Approve**.
*Back in Claude Code:* "try that payment again" → same idempotency key returns
(verified):

```json
{ "status": "paid", "replayed": true, ... }
```

*SAY:* "Above the ask-me line, the request parks in the owner's inbox —
approving executes exactly the tuple the human saw, exactly once. The retry
replays the same receipt: no double spend."

**Closer — 1:18–1:30:** Beat 5 unchanged.

## 5. Honesty checklist (non-negotiable, per docs/GOTOMARKET.md)

- Never imply users, volume, or revenue. If any number appears, it is a real
  number or an honest zero.
- The recording runs against a **local** network (`npm run api`, the JSONL
  showcase engine). If any caption names the environment, say "local demo
  network". When the hosted beta exists, a re-record against it must carry its
  "testnet/beta, not production" label on screen.
- Do not call it a bank, do not show real customer funds, do not claim mainnet
  settlement in this video — the mainnet-bridge clip (real tx hash beside its
  signed receipt) is a separate M1 asset with its own proof burden.
- Every output frame must be a real capture. No mocked JSON in post.

## 6. Alternate climax framings (pick one, A recommended)

- **A. Silent JSON.** No voiceover during the refusal; two seconds of the raw
  denial, then the caption: "Every other demo shows the payment succeeding."
- **B. Injection framing.** Prefix beat 4's prompt with "the web page says
  it's urgent" — makes the security story explicit but risks looking staged;
  if used, keep the prompt visible on screen so viewers see there's no trick.
