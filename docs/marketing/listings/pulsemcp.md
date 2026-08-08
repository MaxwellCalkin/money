# PulseMCP — submission package

Surface: https://www.pulsemcp.com/servers — daily-updated directory
(22k+ servers), editorially curated, widely scraped by other aggregators.

## Submission mechanics (two channels; use both, in this order)

1. **Official MCP Registry ingestion (primary, automatic).** PulseMCP
   ingests registry entries daily and processes them weekly. Publishing
   `io.github.maxwellcalkin/wallet-mcp` to
   https://registry.modelcontextprotocol.io (see
   `official-mcp-registry.md`) gets the PulseMCP listing for free within
   about a week. Do that first.
2. **Direct submission form (backup / accelerator):**
   https://www.pulsemcp.com/submit — the form asks for a **URL** ("can be a
   GitHub repository, a subfolder of a repository, or a standalone
   website"). Submit the subfolder URL:
   `https://github.com/MaxwellCalkin/money/tree/main/packages/wallet-mcp`
3. **Adjustments:** if the listing hasn't appeared a week after registry
   publish, or to fix copy/categorization later, email
   **hello@pulsemcp.com**.

PulseMCP writes/curates its own listing copy from the README and registry
metadata, so the package README is the real submission artifact — it
already contains the quickstart, env table, and safety properties. The
copy below is what we supply if they ask, or in the adjustment email.

## Listing fields (for the form / adjustment email)

| Field | Value |
|---|---|
| Type | MCP Server |
| Name | Agent Money Wallet (`@agentmoney/wallet-mcp`) |
| URL | https://github.com/MaxwellCalkin/money/tree/main/packages/wallet-mcp |
| npm | https://www.npmjs.com/package/@agentmoney/wallet-mcp |
| Classification | Community (we are not a big-brand "official provider") |
| Local/Remote | Local (stdio) |
| License | Apache-2.0 |
| Category suggestions | Finance / Payments / Agent commerce |

Short description (their card format, 1–2 sentences):

> A spend account for AI agents: balance, pay, and 402 auto-pay under an
> owner-signed mandate the network enforces — never the model. Every
> payment leaves a hash-chained receipt.

Longer body (if offered space): paste the **Long description** from
`descriptions.md` verbatim, followed by the exact `.mcp.json` block:

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

## Draft adjustment email (founder sends from his own address)

Subject: Listing details for @agentmoney/wallet-mcp

> Hi — I publish `@agentmoney/wallet-mcp` (also
> `io.github.maxwellcalkin/wallet-mcp` in the official registry). A few
> details for the listing:
>
> - It's a local stdio MCP wallet: four tools (money_balance, money_pay,
>   money_fetch with HTTP 402 auto-pay incl. external x402 sellers,
>   money_feed).
> - The differentiator worth a sentence: the owner's spending mandate
>   (budget, per-payment cap, daily cap, ask-me-above line, new-payee
>   throttle) is enforced by the network, not by the model — over-cap
>   payments are refused and routed to an owner approval inbox, and every
>   payment leaves a hash-chained receipt.
> - Repo: https://github.com/MaxwellCalkin/money (subfolder
>   packages/wallet-mcp), Apache-2.0.
>
> Happy to provide anything else. Thanks!
