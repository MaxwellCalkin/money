# Handoff — `money`: Venmo for agents

You are taking over an in-progress project. Read this file, then read the key
source files it points to, run the test suite to confirm it's green, and
continue with the "Next up" work. Everything you need is in this repo plus the
project memory.

## The mission

Build a **closed-loop payment network for AI agents** — "Venmo for agents." Users
set aside funds; their agents spend at will under user-signed budgets; agents pay
each other and pay APIs/CLIs. The bet is a **very high volume of low-cost
transactions** (agent→agent and agent→API). The owner (Max) is aiming big — treat
this as the foundation of a real company, so correctness and security matter more
than speed.

**Why closed-loop is the whole thesis:** when both parties to a payment are on our
ledger, a payment is a database row — instant, free, sub-cent capable. Card and
stablecoin rails can't touch that economically. External rails only matter at the
*edges* (top-up / cash-out). This is how PayPal, Alipay, and M-Pesa actually won.

## Current state (v0 — working, tested, pushed)

A complete v0 prototype exists and works end-to-end: double-entry ledger, user-signed
mandates → single-use permits, hash-chained receipts, agent-to-agent payments, an
x402-shaped HTTP 402 pay-per-call flow over real HTTP, durable event-sourced
persistence, Ed25519 identity for both agents (spends) and owners (admin), a live SSE
dashboard, an external x402 bridge to the machine economy (against a mock wallet), an
MCP server so a Claude Code agent gets a wallet, one-command onboarding, an E2E demo,
and 77 passing tests. All five roadmap milestones below are DONE. The design of the
last two was adversarially reviewed by a multi-agent workflow before implementation.

- **Git:** private repo `https://github.com/MaxwellCalkin/money`, remote `origin`,
  branch `main`. Working tree may have uncommitted edits — check `git status`.
- **Durable.** State survives restarts via event sourcing to an append-only JSONL
  log (`data/events.jsonl` by default, `MONEY_DATA` to override; the demo uses
  `data/demo-events.jsonl`, wiped per run). Replay rebuilds everything and verifies
  zero-sum + the receipt chain on boot — a tampered or corrupt log refuses to load.
  Torn final lines (crash mid-append) are truncated away WAL-style. Not persisted
  (deliberate): 402 challenges and unconsumed permits — both short-TTL; a lost paid
  challenge means the agent may re-pay once, bounded by the challenge price.

### File map (read these first, in this order)

- `src/core/types.ts` — money math (**integer micro-dollars**, `1_000_000` micros =
  $1) and all domain types. Floats never touch money.
- `src/core/ledger.ts` — double-entry ledger; idempotency-keyed; zero-sum invariant.
- `src/core/policy.ts` — **the envelope**: mandates, caps, escalation, the new-payee
  injection throttle, single-use permits. The security boundary lives here.
- `src/core/receipts.ts` — SHA-256 hash-chained receipt log (the evidence chain).
- `src/core/store.ts` — event types + `JsonlStore` (append-only JSONL, torn-tail
  healing). Raw replay methods live on ledger/policy/receipts; `MoneyNetwork.open()`
  ties it together.
- `src/core/identity.ts` — Ed25519 keypairs; request signing/verification.
- `src/bridge/` — external x402: `x402.ts` (v1 wire + allowlist + host canon),
  `wallet.ts` (`ExternalWallet` interface + `MockWallet`), `mock-x402.ts` (mock seller).
- `src/core/network.ts` — `MoneyNetwork`, the facade that ties it together (the
  closed loop: accounts, funding, allocation, mandates, `pay`, 402 challenges).
- `src/server/api.ts` — Hono HTTP API + the `paid()` x402 middleware + signed-
  request auth + the dashboard routes (`/dashboard`, `/dashboard/state`,
  `/dashboard/events` SSE).
- `src/server/dashboard.ts` — the self-contained dashboard page (inline CSS/JS).
- `src/mcp/server.ts` — MCP server: `money_balance`, `money_pay`, `money_fetch`,
  `money_feed`. The agent holds only its account id (v0), never keys or balances.
