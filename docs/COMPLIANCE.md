# Compliance and risk operating contract

This is the operating contract for migrations `0008_compliance_risk.sql` and
`0009_compliance_operations.sql` and atomic evidence-set hardening in
`0010_compliance_evidence_sets.sql`. The software supplies fail-closed controls,
segregated process identities, and audit evidence. It does not itself make the
company licensed, satisfy a sponsor bank, file a SAR, or replace written
BSA/AML, sanctions, fraud, privacy, complaints, and incident programs.

## Enforced boundary

- Every user account has one compliance subject. Agents and providers inherit
  the subject of their owning user.
- A subject is not eligible for regulated transfers until identity or business
  evidence and sanctions evidence are current, a reviewer has approved a risk
  tier, and no case or restriction remains open. Businesses additionally need
  beneficial-owner evidence.
- Real funding, cross-owner payments, x402 outflow, and payout reserves evaluate
  compliance and velocity inside the posting transaction. Denials are
  idempotent. Allows create an immutable risk decision linked one-to-one with
  the journal transfer.
- Same-owner movement remains internal. Refunds, funding returns, payout
  reversals, and external-payment reversals can restore funds into a frozen
  account, but they do not release the freeze.
- Restrictions freeze every active user, agent, and provider in the owner's
  family. Release requires current evidence, closed cases, no open restriction,
  and a reviewed two-person action.
- Provider evidence, case actions, subject events, risk decisions, limit
  changes, risk-to-transfer links, and operator events are append-only.
- Raw identity documents and identity attributes do not belong in this
  database. The provider client and a recursive database constraint reject
  normalized keys such as names, birth dates, tax IDs, addresses, contact
  details, passports, licenses, documents, images, and selfies.
- Hosted verification is a durable outbox workflow. Provider I/O occurs after
  the claim transaction commits; retries reuse the internal session UUID as
  the provider idempotency key. The hosted URL is stored only as rotatable
  AES-256-GCM ciphertext plus its SHA-256 hash.
- Human actions are attributable to named Ed25519 operators. Emergency
  restrictions are immediate. Subject activation, restriction release,
  terminal case disposition, and risk-limit changes require a different maker
  and supervisor/administrator checker inside one database transaction.

## Transfer matrix

| Operation | Required decision |
|---|---|
| Funding credit | Destination owner's subject is approved and current |
| Same-owner internal transfer | No compliance decision; mandate and balance rules still apply |
| Cross-owner agent payment | Source and destination subjects are approved and current |
| External x402 debit | Source subject is approved/current and canonical payee has a current clear screening |
| Payout reserve | Source subject is approved/current and linked destination has a current clear screening |
| Refund or external reversal | May credit a frozen account; cannot release it |

The journal has a final trigger as well as wrapper checks. A stale or alternate
caller cannot insert a regulated transfer without the exact allow decision in
the same transaction.

## Customer onboarding and hosted inquiries

The signed product API exposes:

- `GET /owner/compliance` - sanitized owner-visible state only.
- `POST /owner/compliance` - accepts `subjectType`, two-letter `countryCode`,
  `expectedSingleMicros`, and `expectedMonthlyMicros`. It never accepts PII.
- `POST /owner/compliance/inquiries` - queues or replays one active inquiry.
  The body is `{ "idempotencyKey": "..." }`.
- `GET /owner/compliance/inquiries/:id` - returns lifecycle state and, only
  while ready and unexpired, the authenticated owner's hosted URL.

Run `npm run compliance:onboarding` with the
`money_compliance_onboarding` login. The product API queues a non-PII profile;
the worker claims with `FOR UPDATE SKIP LOCKED` and commits before network I/O.
For non-Persona development adapters, the provider-neutral wire contract is:

```http
POST /v1/inquiries
Authorization: Bearer <provider API key>
Idempotency-Key: <internal verification-session UUID>
Content-Type: application/json

{"idempotencyKey":"<UUID>","subjectAccountId":"usr_...","subjectType":"individual","countryCode":"US"}
```

