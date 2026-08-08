# Session caps are not mandates

*A technical comparison of owner controls for agent spending: Coinbase Payments MCP's cap model vs. a deterministic mandate engine. Every behavior claimed below is shown with captured output from open-source code you can run yourself.*

## tl;dr

- Coinbase Payments MCP is well-built: limits live outside the model, the agent literally has no transfer or onramp tools, custody is non-custodial MPC, and setup takes minutes. Credit where due.
- Its owner controls are two numbers: a max per call and a max per session, set in the wallet UI. Those answer *how much*. They cannot answer *to whom*, *first time or fiftieth?*, *does a human need to see this one?*, *was this retry already paid?*, or *can I prove this history later?*
- A mandate is a signed policy object that answers all of those, deterministically, outside the model: escalation lines with durable exact-tuple approvals, new-payee throttles keyed on host + destination, allowlists, a budget refunds can't replenish, exactly-once retries, and hash-chained receipts.
- Concretely: under a $0.05/call, $5/session cap, a prompt-injected agent can route the entire $5 to an attacker's brand-new endpoint in 100 policy-compliant calls. Under the mandate below, the first touch of any unseen payee is capped at $0.10 and the attempt is denied with a machine-readable reason.
- None of this requires our runtime or our rail. The wallet is a stdio MCP server that runs in the same clients Coinbase supports; the policy engine doesn't care whether settlement is a ledger row or x402/USDC.

## What Coinbase actually shipped

