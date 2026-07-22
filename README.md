# money — Venmo for agents

A closed-loop payment network where AI agents pay each other and pay APIs/CLIs, at will, under a user-signed spending envelope. Users set money aside; agents spend it — very high volumes of very low-cost transactions, settled as ledger rows: instant, fee-free, sub-cent capable.

## Why closed-loop

When both sides of a transaction are on the same ledger, a payment is a database row. That's the only architecture that serves the agent economy's real shape (July 2026: ~75M machine payments/month averaging $0.32 on x402) — no card rail can touch sub-cent economics, and no on-chain rail beats a ledger row's latency. External rails (cards, stablecoins, banks) matter only at the edges: top-up and cash-out. This is how PayPal, Alipay, and M-Pesa actually won.

## Core design principles

1. **The envelope is the security boundary, not the model's judgment.** Spending limits live in a deterministic policy engine outside any model context. Injected text can ask; nothing in an agent's context can sign or widen a mandate.
2. **Hold authorization, not money.** Customer assets belong in a sponsor-bank FBO program; the internal ledger records beneficial balances and external boundary accounts. The repository now implements the Column-facing software boundary, but a live program still requires bank and regulatory approval.
3. **Prefunding buys the speed.** Authorization is a local policy + balance check — no external round-trip on the hot path.
4. **Exactly-once by construction.** Idempotency keys on every transfer; 402 challenges pay-once/redeem-once. Agents retry by default — the network must shrug.

## What's here (v0.13)

| Piece | File | What it does |
|---|---|---|
| Ledger | `src/core/ledger.ts` | Double-entry over integer micro-dollars, idempotency-keyed, zero-sum invariant |
| Policy | `src/core/policy.ts` | Mandates (budget, per-tx cap, daily cap, escalation line, new-payee throttle, allowlist, expiry) → single-use permits bound to exact payee+amount |
| Receipts | `src/core/receipts.ts` | Hash-chained evidence log; tamper detection |
| Persistence | `src/core/store.ts` | Append-only JSONL event log; replay rebuilds everything and refuses tampered logs |
| Production money kernel | `db/migrations/`, `src/db/` | Postgres double-entry journal plus atomic mandate evaluation, exact-tuple approvals, marketplace challenges, cumulative refunds, durable external settlement, policy evidence, deterministic row locking, actor-scoped idempotency, reconciliation, and SKIP LOCKED workers |
| Identity | `src/core/identity.ts` | Ed25519 keys for owners, agents, and providers; every mutation is verified against the registered key |
| Network | `src/core/network.ts` | Accounts + public handles, funding, agent payments, durable approvals, seller services, mandates, and 402 challenges |
| Service registry | `src/core/network.ts`, `src/db/marketplace.ts` | Provider-owned `@handle/service` listings, registry-authoritative prices, safe shutdown, and public keyset pagination |
| Seller SDK | `src/seller/middleware.ts` | Reusable Hono paywall plus a provider-signed client for challenges, receipt redemption, and partial refunds |
| HTTP API | `src/server/api.ts` | Hono server on **:4021** — agent, owner, provider, catalog, and merchant APIs plus demo paid endpoints |
| Postgres signed API | `src/server/postgres-api.ts` | Multi-instance-safe Ed25519 auth, durable nonce replay defense, hashed owner sessions, internal and external payments, provider catalog, 402 challenge/redeem, refunds, tenant-scoped state, and the private dashboard |
| Owner control plane | `src/server/dashboard.ts` | Private, session-gated balances, activity, services, mandates, and an exact-payment approval inbox |
| Database operations | `src/server/database-ops.ts` | Liveness, schema readiness, and token-gated ledger reconciliation on **:4022**; deliberately no ungoverned payment route |
| x402 boundary | `src/bridge/`, `src/db/external.ts` | Official x402 v2 exact/EVM signing, HTTPS HSM adapter, pinned Base USDC, rotatable AES-256-GCM custody, exact external approvals, independent calldata/log verification, restart recovery, and automatic journal reversal |
| Treasury boundary | `db/migrations/0007_treasury.sql`, `src/treasury/` | Real Column ACH funding and payouts, raw-body webhook HMAC, authenticated event re-fetch, out-of-order recovery, exact returns, exposure freezes, reserve-first payout workers, bank/stablecoin reconciliation, and global circuit breakers |
| Compliance and risk perimeter | `db/migrations/0008_compliance_risk.sql`, `db/migrations/0010_compliance_evidence_sets.sql`, `src/compliance/`, `src/db/compliance.ts` | KYC/KYB and sanctions evidence, atomic event-to-evidence sets, customer/counterparty lifecycle, whole-family restrictions, case evidence, atomic transfer decisions, exact velocity limits, isolated webhook/workers, expiry sweeps, and a segregated operations service |
| Hosted verification and review desk | `db/migrations/0009_compliance_operations.sql`, `src/compliance/onboarding-worker.ts`, `src/compliance/console-server.ts` | Replay-safe hosted inquiries, encrypted redirect custody, named Ed25519 reviewers, a private case console, append-only operator evidence, and database-enforced maker/checker approval |
| Persona production adapter | `src/compliance/persona.ts`, `src/compliance/runtime.ts` | Pinned Persona `2025-12-08` inquiry/report API, account-bound one-time links, database-enforced provider-subject continuity, sparse identity and sanctions refetch, timestamped raw-body HMAC with rotating secrets, and fail-closed KYC/KYB mapping without persisted provider PII |
| Production artifact | `Dockerfile`, `deploy/compose.production.yaml`, `src/deploy/preflight.ts` | Reproducible Node 24 build, source-revision-labeled non-root read-only container, segregated service credentials, readiness probes, startup-enforced production configuration, byte-stable migrations, and SHA-pinned test/image gates that retain the image identity, CycloneDX SBOM, and high/critical vulnerability report |
| MCP server | `src/mcp/server.ts`, `src/mcp/outbound.ts` | `money_balance`, `money_pay`, bounded `money_fetch` with internal/external 402 auto-pay, exact private-origin opt-ins, DNS/private-target rejection, and no credential-forwarding redirects, plus `money_feed` |
| Demo | `src/demo.ts` | The full story end-to-end (10 sections), including a separately authenticated seller joining and earning through the network |

