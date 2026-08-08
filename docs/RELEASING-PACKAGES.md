# Releasing @agentmoney/wallet-mcp and @agentmoney/seller-sdk

> **Activation required:** the workflow ships as
> `docs/publish-packages.workflow.yml` because automated pushes from agent
> sessions lack the GitHub `workflow` scope. Move it into place from your own
> terminal — `git mv docs/publish-packages.workflow.yml
> .github/workflows/publish-packages.yml` — then commit and push. The
> filename is load-bearing for the npm trusted-publisher binding below.

How the two published packages get from `src/` to npm with provenance, using
OIDC trusted publishing. There is **no long-lived npm token** in this
repository, in GitHub secrets, or on any machine — publishing authority is
the workflow file itself plus the trusted-publisher binding on npmjs.com.

Suggested repo location for this file: `docs/RELEASING-PACKAGES.md`.
The workflow goes to `.github/workflows/publish-packages.yml` — the filename
is load-bearing (it must match the npm configuration exactly).

## Trust model in one paragraph

GitHub Actions mints a short-lived OIDC token that proves "this run is
workflow `publish-packages.yml` in `MaxwellCalkin/money`, environment
`npm-publish`". npm (CLI >= 11.5.1) exchanges that token for a short-lived
publish credential — valid only for that run — and automatically generates a
**provenance attestation** (a signed, public statement of the exact commit,
workflow, and run that built the tarball, logged in the Sigstore
transparency log). Consumers verify with `npm audit signatures`; the npm
package page shows a "Provenance" section. This is the receipts story
applied to our own supply chain: the packages that guard agent money are
themselves wash-proof.

## One-time setup on npmjs.com (Max, ~10 minutes)

Prerequisite: both packages already exist on the registry (published
2026-08-06), which npm requires before a trusted publisher can be
configured — unlike PyPI, npm has no "pending publisher" for first
publishes. We're past that.

Do this **twice**, once per package:

1. Log in to npmjs.com as the owner of the `@agentmoney` scope.
2. Open the package's settings page:
   - `https://www.npmjs.com/package/@agentmoney/wallet-mcp/access`
   - `https://www.npmjs.com/package/@agentmoney/seller-sdk/access`
   (This is the page the docs call *Package Settings*; the section is
   labeled **Trusted publisher** / "Trusted publishing".)
