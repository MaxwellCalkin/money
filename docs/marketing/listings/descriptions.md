# Shared description set — @agentmoney/wallet-mcp

Canonical copy used by every listing surface. Every claim below is grounded in
`packages/wallet-mcp/README.md`, `src/mcp/server.ts`, and
`packages/wallet-mcp/package.json` (v0.14.0) as of 2026-08-23. Do not add
capabilities that are not in the shipped package.

## Canonical facts (do not deviate)

| Fact | Value |
|---|---|
| npm package | `@agentmoney/wallet-mcp` v0.14.0 (this repo; npm publish pending — live npm is 0.13.0 until the v0.14.0 publish lands, a move-2 gate) — https://www.npmjs.com/package/@agentmoney/wallet-mcp |
| Bin | `money-wallet-mcp` (`npx -y @agentmoney/wallet-mcp`) |
| Transport | stdio (MCP), Node >= 20 |
| Tools | `money_balance`, `money_pay`, `money_fetch`, `money_card_create`, `money_card_status`, `money_card_close`, `money_feed` (exactly seven) |
| Rails | three: instant agent-to-agent ledger payments · x402/HTTP-402 auto-pay for machine-priced APIs · reserved virtual cards for ordinary checkouts (sandbox/test-mode today) |
| License | Apache-2.0 |
| Repo | https://github.com/MaxwellCalkin/money (monorepo dir `packages/wallet-mcp`) |
| Runtimes | Any MCP client: Claude Code, Cursor, Codex, etc. |
| Author | Maxwell Calkin |

Card-rail server requirement (state wherever the card tools are described):
the card tools need a network API with the card rail (the Postgres-backed
server, v0.14+). Against an older API they return a clear "this API does not
implement /cards" message; networks without a configured card issuer answer
`503`. The card rail runs in sandbox/test-mode today — sandbox, no real funds;
nothing here is a bank, card, or deposit account.

Tool one-liners (match the registered MCP tool descriptions in
`src/mcp/server.ts`):

- `money_balance` — how much this agent can still spend under its owner's
  mandate.
- `money_pay` — pay any account (agent, provider, or user) by id or `@handle`;
  idempotency-keyed so retries can never double-charge; larger payments
  return a durable `approval_required` request for the owner's inbox.
- `money_fetch` — GET a URL; on HTTP 402 (a money-network challenge or an
  external x402 seller) pay it within the mandate and retry automatically —
  exactly-once, crash-recoverable; external x402 payments are policy-checked,
  capped, and auto-reversed if the seller never delivers.
- `money_card_create` — a reserved virtual card under the owner's spend
  mandate, for buying at an ordinary online merchant (checkout pages, APIs,
  SaaS). Single-use by default, locked to one merchant, and its full cap is
  reserved from the agent funds at issue; the unspent remainder returns when
  the card closes. Returns only the last4 — the tool never sees or returns
  the card number. Caps above the owner's escalation threshold become a
  durable approval request instead.
- `money_card_status` — one card's state, cap, what has cleared at the
  merchant, and whether the owner has approved it yet.
- `money_card_close` — close a card; the unspent remainder of its cap returns
  to the agent funds; mandate authority already used is not restored.
- `money_feed` — recent receipts from the hash-chained evidence feed.

## The one differentiator every listing must carry

Deterministic policy, outside the model. The owner's spend mandate — budget,
per-transaction cap, daily cap, ask-me-above escalation line, new-payee
throttle, payee allowlist — is enforced by the network on all three rails,
never by the model. On the card rail the same ladder answers the merchant
network's synchronous authorization request in real time, and the card number
never enters the model's context (the tools return only the last4). Injected
text can ask; nothing in the agent's context can sign or widen a mandate. The
hero moment is the wallet saying **no**: in the deterministic demo transcript
(`docs/marketing/demo/agent-card-transcript.md`) a $29.00 purchase at the
mandated merchant is APPROVED in under 2 seconds and a $400.00 gift-card
attempt at an unseen merchant is DECLINED, decline code `new_payee_cap`.

## Honesty constraints (from docs/GOTOMARKET.md)

- Never fake traction. No user counts, no "trusted by", no fabricated logos.
- The card rail is sandbox/test-mode today. Label every card surface
  "sandbox, no real funds". The Stripe Issuing integration is
  protocol-faithful, fixture-tested, test-mode ready — there is no live card
  program. x402 mainnet settlement is implemented; activation is gated on a
  small (~$15) founder float.
- Do not claim a hosted service exists. Today the honest install story is:
  run the money network yourself (repo) or get credentials from a network
  operator. When the hosted beta ships it is described as
  "invite-only beta, testnet-labeled, best-effort" — nothing more.
- Fail-closed is the brand: it is fine (good, even) to lead with refusal.

## Short description — 97 chars (fits the official registry's 100-char limit)

> Owner-mandated spending for AI agents: agent payments, x402 auto-pay, and reserved virtual cards.

Alternate short (95 chars, refusal-forward — use where a second line exists):

> Gives your agent a wallet that can say no: three rails, one owner mandate the network enforces.

## Medium description (~420 chars — directory cards, npm-style blurbs)

> An MCP wallet that gives any agent runtime (Claude Code, Cursor, Codex)
> owner-mandated spending across three rails: instant agent-to-agent
> payments, x402/HTTP-402 auto-pay for machine-priced APIs, and reserved
> virtual cards for ordinary checkouts (sandbox/test-mode today). Seven
> tools. Mandate caps, approvals, and new-payee throttles are enforced by
> the network, never the model; the card number never enters the model's
> context; every payment leaves a hash-chained receipt.

## Long description (detail pages: mcp.so content, PulseMCP, landing page)