The verification and non-code launch gates for this candidate are tracked in
`docs/RELEASES.md`; copy `docs/RELEASE_EVIDENCE_TEMPLATE.md` to retain the
exact-commit proof for each candidate. The repository-specific adversarial model, protected
invariants, trust boundaries, residual risks, and incident containment order
are in `docs/THREAT_MODEL.md`; private vulnerability reporting and initial
response rules are in `SECURITY.md`.

## Run it

```bash
npm ci                    # install the exact reviewed dependency tree
npm run typecheck
npm test                  # complete product and invariant suite
npm run build             # compile every production entry point into dist/
npm run verify:deployment # exercise all 14 compiled service preflights, positive and negative
npm audit --audit-level=moderate
npm run demo              # the whole story in one script
npm run api               # the HTTP server on :4021 (durable: data/events.jsonl)
```

### Run the production money kernel

The database path requires Node 24+ and PostgreSQL 18. Start the local database
and transaction pool (the committed password is intentionally local-only):

```bash
docker compose up -d postgres pgbouncer
export DATABASE_URL=postgres://money:money-dev-only@127.0.0.1:5432/money
npm run db:migrate
npm run db:reconcile
npm run db:test
npm run api:db
npm run external:worker
npm run treasury:webhooks
npm run treasury:events
npm run treasury:payouts
npm run treasury:reconcile
npm run compliance:webhooks
npm run compliance:events
npm run compliance:onboarding
npm run compliance:reviews
npm run compliance:ops
npm run compliance:console
```

The ordinary suite safely skips its destructive real-server gate. Before a
release candidate, point `MONEY_TEST_DATABASE_URL` at an explicitly disposable
loopback PostgreSQL 18 database whose name contains `test`, `live`, or a version
marker, then run `npm run test:postgres-live`. That gate applies and replays the
exact migrations and roles, checks data checksums and effective privileges,
proves that application-role bypasses fail, races independent connections
against one spending cap, and reconciles the resulting journal. The pinned CI
`postgres` job runs the same gate on every candidate branch and pull request.