The generic provider adapter expects:

```json
{
  "id": "provider-inquiry-id",
  "hostedUrl": "https://approved-provider-origin/session/...",
  "expiresAt": "2026-07-20T18:00:00.000Z"
}
```

The adapter rejects redirects, non-HTTPS provider APIs, responses over 64 KiB,
unapproved hosted origins, URL credentials/fragments, and expiries outside one
minute to seven days. Configure the exact allowlist with
`MONEY_COMPLIANCE_HOSTED_ORIGINS`. Provider credentials exist only in the
worker. The product API has the URL-decryption keyring but no provider API key.

Ciphertext associated data binds session ID, owner subject, provider, expiry,
and key ID. The API also checks the durable plaintext hash before returning the
URL. Rotate with `MONEY_COMPLIANCE_SESSION_KEYS` and
`MONEY_COMPLIANCE_SESSION_ACTIVE_KEY_ID`; retain old keys until every unexpired
session using them has expired.

The generic contract remains available for development adapters. The v0.13
production path is the pinned Persona adapter below. Customer-visible state
never includes provider references, evidence hashes, internal reasons, case
details, or regulatory-report status.

### Persona `2025-12-08` adapter

Set:

```text
MONEY_COMPLIANCE_PROVIDER=persona
MONEY_COMPLIANCE_PROVIDER_URL=https://api.withpersona.com
MONEY_PERSONA_API_VERSION=2025-12-08
MONEY_PERSONA_INDIVIDUAL_TEMPLATE_ID=itmpl_...
MONEY_PERSONA_BUSINESS_TEMPLATE_ID=itmpl_...
MONEY_PERSONA_INDIVIDUAL_WATCHLIST_REPORT_TEMPLATE_ID=rptp_...
MONEY_PERSONA_BUSINESS_WATCHLIST_REPORT_TEMPLATE_ID=rptp_...
MONEY_PERSONA_BUSINESS_ASSOCIATED_PERSONS_REPORT_TEMPLATE_ID=rptp_...
MONEY_PERSONA_SCREENING_TTL_DAYS=30
MONEY_COMPLIANCE_HOSTED_ORIGINS=https://withpersona.com
```

All five template IDs are required and must be different. The inquiry IDs
identify separately reviewed KYC and KYB flows. Each flow must create the
configured watchlist report, and the business flow must also create the
configured Business Associated Persons report. Pinning report-template IDs
prevents an unrelated report of the same type from satisfying the evidence
contract. The adapter refuses another API date until its mapping and fixtures
are deliberately upgraded.

The hosted worker calls Persona's documented Create an Inquiry endpoint with
`Persona-Version: 2025-12-08`, `Key-Inflection: kebab`, and the internal
session UUID in `Idempotency-Key`. It sends no name, address, tax number,
document, or contact data:

```json
{
  "data": {
    "attributes": { "inquiry-template-id": "itmpl_..." }
  },
  "meta": {
    "auto-create-account": true,
    "auto-create-account-reference-id": "usr_...",
    "auto-create-one-time-link": true,
    "expiration-after-create-interval-seconds": 86400
  }
}
```