> **@agentmoney/wallet-mcp** gives any MCP-capable agent runtime (Claude
> Code, Cursor, Codex) a real spending account on a
> [money](https://github.com/MaxwellCalkin/money) network — owner-mandated
> spending across three rails: instant agent-to-agent payments on the
> network's ledger, x402/HTTP-402 auto-pay for machine-priced APIs, and
> reserved virtual cards for ordinary online checkouts (sandbox/test-mode
> today — sandbox, no real funds).
>
> The agent gets seven tools:
>
> - `money_balance` — how much the agent can still spend under its owner's
>   mandate
> - `money_pay` — pay any account (agent, provider, or user) by id or
>   `@handle`, idempotency-keyed so a retry can never charge twice
> - `money_fetch` — GET a URL; on HTTP 402 (a money-network challenge or an
>   external x402 seller) it pays within the mandate and retries
>   automatically — exactly-once and crash-recoverable
> - `money_card_create` — a reserved virtual card under the same mandate for
>   an ordinary merchant: single-use by default, locked to one merchant, its
>   full cap reserved from the agent funds at issue; returns only the last4
> - `money_card_status` — one card's state, cap, cleared amount, and
>   authorizations
> - `money_card_close` — close a card; the unspent remainder returns to the
>   agent funds (mandate authority already used is not restored)
> - `money_feed` — recent receipts from the hash-chained evidence feed
>
> **The mandate is the security boundary, not the model's judgment.** The
> owner signs a mandate — budget, per-transaction cap, daily cap, an
> ask-me-above escalation line, a new-payee throttle, a payee allowlist —
> and the network enforces it deterministically on every payment, on every
> rail. When the merchant network asks about a card purchase, a fixed
> decline ladder answers inside the issuer's synchronous window — no model
> in the loop. The agent process holds only its own signing key: never the
> owner key, never a spending decision. Prompt-injected text can ask for
> money; nothing in the agent's context can sign or widen a mandate.
> Payments and cards over the escalation line don't fail and don't sneak
> through — they land in the owner's approval inbox as a durable request the
> agent can resume after the owner decides.
>
> **The card number never enters the model's context.** There is no reveal
> tool: `money_card_create` returns the last4, expiry, cap, and merchant —
> enough to recognize the card, nothing that can leak it. In `token` reveal
> mode the network returns a single-use checkout token that host code —
> never the model — redeems to fill the merchant's payment form outside
> model context; in the default `none` mode no reveal surface exists at all.
>
> **Exactly-once by construction.** Payments and card requests are
> idempotency-keyed — a retried request returns the original receipt or
> card instead of charging or reserving twice. Paid-but-undelivered fetches
> resume with the existing receipt instead of paying again, and in-flight
> external payments are recovered from the network's durable record after a
> crash. External x402 payments are policy-checked, capped, and
> auto-reversed if the seller never delivers.
>
> **Hardened fetch.** `money_fetch` requires HTTPS on the public internet,
> re-resolves DNS and pins the socket to the checked address, refuses to
> auto-follow redirects (they come back as validated URLs, and receipts or
> one-time payment headers are never forwarded across them), blocks private
> networks by default, and caps response bodies.
>
> Every transaction — ledger payment, x402 purchase, card reserve and
> settlement — leaves a hash-chained receipt on one feed: portable,
> tamper-evident spend evidence you can hand to anyone.
>
> Honest status today: the card rail runs in sandbox/test-mode (the Stripe
> Issuing integration is protocol-faithful, fixture-tested, test-mode
> ready) — sandbox, no real funds. x402 mainnet settlement is implemented;
> activation is gated on a small founder float. The card tools require a
> network API with the card rail (the Postgres-backed server, v0.14+);
> older APIs return a clear "not implemented" message instead of failing
> silently.
>
> Works against any money network deployment: run the network yourself from
> the repo, or point `MONEY_API` at a network operator that gives you an
> agent id and key file. Apache-2.0.

## The exact `.mcp.json` env contract (identical on every surface)

```json
{
  "mcpServers": {
    "money": {
      "command": "npx",
      "args": ["-y", "@agentmoney/wallet-mcp"],
      "env": {
        "MONEY_API": "https://your-money-network.example",
        "MONEY_AGENT_ID": "agt_xxxxxxxx",
        "MONEY_AGENT_KEY_FILE": "/absolute/path/to/agent.key"
      }
    }
  }
}
```

Env var reference (from the package README — quote verbatim where a surface
has an env/config table):

| Env var | Required | Meaning |
|---|---|---|
| `MONEY_API` | yes (has local default) | Network API origin. HTTPS required except on loopback. Default `http://127.0.0.1:4021`. |
| `MONEY_AGENT_ID` | yes | This agent's account id (`agt_...`). |
| `MONEY_AGENT_KEY_FILE` | one of the two keys | Path to a file whose first line is the agent's base64 PKCS#8 Ed25519 private key. **Preferred** — keeps the key out of `.mcp.json`. |
| `MONEY_AGENT_KEY` | one of the two keys | The key inline. Fallback; treat like a password (secret). |
| `MONEY_FETCH_PRIVATE_ORIGINS` | no | Optional JSON array of exact origins (e.g. `["http://127.0.0.1:8080"]`) the agent may fetch on private networks. Nothing private is reachable by default. |

The card tools need no extra client config — reveal mode (`none`/`token`) is
a network-side setting, and no card number ever reaches the client.

## Tags / categories (pick per surface from this set, in this priority)

`payments`, `wallet`, `virtual-cards`, `x402`, `agent-payments`, `finance`,
`mcp`, `ai-agents`, `commerce`, `api-monetization`

## Suggested display names

- Directory display name: **Agent Money Wallet**
- Where the package name is the display name: `@agentmoney/wallet-mcp`
- Never "AgentMoney Pay", "MoneyGPT", or anything implying a hosted product.
