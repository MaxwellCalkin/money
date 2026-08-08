# Smithery — submission package

Surface: https://smithery.ai — CLI-first MCP registry with per-server pages,
install analytics, and a config UI rendered from a schema.
Docs: https://smithery.ai/docs/build/publish · yaml reference:
https://smithery.ai/docs/build/project-config/smithery.yaml

## Submission mechanics

Smithery today has three intake paths; ours is (c):

- (a) **Hosted HTTPS URL** (smithery.ai/new → enter your server's public
  URL; Smithery proxies and scans it). **Do not use** — this wallet is a
  local stdio process that reads an on-disk Ed25519 key file and can be
  opted into private-network fetches. Hosting it behind Smithery's proxy
  would mean shipping agent keys to a third party. Fail-closed is the brand.
- (b) **MCPB bundle upload** for local servers (package as `.mcpb`, upload
  with config schema + metadata). Viable later; extra build artifact now.
- (c) **GitHub repo listing with `smithery.yaml`** (the classic stdio path):
  sign in to https://smithery.ai with GitHub, add the server from the repo
  at https://smithery.ai/new, and claim it as the repo owner. For the
  monorepo, set the base directory to `packages/wallet-mcp` when prompted
  (Smithery supports subfolder configs). Founder does the sign-in/claim;
  the yaml below is committed to the repo first.
- CLI alternative once claimed: `npm i -g @smithery/cli` then
  `smithery mcp publish -n @MaxwellCalkin/wallet-mcp` (namespace = GitHub
  handle).

The listing page pulls: display name, the one-sentence description, tool
list (from a scan or the server card), the config form (from
`configSchema`), and the README. An `icon.svg`/`icon.png` in the base
directory is used as the logo (TODO-founder: drop in the agentmoney mark
when one exists; listing works without it).

## `smithery.yaml` (commit at `packages/wallet-mcp/smithery.yaml`)

```yaml
startCommand:
  type: stdio
  configSchema:
    type: object
    required:
      - moneyApi
      - agentId
    properties:
      moneyApi:
        type: string
        title: Money network API origin
        description: >-
          The money network to spend on. HTTPS required except on loopback.
          Use http://127.0.0.1:4021 for a self-hosted network.
        default: http://127.0.0.1:4021
      agentId:
        type: string
        title: Agent account id
        description: This agent's account id on the network (agt_...).
      agentKeyFile:
        type: string
        title: Agent key file (preferred)
        description: >-
          Absolute path to a file whose first line is the agent's base64
          PKCS#8 Ed25519 private key. Keeps the key out of client config.
      agentKey:
        type: string
        title: Agent key (inline fallback)
        description: >-
          The agent's base64 PKCS#8 Ed25519 private key inline. Treat like
          a password; prefer agentKeyFile. Set exactly one of the two.
  commandFunction: |-
    (config) => ({
      command: 'npx',
      args: ['-y', '@agentmoney/wallet-mcp'],
      env: {
        MONEY_API: config.moneyApi,
        MONEY_AGENT_ID: config.agentId,
        ...(config.agentKeyFile ? { MONEY_AGENT_KEY_FILE: config.agentKeyFile } : {}),
        ...(config.agentKey ? { MONEY_AGENT_KEY: config.agentKey } : {})
      }
    })
  exampleConfig:
    moneyApi: http://127.0.0.1:4021
    agentId: agt_1a2b3c4d
    agentKeyFile: /home/me/.money/agent.key
```

## Listing fields

| Field | Value |
|---|---|
| Server name / namespace | `@MaxwellCalkin/wallet-mcp` (claimed via GitHub) |
| Display name | Agent Money Wallet |
| One-sentence description | A spend account for AI agents: balance, pay, and 402 auto-pay under an owner-signed mandate. |
| Transport | stdio (local) |
| Tool count | 4 (`money_balance`, `money_pay`, `money_fetch`, `money_feed`) |
| GitHub repository | https://github.com/MaxwellCalkin/money |
| Homepage | https://github.com/MaxwellCalkin/money (TODO-founder: landing page when live) |
| Icon | TODO-founder (optional `icon.svg` in `packages/wallet-mcp/`) |
| Tags | payments, wallet, x402, finance, ai-agents |

If Smithery's page supports a longer body, paste the **Long description**
from `descriptions.md` verbatim; otherwise the README (already in the
package) carries it.

## Post-submit checklist

- Verify the rendered config form asks for exactly: moneyApi, agentId,
  agentKeyFile/agentKey — nothing else.
- Verify the page does not label the server "hosted"; it must read as a
  local/stdio install.
- Verify the install snippet resolves to `npx -y @agentmoney/wallet-mcp`.
