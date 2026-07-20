# Compliance and risk perimeter

This is the operating contract for migration `0008_compliance_risk.sql`.
The code supplies fail-closed controls and audit evidence. It does not itself
make the company licensed, satisfy a sponsor bank, file a SAR, or replace a
written BSA/AML, sanctions, fraud, privacy, and complaints program.

## What the boundary guarantees

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
  and an explicit reviewed action.
- Provider evidence, case actions, subject events, risk decisions, risk-limit
  changes, and risk-to-transfer links are append-only.
- Raw identity documents and identity attributes do not belong in this
  database. Both the provider client and a recursive database constraint reject
  normalized keys such as names, dates of birth, tax IDs, addresses, contact
  details, passports, licenses, documents, images, and selfies.

## Transfer matrix

| Operation | Required decision |
|---|---|
| Funding credit | Destination owner's subject is approved and current |
| Same-owner internal transfer | No compliance decision; mandate and balance rules still apply |
| Cross-owner agent payment | Source and destination owner subjects are approved and current |
| External x402 debit | Source subject is approved/current and canonical payee has a current clear screening |
| Payout reserve | Source subject is approved/current and linked bank destination has a current clear screening |
| Refund or external reversal | May credit a frozen account; cannot release it |

The journal has a final trigger as well as wrapper checks. A stale or alternate
caller cannot insert a regulated transfer without the exact allow decision in
the same transaction.

## Customer onboarding

The signed product API exposes:

- `GET /owner/compliance` — sanitized owner-visible state only.
- `POST /owner/compliance` — accepts `subjectType`, two-letter `countryCode`,
  `expectedSingleMicros`, and `expectedMonthlyMicros`. It never accepts PII.

Hosted identity-inquiry creation belongs in the deployment's provider
orchestration layer. Keep provider credentials and raw inquiry payloads out of
the product API. That service should return the provider-hosted URL to the
authenticated owner, send only the internal `usr_...` ID as metadata, and use
provider-side idempotency. The repository's generic provider boundary begins
at the signed result-reference webhook described below.

Approval is intentionally manual in v0.11. The `money_compliance_admin` login
uses `PostgresCompliance.approveSubject(...)` only after the evidence and case
review required by the written program. Customer-facing status never includes
provider references, evidence hashes, internal reasons, case details, or
regulatory-report status.

## Provider contract

Run public ingress with `npm run compliance:webhooks`. Its database login
inherits only `money_compliance_ingress`.

Webhook request:

```http
POST /webhooks/compliance
X-Compliance-Signature: <hex HMAC-SHA256 of the exact raw body>
X-Compliance-Endpoint-Id: <configured endpoint id>
Content-Type: application/json

{"id":"provider-event-id","resultRef":"provider-result-id"}
```

Ingress verifies the exact bytes and endpoint binding, then stores only the
event ID, result reference, endpoint, and SHA-256 delivery hash. The 64 KiB
limit is enforced before parsing. It cannot read evidence or change an account.

Run `npm run compliance:events` with the `money_compliance_worker` login. The
worker claims events with `FOR UPDATE SKIP LOCKED`, commits the claim, and then
performs provider I/O; no database transaction stays open across the network
call. It fetches:

```http
GET /v1/results/<url-encoded-resultRef>
Authorization: Bearer <provider API key>
Accept: application/json
```

Expected result:

```json
{
  "id": "provider-result-id",
  "subjectAccountId": "usr_...",
  "kind": "identity",
  "decision": "clear",
  "evidenceHash": "64 lowercase-or-uppercase hex characters",
  "listVersion": "provider-list-version",
  "observedAt": "2026-07-19T12:00:00.000Z",
  "expiresAt": "2026-08-19T12:00:00.000Z",
  "normalized": { "verified": true }
}
```

Supported kinds are `identity`, `business`, `beneficial_owner`, `sanctions`,
`pep`, and `adverse_media`. Decisions are `clear`, `review`, `blocked`, or
`error`. The client requires HTTPS, refuses redirects, authenticates every
fetch, binds the response ID to the requested ID, caps the response at 256
KiB, and never stores an error response body. Permanent schema or PII failures
go to the dead-letter state; transient provider failures retry with bounded
backoff. A blocked result opens a critical case and freezes the subject family.

Provider adapters must map their native API into this contract and must not
invent `clear` from an incomplete or timed-out check. Store raw documents only
with the contracted identity provider under the approved retention policy.

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
Only `money_compliance_admin` can call `configureRiskLimits(...)`; every change
requires a review reference and reason and appends a `risk_limit_events` row.

The current rules are intentionally explainable: eligibility, counterparty
screening, per-transfer cap, category daily cap, and rolling 30-day cap. A
future model may create an alert, but it must not directly widen limits or
authorize a transfer.

## Ongoing review and operations

Run `npm run compliance:reviews` with the `money_risk_worker` login. The worker
marks expired counterparty screenings as expired and turns approved subjects
with expired identity/sanctions evidence or an overdue review into a high
severity case plus whole-family restriction. Re-screening should arrive before
expiry; the sweep is the fail-closed backstop, not the screening scheduler.

