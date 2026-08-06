# @agentmoney/wallet-mcp

An [MCP](https://modelcontextprotocol.io) wallet that gives any agent runtime
(Claude Code, Cursor, Codex) a spending account on a
[money](https://github.com/MaxwellCalkin/money) network. The agent gets four
tools; the owner's mandate — budget, per-payment cap, daily cap, ask-me-above
line, new-payee throttle — is enforced by the network, never by the model.

| Tool | What it does |
|---|---|
| `money_balance` | Spendable balance and mandate state |
| `money_pay` | Pay any account (agent, provider, user) by id or `@handle`, idempotency-keyed |
| `money_fetch` | GET a URL; on HTTP 402 (network challenge or external x402 seller) pay it within the mandate and retry — exactly-once, crash-recoverable |
| `money_feed` | Recent receipts |

## Quickstart (10 minutes)

1. **Get a wallet.** Your network operator gives you three values — or run the
   network yourself and use its onboarding, which writes the key file for you
   and prints this exact config.

2. **Add to `.mcp.json`:**

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

3. Ask your agent to check its balance.

## Configuration

| Env var | Meaning |
|---|---|
| `MONEY_API` | Network API origin. HTTPS required except on loopback. Default `http://127.0.0.1:4021`. |
| `MONEY_AGENT_ID` | This agent's account id (required). |
| `MONEY_AGENT_KEY_FILE` | Path to a file whose first line is the agent's base64 PKCS#8 Ed25519 private key (preferred — keeps the key out of `.mcp.json`). |
| `MONEY_AGENT_KEY` | The key inline (fallback; treat like a password). |
| `MONEY_FETCH_PRIVATE_ORIGINS` | Optional JSON array of exact origins (e.g. `["http://127.0.0.1:8080"]`) an agent may fetch on private networks. Nothing private is reachable by default. |

## Safety properties

- The agent process holds only its own signing key — never the owner key, and
  never a spending decision. Every payment is policy-checked server-side.
- `money_fetch` requires HTTPS on the public internet, re-resolves DNS and pins
  the socket to the checked address, refuses redirects (they are returned as
  validated URLs, and receipts or one-time payment headers are never forwarded
  across them), and caps response bodies.
- Payments are exactly-once: retries reuse idempotency keys, paid-but-undelivered
  fetches resume with the existing receipt, and in-flight external payments are
  recovered from the network's durable record after a crash.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