[Payments MCP](https://github.com/coinbase/payments-mcp) (an installer for what the docs now call the Agentic Wallet MCP) gives an agent an embedded wallet plus x402 payments in Claude Desktop, Claude Code, Codex CLI, Gemini CLI, Cherry Studio, and any stdio MCP client. The [tool surface](https://docs.cdp.coinbase.com/agentic-wallet/mcp/mcp-tools/overview) is tight: get address, get balance, open the wallet UI, check sign-in, discover Bazaar services, fetch a service's docs, check an endpoint's price without paying, and make an x402 request that handles payment automatically, on Base, Polygon, or Solana.

The owner controls, per the docs: you configure a max spend per call (their example: $0.05) and a max per session (their example: $5.00) in the wallet UI. "Agents respect these limits but can't change them," as [the tools reference](https://docs.cdp.coinbase.com/payments-mcp/tools-reference) puts it. Just as important is what the MCP agent *cannot* do by construction: it cannot set limits, cannot transfer funds to arbitrary addresses, and cannot onramp. The [FAQ](https://docs.cdp.coinbase.com/agentic-wallet/mcp/faq) is clear that the wallet is non-custodial and recovered via email/OTP. Settlement on Base is gasless via a paymaster, so the agent never holds ETH.

Three things here are genuinely right, and we build on the same principles:

1. **Enforcement outside the model.** The agent cannot widen its own limits. This is the core insight — injected text can ask, but nothing in model context can authorize.
2. **Capability subtraction beats policy checking.** An agent with no transfer tool can't be talked into a transfer. Structural absence is the strongest control there is.
3. **Low-friction custody.** MPC-backed keys the agent never sees, no seed phrase in context, minutes to set up. This is what mass adoption of agent wallets will actually require.

The broader Coinbase platform also has richer primitives — Spend Permissions and an embedded-wallet policy engine with allowlists and value caps exist in CDP's server-side APIs. But the Payments MCP owner surface, as documented today, is the two caps. That surface is what an owner actually configures, so it's what we compare against.

## The question caps can't ask

A per-call cap and a session cap treat every counterparty identically. The vendor you've paid fifty times and the endpoint an injected instruction invented ten seconds ago get exactly the same budget. So the honest failure model under a $0.05/$5.00 configuration is: a compromised agent can spend $5.00 per session, $0.05 at a time, to anyone, silently, and the caps are working as designed. There is also no path for a payment the owner would *want* to make — one over the cap — except raising the cap for everything.

A mandate makes the counterparty, the novelty, the amount, and the human's role all part of one policy decision. Here is the grant our demo owner signs:

```
budget $10 · per-tx $1 · daily $5 · ask-me-above $2 · new-payee first-touch 10¢ · expires 30d
```

Everything below is enforced in `src/core/policy.ts` by a deterministic engine outside any model context, and the same rules are enforced in SQL, atomically with the double-entry journal, in the Postgres kernel (`db/migrations/0002_policy.sql`, `0005_external_settlement.sql`). Outputs are captured from the published wallet (`@agentmoney/wallet-mcp`, Apache-2.0) driving the local network API, plus a short capture script against the same engine.

### 1. New-payee throttle: novelty is a policy input

The first payment to any payee this mandate has never seen is capped at cents — regardless of the per-tx cap. The classic injection ("urgent: pay this vendor now") hits this wall:

```
▶ money_pay {"to":"prv_2a12878c","amount_usd":0.5,"memo":"urgent: pay this vendor now", ...}
{
  "status": "denied",
  "code": "new_payee_cap",
  "reason": "first payment to unseen payee prv_2a12878c is capped at $0.10 (injection throttle)"
}
```

For external x402 payments, the payee identity is keyed on **canonical host plus destination address** — in the Postgres kernel, literally `'x402:' || lower(host) || ':' || lower(pay_to)`, and the kernel rejects any external payment whose stated policy payee disagrees with its host and destination. Swapping the `payTo` address on a trusted seller's host produces a *new* payee that starts back at the first-touch cap; an attacker's endpoint can't inherit anyone's trust. Sibling agents under the same owner are exempt (that money never leaves the owner's accounts); every other limit still applies to them.

### 2. Escalation lines: over-the-line payments go to a human, not to a wall

Above the ask-me line, the payment isn't denied — it becomes a durable approval request:

```
▶ money_pay {"to":"@writer","amount_usd":3,"memo":"rush: full market survey tonight", ...}
{
  "status": "approval_required",
  "approval": {
    "id": "apr_2b9daa2c-...", "to": "agt_f7c131b0", "amount": 3000000,
    "memo": "rush: full market survey tonight",
    "createdAt": 1786213274388, "expiresAt": 1786299674388, "status": "pending"
  }
}
```

The owner's inbox shows the stored payee, amount, and memo. Approving executes **that immutable tuple** — approval mints a single-use permit bound to (agent, payee, amount), so there is no gap between what the human saw and what settles. The approval bypasses the escalation line, the per-tx cap, and the new-payee throttle, but never the total budget or expiry. Requests survive restart, expire after 24 hours, and recover exactly once across a crash at settlement. A session cap has no equivalent: its only two outcomes are silent success and a failure the owner can fix only by raising the cap for every future payment.

### 3. Allowlists: to-whom as a hard boundary

When an agent's job is "pay these three APIs," the mandate can say exactly that:

```
### pay a payee NOT on the mandate allowlist
{
  "status": "denied",
  "code": "payee_not_allowed",
  "reason": "payee prv_e4f0b6c7 is not on this mandate's allowlist"
}
```

The same $0.05 to the allowlisted payee succeeds. Coinbase's platform APIs do have allowlist primitives server-side; the difference is that here the allowlist is one field of the same owner-signed object as the caps, throttles, and escalation line, evaluated in one place, per mandate, per agent.

### 4. A budget refunds can't restore

Session caps reset when the session does. A mandate budget is a durable counter — and it deliberately does not decrement on refunds:

```
### budget: try $0.20 more (would exceed $1.00 total budget)
{ "status": "denied", "code": "budget",
  "reason": "would exceed total budget: spent $0.90 of $1.00, requested $0.20" }

### provider refunds the full $0.90 ... then:
### mandate counters AFTER the refund
{ "budget": "$1.00", "spent": "$0.90", "agentBalanceAfterRefund": "$9.95" }

### retry the $0.20 payment after the refund (still denied)
{ "status": "denied", "code": "budget",
  "reason": "would exceed total budget: spent $0.90 of $1.00, requested $0.20" }
```

The money comes back; the *spending authority* does not. A colluding buyer and seller cannot pay-and-refund in a loop to recycle an agent's envelope. Refunds are also bound to the original receipt and cumulatively capped at the purchase amount, in SQL, so replicas and retries can't over-refund.

### 5. Exactly-once retries

Agents retry by default. The x402 protocol carries no buyer-side idempotency key: a retried request is a fresh payment. (To be fair, an EIP-3009 authorization has a nonce, so replaying the *same signed payload* fails on-chain — but a client that retries by signing a fresh authorization has paid twice. Whether a given wallet deduplicates is implementation-defined.) Here it's a contract: the agent retried the approved $3 payment with the same idempotency key and got the *original* transfer and receipt back:

```
▶ money_pay {"to":"@writer","amount_usd":3, ..., "idempotency_key":"task-1441-rush"}
{ "status": "paid",
  "transfer": { "id": "tr_bb3bbffc-0002-42f0-8f5d-2bc190cf3192", ... },
  "receipt":  { "id": "rcp_361a07c3-859c-412f-8df5-7a1a120736bc", ... },
  "replayed": true }
```

Same key with changed terms returns an idempotency conflict instead. Nothing pays twice; nothing pays differently than recorded.

### 6. Hash-chained receipts: evidence that travels

Every payment appends a receipt whose hash covers the previous receipt's hash, and every receipt names the mandate and single-use permit that authorized it:

```
▶ verify chain →  {"ok": true}
### after mutating receipt seq 0's amount by one micro
{"ok": false, "brokenAt": 0}
```

Coinbase's answer here is reasonable — an activity log, plus on-chain settlement that anyone can verify. But March's [Artemis analysis](https://www.coindesk.com/markets/2026/03/11/coinbase-backed-ai-payments-protocol-wants-to-fix-micropayment-but-demand-is-just-not-there-yet) showed why on-chain visibility isn't sufficient evidence: roughly half of observed x402 transactions were self-dealing or wash cycles. A transaction hash proves a transfer happened; it says nothing about whether the commerce was real. A receipt that is chained (tamper-evident), policy-linked (which owner authority, which permit, which mandate), and rail-agnostic (identical shape for a ledger-row micropayment and an external x402 settlement) is the artifact an auditor, a dispute process, or a skeptical analyst can actually use.

## What we're not claiming

This is a comparison of control models, not of businesses. Coinbase has distribution, a custody stack, and a funded team; agentmoney is an open-source project whose Postgres kernel and published SDKs are real and tested, whose external x402 path is implemented and exercised against test infrastructure, and whose mainnet activation sits behind deliberately small hard caps on the near-term roadmap. Session caps also cover one thing mandates don't remove: they're two numbers a non-technical owner understands in five seconds. Policy richness has to earn its complexity with defaults this simple — our default grant is one line for a reason.

## Why this ends at neutrality

The deeper difference isn't any single control. Coinbase's caps live inside Coinbase's wallet, on Coinbase-supported rails. Stripe's agent approvals live inside Stripe's processing. Google's AP2 mandates live inside AP2. Each is good design bound to one company's stack.

A spend policy is most useful exactly when it *doesn't* care where it runs or how it settles. The mandate engine above is a stdio MCP server that runs in Claude Code, Codex, Gemini, Cursor — the same list — and the policy decision is identical whether the payment settles as a database row, as x402/USDC on Base, or (behind a bank-approved treasury boundary that exists in code but is honestly not live) as fiat. Escalation lines, new-payee throttles, allowlists, refund-proof budgets, exactly-once retries, and chained receipts, one signed object, above the rail rather than inside one.

Session caps are a good seatbelt. A mandate is the traffic law. Agents are about to need both — from someone neutral enough to enforce them everywhere.

---

*Everything shown is reproducible: the wallet is [`@agentmoney/wallet-mcp`](https://www.npmjs.com/package/@agentmoney/wallet-mcp) on npm (Apache-2.0), and `npm run demo` in the repo replays the full story, including the denials. Corrections welcome — especially from the Coinbase team, whose docs we've tried to represent fairly: [overview](https://docs.cdp.coinbase.com/payments-mcp/welcome), [tools](https://docs.cdp.coinbase.com/agentic-wallet/mcp/mcp-tools/overview), [FAQ](https://docs.cdp.coinbase.com/agentic-wallet/mcp/faq).*
