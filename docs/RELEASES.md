# Release milestones

## v0.13 — Persona and production deployment perimeter

Status: release candidate. Publish only after every verification gate below is
recorded green for the exact commit and production image digest.
Copy `docs/RELEASE_EVIDENCE_TEMPLATE.md` for the candidate and attach a command
result, workflow/provider reference, live configuration export, or artifact
hash to every applicable row. A checked box or committed config file is not
authoritative evidence that a runtime or hosted control was active.

### Product changes

- Adds the production Persona `2025-12-08` adapter for account-bound,
  idempotent one-time inquiry links; separately configured individual and
  business flows; required watchlist reports; continuous-monitoring events;
  contract-valid attribute-only sparse fieldsets; one-round-trip report/account
  binding; database-enforced continuity between the approved inquiry's opaque
  Persona Account ID and every later monitoring report; monotonic fail-closed
  inquiry and report event decisions; and sparse, non-PII evidence
  normalization.
- Keeps business onboarding fail-closed. Persona Business Associated Persons
  discovers owners but does not verify them, so the adapter records review
  evidence and never marks beneficial owners verified.
- Makes every authenticated provider event and its ordered evidence set one
  PostgreSQL transaction. Subject changes, restrictions, audit links, and inbox
  completion commit together; exact replays cannot change count, order, hashes,
  normalized facts, timestamps, provider subject, or provider list/template
  version. The obsolete split-phase completion command is removed.
- Adds a pinned Node 24 production image, compiled runtime entries, a
  process-separated Compose topology, per-service authority allowlists,
  loopback-safe local defaults, byte-stable cross-platform migration inputs,
  CI and dependency updates, and a no-network production preflight enforced
  by every deployable process before it acquires external authority.
- Pins the certified v0.13 compliance deployment to Persona's official API
  origin and dated contract, and requires all schema changes to pass through
  the standalone reviewed migration job.
- Hardens remote x402 signing with a required production bearer credential,
  HTTPS and non-loopback enforcement, redirect refusal, a bounded response,
  nonzero signer identity, and local EIP-712 signature verification.
- Hardens the agent-side fetch-and-pay loop with canonical retry keys, bounded
  API/resource bodies, public-HTTPS and DNS/private-target checks, socket
  pinning, exact local CLI origin opt-ins, and redirect handling that never
  forwards receipts or one-time payment authorizations to another target.
- Applies the same bounded-response, timeout, redirect-refusal, and
  HTTPS-or-loopback rules to signed owner, seller, and compliance onboarding
  clients.

### Verification gates

Run from a clean checkout with Node 24.18.0 and the lockfile unchanged:

```text
npm ci --no-audit --no-fund
npm run typecheck
npm test -- --reporter=dot
npm run build
npm run verify:deployment
npm audit --audit-level=moderate
MONEY_TEST_DATABASE_URL=<disposable-loopback-postgres-18-url> npm run test:postgres-live
docker build --pull --build-arg SOURCE_COMMIT=<40-character-commit> --tag money:v0.13-rc .
```

Additionally:

1. Confirm `main` requires pull requests, resolves review conversations,
   rejects force pushes and deletion, and requires the `product`, `postgres`, and `image`
   jobs from GitHub Actions for the exact head commit. Record any break-glass
   bypass as an incident and review it independently. Record the reviewer roster
   and whether the private-repository plan supports enforced code-owner review.
   The present single-owner milestone cannot claim independent approval; that
   remains an external-beta blocker, when code-owner approval and fresh approval
   after material changes become mandatory. `CODEOWNERS` and the pull-request
   template are routing and evidence controls only; they do not prove that the
   repository rule exists.
2. Confirm every third-party CI action remains pinned to its reviewed full
   commit, confirm the Trivy input remains fixed at `v0.70.0` with cache reuse
   disabled, then scan the exact production image with the pinned action in
   `.github/workflows/ci.yml`. Any HIGH or CRITICAL OS or library finding
   blocks release. A temporary exception must identify the
   vulnerability, owner, justification, compensating controls, and expiration
   date. Download the commit-named image-evidence artifact, verify that its
   `SHA256SUMS` manifest is valid, verify that its image ID agrees with the
   CycloneDX metadata and scan report target, and copy the identity, SBOM,
   report, and manifest to the controlled long-term release store before the
   90-day CI retention expires. After publication, add the immutable registry
   manifest digest; do not substitute the local image ID for that digest.
3. Run `npm run test:postgres-live` against an explicitly disposable loopback
   PostgreSQL 18 database with data checksums enabled. The gate applies all
   migrations through `0010`, proves a no-op replay, applies `db/roles.sql`
   twice, checks effective roles and removed bypasses, races independent
   connections against one spending cap, and reconciles the journal. Repeat on
   an isolated production-shaped restore for the backup/forward-repair drill.
4. Run `npm run verify:deployment`, render `deploy/compose.production.yaml`,
   and confirm every compiled command is present in the image. The deterministic
   verifier must report 14 positive and 14 leaked-authority negative preflights;
   repeat inside the candidate image with the real service credential files.
5. Exercise Persona sandbox approval, decline, review, pending-report retry,
   duplicate and reordered delivery, current/old webhook-secret overlap,
   continuous watchlist match/dismissal/error, and business owner discovery.
6. Exercise a real testnet remote signer and an independent RPC, including
   signer auth failure, redirect rejection, wrong-key signatures, oversized
   responses, delayed confirmations, and settlement reversal recovery.
7. Review `docs/THREAT_MODEL.md` against the exact deployment. Assign named
   owners to every residual launch control, exercise the incident containment
   order, and confirm that every new authority or external boundary introduced
   by the release has explicit evidence and an emergency revocation path.

### Non-code launch gates

This milestone is not authorization to hold or move customer funds. The
sponsor-bank/FBO program, licensing analysis, BSA/AML and sanctions program,
Persona and Column production contracts, safeguarding and reconciliation,
reviewer staffing, privacy controls, independent testing, incident response,
and jurisdiction-by-jurisdiction approval in `docs/COMPLIANCE.md` and
`docs/TREASURY.md` remain mandatory.
