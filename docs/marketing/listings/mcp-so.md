# mcp.so — submission package

Surface: https://mcp.so — large community directory (chatmcp), listing pages
with a markdown body and a "Server Config" JSON block.

## Submission mechanics

1. **Form (primary):** https://mcp.so/submit — sign in, submit the public
   GitHub repo URL (only public GitHub MCP servers are supported). The
   submission creates a **draft**; complete the draft fields (title,
   description, content, config) and **save — saving publishes it
   automatically**.
2. **Fallback:** leave the repo link as a comment on the maintainers'
   intake issue: https://github.com/chatmcp/mcp-directory/issues/1
   ("Submit Your MCP Servers here"). They also take tickets for
   non-standard cases (clients, non-open-source, website URLs).
3. Monorepo note: submit the repo root URL if the form rejects a subfolder
   path, and put the subfolder link in the content body.

## Draft fields (copy-paste)

| Field | Value |
|---|---|
| Name (slug) | agentmoney-wallet |
| Title | Agent Money Wallet — a spend account for AI agents |
| Description (card/SEO, 155 chars) | MCP wallet for AI agents: pay agents, auto-pay HTTP 402/x402 APIs, and buy at ordinary checkouts with reserved virtual cards under an owner-signed mandate. |
| GitHub URL | https://github.com/MaxwellCalkin/money |
| Website | https://github.com/MaxwellCalkin/money/tree/main/packages/wallet-mcp |
| Categories / Tags | payments, wallet, virtual-cards, x402, finance, ai-agents, commerce |
| Type | MCP Server (community, local/stdio) |

Server Config block (their pages render one; use the exact contract):

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

## Content body (markdown for the draft's long field)

Paste everything below the line verbatim.

---

**@agentmoney/wallet-mcp** gives any MCP-capable agent runtime (Claude
Code, Cursor, Codex) a real spending account on a
[money](https://github.com/MaxwellCalkin/money) network — owner-mandated
spending across three rails: instant agent-to-agent payments on the
network's ledger, x402/HTTP-402 auto-pay for machine-priced APIs, and
reserved virtual cards for ordinary online checkouts (sandbox/test-mode
today — sandbox, no real funds).

## Tools

| Tool | What it does |
|---|---|
| `money_balance` | How much the agent can still spend under its owner's mandate |
| `money_pay` | Pay any account (agent, provider, user) by id or `@handle`, idempotency-keyed |
| `money_fetch` | GET a URL; on HTTP 402 (network challenge or external x402 seller) pay it within the mandate and retry — exactly-once, crash-recoverable |
| `money_card_create` | A reserved virtual card under the owner's spend mandate for an ordinary merchant — single-use by default, merchant-locked, full cap reserved at issue; returns only the last4 |
| `money_card_status` | One card's state, cap, cleared amount, and authorizations |
| `money_card_close` | Close a card; the unspent remainder returns to the agent funds |
| `money_feed` | Recent receipts from the hash-chained evidence feed |

## Why this wallet

**The mandate is the security boundary, not the model's judgment.** The
owner signs a mandate — budget, per-transaction cap, daily cap, an
ask-me-above escalation line, a new-payee throttle, a payee allowlist —
and the network enforces it deterministically on every payment, on every
rail. When the merchant network asks about a card purchase, a fixed
decline ladder answers inside the issuer's synchronous window — no model
in the loop. The agent process holds only its own signing key: never the
owner key, never a spending decision. Prompt-injected text can ask for
money; nothing in the agent's context can sign or widen a mandate.
Over-the-line payments and cards are refused and land in the owner's
approval inbox as a durable request the agent can resume after the owner
decides.

**The card number never enters the model's context.** There is no reveal
tool: `money_card_create` returns the last4, expiry, cap, and merchant —
enough to recognize the card, nothing that can leak it. In `token` reveal
mode the network returns a single-use checkout token that host code —
never the model — redeems to fill the merchant's payment form outside
model context; in the default `none` mode no reveal surface exists at
all. The card tools require a network API with the card rail (the
Postgres-backed server, v0.14+); the card rail is sandbox/test-mode today
— sandbox, no real funds.

**Exactly-once by construction.** Payments and card requests reuse
idempotency keys — a retry returns the original receipt or card instead
of charging or reserving twice. Paid-but-undelivered fetches resume with
the existing receipt instead of paying again, and in-flight external
payments are recovered from the network's durable record after a crash.
External x402 payments are policy-checked, capped, and auto-reversed if
the seller never delivers.

**Hardened fetch.** `money_fetch` requires HTTPS on the public internet,
re-resolves DNS and pins the socket to the checked address, refuses to
auto-follow redirects (receipts and one-time payment headers are never
forwarded across them), blocks private networks by default, and caps
response bodies.

Every transaction — ledger payment, x402 purchase, card reserve and
settlement — leaves a hash-chained receipt on one feed: portable,
tamper-evident spend evidence.

## Quickstart

1. Get a wallet: your network operator gives you three values — or run the
   network yourself from the repo; its onboarding writes the key file and
   prints the exact config.
2. Add the server config above to `.mcp.json` (or your client's MCP
   settings).
3. Ask your agent to check its balance.

Env vars: `MONEY_API` (network origin; HTTPS required off loopback),
`MONEY_AGENT_ID` (account id), `MONEY_AGENT_KEY_FILE` (path to the agent's
Ed25519 key file — preferred) or `MONEY_AGENT_KEY` (inline fallback),
optional `MONEY_FETCH_PRIVATE_ORIGINS`.

Apache-2.0 · Node >= 20 · stdio transport.