3. In the Trusted publisher section, select **GitHub Actions** and fill in
   (every field is **case-sensitive** and must match exactly):

   | Field | Value |
   |---|---|
   | Organization or user | `MaxwellCalkin` |
   | Repository | `money` |
   | Workflow filename | `publish-packages.yml` (filename only — no `.github/workflows/` path, extension included) |
   | Environment name | `npm-publish` (must match the `environment:` in the workflow's publish job) |
   | Allowed actions (if shown) | `npm publish` |

4. Save. npm does **not** validate the configuration on save — typos only
   surface as auth failures on the first run, so copy-paste the values.
5. Repeat for the second package. Each package supports exactly **one**
   trusted publisher configuration at a time; saving a new one replaces
   the old.

### Hardening (do after the first successful OIDC publish)

6. On each package's **Publishing access** settings, select **"Require
   two-factor authentication and disallow tokens"**. Trusted publishers
   keep working (the setting only affects classic/granular token auth), and
   a stolen token can no longer publish these packages at all.
7. In GitHub: repo **Settings → Environments → npm-publish** (GitHub
   creates the environment automatically on the first run that references
   it) → add **Required reviewers: MaxwellCalkin**. Every real publish then
   pauses for a one-click human approval; dry-runs are unaffected (they run
   in a separate job with no environment).

### Requirements the workflow already enforces or assumes

- **npm >= 11.5.1** on the runner (trusted-publishing support). Node
  24.18.0 bundles a new-enough npm; the workflow asserts the version and
  fails closed if a future node-version bump regresses it.
- **GitHub-hosted runner** (`ubuntu-24.04`). Self-hosted runners are not
  supported for trusted publishing or provenance.
- **Public repository.** Provenance is only generated for public repos;
  a private repo makes `--provenance` fail even for a public package.
- `id-token: write` permission on the publish job (already set).
- Each `package.json` has a `repository.url` matching
  `git+https://github.com/MaxwellCalkin/money.git` with the correct
  `directory` (already true; case-sensitive match required for provenance).
- Deliberately **no** `registry-url:` on setup-node and **no**
  `NODE_AUTH_TOKEN` anywhere: that input writes an `.npmrc` expecting a
  token env var, which breaks token-less OIDC publishing.

## Cutting a release

Versions are in lockstep by construction — `test/packages-build.test.ts`
fails the gate if any of these disagree:

1. Bump the version in **four** places to the same `X.Y.Z`:
   - `package.json` (root)
   - `packages/wallet-mcp/package.json`
   - `packages/seller-sdk/package.json`
   - `src/mcp/server.ts` — the advertised `version: "X.Y.Z"` string
2. Verify locally:
   ```sh
   npm run build:packages
   npm test -- test/packages-build.test.ts
   ```
3. Land the bump on `main` through the normal PR flow (`verify` CI must be
   green — the publish workflow refuses tags whose commit is not in
   `main`'s history).
4. Tag the release commit on main — one tag per package you're releasing:
   ```sh
   git tag wallet-mcp-vX.Y.Z <commit-sha>
   git tag seller-sdk-vX.Y.Z <commit-sha>
   git push origin wallet-mcp-vX.Y.Z seller-sdk-vX.Y.Z
   ```
   Each tag triggers its own workflow run and publishes exactly that one
   package. Tag both to release both. (Versions must not contain the
   substring `-v` — the tag parser splits on the last `-v`.)
5. If the `npm-publish` environment has required reviewers, approve the
   pending deployment in the Actions UI.

What each run does: full-history checkout → refuse tags off `main` → parse
the tag and check it against the package manifest version → `npm ci` →
`npm run build:packages` → the `packages-build` test gate → (approval) →
`npm publish --provenance --access public` from the package directory
(`prepack` rebuilds `dist/` from `src/` during publish, so a stale artifact
can never ship) → poll `npm view` until the registry serves the version.

## Dry-run mode (no tag, publishes nothing)

Actions → **publish-packages** → **Run workflow** → pick `both`,
`wallet-mcp`, or `seller-sdk`. Manual dispatch is *always* a dry run — it
runs the identical gate, then `npm publish --dry-run` plus `npm pack`, and
uploads the tarball(s) as run artifacts. Use it to eyeball the exact file
list and unpacked size before tagging. There is no input that turns a
manual run into a real publish; real publishes come only from tags.

## Verifying a release

- Package page on npmjs.com shows the new version **and a "Provenance"
  section** linking the exact commit and workflow run.
- `npm view @agentmoney/wallet-mcp@X.Y.Z` (the workflow already polls this).
- In any scratch project:
  ```sh
  npm i @agentmoney/wallet-mcp@X.Y.Z @agentmoney/seller-sdk@X.Y.Z hono
  npm audit signatures   # expect "verified attestations" to cover both
  ```

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `E404` or `ENEEDAUTH` on publish | Trusted-publisher config mismatch. Re-check all fields on the package's `/access` page against reality — user `MaxwellCalkin`, repo `money`, filename `publish-packages.yml`, environment `npm-publish` — all case-sensitive. npm never validated them on save. |
| OIDC exchange fails only for one package | That package's trusted publisher was never configured, or was replaced (only one config per package). Redo the setup table above for it. |
| "npm X is older than 11.5.1" step fails | A node-version change pulled an older bundled npm. Bump `node-version` in the workflow, or add `npm install -g npm@latest` before the assert. |
| Provenance error mentioning private repo / unsupported CI | Repo must be public and the runner GitHub-hosted; `--provenance` fails closed otherwise. |
| "tag ... is not an ancestor of origin/main" | You tagged a branch commit. Land it on `main` first, then re-tag. |
| "tag says X but packages/... says Y" | Version lockstep step 1 was incomplete. Fix the manifests on `main`, delete the bad tag (`git push origin :refs/tags/<tag>`), re-tag. |
| Publish succeeded but you need to redo it | npm never allows republishing the same version. Fix forward: bump the patch version and release again. To warn consumers off a bad version: `npm deprecate @agentmoney/<pkg>@X.Y.Z "reason"`. Unpublish is a last resort with strict registry time limits. |
| Workflow run for a tag doesn't start | Tag must match `wallet-mcp-v*` or `seller-sdk-v*` and the workflow file must exist at the tagged commit. |

### Break-glass (registry incident, Actions outage)

Local publish with a 2FA-protected session still works *until* the
"disallow tokens" hardening step is enabled — but a local publish has **no
provenance** and weakens the story. Prefer waiting out the outage. If it is
ever truly necessary, temporarily relax Publishing access for that package,
publish locally with OTP, then immediately re-enable "disallow tokens".

## References

- npm trusted publishers: https://docs.npmjs.com/trusted-publishers
- npm provenance statements: https://docs.npmjs.com/generating-provenance-statements
- GA announcement (2025-07-31): https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/
- Practical gotchas: https://philna.sh/blog/2026/01/28/trusted-publishing-npm/
