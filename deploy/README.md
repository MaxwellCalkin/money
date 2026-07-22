# Production deployment contract

`compose.production.yaml` is a cloud-neutral reference topology for the
database-backed product. It deliberately contains no database, credentials,
TLS terminator, or fake rail. Use a managed PostgreSQL primary plus pooler,
an external secrets manager, and an authenticated edge/load balancer.

## Immutable image

Build the root `Dockerfile` and publish it by digest. The image compiles the
TypeScript entry points on Node 24 LTS, prunes development dependencies, runs
as the unprivileged `node` user, and contains the SQL migrations alongside the
compiled services. Deploy `registry.example/money@sha256:...`, never a mutable
tag. The base image is itself pinned to an official multi-platform digest.
Every third-party CI action is pinned to a reviewed full commit. CI scans that
exact built image with a full-commit-pinned Trivy action, an explicit scanner
version, no restored scanner/database cache, and
blocks every HIGH or CRITICAL OS or library vulnerability. Do not suppress a
finding globally: any temporary waiver needs a vulnerability ID, accountable
owner, justification, compensating controls, and an expiration date.

The CI build supplies the source commit as the OCI
`org.opencontainers.image.revision` label. For every successful image build it
retains one 90-day GitHub Actions artifact named with that commit. The artifact
contains the local image ID and workflow identity, a CycloneDX inventory, and
the machine-readable HIGH/CRITICAL scan report, covered by a sorted
`SHA256SUMS` manifest. The upload step runs even when the vulnerability gate
fails, so the blocking evidence is not lost. Verify the manifest immediately
after download. Before a release, copy this evidence into the controlled
long-term release store and record the immutable registry manifest digest
produced by publication; a local Docker image ID is not a registry digest or a
signed provenance statement.
Reject a release image whose revision label is `unknown` or differs from the
reviewed 40-character source commit.

## Repository change control

`.github/CODEOWNERS` routes every change to the repository owner and repeats
the money, identity, provider, deployment, and security boundaries explicitly.
The pull-request template requires authority, money-invariant, role,
failure-mode, migration, verification, rollout, and containment evidence.
Neither file enforces review by itself.

Protect `main` with a GitHub ruleset or branch rule that requires pull requests,
the `product`, `postgres`, and `image` jobs from the pinned workflow with GitHub Actions as
their expected source, and resolved review conversations. Disable force pushes
and branch deletion. Restrict bypass to a named, time-bounded break-glass
procedure whose use is independently reviewed.

The current single-owner repository cannot honestly claim independent review;
requiring that same owner to approve their own pull request is not a substitute
and may make the rule unsatisfiable. Private-repository code-owner enforcement
also depends on the GitHub plan. Record both facts for software milestones.
Before external beta, use a plan and reviewer roster that can require code-owner
approval plus fresh approval after material changes from at least one
independent qualified reviewer. Before customer funds, require two-person
review for money kernel, role/migration, signer/custody, treasury, compliance,
and CI/release changes. Dependabot pull requests cross the same gate and must
not be merged merely because they were generated automatically.

## One identity and secret set per process

Set `MONEY_RUNTIME_DIR` to a host directory populated by your secrets manager.
Create exactly these files, mode `0400`, with only the variables that process
needs:

