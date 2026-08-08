# Cursor directory — submission package

Two related surfaces:

- **cursor.directory** — the community directory Cursor itself now points
  to (Cursor's own `github.com/cursor/mcp-servers` list was archived
  2026-03-19 with "Use cursor.directory instead").
- **"Add to Cursor" deeplink button** — goes in our README/landing page and
  in any directory entry that accepts HTML/markdown; this is what actually
  installs the server in Cursor.

## Submission mechanics

1. **cursor.directory:** submit at https://cursor.directory/plugins/new
   (sign-in required; the form is web-based — no PR flow anymore). Have
   ready: name, description, GitHub repo URL, install config, logo. The
   exact field set changes; everything it can ask for is below.
2. **Cursor Marketplace** (https://cursor.com/marketplace) is for official
   OAuth-integrated plugins — not our path today; skip.
3. **Deeplink button:** no submission needed; add the markdown below to
   `packages/wallet-mcp/README.md` and the landing page. (README change =
   repo edit + npm patch to update the npm page; can ride along with the
   `mcpName` patch release from `official-mcp-registry.md`.)

## Listing fields (cursor.directory)

| Field | Value |
|---|---|
| Name | Agent Money Wallet |
| Package | `@agentmoney/wallet-mcp` (npm) |
| Short description | A spend account for AI agents: balance, pay, and 402 auto-pay under an owner-signed mandate. |
| Longer description | Use the **Medium description** from `descriptions.md`; if a full body is allowed, the **Long description**. |
| Repo URL | https://github.com/MaxwellCalkin/money |
| Categories/Tags | payments, finance, wallet, x402, ai-agents |
| Logo | TODO-founder (optional) |

## Cursor install config — `.cursor/mcp.json`

Project-scoped `.cursor/mcp.json` (or global `~/.cursor/mcp.json`) — same
env contract as everywhere:

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

## "Add to Cursor" deeplink

Format: `cursor://anysphere.cursor-deeplink/mcp/install?name=<name>&config=<base64 of the server's config object>`

Our config object (what gets base64-encoded — the single server object,
not the whole `mcpServers` wrapper):

```json
{"command":"npx","args":["-y","@agentmoney/wallet-mcp"],"env":{"MONEY_API":"https://your-money-network.example","MONEY_AGENT_ID":"agt_xxxxxxxx","MONEY_AGENT_KEY_FILE":"/absolute/path/to/agent.key"}}
```

Ready-made deeplink (config pre-encoded from the JSON above; Cursor opens
an install dialog where the user edits the placeholder env values):

```
cursor://anysphere.cursor-deeplink/mcp/install?name=money&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBhZ2VudG1vbmV5L3dhbGxldC1tY3AiXSwiZW52Ijp7Ik1PTkVZX0FQSSI6Imh0dHBzOi8veW91ci1tb25leS1uZXR3b3JrLmV4YW1wbGUiLCJNT05FWV9BR0VOVF9JRCI6ImFndF94eHh4eHh4eCIsIk1PTkVZX0FHRU5UX0tFWV9GSUxFIjoiL2Fic29sdXRlL3BhdGgvdG8vYWdlbnQua2V5In19
```

README/landing-page button markdown (Cursor's official button assets):

```markdown
[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=money&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBhZ2VudG1vbmV5L3dhbGxldC1tY3AiXSwiZW52Ijp7Ik1PTkVZX0FQSSI6Imh0dHBzOi8veW91ci1tb25leS1uZXR3b3JrLmV4YW1wbGUiLCJNT05FWV9BR0VOVF9JRCI6ImFndF94eHh4eHh4eCIsIk1PTkVZX0FHRU5UX0tFWV9GSUxFIjoiL2Fic29sdXRlL3BhdGgvdG8vYWdlbnQua2V5In19)
```

(Light-theme asset: `https://cursor.com/deeplink/mcp-install-light.svg`.
Note: GitHub READMEs strip custom URI schemes in some renderers — if the
button is dead on github.com, keep it on the landing page and give README
readers the `.cursor/mcp.json` block instead. Verify once before shipping.)

## Verification checklist (founder, after submitting)

- Clicking the deeplink in Cursor opens the install dialog with name
  `money`, command `npx -y @agentmoney/wallet-mcp`, and the three env
  placeholders — nothing else.
- After the user swaps in real values, "money" appears under Settings →
  Tools & MCP with 4 tools, and "check my balance" round-trips.
- The directory entry never claims a hosted service; install is local
  stdio against the user's own or an operator's network.