Application traffic should use PgBouncer on port `6432`; migrations and
administrative work should connect directly on `5432`. Transaction pooling is
safe here because the application uses transaction-local settings and
transaction-level advisory locks, never session-local state.

For a deployed environment, build the root `Dockerfile`, publish the image by
digest, and use the process-separated reference topology in
`deploy/compose.production.yaml`. It does not bundle PostgreSQL, secrets, fake
funding, or fake rails. Each process receives a different database login and
credential file. Run `npm run deploy:preflight -- <service>` before rollout to
reject cross-service credential leakage, obvious owner database URLs,
non-verifying TLS, provider version drift, local signing keys, and development
escape hatches. Every production entry point enforces the same contract again
before opening a database pool, provider client, or listening socket. See
`deploy/README.md` for the complete rollout and network contract.

The Postgres kernel stores micros as signed 64-bit integers (not JavaScript
numbers), locks both account rows in deterministic order, writes exactly two
zero-sum journal entries, updates cached balances, creates receipt evidence,
and enqueues an outbox event in one transaction. Exact retries return the same
transfer and receipt; changed terms return an idempotency conflict. Normal
application credentials can register identities, allocate owner funds,
grant/revoke mandates, request policy-governed agent payments, and resolve
owner approvals. They cannot invoke raw agent payment, generic posting, or
treasury funding.

For operations health, set `MONEY_OPS_TOKEN` and run `npm run ops:db`.
`GET /health/live` and `GET /health/ready` are safe for probes;
`GET /ops/reconcile` requires that bearer token. `GET /ops/treasury` reports
external-asset coverage, stale or divergent snapshots, dead provider events,
and manual-review payouts; it fails readiness with `503` when intervention is
required.

Compliance operations run as a separate process and database role. Set
`MONEY_COMPLIANCE_OPS_DATABASE_URL` and `MONEY_COMPLIANCE_OPS_TOKEN`, run
`npm run compliance:ops`, and query `GET /ops/compliance` on port `4025`.
It returns `503` for dead evidence events, failed hosted inquiries, pending
checker decisions, open cases/restrictions, or evidence expiring within seven
days. General operations credentials cannot read those tables or infer
regulatory-report status. The separate compliance desk runs on `:4026`; use
`npm run compliance:operator-setup` once per named reviewer and
`npm run compliance:login` to mint a 30-minute browser session.

Treasury controls install disabled by default. Register bank/wallet sources,
obtain a clean reconciliation, and use the reviewed admin restore command in
`docs/TREASURY.md`; internal agent-to-agent payments remain available while
the external perimeter is stopped.

The policy, marketplace, and external-settlement Postgres gateways are
`src/db/policy.ts`, `src/db/marketplace.ts`, and `src/db/external.ts`; the signed product API is
`src/server/postgres-api.ts` (`npm run api:db`). It covers identity onboarding,
durable replay-safe authentication, owner sessions, allocation, mandates,
agent payments, exact owner approvals, key rotation, provider service
publishing, public discovery, registry-priced 402 challenges, single-use
redemption, cumulative-capped refunds, durable external x402 settlement,
sanitized owner compliance status, replay-safe hosted verification sessions,
scoped balances/activity, and the private dashboard. The ops service
intentionally exposes no payment endpoint.

Migration `0008` fails closed for real funding, cross-owner payment, external
x402 debit, and payout reservation unless the required customer subjects and
counterparties have current reviewed evidence. Every regulated transfer gets
an append-only risk decision linked one-to-one with the journal transfer;
same-owner internal movement remains local, while refunds and externally
verified reversals can restore funds into a frozen account without unfreezing
it. See `docs/COMPLIANCE.md` for the provider contract, role separation,
review procedures, risk limits, and launch gates.

Migration `0009` makes the perimeter operable. Owners queue one active hosted
identity inquiry; a dedicated worker calls the provider outside the database
transaction and stores only an authenticated provider reference, URL hash, and
rotatable AES-256-GCM ciphertext. The product API decrypts a live URL only for
its authenticated owner. Named reviewers sign into a same-origin compliance
desk without putting their long-lived key in the browser. Emergency freezes
remain immediate, while subject activation, restriction release, terminal case
resolution, and risk-limit changes require a different supervisor checker.
The prior administrator bypasses for those actions are removed.

