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
| Description (card/SEO, ~155 chars) | MCP wallet for AI agents: check balance, pay accounts, auto-pay HTTP 402 URLs (incl. x402) under an owner-signed mandate the network enforces. |
| GitHub URL | https://github.com/MaxwellCalkin/money |
| Website | https://github.com/MaxwellCalkin/money/tree/main/packages/wallet-mcp |
| Categories / Tags | payments, wallet, x402, finance, ai-agents, commerce |
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
[money](https://github.com/MaxwellCalkin/money) network.

## Tools

| Tool | What it does |
|---|---|
| `money_balance` | Spendable balance and mandate state |
| `money_pay` | Pay any account (agent, provider, user) by id or `@handle`, idempotency-keyed |
| `money_fetch` | GET a URL; on HTTP 402 (network challenge or external x402 seller) pay it within the mandate and retry — exactly-once, crash-recoverable |
| `money_feed` | Recent receipts from the hash-chained evidence feed |

## Why this wallet

**The mandate is the security boundary, not the model's judgment.** The
owner signs a mandate — budget, per-payment cap, daily cap, an
ask-me-above escalation line, a new-payee throttle — and the network
enforces it deterministically on every payment. The agent process holds
only its own signing key: never the owner key, never a spending decision.
Prompt-injected text can ask for money; nothing in the agent's context can
sign or widen a mandate. Over-the-line payments are refused and land in
the owner's approval inbox as a durable request the agent can resume after
the owner decides.

**Exactly-once by construction.** Retries reuse idempotency keys,
paid-but-undelivered fetches resume with the existing receipt instead of
paying again, and in-flight external payments are recovered from the
network's durable record after a crash. External x402 payments are
policy-checked, capped, and auto-reversed if the seller never delivers.

**Hardened fetch.** `money_fetch` requires HTTPS on the public internet,
re-resolves DNS and pins the socket to the checked address, refuses to
auto-follow redirects (receipts and one-time payment headers are never
forwarded across them), blocks private networks by default, and caps
response bodies.

Every transaction leaves a hash-chained receipt — portable, tamper-evident
spend evidence.

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