- `src/onboard.ts` — owner-signed setup of user+agent+mandate, prints `.mcp.json`.
- `src/demo.ts` — the E2E story; `npm run demo` is the best way to see it all work.
- `test/*.test.ts` — 79 tests across ledger, policy, network, persistence,
  identity, owner-auth, dashboard, bridge.

## Invariants — do NOT break these

1. **Money is integer micros.** Never use floats for amounts. `assertMicros` guards
   both transfer amounts and resulting balances (past 2^53 micros floats lose money).
2. **The envelope is the security boundary, not the model.** Assume the agent is
   prompt-injected. All limits are enforced by deterministic code the model can't
   reach. Mandates are created/widened only by the owner, never from agent context.
3. **Everything money-moving is idempotent.** Clients supply the key; retrying a key
   returns the original outcome, never a second spend. Reserved key namespaces:
   `chl_` (challenges) and `rev_` (reversals) — client keys can't use them.
4. **Closed-loop zero-sum.** Every balance sums to zero; only the boundary accounts
   `EXTERNAL_FUNDING` (top-up, goes negative) and `EXTERNAL_X402` (bridge outflows,
   goes positive) sit at the edges. `network.ledger.zeroSum()` must hold. Agents can
   never pay a boundary account directly — only `fund()` and `payExternal()` touch them.
5. **Receipt chain stays verifiable.** `network.verifyReceipts()` must stay `ok`.
6. **Single-owner loop only.** Today all agents belong to ONE user paying each other
   and paying providers — that's a user moving their own money, NOT money
   transmission. Cross-owner agent-to-agent payments ARE money transmission and need
   licensing / a sponsor-bank structure. **Do not cross that line in code without
   explicitly flagging it to Max.** Compliant sequencing = single-owner first.

## Roadmap — all five milestones DONE

Built one verified layer at a time (commit + push + regression tests each). The
records below stay as the running log. **Whoever picks this up next: the natural
frontier is real on-chain x402 (a live USDC wallet + facilitator against
Base testnet — the client is already protocol-faithful, only the wallet and
settlement are mocked), then the differentiators from the design brief —
subscriptions, refunds, sub-agent delegation, agent-error insurance — and the
production hardening the reviews flagged (owner-key delivery off stdout, signup
rate limiting, `@authority` binding in the signature for multi-instance,
subdomain-aware host throttling).**

### 1. Persistence — DONE

Implemented exactly as designed: append-only JSONL event log, concrete outcomes
stored per event, policy counters rebuilt from transfers on replay, raw-apply
methods (`Ledger.insert`, `ReceiptChain.insertRaw`, `PolicyEngine.loadMandate` /
`replaySpend`), `MoneyNetwork.open(path)`. Extras beyond the plan: replay verifies
zero-sum + receipt chain and cross-checks each receipt against its transfer (a
tampered log throws instead of loading); torn final lines are truncated WAL-style;
reversal pairs are written in one atomic append along with the denial their key
must replay to; `network.revokeMandate()` + `POST /mandates/:id/revoke` so the
kill switch is durable and reachable. 9 persistence tests in
`test/persistence.test.ts`; demo section 8 rebuilds from the log live.

### 2. Agent identity — DONE

