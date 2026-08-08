# Official MCP Registry — submission package

Surface: https://registry.modelcontextprotocol.io (preview; PulseMCP and
other aggregators ingest from it daily — **publish here first**).
Docs: https://modelcontextprotocol.io/registry/quickstart

## Submission mechanics (CLI, not a form or PR)

1. **Prerequisite — patch release required.** The registry verifies package
   ownership by reading an `mcpName` field from the published npm tarball's
   `package.json`. The live `@agentmoney/wallet-mcp@0.13.0` does not have it,
   so add to `packages/wallet-mcp/package.json`:

   ```json
   "mcpName": "io.github.maxwellcalkin/wallet-mcp"
   ```

   and publish a patch (`0.13.1`) to npm before publishing to the registry.
   With GitHub authentication the name **must** start with
   `io.github.<github-username>/` — for the MaxwellCalkin account that is
   `io.github.maxwellcalkin/`. (`server.json` `name` must match `mcpName`
   exactly.)

2. Install the publisher CLI (founder machine, Windows PowerShell):

   ```powershell
   $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
   Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"
   tar xf mcp-publisher.tar.gz mcp-publisher.exe
   ```

3. Put the `server.json` below in `packages/wallet-mcp/`.

4. Authenticate (founder — GitHub device-code flow):
   `mcp-publisher login github`

5. Publish: `mcp-publisher publish`

6. Verify:
   `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.maxwellcalkin/wallet-mcp"`

Later: automate on release via the GitHub Action
(https://github.com/marketplace/actions/publish-mcp-server) alongside npm
provenance publishing.

## server.json (submission-ready)

Description is 92 chars — registry guides state a 100-character maximum, and
the schema validates on publish.

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.maxwellcalkin/wallet-mcp",
  "description": "A spend account for AI agents: balance, pay, and 402 auto-pay under an owner-signed mandate.",
  "websiteUrl": "https://github.com/MaxwellCalkin/money",
  "repository": {
    "url": "https://github.com/MaxwellCalkin/money",
    "source": "github",
    "subfolder": "packages/wallet-mcp"
  },
  "version": "0.13.1",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "@agentmoney/wallet-mcp",
      "version": "0.13.1",
      "transport": {
        "type": "stdio"
      },
      "environmentVariables": [
        {
          "name": "MONEY_API",
          "description": "Money network API origin. HTTPS required except on loopback. Default http://127.0.0.1:4021.",
          "isRequired": true,
          "isSecret": false,
          "format": "string",
          "default": "http://127.0.0.1:4021"
        },
        {
          "name": "MONEY_AGENT_ID",
          "description": "This agent's account id on the network (agt_...).",
          "isRequired": true,
          "isSecret": false,
          "format": "string"
        },
        {
          "name": "MONEY_AGENT_KEY_FILE",
          "description": "Path to a file whose first line is the agent's base64 PKCS#8 Ed25519 private key. Preferred over MONEY_AGENT_KEY; set exactly one of the two.",
          "isRequired": false,
          "isSecret": false,
          "format": "filepath"
        },
        {
          "name": "MONEY_AGENT_KEY",
          "description": "The agent's base64 PKCS#8 Ed25519 private key inline. Fallback when a key file is impractical; treat like a password.",
          "isRequired": false,
          "isSecret": true,
          "format": "string"
        },
        {
          "name": "MONEY_FETCH_PRIVATE_ORIGINS",
          "description": "Optional JSON array of exact origins (e.g. [\"http://127.0.0.1:8080\"]) money_fetch may reach on private networks. Nothing private is reachable by default.",
          "isRequired": false,
          "isSecret": false,
          "format": "string"
        }
      ]
    }
  ]
}
```

Notes:
- `version` bumps in lockstep with the npm version on every future publish.
- Keep `websiteUrl` at the GitHub repo until the landing page exists, then
  update (TODO-founder: swap in the landing page URL when live).
- The registry hosts metadata only; npm remains the artifact source, so the
  cold-install path stays `npx -y @agentmoney/wallet-mcp`.