Migration `0010` makes a provider event and all evidence derived from it one
database commit. It records an ordered event-to-evidence audit link, applies
every identity/screening result, and completes the inbox claim atomically. A
crash can therefore replay the whole set or none of it; it cannot strand a
mutable provider result between a committed evidence row and an unfinished
event. For Persona, that command also establishes the inquiry's opaque Account
ID on the compliance subject and requires every later sanctions/monitoring
result to present the identical provider subject.

With `MONEY_COMPLIANCE_PROVIDER=persona`, v0.13 replaces the generic launch
placeholder with a dated Persona adapter. Inquiry creation uses Persona's
idempotency header, separate reviewed individual/business templates, stable
account reference IDs, and one-time hosted links. Signed final decisions and
watchlist state changes enter the inbox; workers independently refetch a sparse
Inquiry or Report view, with the Report response explicitly including only its
Account reference. A clear inquiry is therefore not
enough by itself: current no-match sanctions evidence is also required.
Positive and continuous-monitoring matches immediately become review, never
automatic clearance; delayed match, dismissal, and error events cannot be
weakened by a newer provider response. The database also requires every report's
opaque Persona Account ID to match the account established by that subject's
approved inquiry, so a signed but unrelated report cannot clear screening.
Authenticated inquiry decline/review events carry their decision in the durable
reference and cannot be weakened by a later approved provider state; ambiguous
legacy references are review-only.
Persona's Business
Associated Persons report is recorded as owner discovery—not verified UBO
evidence—so business activation remains fail-closed until each owner has a
separate identity and screening workflow. Webhook payloads and provider fields
may contain PII transiently, but the product database receives only object
references, hashes, expiry, and a small allowlisted decision summary. A real
launch still requires the organization's own Persona sandbox/production
contract and reviewed inquiry/report template configuration.

The production treasury path is documented in `docs/TREASURY.md`. Incoming
funding is credited only after an HMAC-authenticated webhook has been queued by
a no-money-movement role and independently re-fetched with Column API
credentials. Owner and provider payouts reserve ledger funds before provider
I/O and use deterministic Column idempotency. Funding returns can create an
exact tracked negative balance, freeze the owner's whole account family, and
require explicit operator release after recovery. New x402 activation, funding,
and payouts share reconciliation and incident circuit breakers.

External routes fail closed unless a signer, a versioned header-encryption
keyring, and an independent settlement verifier are all configured. `POST
/pay-external` first stores an unsigned intent and evaluates policy. It signs a
fresh EIP-3009 authorization only immediately before an atomic recheck and
debit; owner approvals wait unsigned. PostgreSQL stores only AES-256-GCM
ciphertext plus a plaintext-header hash. The agent sends the seller's complete
settlement response to `POST /pay-external/:id/confirm`; the verifier checks
the EIP-712 signature, exact transaction calldata, receipt log and confirmation
depth before the short database transition. Confirmation races safely against
the SKIP LOCKED reversal worker. See `docs/EXTERNAL_SETTLEMENT.md` for the API,
key-rotation procedure and deployment contract.

For local protocol-shaped testing only, set `MONEY_EXTERNAL_MOCK=true` and a
stable `MONEY_EXTERNAL_HEADER_KEY` (32 bytes, base64 or 64 hex characters).
Mock mode and raw EVM private keys are refused when `NODE_ENV=production`.
Production v2 uses `MONEY_EVM_SIGNER_URL`, `MONEY_EVM_SIGNER_ADDRESS`, a
separately rotatable `MONEY_EVM_SIGNER_TOKEN`, `MONEY_EXTERNAL_HEADER_KEYS`,
`MONEY_EXTERNAL_HEADER_ACTIVE_KEY_ID`, and `MONEY_EVM_RPC_URLS`. Rotate stored
authorization ciphertext under the dedicated database role with
`npm run external:rotate-keys`.

Owner-signed `/fund` is disabled on the Postgres API by default because real
top-ups belong to a separately credentialed treasury integration. For an
explicit local-only walkthrough, start it with
`MONEY_ALLOW_DEV_FUNDING=true npm run api:db`; never enable that switch in a
deployed environment.