Ed25519 keypair per agent (`src/core/identity.ts`): keys travel as single-line
base64 DER (SPKI public / PKCS#8 private); the public key registers on the
Account at creation, so it persists through the event log for free. `/pay` and
`/pay-challenge` require signed headers (x-agent-id, x-signature-ts,
x-signature-nonce, x-signature) over method+path+sha256(body)+ts+nonce, verified
against the registered key with a 2-minute freshness window and a nonce replay
cache (in-memory — post-restart replays within the window are neutralized by
idempotency keys). Onboarding generates the pair and puts MONEY_AGENT_KEY in the
MCP config; the MCP server signs every API call. 8 tests in
`test/identity.test.ts` (unsigned/forged/tampered/stale/replayed/keyless all
rejected); demo section 3 shows unsigned + wrong-key spends bouncing live.

### 3. Live dashboard — DONE

`http://127.0.0.1:4021/dashboard` — one self-contained page (inline CSS/JS, zero
external requests) served by the Hono app: balances by account kind, mandate
cards with budget/daily progress bars and active/revoked/expired status, and a
newest-first live receipt feed. Real-time via SSE: `network.onEvent()` observers
hook the same `emit()` every mutation funnels through; `/dashboard/events`
pushes a full state snapshot coalesced to 250ms plus a 15s heartbeat;
`/dashboard/state` serves the JSON. All agent-controlled strings (memos, names)
are HTML-escaped — a payment memo must not script the owner's dashboard.
Verified live in a browser: feed streams while agents pay, revoking a mandate
flips its badge without a reload. Tests in `test/dashboard.test.ts`.

### 4. Owner auth on admin routes — DONE

The envelope's control plane is now gated. `POST /users` requires an owner
`publicKey` (signup = key registration, so an un-administerable account can't
exist). `/fund`, `/agents`, `/allocate`, `/mandates`, and revoke require
owner-signed requests (`x-user-id`, same Ed25519 scheme as agent spends) and
bind the signed user to the resource — `body.userId`/`ownerId` must equal the
signer or it's a 403; revoke re-checks `mandate.userId`. Grants are
idempotency-keyed (`PolicyEngine.grant` returns `{mandate, replayed}`): a
captured grant replayed after a restart returns the original mandate instead
of resetting the spent counters. Key rotation (`POST /accounts/:id/rotate-key`,
owner-signed, self or owned agent; `key_rotated` event) is the leaked-key
remediation path. Hardened from a 3-agent adversarial design review: `/providers`
route removed (durable-log poisoning), future-dated timestamps rejected beyond
30s skew, signed bodies capped at 256KB pre-hash. 9 tests in
`test/owner-auth.test.ts`; onboarding is fully owner-signed.

### 5. External x402 bridge (mock) — DONE

`src/bridge/` — one balance now pays the machine economy *outside* the loop.
Speaks x402 v1 wire format (field names verified against the coinbase/x402 spec):
parses the 402 `accepts[]`, signs an EIP-3009-shaped authorization, issues the
base64 `X-PAYMENT` header, reads the `X-PAYMENT-RESPONSE` settlement.
`ExternalWallet` is an interface; `MockWallet` signs Ed25519 (real
secp256k1/keccak EIP-712 needs deps we don't take) and the mock seller ALWAYS
verifies signatures with single-use nonces. Reshaped by the bridge critique:
- **Two-phase lifecycle** — `payExternal` debits agent→`external:x402` and mints
  the receipt at header issuance (state `pending`); `confirmExternal` finalizes
  on settlement; `sweepExternal` auto-reverses anything unconfirmed past
  `reverseAfter` via the existing `rev_` machinery, *without* handing budget
  back to the (possibly-compromised) agent.
- **Policy payee = canonical vendor host** `x402:<host>` (from the URL the agent
  fetched, never the 402 body), so the new-payee throttle covers external
  vendors and can't be dodged by case/port/dot variants. Ledger destination is
  the boundary account; `Transfer.externalPayee`/`Receipt.externalPayee` carry
  the host and are **inside the receipt hash**, so replay rebuilds throttle
  state exactly and a doctored log is refused.
- **Economic fields pinned server-side** — `ASSET_ALLOWLIST` fixes (network,
  asset, decimals); nothing economic is trusted from the 402 body; `$10`
  hard per-tx cap. USDC atomic units are micro-dollars exactly.
- `pay()`/`approveAndPay()` reject external boundary accounts as payees, so an
  injected agent can't fabricate outflows. Replaying the create key returns the
  SAME payment + header (one authorization, ever).
MCP `money_fetch` handles external 402s (`accepts[]`) with a namespaced resume
map, preferring the internal `challengeId` flow when both are present.
`MOCK_X402_PORT` on `npm run api` serves a wallet-wired mock seller for local
dev. Tests in `test/bridge.test.ts`; demo section 9 + a real MCP agent buying
from the mock seller, verified end-to-end.

**Post-implementation review (4-agent adversarial workflow, each finding
independently verified) found 4 real issues — all fixed in the next commit:**
- (HIGH) Multi-event log writes weren't crash-atomic: a torn append between a
  batch's lines could strand funds or brick the log with a duplicate `rev_`
  key. Fixed: each `emit()` is now ONE JSONL line (a JSON array), so a torn
  write drops the whole batch (`store.ts`); `sweepExternal` also guards the
  `replayed` flag. Regression test in `test/persistence.test.ts`.
- (HIGH) The external `payTo` was unbound from the mandate's payee controls —
  an injected agent could name a trusted/seen host but redirect the signed
  authorization to an attacker address. Fixed: the policy payee is now
  `x402:<host>:<payTo>`, so a fresh destination is a fresh (throttled) payee
  and a `payeeAllowlist` entry pins the exact pair. Test in `test/bridge.test.ts`.
- (LOW) `POST /users` now rejects a malformed `publicKey` (can't fill the log
  with un-authenticatable accounts); rate limiting still production-deferred.
- (LOW) `payExternal`'s replay branch now returns `denied` for an
  already-auto-reversed payment instead of a misleading `paid` + dead header.

**Remaining known v0 gaps (documented, not bugs):** the MockWallet certifies the
bridge's accounting and policy, NOT real EIP-712/secp256k1 signing or on-chain
settlement finality — mock-green ≠ chain-ready. `external:x402`'s balance is
face value (gas/fees/peg slippage unmodeled). Subdomain rotation
(`a1.evil.com`…) still gets a fresh new-payee allowance per hostname.
`POST /users` still needs rate limiting in production. There's no `fsync`, so
durability is OS-flush-dependent (acceptable for a single-node prototype).

(Real on-chain x402 — a live USDC wallet + facilitator — remains deferred: it
needs real funds. The client is built and protocol-faithful; only the wallet
and settlement are mocked.)

## How to run / verify

Environment: **Windows, Node 18.3, npm 8.** Shell is PowerShell (primary); a Bash
tool is also available — use POSIX syntax there, PowerShell syntax otherwise.

```
npm install          # if node_modules is missing
npm test             # vitest — 79 tests, must stay green
npm run typecheck    # tsc --noEmit
npm run demo         # spins up the server on 4021 and runs the full E2E story (9 sections)
npm run api          # the HTTP server (durable; MOCK_X402_PORT also serves a mock x402 seller)
npm run onboard      # owner-signed create user+agent+mandate, print .mcp.json (+ owner key)
npm run mcp          # MCP server (needs MONEY_AGENT_ID and MONEY_AGENT_KEY env)
```

Dashboard: `http://127.0.0.1:4021/dashboard`. For the external bridge locally,
`MOCK_X402_PORT=4022 npm run api` then point `money_fetch` at
`http://127.0.0.1:4022/external/report`.

## Environment gotchas (these cost real time — heed them)

- **Bind `127.0.0.1`, not `localhost`.** Node 18's `fetch` resolves `localhost` to
  `::1` (IPv6) first; the server binds IPv4. Clients must hit `http://127.0.0.1:4021`.
- **Port 4021** (402 + 1).
- **ESM project** (`"type": "module"`); imports use explicit `.ts` extensions and
  `tsconfig` has `allowImportingTsExtensions`. Run TS via `tsx`.
- **Pinned deps that matter:** `typescript@5.6`, `vitest@2`, `@hono/node-server@1.8.2`,
  `hono`, `@modelcontextprotocol/sdk`, `zod`, `tsx`, and `@rollup/rollup-win32-x64-msvc`
  as a devDep (works around an npm optional-deps bug that otherwise breaks vitest).
- **`gh` CLI is NOT installed.** Git auth goes through the GitHub Credential Manager
  (wincred). It only hands the token to `git credential fill` when interactivity is
  allowed — run that time-boxed (e.g. `timeout 25 git credential fill`) rather than
  fully non-interactive, which returns nothing. `git push` itself works fine.
- Project memory lives under the Claude project dir and loads automatically for this
  repo; it has the running project log. Keep it updated as you go.

## First moves for the new agent

1. `git status` and `npm test` — confirm you're starting from green.
2. Skim the file map above in order.
3. Implement persistence (task 1), add the restart test, run `npm run demo` and
   `npm test`, then commit + push.
4. Then identity, then the dashboard.
