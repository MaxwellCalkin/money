# Release evidence record

Copy this template for each candidate. Do not mark a gate complete from memory,
intent, a narrower test, or the presence of configuration text. Link or hash the
authoritative evidence produced for the exact candidate.

This record proves a software milestone only. It does not authorize customer
funds; the final section separately records non-code launch authority.

## Candidate identity

| Field | Evidence |
|---|---|
| Version | `<package version>` |
| Candidate source commit | `<40-character commit>` |
| Candidate branch/tag | `<immutable ref>` |
| Repository | `MaxwellCalkin/money` |
| Verification start/end (UTC) | `<timestamps>` |
| Verifier and independent reviewer | `<named people; state explicitly if no independent reviewer exists>` |
| Clean-checkout evidence | `<command/output or workflow>` |
| Node and npm versions | `<exact output>` |
| PostgreSQL version | `<exact output>` |
| CI workflow run | `<URL and run attempt>` |
| Local image ID | `<sha256:...>` |
| OCI source-revision label | `<must equal candidate commit>` |
| Published registry digest | `<registry/name@sha256:... or not published>` |
| Image-evidence artifact and digest | `<artifact URL/name and GitHub artifact digest>` |
| Evidence archive location/retention | `<controlled store and policy>` |

## Repository controls

Configuration files are not evidence that GitHub enforces them. Attach a live
ruleset/branch-protection export, API response, or reviewed settings capture.

| Gate | Result and evidence |
|---|---|
| Repository is private; owner and default branch are expected | `<live repository metadata>` |
| Candidate ref exists remotely at the recorded commit | `<live branch/tag metadata>` |
| `main` requires pull requests | `<live rule>` |
| Required checks are `product`, `postgres`, and `image` from GitHub Actions | `<live rule plus exact-head check runs>` |
| Review conversations must resolve | `<live rule>` |
| Force pushes and deletion are blocked | `<live rule>` |
| Bypass actors are absent or governed by named break-glass | `<live rule and incident process>` |
| CODEOWNERS is valid on the base branch | `<live file plus GitHub ownership signal>` |
| Independent approval is enforced | `<review evidence, or explicit external-beta blocker>` |
| No unresolved review or requested change remains | `<PR review/thread evidence>` |

## Source, dependency, and build gates

Record exit status, UTC time, exact command, and retained output for every row.

| Gate | Result and evidence |
|---|---|
| `npm ci --no-audit --no-fund` with unchanged lockfile | `<evidence>` |
| `npm run typecheck` | `<evidence>` |
| `npm test -- --reporter=dot` complete suite | `<test count, duration, output>` |
| `npm run build` with every production entry | `<evidence>` |
| `npm run verify:deployment` | `<must report 16 positive and 16 negative>` |
| `npm audit --audit-level=moderate` | `<evidence>` |
| All workflow actions resolve to reviewed full commits | `<six refs and source review>` |
| Base image digest resolves to the reviewed official image | `<registry evidence>` |
| Credential/secret scan | `<tool, scope, result>` |

## PostgreSQL and money-kernel gates

Use an isolated PostgreSQL 18 database restored from the production-shaped
backup process. In-memory and PGlite tests cannot substitute for these rows.

| Gate | Result and evidence |
|---|---|
| Fresh migrations apply through `0012` | `<database ID, output, migration rows/checksums>` |
| Rerun is a no-op and altered checksum is rejected | `<evidence>` |
| `db/roles.sql` applies from the administrative identity | `<evidence>` |
| Effective roles allow only the documented commands | `<positive and negative assertions>` |
| Obsolete split-phase compliance function is absent | `<catalog query>` |
| Ledger conservation and cached-balance reconciliation | `<reconciliation output>` |
| Concurrent debit, mandate, approval, refund, reversal, and replay tests | `<test output>` |
| Treasury and compliance atomicity/recovery tests | `<test output>` |
| Card rail: reserve accounting, decline ladder, 20-way authorization race, role matrix, and no-PAN regression | `<test output>` |
| `npm run test:postgres-live` on checksummed PostgreSQL 18 | `<server/database identity and four-test output>` |
| Backup restore and forward-repair drill | `<restore ID and result>` |

## Image and deployment gates

| Gate | Result and evidence |
|---|---|
| Image built with candidate commit as `SOURCE_COMMIT` | `<build output>` |
| Image revision label equals candidate commit | `<inspect output>` |
| Runtime contract proves UID 65532, all 16 commands, and no shell/npm/Yarn | `<runtime-contract.json>` |
| CycloneDX metadata image ID equals recorded image ID | `<bounded comparison output>` |
| HIGH/CRITICAL report targets that same image | `<report target and result>` |
| `SHA256SUMS` verifies after artifact download | `<verification output>` |
| No unexpired vulnerability exception is required | `<none, or exception table below>` |
| Compose renders without missing variables or fake rails | `<rendered-config hash>` |
| Every Compose command exists in the built image | `<evidence>` |
| Every service passes production preflight with only its credential file | `<service-by-service matrix>` |
| Every service rejects one representative leaked authority | `<negative matrix>` |
| Health/readiness and graceful shutdown work for long-running services | `<evidence>` |