The dashboard is private. Export the `MONEY_USER_ID` and `MONEY_OWNER_KEY`
printed during onboarding, then mint an eight-hour browser session:

```bash
npm run dashboard:login
```

Open the fragment-token link it prints. The long-lived owner key never enters
browser storage, financial reads are tenant-scoped, and logging out revokes the
in-memory session immediately.

### Give a Claude Code agent a wallet

Start the API (`npm run api`), then in another terminal:

```bash
npm run onboard    # creates user + agent + mandate, prints the MCP config
```

Or wire it manually — add to `.mcp.json`:

```json
{
  "mcpServers": {
    "money": {
      "command": "npx",
      "args": ["tsx", "C:/Users/mcalk/code/money/src/mcp/server.ts"],
      "env": {
        "MONEY_API": "http://127.0.0.1:4021",
        "MONEY_AGENT_ID": "agt_xxxxxxxx",
        "MONEY_AGENT_KEY": "<base64 Ed25519 private key from onboarding — keep out of git>"
      }
    }
  }
}
```

The agent can then check its balance, pay other agents, and fetch 402-gated URLs
that get paid automatically inside its mandate. Internet fetches require HTTPS,
reject local/private/reserved literal or DNS results, pin the checked address
to the actual socket, cap upstream bodies, and never forward a receipt or
one-time payment authorization across a redirect.
An unauthenticated redirect is returned as a validated URL for a second
`money_fetch` call. To let an agent pay an explicitly trusted local CLI, set a
JSON allowlist of exact origins such as
`MONEY_FETCH_PRIVATE_ORIGINS=["http://127.0.0.1:8080"]`; no private origin is
enabled by default. Opt-ins must resolve entirely to loopback, RFC1918, CGNAT,
or IPv6 ULA addresses. Link-local metadata, multicast, documentation, and
other reserved ranges cannot be enabled through this escape hatch.

### Publish a paid API

Provider identities are created by an owner, then use their own signing key to
publish services and redeem receipts. After `npm run onboard`, export the
`MONEY_USER_ID` and `MONEY_OWNER_KEY` it prints, then run:

```bash
npm run onboard:seller -- \
  --handle research-cloud \
  --slug market-report \
  --endpoint https://seller.example/report \
  --price 0.05
```

The command prints `MONEY_PROVIDER_ID`, `MONEY_PROVIDER_KEY`, and
`MONEY_SERVICE_ID`. It writes the provider key and stable registration keys to
the gitignored `.money/` directory before contacting the network, so an
interrupted run can be repeated without orphaning the handle or duplicating the
service. Mount the reusable Hono middleware on the registered route:

```ts
import { Hono } from "hono";
import { createMoneySellerClient, moneyPaid } from "./src/seller/middleware.ts";

const app = new Hono();
app.get("/report", moneyPaid({
  networkUrl: process.env.MONEY_API!,
  providerId: process.env.MONEY_PROVIDER_ID!,
  providerKey: process.env.MONEY_PROVIDER_KEY!,
  serviceId: process.env.MONEY_SERVICE_ID!,
}), (c) => c.json({ report: "valuable machine-readable result" }));

const seller = createMoneySellerClient({
  networkUrl: process.env.MONEY_API!,
  providerId: process.env.MONEY_PROVIDER_ID!,
  providerKey: process.env.MONEY_PROVIDER_KEY!,
});

// Partial or full; the same key can be retried without issuing it twice.
await seller.refund({
  receiptId: "rcpt_...",
  amountMicros: 10_000,
  memo: "service credit",
  idempotencyKey: "refund-order-123-v1",
});
```

