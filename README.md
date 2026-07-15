# money — Venmo for agents

A closed-loop payment network where AI agents pay each other and pay APIs/CLIs, at will, under a user-signed spending envelope. Users set money aside; agents spend it — very high volumes of very low-cost transactions, settled as ledger rows: instant, fee-free, sub-cent capable.

## Why closed-loop

When both sides of a transaction are on the same ledger, a payment is a database row. That's the only architecture that serves the agent economy's real shape (July 2026: ~75M machine payments/month averaging $0.32 on x402) — no card rail can touch sub-cent economics, and no on-chain rail beats a ledger row's latency. External rails (cards, stablecoins, banks) matter only at the edges: top-up and cash-out. This is how PayPal, Alipay, and M-Pesa actually won.

## Core design principles

1. **The envelope is the security boundary, not the model's judgment.** Spending limits live in a deterministic policy engine outside any model context. Injected text can ask; nothing in an agent's context can sign or widen a mandate.
2. **Hold authorization, not money** (production posture: FBO account at a sponsor bank; this prototype simulates the boundary as the `external:funding` account).
3. **Prefunding buys the speed.** Authorization is a local policy + balance check — no external round-trip on the hot path.
4. **Exactly-once by construction.** Idempotency keys on every transfer; 402 challenges pay-once/redeem-once. Agents retry by default — the network must shrug.

## What's here (v0)

| Piece | File | What it does |
|---|---|---|
| Ledger | `src/core/ledger.ts` | Double-entry over integer micro-dollars, idempotency-keyed, zero-sum invariant |
| Policy | `src/core/policy.ts` | Mandates (budget, per-tx cap, daily cap, escalation line, new-payee throttle, allowlist, expiry) → single-use permits bound to exact payee+amount |
| Receipts | `src/core/receipts.ts` | Hash-chained evidence log; tamper detection |
| Network | `src/core/network.ts` | The facade: accounts, funding, agent-to-agent `pay()`, human `approveAndPay()`, 402 challenges |
| HTTP API | `src/server/api.ts` | Hono server on **:4021** — network API + demo paid endpoints behind an x402-shaped 402 gate |
| MCP server | `src/mcp/server.ts` | `money_balance`, `money_pay`, `money_fetch` (auto-pays 402s within mandate), `money_feed` |
| Demo | `src/demo.ts` | The full story end-to-end, including denial and tamper cases |

## Run it

```bash
npm install
npm test         # ledger/policy/network invariants
npm run demo     # the whole story in one script
npm run api      # just the HTTP server on :4021
```

### Give a Claude Code agent a wallet

Start the API (`npm run api`), then in another terminal:

```bash
npm run onboard    # creates user + agent + mandate, prints the MCP config
```

Or wire it manually — add to `.mcp.json`:

```json
{
  "mcpServers": {
    "money": {
      "command": "npx",
      "args": ["tsx", "C:/Users/mcalk/code/money/src/mcp/server.ts"],
      "env": {
        "MONEY_API": "http://localhost:4021",
        "MONEY_AGENT_ID": "agt_xxxxxxxx"
      }
    }
  }
}
```

The agent can then check its balance, pay other agents, and fetch 402-gated URLs that get paid automatically inside its mandate.

## The mandate model

```
grant: budget $10 · per-tx $1 · daily $5 · ask-me-above $2 · new-payee first-touch 10¢ · expires 30d
```

- **Escalation**: above the ask-me line, the network returns `escalate`; a human approval mints a one-time permit bound to the *exact* payee+amount approved ("approval is the mandate" — no gap between what the human saw and what executes).
- **New-payee throttle**: the first payment to any unseen payee is capped at cents. A prompt-injected agent lured to an attacker's endpoint can leak cents/day, not the envelope. Payees inside the owner's own trust domain (the owner, sibling agents they own) are exempt — money paid to them never leaves the owner's accounts. Everything else (caps, budget, escalation) still applies to them.
- **Permits**: single-use, 60s TTL, bound to (agent, payee, amount). Replay and amount-inflation are structurally dead.

## Honest v0 shortcuts (the roadmap is the inverse)

- In-memory state; no persistence (→ Postgres, event-sourced from the receipt chain).
- `x-agent-id` header is identification, not authentication (→ signed requests / Web Bot Auth keypairs per agent, chained to a KYC'd owner).
- Single-node; network and API share a process (→ policy/signer split into separate trust domains, as in the design brief).
- No external rails: top-up is simulated (→ card/ACH via sponsor-bank FBO; USDC leg for x402 interop).
- Single-owner loop only: agents of one user pay each other and providers. **Cross-owner transfers are deliberately out** — that's the money-transmission line; it comes with licensing/partner structure, not before.
- No subscriptions, refunds, sub-agent delegation, or insurance yet — these are the differentiators identified in the design brief and belong on the roadmap in that order.

## The bigger picture

See the design brief (research + architecture + market map, July 2026): the artifact "The Agent Spend Account". The wedge: the neutral, dual-economy spend account for coding-agent runtimes — one balance paying both x402-style machine endpoints and fiat-priced metered providers, enforced outside the model, exactly-once, with one receipt feed.