| File | Database login inheritance | Additional authority |
| --- | --- | --- |
| `migrate.env` | schema owner, deployment window only | none |
| `api.env` | `money_app` | hosted-URL and external-header decrypt keys; remote signer URL, public address, and bearer credential; never provider credentials |
| `database-ops.env` | `money_ops` | random 32+ character ops token |
| `external-worker.env` | `money_worker` | none |
| `treasury-webhook.env` | `money_treasury_ingress` | Column webhook secret only |
| `treasury-events.env` | `money_treasury_worker` | read-only Column event API key |
| `treasury-payouts.env` | `money_payout_worker` | Column payout key and source account IDs |
| `treasury-reconciler.env` | `money_reconciler` | independently scoped read-only bank/chain credentials |
| `compliance-webhook.env` | `money_compliance_ingress` | Persona webhook secrets only |
| `compliance-events.env` | `money_compliance_worker` | Persona inquiry/report/account read key and template configuration |
| `compliance-onboarding.env` | `money_compliance_onboarding` | Persona create/read key and hosted-URL encryption keyring |
| `compliance-reviews.env` | `money_risk_worker` | none |
| `compliance-ops.env` | `money_compliance_ops` | random 32+ character ops token |
| `compliance-console.env` | `money_compliance_console` | none; operators authenticate with their own Ed25519 keys |

Every file needs `NODE_ENV=production`; HTTP services also need
`MONEY_BIND_HOST=0.0.0.0`. Service PostgreSQL URLs must use a passworded
non-owner login and `sslmode=verify-full`; `migrate.env` instead uses a
dedicated schema-owner login that exists only for the deployment window. Do
not give a container a superset file: the preflight intentionally rejects
every enumerated cross-service database URL, key, and credential.

Run the no-network preflight against each file before rollout:

```text
npm run build
npm run verify:deployment
docker run --rm --env-file <runtime>/api.env <image-digest> dist/deploy/preflight.js api
docker run --rm --env-file <runtime>/compliance-webhook.env <image-digest> dist/deploy/preflight.js compliance-webhook
```

The repository verifier first proves that all 14 Compose commands exist in the
compiled artifact, that each service accepts a synthetic least-authority
environment, and that each rejects one representative leaked authority. Then
repeat the image command for every service name in the Compose file using its
real credential file. Every production entry
point also executes the identical check before opening any database pool,
provider client, or listening socket, so skipping this rollout step cannot
silently weaken the running process. The preflight validates narrow
database URLs, per-process authority allowlists, keyrings, Persona's pinned API
version and official API origin, authenticated remote signing, independent RPC
verification, and production-only flags without printing secret values or
touching external systems. It also refuses in-process auto-migration and a
custom migration directory; only the reviewed standalone migration job may
change production schema.

## Rollout

1. Restore the latest backup into an isolated database and run the migration
   job there. Verify migration checksums, role grants, reconciliation, and the
   compliance console before touching production.
2. Run `migrate` once under the admin profile, then destroy its credentials.
3. Start workers and internal operations services. Require green database,
   treasury, and compliance readiness probes. Persona worker files must pin
   both inquiry templates and all three required report templates; screening
   expiry is a separately reviewed parameter.
4. Start the API and webhook ingresses behind TLS. Expose only ports 4021,
   4023, and 4024 through the edge; keep ops and the reviewer console on the
   administrative network with SSO/VPN access controls.
5. Configure Persona to deliver `inquiry.approved`, `inquiry.declined`,
   `inquiry.marked-for-review`, plus `ready`, `matched`, `dismissed`, and
   `errored` events for individual and business watchlist reports. Keep its
   payload attribute blocklist enabled. Exercise sandbox approval, review,
   decline, continuous-monitoring match, dismissal, duplicate delivery,
   out-of-order delivery, old-secret overlap, and old timestamp rejection.
   Verify an approved individual produces the configured no-match watchlist
   report before activation. Keep business activation closed: the
   associated-persons report discovers owners but does not verify them, and
   v0.13 intentionally routes those subjects to review.
6. Release traffic in reviewed limit tiers. Keep funding, payouts, and
   external x402 breakers closed until treasury reconciliation and the
   non-code compliance launch gates are signed off.

The Compose ports bind to host loopback by default because the reference
expects a colocated reverse proxy. Override a `*_BIND` variable only when the
host firewall and upstream authentication are already in place. Container
filesystems are read-only, Linux capabilities are dropped, privilege
escalation is disabled, and every long-running process receives `SIGTERM` with
a 30-second drain window.
