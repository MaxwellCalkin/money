# @agentmoney/wallet-mcp

An [MCP](https://modelcontextprotocol.io) wallet that gives any agent runtime
(Claude Code, Cursor, Codex) a spending account on a
[money](https://github.com/MaxwellCalkin/money) network. The agent gets seven
tools; the owner's mandate — budget, per-payment cap, daily cap, ask-me-above
line, new-payee throttle — is enforced by the network, never by the model.

| Tool | What it does |
|---|---|
| `money_balance` | How much this agent can still spend under its owner's mandate |
| `money_pay` | Pay any account (agent, provider, user) by id or `@handle`, idempotency-keyed |
| `money_fetch` | GET a URL; on HTTP 402 (network challenge or external x402 seller) pay it within the mandate and retry — exactly-once, crash-recoverable |
| `money_card_create` | Request a reserved virtual card for an ordinary online merchant, under the same mandate; issuing reserves the full cap up front. Returns only the last4 — never the card number |
| `money_card_status` | One card's state, cap, cleared amount, and authorizations |
| `money_card_close` | Close a card; the unspent remainder returns to the agent's funds (mandate authority already used is not restored) |
| `money_feed` | Recent receipts |

The card tools require a network API with the card rail (the Postgres-backed
server, v0.14+); against an older API they return a clear "this API does not
implement /cards" message instead of failing silently. Networks without a
configured card issuer answer `503`, and the hosted sandbox runs the mock
issuer — sandbox, no real funds;
nothing here is a bank, card, or deposit account.

## The card number never enters the conversation

There is no reveal tool. `money_card_create` returns `last4`, expiry, cap, and
merchant — enough to recognize the card, nothing that can leak it. When the
network runs in `token` reveal mode, a fresh activation also returns a
single-use `checkoutToken` (10-minute TTL, at most 3 per card, bound to this
agent and this card). The **fill contract**: the model hands that token to the
host runtime, and host code — never the model — redeems it once via
`POST /cards/:id/reveal {checkoutToken}` on the signed network API and fills
the merchant's payment form outside model context. In the default `none` mode
no reveal surface exists at all and no token is returned.

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

3. Ask your agent to check what its mandate allows.

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
- Reserved cards are policy-decided at every network authorization: merchant
  category, merchant allowlist, merchant lock, single-use, first-merchant
  throttle, and cap are evaluated in the network's database, outside any model
  context. Caps above the owner's ask-me line become a durable owner approval,
  not a purchase.
- `money_fetch` requires HTTPS on the public internet, re-resolves DNS and pins
  the socket to the checked address, refuses redirects (they are returned as
  validated URLs, and receipts or one-time payment headers are never forwarded
  across them), and caps response bodies.
- Payments are exactly-once: retries reuse idempotency keys, paid-but-undelivered
  fetches resume with the existing receipt, in-flight external payments are
  recovered from the network's durable record after a crash, and a retried
  `money_card_create` with the same idempotency key returns the original card
  instead of reserving twice.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
