# Release milestones

## v0.14 — the card rail

Status: release candidate (supersedes v0.13 as the current candidate; the
verification-gate procedure below is shared and its migration/service counts
now reflect v0.14). Publish only after every gate is recorded green for the
exact commit and production image digest.

### Product changes

- Adds migration `0012` and the reserved-card rail (`src/cards/*`,
  `src/db/cards.ts`): virtual cards under existing mandates whose full cap is
  reserved from the agent's funds at issue with one `card_reserve` transfer,
  one receipt, an atomic risk decision, and at most one exact-tuple owner
  approval; a fixed twelve-step decline ladder decided synchronously by a
  dedicated `money_card_ingress` role that locks one card row and can post no
  transfer; durable issuer-event ingestion (`money_card_worker`) that
  re-fetches every clearing, void, refund, and card-close from the issuer
  before any ledger command; bounded overcapture tolerance; refunds capped by
  settled amounts that never restore mandate authority; and reserve release
  on close/expiry. `ledger_health()` gains a card clause and the treasury
  breaker family gains an explicitly operator-enabled `card_spend_enabled`
  control that every breaker trip clears.
- The card number never enters model context: no MCP reveal tool, issuer
  parsers strip secret fields, reveal mode defaults to `none`, and `token`
  mode uses single-use hashed checkout tokens (10-minute TTL, 3 per card)
  bound to the signing agent and card. Compliance fails closed per
  `card:hint:<host>` merchant counterparty.
- Two new production services (`card-authorization` on :4027, `card-events`)
  with segregated credentials: the ingress holds only webhook secrets, the
  worker only a read-only issuer key, the API only the create/close/reveal
  key. Preflight, the 16-service deployment verifier, the beta profile, and
  `db/roles.sql` enforce the split; the mock issuer is refused in production.
- A Stripe Issuing adapter tested against recorded fixtures only (live
  sandbox never called in CI; wire details listed as unverified in
  `docs/CARD_RAIL.md` must be recorded before go-live), plus a Stripe-shaped
  mock issuer network for the deterministic `npm run demo:card` transcript.
- Distribution artifacts shipped with the code: `docs/CARD_RAIL.md`, the demo
  transcript, the README cast, the Stripe readiness kit, the launch-post
  draft, and an enforced vocabulary lint (`npm run lint:vocabulary`) for the
  reserved-card lexicon.

### v0.14-specific gates (in addition to the shared gates below)

- `npx vitest run` green including `test/postgres-cards.test.ts`,
  `test/postgres-cards-api.test.ts`, `test/card-issuer-mock.test.ts`,
  `test/card-workers.test.ts`, and `test/vocabulary.test.ts`; the live gate
  (`npm run test:postgres-live`) additionally races 20 independent
  authorization decisions against one card cap.
- No 13-19 digit run in any captured agent/owner body, MCP text, or log line
  during the full card loop (asserted by the cards API suite).
- The role matrix proves `money_card_ingress` can only decide/enqueue,
  `money_card_worker` cannot decide or prepare, and `money_app` can do
  neither; direct `post_card_transfer` from application roles fails.
- `npm run demo:card` exits 0 and its committed transcript
  (`docs/marketing/demo/agent-card-transcript.md`) carries the sandbox label.

## v0.13 — Persona and production deployment perimeter

Status: shipped candidate, superseded by v0.14. Publish only after every
verification gate below is recorded green for the exact commit and production
image digest.
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
- Post-candidate hardening: the payout worker and production preflight share
  one exactly-one payout-source contract; onboarding writes private keys to
  gitignored files read via `*_FILE` variables and targets the Postgres
  kernel with a dev-only, production-refused approval CLI; the MCP wallet
  surfaces recovery failures instead of swallowing them; migration `0011`
  stores ops-recorded ledger-health verdicts so the owner surface serves a
  real integrity indicator without the global probe privilege; and the
  production image bakes a marker that makes an overridden `NODE_ENV` crash
  at startup instead of silently disabling the deployment contract (the CI
  image contract verifies the marker's exact path).
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
   migrations through `0012`, proves a no-op replay, applies `db/roles.sql`
   twice, checks effective roles and removed bypasses, races independent
   connections against one spending cap, and reconciles the journal. Repeat on
   an isolated production-shaped restore for the backup/forward-repair drill.
4. Run `npm run verify:deployment`, render `deploy/compose.production.yaml`,
   and confirm every compiled command is present in the image. The deterministic
   verifier must report 16 positive and 16 leaked-authority negative preflights;
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