### Service preflight matrix

| Service | Positive preflight | Leaked-authority negative | Runtime readiness |
|---|---|---|---|
| `api` | | | |
| `database-ops` | | | |
| `external-worker` | | | |
| `migrate` | | | N/A |
| `treasury-webhook` | | | |
| `treasury-events` | | | |
| `treasury-payouts` | | | |
| `treasury-reconciler` | | | |
| `compliance-webhook` | | | |
| `compliance-events` | | | |
| `compliance-onboarding` | | | |
| `compliance-reviews` | | | |
| `compliance-ops` | | | |
| `compliance-console` | | | |
| `card-authorization` | | | |
| `card-events` | | | |

## Persona sandbox contract

Record Persona environment, pinned API version, template/list IDs by hash or
approved configuration reference—not customer data or complete provider
payloads.

| Case | Result and evidence |
|---|---|
| Individual inquiry creation and one-time hosted link | |
| Approved inquiry plus current no-match watchlist activates subject | |
| Decline remains blocked after later weaker provider state | |
| Marked-for-review remains review after later weaker provider state | |
| Missing/pending required report retries without partial evidence | |
| Duplicate delivery is an exact no-op | |
| Reordered delivery cannot weaken the decision floor | |
| Current and previous webhook secret overlap | |
| Old timestamp and invalid signature rejection | |
| Unrelated Persona Account ID cannot clear screening | |
| Continuous watchlist match, dismissal, and error route to review/restriction | |
| Included account/resource mismatch is permanent failure | |
| Business associated-person discovery remains fail-closed | |
| Webhook/provider payload PII is absent from durable product data and logs | |

## External x402 testnet contract

| Case | Result and evidence |
|---|---|
| Remote signer authenticates and returns the configured key | |
| Missing/invalid signer credential fails closed | |
| Redirect, wrong-key signature, malformed and oversized response rejection | |
| RPC network/asset/method/domain pins reject changed terms | |
| Exact calldata, receipt, transfer log, parties, amount, and depth confirm | |
| Delayed confirmation races reversal exactly once | |
| Restart resumes the same durable authorization without signing/debiting twice | |
| RPC failure or disagreement remains pending/reviewable, never confirmed | |
| Base Sepolia end-to-end seller settlement | |

## Treasury, compliance, and incident drills

| Drill | Result and evidence |
|---|---|
| Funding, payout, and external-spend breakers begin closed | |
| Reconciliation opens only reviewed controls and detects stale/variant assets | |
| Duplicate/out-of-order Column event and authenticated refetch | |
| Ambiguous payout stays reserved and requires reviewed resolution | |
| Return creates exact exposure, family freeze, recovery, and reviewed release | |
| Persona evidence expiry creates case/restriction | |
| Compromised agent/owner/provider/operator credential revocation | |
| Webhook, API, database, signer, RPC, and encryption-key rotation | |
| Journal/asset/evidence reconciliation after simulated compromise | |
| Backup restore and regional/service recovery | |
| Two-person breaker restoration and retained incident record | |

## Exceptions

An empty table means no exceptions. Never write “accepted risk” without the
specific exposure and expiration.

| ID | Failed gate or vulnerability | Impact/exposure | Owner | Compensating control | Expiration | Approval |
|---|---|---|---|---|---|---|

## Non-code launch authority

For a software-only milestone, mark these **not authorized** rather than
silently omitting them.

| Authority | Status and authoritative evidence |
|---|---|
| Sponsor-bank/FBO program approved for this use case | |
| Money-transmission and launch-jurisdiction counsel approval | |
| BSA/AML, sanctions, KYB/UBO, monitoring, SAR, and record programs | |
| Persona and Column production contracts/configuration approval | |
| Safeguarding, reserves, insurance, reconciliation, and finance sign-off | |
| Privacy, security, penetration, vendor, backup, and incident programs | |
| Named operations/reviewer/on-call/support staffing | |
| Customer terms, disclosures, complaints, disputes, tax, and loss allocation | |
| Executive customer-funds go/no-go | |

## Decision

- Candidate software milestone: `<approved / rejected>`
- Customer funds: `<not authorized / authorized for named scope>`
- Scope and limits: `<exact environment, users, assets, networks, volume>`
- Residual blockers: `<linked items>`
- Approver(s), role, timestamp, and signature/reference: `<evidence>`

Approval is invalid if the candidate commit, image digest, provider templates,
runtime authorities, migration set, required checks, or exception set changes.
