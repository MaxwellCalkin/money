# Shared description set — @agentmoney/wallet-mcp

Canonical copy used by every listing surface. Every claim below is grounded in
`packages/wallet-mcp/README.md`, `packages/wallet-mcp/dist/server.js`, and
`packages/wallet-mcp/package.json` (v0.13.0) as of 2026-08-08. Do not add
capabilities that are not in the shipped package.

## Canonical facts (do not deviate)

| Fact | Value |
|---|---|
| npm package | `@agentmoney/wallet-mcp` v0.13.0 — https://www.npmjs.com/package/@agentmoney/wallet-mcp |
| Bin | `money-wallet-mcp` (`npx -y @agentmoney/wallet-mcp`) |
| Transport | stdio (MCP), Node >= 20 |
| Tools | `money_balance`, `money_pay`, `money_fetch`, `money_feed` (exactly four) |
| License | Apache-2.0 |
| Repo | https://github.com/MaxwellCalkin/money (monorepo dir `packages/wallet-mcp`) |
| Runtimes | Any MCP client: Claude Code, Cursor, Codex, etc. |
| Author | Maxwell Calkin |

Tool one-liners (match the registered MCP tool descriptions):

- `money_balance` — spendable balance and mandate state.
- `money_pay` — pay any account (agent, provider, or user) by id or `@handle`;
  idempotency-keyed so retries can never double-charge; over-line payments
  return a durable `approval_required` request for the owner's inbox.
- `money_fetch` — GET a URL; on HTTP 402 (a money-network challenge or an
  external x402 seller) pay it within the mandate and retry automatically —
  exactly-once, crash-recoverable; external x402 payments are policy-checked,
  capped, and auto-reversed if the seller never delivers.
- `money_feed` — recent receipts from the hash-chained evidence feed.

## The one differentiator every listing must carry

The mandate is enforced by the network, never by the model. Budget,
per-payment cap, daily cap, ask-me-above escalation line, new-payee throttle —
all checked server-side. Injected text can ask; nothing in the agent's context
can sign or widen a mandate. The hero moment is the wallet saying **no** to an
over-cap payment (and routing it to the owner's approval inbox instead).

## Honesty constraints (from docs/GOTOMARKET.md)

- Never fake traction. No user counts, no "trusted by", no fabricated logos.
- Do not claim a hosted service exists. Today the honest install story is:
  run the money network yourself (repo) or get credentials from a network
  operator. When the hosted beta ships it is described as
  "invite-only beta, testnet-labeled, best-effort" — nothing more.
- Fail-closed is the brand: it is fine (good, even) to lead with refusal.

## Short description — 92 chars (fits the official registry's 100-char limit)

> A spend account for AI agents: balance, pay, and 402 auto-pay under an owner-signed mandate.

Alternate short (95 chars, refusal-forward — use where a second line exists):

> Gives your agent a wallet that can say no: pay APIs and 402 URLs under an owner-signed mandate.

## Medium description (~360 chars — directory cards, npm-style blurbs)

> An MCP wallet that gives any agent runtime (Claude Code, Cursor, Codex) a
> spending account on a money network. Four tools — balance, pay, 402
> auto-pay fetch, receipts — with the owner's mandate (budget, per-payment
> cap, daily cap, ask-me-above line, new-payee throttle) enforced by the
> network, never by the model. Every payment leaves a hash-chained receipt.

## Long description (detail pages: mcp.so content, PulseMCP, landing page)

> **@agentmoney/wallet-mcp** gives any MCP-capable agent runtime (Claude
> Code, Cursor, Codex) a real spending account on a
> [money](https://github.com/MaxwellCalkin/money) network.
>
> The agent gets four tools:
>
> - `money_balance` — spendable balance and mandate state
> - `money_pay` — pay any account (agent, provider, or user) by id or
>   `@handle`, idempotency-keyed so a retry can never charge twice
> - `money_fetch` — GET a URL; on HTTP 402 (a money-network challenge or an
>   external x402 seller) it pays within the mandate and retries
>   automatically — exactly-once and crash-recoverable
> - `money_feed` — recent receipts from the hash-chained evidence feed
>
> **The mandate is the security boundary, not the model's judgment.** The
> owner signs a mandate — budget, per-payment cap, daily cap, an
> ask-me-above escalation line, a new-payee throttle — and the network
> enforces it deterministically on every payment. The agent process holds
> only its own signing key: never the owner key, never a spending decision.
> Prompt-injected text can ask for money; nothing in the agent's context can
> sign or widen a mandate. Payments over the escalation line don't fail and
> don't sneak through — they land in the owner's approval inbox as a durable
> request the agent can resume after the owner decides.
>
> **Exactly-once by construction.** Retries reuse idempotency keys,
> paid-but-undelivered fetches resume with the existing receipt instead of
> paying again, and in-flight external payments are recovered from the
> network's durable record after a crash. External x402 payments are
> policy-checked, capped, and auto-reversed if the seller never delivers.
>
> **Hardened fetch.** `money_fetch` requires HTTPS on the public internet,
> re-resolves DNS and pins the socket to the checked address, refuses to
> auto-follow redirects (they come back as validated URLs, and receipts or
> one-time payment headers are never forwarded across them), blocks private
> networks by default, and caps response bodies.
>
> Every transaction leaves a hash-chained receipt — portable, tamper-evident
> spend evidence you can hand to anyone.
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

## Tags / categories (pick per surface from this set, in this priority)

`payments`, `wallet`, `x402`, `agent-payments`, `finance`, `mcp`,
`ai-agents`, `commerce`, `api-monetization`

## Suggested display names

- Directory display name: **Agent Money Wallet**
- Where the package name is the display name: `@agentmoney/wallet-mcp`
- Never "AgentMoney Pay", "MoneyGPT", or anything implying a hosted product.