The public catalog is `GET /services`. Agents may also pay accounts by public
handle (for example `@research-cloud`) instead of copying opaque ids. Refunds
are tied to the original hash-chained receipt, cannot exceed the purchase, and
do not restore mandate budget (so cooperating buyer and seller accounts cannot
recycle an agent's spending authority).

## The mandate model

```
grant: budget $10 · per-tx $1 · daily $5 · ask-me-above $2 · new-payee first-touch 10¢ · expires 30d
```

- **Escalation**: above the ask-me line, the agent receives a durable `approval_required` intent. The owner inbox shows the stored payee, amount, and memo; approving executes that immutable tuple through a one-time permit ("approval is the mandate" — no gap between what the human saw and what executes). Requests survive restart, expire after 24 hours, and recover exactly once across a crash at settlement.
- **New-payee throttle**: the first payment to any unseen payee is capped at cents — including external x402 vendors, keyed on canonical host plus destination address. A prompt-injected agent lured to an attacker's endpoint can leak cents/day, not the envelope, and swapping `payTo` cannot inherit a vendor's trust. Payees inside the owner's own trust domain (the owner, sibling agents they own) are exempt — money paid to them never leaves the owner's accounts. Everything else (caps, budget, escalation) still applies to them.
- **Permits**: single-use, 60s TTL, bound to (agent, payee, amount). Replay and amount-inflation are structurally dead.

## Honest v0 shortcuts (the roadmap is the inverse)

- The complete showcase API still defaults to the local JSONL engine (`data/events.jsonl`; `MONEY_DATA` overrides it). The Postgres API now serves the signed identity, payment, approval, owner control plane, service marketplace, challenge, redemption, refund, and external x402 paths; new deployment work should target `api:db`.
- Postgres marketplace challenges are durable, claimed by at most one agent, paid once, and redeemed once; paid retries win over expiry. Expired unpaid rows are cleaned in bounded batches. At truly enormous anonymous-request volume, challenge issuance should move to signed stateless edge tokens so unpaid 402 traffic does not require one database write per offer.
- Identity is an Ed25519 keypair per account: agents sign spends and owners sign admin mutations over method+path+body+timestamp+nonce. The Postgres API records accepted nonces durably, rejects replay across replicas, makes public-key onboarding retry-safe, and revokes browser sessions when an owner rotates keys (→ RFC 9421 HTTP Message Signatures + `@authority` binding on the wire; keys chained to a KYC'd owner; signup rate-limiting and owner-key delivery off stdout).
- Browser access uses an eight-hour bearer session minted by an owner-signed request. Only SHA-256 token hashes are stored; sessions survive restart, cap at ten per owner, expire, revoke individually, and die on owner-key rotation (→ passkeys for the production owner ceremony).
- The JSONL product path is single-node and remains a showcase. The Postgres path is multi-instance-safe for ledger, mandate, approval, signed identity, nonce, session, tenant-scoped control-plane, marketplace, challenge, redemption, refunds, and the pending/confirmed/cancelled/reversed external state machine.
- The real-rail software boundary is implemented but not activated with customer funds. Column ACH funding/payouts, provider-event recovery, returns, freezes, and continuous bank/stablecoin reconciliation are present; x402 has remote-HSM signing and independent chain verification. A launch still needs an executed sponsor-bank/FBO program, production Column/RPC/HSM credentials and redundancy, funded reserves, verified customer/counterparty enrollment, and the legal and operating program in `docs/COMPLIANCE.md`.
- The ledger can settle between accounts owned by different users and now enforces reviewed KYC/KYB, sanctions, counterparty, and velocity decisions in the database. It is still a development sandbox: real customer funds require the sponsor-bank/FBO, licensing analysis, BSA/AML and OFAC programs, trained reviewers, SAR governance, safeguarding, independent testing, and production provider contracts. Code alone does not cross the money-transmission line.
- The Persona adapter can make an individual eligible only after both an approved inquiry and current configured watchlist evidence, and it ingests later monitoring matches. Business KYB remains deliberately fail-closed: v0.13 discovers associated persons but does not yet orchestrate and link a separate KYC/sanctions inquiry for every UBO or control person.
- No subscriptions, delegated sub-agent mandates, complete dispute/chargeback case workflows, tax reporting, credit, or insurance yet. Provider payouts now exist; the remaining programmable-commerce and risk layers come next.

## The bigger picture

See the design brief (research + architecture + market map, July 2026): the artifact "The Agent Spend Account". The wedge: the neutral, dual-economy spend account for coding-agent runtimes — one balance paying both x402-style machine endpoints and fiat-priced metered providers, enforced outside the model, exactly-once, with one receipt feed.
