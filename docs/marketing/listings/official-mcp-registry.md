# Official MCP Registry — listing

Surface: https://registry.modelcontextprotocol.io (preview; PulseMCP and
other aggregators ingest from it daily — **publish here first**).
Docs: https://modelcontextprotocol.io/registry/quickstart

## Status (2026-09-11)

- **Automated.** The `registry` job in
  `.github/workflows/publish-packages.yml` publishes the listing on every
  `wallet-mcp-v*` tag, strictly after the npm publish, authenticated by
  GitHub OIDC. No founder step, no registry credential, no CLI on any
  machine. How it works and how to troubleshoot it: the "MCP registry
  listing" section of `docs/RELEASING-PACKAGES.md`.
- **Not yet live.** The listing first exists when `wallet-mcp-v0.14.1`
  ships. Live npm is 0.14.0 (`npm view @agentmoney/wallet-mcp version`,
  2026-09-11) and that tarball has no `mcpName`, which the registry
  requires; the repo is at 0.14.1 with `mcpName` and
  `packages/wallet-mcp/server.json` in place.

## Identity — case matters

`packages/wallet-mcp/package.json` carries

```json
"mcpName": "io.github.MaxwellCalkin/wallet-mcp"
```

and `packages/wallet-mcp/server.json` `name` is the same string. With
GitHub authentication the registry grants `io.github.<github-login>/*`
from the OIDC token's repository-owner claim verbatim and matches it as a
case-sensitive prefix. The login is `MaxwellCalkin`
(`gh api users/MaxwellCalkin`), so the lowercase `io.github.maxwellcalkin/`
this document used to show would be refused. `test/packages-build.test.ts`
pins the prefix, `name == mcpName`, and the version lockstep.

## Mechanics (for the record — the job does all of this)

1. The registry verifies package ownership by reading `mcpName` from the
   **published** npm tarball's `package.json`, so the npm publish must land
   first. The job declares `needs: [gate, publish]` and therefore runs
   after the workflow's `npm view` poll has seen the new version.
2. `mcp-publisher` v1.8.1 (linux/amd64) is downloaded from the versioned
   release URL — never `/releases/latest/` — and sha256-verified against
   `registry_1.8.1_checksums.txt` before it runs; then
   `login github-oidc` and `publish` in `packages/wallet-mcp/`.
3. A re-run against an already-listed version ("cannot publish duplicate
   version … already exists") is treated as success, and the job is
   `continue-on-error` so a registry outage never fails the npm publish.

Verify (the only manual step, after the tag's run is green):

```sh
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.MaxwellCalkin/wallet-mcp"
```

## server.json

Canonical file: `packages/wallet-mcp/server.json`. It is not in the npm
tarball (`files` stays `dist`, `README.md`) — only `mcpName` in
`package.json` has to ship. Schema:
`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`
— required top-level fields are `name`, `description`, `version`; each
package needs `registryType`, `identifier`, `transport`; `websiteUrl` and
`repository` are optional; `description` is capped at 100 characters. Ours
is 97 characters and names all three rails; the card rail is
sandbox/test-mode today — the README the registry links to carries the
"sandbox, no real funds" label.

The file is the source of truth (a second copy here would only drift); the
lockstep test keeps its version fields equal to the release. Its shape:

| Field | Value |
|---|---|
| `name` | `io.github.MaxwellCalkin/wallet-mcp` (= `mcpName`) |
| `description` | the 97-char short description from `descriptions.md` |
| `version`, `packages[0].version` | the release version (0.14.1 now) |
| `packages[0].registryType` / `registryBaseUrl` / `identifier` | `npm` / `https://registry.npmjs.org` / `@agentmoney/wallet-mcp` |
| `packages[0].transport.type` | `stdio` |
| `packages[0].environmentVariables` | `MONEY_API`, `MONEY_AGENT_ID`, `MONEY_AGENT_KEY_FILE`, `MONEY_AGENT_KEY` (secret), `MONEY_FETCH_PRIVATE_ORIGINS` — the same env contract as the package README and `descriptions.md` |
| `websiteUrl`, `repository.url` | the GitHub repo until the landing page is live (TODO-founder: swap `websiteUrl` to the landing page URL when live) |

Notes:
- `version` bumps in lockstep with the npm version on every publish (see
  "Cutting a release" in `docs/RELEASING-PACKAGES.md`) — it must always
  equal the npm version whose tarball carries `mcpName`.
- The registry hosts metadata only; npm remains the artifact source, so the
  cold-install path stays `npx -y @agentmoney/wallet-mcp`.