Run `npm run compliance:ops` on port `4025` with the read-only
`money_compliance_ops` login and a separate `MONEY_COMPLIANCE_OPS_TOKEN`.
`GET /ops/compliance` reports subject counts, evidence approaching expiry,
dead events, open cases/restrictions, reviewed limits, and recent non-allow
decisions. It returns `503` when intervention is required. This service is
separate from general ledger operations so ordinary operators cannot infer
case or regulatory-report status.

Review workflow:

1. Identify the evidence, alert, subject, counterparty, and exact transfer or
   risk decision involved. Never copy raw provider PII into a case summary.
2. Open or claim the case under the approved case-management process. Record
   every action with a review reference and reason.
3. Restrict first when sanctions, account takeover, material fraud, or uncertain
   disposition requires it. Do not rely on an agent runtime to stop itself.
4. Resolve as `closed_no_action`, `blocked`, or `reported` only under the
   written escalation and filing procedure. Regulatory-report status is
   confidential and absent from customer/general-ops views.
5. Release a restriction only after cases are closed and evidence remains
   current. Release never happens as a side effect of receiving new evidence.

## Process identities

| Role | Allowed | Explicitly not allowed |
|---|---|---|
| `money_app` | Submit non-PII profile; read own sanitized state | Evidence, approval, cases, limits, raw tables |
| `money_compliance_ingress` | Enqueue signed event/result reference | Read results or change accounts |
| `money_compliance_worker` | Claim events; append provider evidence and screenings | Approve/release subjects, move money, read cases |
| `money_risk_worker` | Sweep expiry; open cases; restrict subjects | Approve, release, close, or read raw tables |
| `money_compliance_admin` | Reviewed approval/case/restriction/counterparty/limit commands | Direct journal writes |
| `money_compliance_ops` | Read compliance and risk evidence | Mutations or ordinary financial operations |

Each production login should inherit exactly one role, never own the schema,
and use a separately rotatable credential. Apply `db/roles.sql` after all
migrations and test the effective grants before launch.

## Deployment order

1. Back up and apply migration `0008`; existing users backfill as `unverified`.
   New regulated transfers fail closed immediately. Exact pre-migration retries
   still replay their original result.
2. Apply `db/roles.sql`; provision distinct ingress, provider-worker,
   risk-worker, compliance-admin, and compliance-ops logins.
3. Configure the provider webhook endpoint and secrets. Test raw-body signature
   verification, authenticated result fetch, subject-ID binding, replay, and a
   deliberately malformed event in a non-production environment.
4. Start ingress, event worker, review worker, and compliance ops. Alert on
   process absence, dead events, open restrictions, open cases, and seven-day
   expiry horizon.
5. Backfill and manually review existing customers and every external payout or
   x402 counterparty needed for launch.
6. Reconcile treasury assets, restore external breakers through the treasury
   procedure, and release traffic gradually under reviewed limits.

There is no down migration. Removing the perimeter while customer value exists
would silently broaden authority. Roll forward, or stop funding/payout/x402
breakers and restore from a tested backup under an incident plan.

## Non-code launch gates

Before real customer funds or public cross-owner transfers, obtain written
approval for at least:

- sponsor-bank/FBO structure, funds-flow diagram, account titling, safeguarding,
  reconciliation, reserves, returns, and loss allocation;
- money-transmission and other licensing analysis for every launch jurisdiction;
- a risk-based CIP/CDD/KYC/KYB and beneficial-owner program, customer risk
  profiles, ongoing monitoring, periodic review, records, and independent test;
- OFAC/sanctions screening at onboarding and relevant transaction points,
  including block/reject/report procedures suitable for instant payments;
- fraud, account takeover, complaints, disputes, investigations, escalation,
  SAR decision/filing/confidentiality, subpoenas, and law-enforcement response;
- privacy notices, provider DPAs, data mapping, retention/deletion, access
  controls, breach response, and restrictions on automated decisioning;
- trained named reviewers, dual control for high-impact actions, on-call and
  incident runbooks, audit export, and board/risk-committee limit approval.

Primary program references include FinCEN's [CDD rule and current
requirements](https://www.fincen.gov/resources/statutes-and-regulations/cdd-final-rule),
the FFIEC [CIP](https://bsaaml.ffiec.gov/manual/AssessingComplianceWithBSARegulatoryRequirements/01)
and [CDD/ongoing-monitoring](https://bsaaml.ffiec.gov/manual/AssessingComplianceWithBSARegulatoryRequirements/02)
manual sections, FinCEN's [MSB suspicious-activity reporting
guidance](https://www.fincen.gov/money-services-business-msb-suspicious-activity-reporting),
and OFAC's [sanctions compliance
framework](https://ofac.treasury.gov/system/files/126/framework_ofac_cc.pdf) and
[instant-payment guidance](https://ofac.treasury.gov/system/files/126/instant_payment_systems_compliance_guidance_brochure.pdf).