It requires the response's account reference and template to match the
request, takes only `meta.one-time-link`, validates the configured origin and
`expires-at`, then hands the URL to the existing encrypted-session store.
Persona recommends one-time links instead of persistent session-token links;
the implementation never stores or returns a session token. See Persona's
[Create an Inquiry](https://docs.withpersona.com/api-reference/inquiries/create-an-inquiry),
[Inquiries overview](https://docs.withpersona.com/inquiries), and
[one-time link](https://docs.withpersona.com/docs/inquiry-one-time-links)
documentation.

Persona webhook ingress accepts its JSON:API event shape and verifies the
`Persona-Signature` over `<unix-seconds>.<exact raw body>`. Timestamps outside
the configured 30-900 second window are rejected. Set
`MONEY_COMPLIANCE_WEBHOOK_SECRETS` to a JSON array with the current and prior
secret during rotation; all candidate comparisons use constant-time digests.
`inquiry.approved`, `inquiry.declined`, and `inquiry.marked-for-review` enter
the durable inbox, as do `ready`, `matched`, `dismissed`, and `errored` events
for individual and business watchlist reports. Other correctly signed
lifecycle events receive a successful ignored response. Configure Persona's
webhook event filter and attribute blocklist anyway, so unnecessary identity
fields do not cross the ingress boundary. Persona documents duplicate and
out-of-order delivery, raw-body signatures, and overlapping rotation secrets
in its [webhook best practices](https://docs.withpersona.com/webhooks-best-practices).

The inbox stores a composite inquiry/event/decision-code reference, not the
webhook payload. That authenticated code is monotonic: a delayed `declined`
event remains blocked and a delayed `marked-for-review` event remains review
even if the inquiry is later re-fetched as approved. Legacy references without
a decision code are review-only and can never create clearance.
The evidence worker independently retrieves a sparse Inquiry projection and
requires the account reference, inquiry ID, configured template, and the
relationship IDs Persona returns outside `data.attributes`. For an approved
inquiry it retrieves only allowlisted status attributes from the configured
watchlist report and explicitly includes that report's Account with only its
`reference-id`. Relationship names never appear in Persona's `fields[...]`
parameters, which accept attribute names only. The adapter never requests match
details, queries, owner records, or identity attributes. Reports are
asynchronous, so a missing or pending required report keeps the inbox event
retryable instead of silently producing incomplete evidence. For an
authenticated approval event, the currently fetched final inquiry status maps
as follows:

| Persona Inquiry status | Money evidence decision |
| --- | --- |
| `approved` | `clear` |
| `declined` | `blocked` |
| `needs_review` | `review` |

Every other current status is retryable on an approval event and cannot become
`clear`. Authenticated decline and review events instead retain their blocked
or review floor even if the later fetched status is non-final or less
restrictive. A ready watchlist report with `has-match=false` produces current sanctions evidence;
`has-match=true` produces `review`, never an automatic sanctions block or
clearance. A later continuous-monitoring match is independently re-fetched and
bound twice: the sparse Account `reference-id` must name the local subject, and
the opaque Persona Account ID must equal the provider-subject reference stored
from that subject's approved inquiry. The ordered event/evidence link retains
the same opaque reference for immutable replay comparison. Thus a signed report
for an unrelated Persona account cannot clear another user's screening, and no
second provider round trip is required. A match immediately moves an approved
subject back to review. Report-event handling is likewise monotonic even if the
provider report changes before the worker refetches it:
`matched` and `dismissed` events require review, and an `errored` event produces
error evidence. A delayed safety event therefore cannot silently become
clearance from a newer no-match response. The adapter
hashes each exact sparse response, discards it, and returns only status,
configured template IDs, a one-way version fingerprint, boolean match state, timestamps, and
expiry. The database's recursive identity-field constraint remains a second
independent barrier. `MONEY_PERSONA_EVIDENCE_TTL_DAYS` and
`MONEY_PERSONA_SCREENING_TTL_DAYS` are reviewed program parameters, not claims
by Persona about regulatory validity.

Persona's Business Associated Persons report discovers ownership data; it does
not prove each beneficial owner passed identity verification and sanctions
screening. Money therefore records that report as `beneficial_owner: review`
with `ownerVerification=required`. It never flips
`beneficial_owners_verified`. Business accounts remain in the review queue and
cannot be approved until a future UBO orchestration flow links and verifies
each owner. Treating discovery as verification would be a material compliance
bug. Persona likewise recommends using a Case payload when KYB spans separate
business and UBO inquiries. See Persona's [Reports](https://docs.withpersona.com/api-reference/reports),
[Business Associated Persons event](https://docs.withpersona.com/2023-01-05/api-reference/webhooks/report-events/webhook-report-business-associated-persons-ready),
and [payload integration guide](https://docs.withpersona.com/integration-guide-understanding-a-persona-api-payload).

The automated suite is a contract fixture, not proof of account access. Before
real funds, run the same approval/review/decline, duplicate, reordering,
rotation, malformed response, and untrusted-link scenarios in the company's
own Persona sandbox and retain the provider request IDs as launch evidence.

## Provider result contract

This subsection describes the provider-neutral fallback used by fixture and
custom adapters. Persona uses the dated JSON:API mapping above.

Run public ingress with `npm run compliance:webhooks`. Its login inherits only
`money_compliance_ingress`.

```http
POST /webhooks/compliance
X-Compliance-Signature: <hex HMAC-SHA256 of exact raw body>
X-Compliance-Endpoint-Id: <configured endpoint id>
Content-Type: application/json

{"id":"provider-event-id","resultRef":"provider-result-id"}
```

Ingress verifies exact bytes and endpoint binding, then stores only event ID,
result reference, endpoint, and SHA-256 delivery hash. The 64 KiB limit is
enforced before parsing. Ingress cannot read evidence or change an account.

Run `npm run compliance:events` with the `money_compliance_worker` login. It
claims events with `FOR UPDATE SKIP LOCKED`, commits, and performs provider I/O
without holding a database transaction open:

```http
GET /v1/results/<url-encoded-resultRef>
Authorization: Bearer <provider API key>
Accept: application/json
```

```json
{
  "id": "provider-result-id",
  "subjectAccountId": "usr_...",
  "kind": "identity",
  "decision": "clear",
  "evidenceHash": "64 hex characters",
  "listVersion": "provider-list-version",
  "observedAt": "2026-07-20T12:00:00.000Z",
  "expiresAt": "2026-08-20T12:00:00.000Z",
  "normalized": { "verified": true }
}
```

Supported kinds are `identity`, `business`, `beneficial_owner`, `sanctions`,
`pep`, and `adverse_media`. Decisions are `clear`, `review`, `blocked`, or
`error`. The client requires HTTPS, refuses redirects, authenticates every
fetch, binds response ID to requested ID, caps responses at 256 KiB, and never
stores an error body. Permanent schema/PII failures dead-letter; transient
failures retry with bounded backoff. A blocked result opens a critical case and
freezes the subject family.

After provider I/O, the worker submits one bounded evidence set to the
database. `record_compliance_event_evidence_set` records every item, links each
row to its inbox event with an ordinal, and marks the claim complete in one
transaction. If any item is malformed or the process/database fails, the
entire set rolls back. The worker role cannot call the older free-standing
record/complete commands, which removes the crash window between evidence and
inbox completion.

Provider adapters must not invent `clear` from an incomplete or timed-out
check. Store raw documents only with the contracted identity provider under
the approved retention policy.

## Named operator console

Run the compliance desk on loopback port `4026` with the
`money_compliance_console` login:

```bash
npm run compliance:console
```

Bootstrap an operator through the offline admin boundary. The private key is
displayed once and belongs in the approved secrets manager:

```bash
npm run compliance:operator-setup -- \
  --name "Avery Analyst" --handle avery --role analyst \
  --review-reference HR-ACCESS-2026-07
```

Set `MONEY_COMPLIANCE_OPERATOR_ID` and `MONEY_COMPLIANCE_OPERATOR_KEY` only in
the trusted login environment, then run `npm run compliance:login`. It signs a
single-use request and prints a `/console#token=...` URL. Browser URL fragments
are not sent in HTTP access logs. The browser receives a random 30-minute
bearer session, never the signing key. Five concurrent sessions are allowed;
operator suspension revokes all of them.

The console is same-origin and dependency-free, with no external scripts,
fonts, cookies, or CORS. Its database credential has no table grants. Every
read and mutation supplies the hashed live operator session to a narrow
`SECURITY DEFINER` command.

| Action | Authority |
|---|---|
| Claim a case or append a non-PII note/evidence hash | Any active analyst |
| Restrict a subject with an open subject-bound case | Immediate; any active analyst |
| Recommend subject approval | Maker; any active analyst |
| Recommend terminal case disposition or restriction release | Maker; any active analyst |
| Recommend reviewed risk-limit changes | Maker; any active analyst/supervisor |
| Execute or reject a recommendation | Different supervisor or administrator |
| Register/suspend/close an operator | Offline compliance-admin boundary |

The old direct administrator grants for approval, release, terminal case
resolution, and limit changes are removed in v0.12. The checker locks the
pending request, revalidates current evidence/cases/restrictions, executes the
underlying command, marks the request executed, and appends operator audit
evidence in one transaction. Failed revalidation leaves the request pending;
it cannot partially activate or unfreeze a customer.

Reviewers must not copy customer PII or raw provider payloads into summaries,
notes, review references, or reasons. Use provider object references and
evidence hashes under the written case-management procedure.

## Risk limits and concurrency

Amounts are integer micro-dollars. Defaults are conservative launch ceilings,
not a substitute for a risk committee decision:

| Tier | Per transfer | Daily cross-user | Daily external | Daily payout | Rolling 30-day outflow |
|---|---:|---:|---:|---:|---:|
| Low | $25,000 | $100,000 | $50,000 | $100,000 | $500,000 |
| Standard | $10,000 | $25,000 | $10,000 | $25,000 | $100,000 |
| High | $1,000 | $2,500 | $1,000 | $2,500 | $10,000 |

Each subject/category/day bucket is created and locked in deterministic order.
The rolling calculation runs under the current-day `all_outflow` lock, so
concurrent agents owned by one customer cannot race past an aggregate limit.
Limit changes use the operator maker/checker queue and append a
`risk_limit_events` row with both reviewed references.

The rules are intentionally explainable: eligibility, counterparty screening,
per-transfer cap, category daily cap, and rolling 30-day cap. A future model
may create an alert, but it must not widen limits or authorize a transfer.

## Ongoing review and operations

Run `npm run compliance:reviews` with the `money_risk_worker` login. It expires
stale hosted sessions and counterparty screenings and turns approved subjects
with expired identity/sanctions evidence or an overdue review into a high case
plus whole-family restriction. Re-screening should arrive before expiry; the
sweep is the fail-closed backstop, not the scheduler.

Run `npm run compliance:ops` on port `4025` with read-only
`money_compliance_ops` and a separate bearer token. `GET /ops/compliance`
reports subject counts, evidence approaching expiry, dead result events,
failed/pending hosted inquiries, active named operators, pending checker
actions, open cases/restrictions, reviewed limits, and recent non-allow risk
decisions. It returns `503` when intervention is required. General operations
credentials cannot infer case or regulatory-report status.

Review workflow:

1. Identify the evidence, alert, subject, counterparty, and exact transfer or
   risk decision involved. Never copy raw provider PII into a case.
2. Claim the case and record every note with a review reference and reason.
3. Restrict first for sanctions, account takeover, material fraud, or uncertain
   disposition. Do not rely on an agent runtime to stop itself.
4. Resolve as `closed_no_action`, `blocked`, or `reported` only under the
   written escalation/filing procedure and two-person control.
5. Release only after cases are closed and evidence remains current. Release
   never happens as a side effect of receiving evidence.

## Process identities

| Role | Allowed | Explicitly not allowed |
|---|---|---|
| `money_app` | Submit non-PII profile, queue inquiry, decrypt/read own live URL | Provider credentials, evidence, cases, raw tables |
| `money_compliance_ingress` | Enqueue signed event/result reference | Read results or change accounts |
| `money_compliance_worker` | Claim events; append evidence/screenings | Approve/release, move money, read cases |
| `money_compliance_onboarding` | Claim profiles; create inquiry; store encrypted URL | Read URL, approve/release, inspect cases, move money |
| `money_risk_worker` | Sweep expiry; open cases; restrict subjects | Approve, release, close, or read raw tables |
| `money_compliance_admin` | Bootstrap/offboard operators; urgent case/restriction and counterparty administration | Direct approval/release/case resolution/limit change; journal writes |
| `money_compliance_console` | Session-gated case work and maker/checker commands | Table reads, unsigned actions, direct high-impact commands, journal writes |
| `money_compliance_ops` | Read compliance/risk evidence except URL ciphertext | Mutations or ordinary financial operations |

Each production login inherits exactly one role, never owns the schema, and
uses a separately rotatable credential. Apply `db/roles.sql` after migrations
and test effective grants before launch.

## Deployment order

1. Back up and apply migrations `0008`, `0009`, and `0010`. Existing users backfill as
   unverified and regulated movement fails closed. Exact historical retries
   retain their original result.
2. Apply `db/roles.sql`; provision distinct ingress, evidence-worker,
   onboarding-worker, risk-worker, compliance-admin, compliance-console, and
   compliance-ops logins.
3. Configure the pinned Persona API, two reviewed inquiry-template IDs, three
   reviewed report-template IDs, one-time-link origin, decision-only webhook
   filter, attribute blocklist, and overlapping webhook secrets. Test
   exact-body signatures and age limits, authenticated sparse inquiry/report
   refetch, account/template binding, pending reports, positive watchlist
   matches, provider-side idempotency, an untrusted link,
   duplicate/reordered decisions, and malformed evidence in the company's
   sandbox. Keep business activation disabled until the separate UBO
   verification workflow is complete.
4. Generate and escrow the hosted-URL keyring. Start ingress, evidence worker,
   onboarding worker, review worker, console, and compliance ops. Alert on
   process absence, dead events, failed inquiries, pending checker actions,
   open restrictions/cases, and the seven-day expiry horizon.
5. Provision at least two trained people with separate maker and checker
   credentials. Exercise login, suspension, case claim, emergency restriction,
   rejected self-approval, second-person execution, and session revocation.
6. Backfill and review existing customers and every external payout/x402
   counterparty needed for launch.
7. Reconcile treasury assets, restore external breakers through the treasury
   procedure, and release traffic gradually under reviewed limits.

The container/process topology, no-network preflight, image build, port
exposure, and per-service secret inventory are in `deploy/README.md`.

There is no down migration. Removing the perimeter while customer value exists
would silently broaden authority. Roll forward, or stop funding/payout/x402
breakers and restore from a tested backup under an incident plan.

## Non-code launch gates

Before real customer funds or public cross-owner transfers, obtain written
approval for at least:

- sponsor-bank/FBO structure, funds flow, account titling, safeguarding,
  reconciliation, reserves, returns, and loss allocation;
- money-transmission and other licensing analysis for every jurisdiction;
- risk-based CIP/CDD/KYC/KYB and beneficial-owner programs, customer risk
  profiles, ongoing monitoring, periodic review, records, and independent test;
- OFAC/sanctions screening at onboarding and relevant transaction points,
  including block/reject/report procedures suitable for instant payments;
- fraud, account takeover, complaints, disputes, investigations, escalation,
  SAR decision/filing/confidentiality, subpoenas, and law-enforcement response;
- privacy notices, provider DPAs, data mapping, retention/deletion, access
  controls, breach response, and automated-decision restrictions;
- trained named reviewers, dual control, on-call and incident runbooks, audit
  export, and board/risk-committee limit approval.

Primary program references include FinCEN's [CDD rule and current
requirements](https://www.fincen.gov/resources/statutes-and-regulations/cdd-final-rule),
the FFIEC [CIP](https://bsaaml.ffiec.gov/manual/AssessingComplianceWithBSARegulatoryRequirements/01)
and [CDD/ongoing-monitoring](https://bsaaml.ffiec.gov/manual/AssessingComplianceWithBSARegulatoryRequirements/02)
manual sections, FinCEN's [MSB suspicious-activity reporting
guidance](https://www.fincen.gov/money-services-business-msb-suspicious-activity-reporting),
and OFAC's [sanctions compliance
framework](https://ofac.treasury.gov/system/files/126/framework_ofac_cc.pdf) and
[instant-payment guidance](https://ofac.treasury.gov/system/files/126/instant_payment_systems_compliance_guidance_brochure.pdf).
