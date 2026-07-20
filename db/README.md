# Production database

`migrations/` contains ordered, checksum-locked Postgres migrations. Run them
with `npm run db:migrate` against `DATABASE_URL`; use a PgBouncer transaction
pool in deployed environments.

The ledger has two representations, committed in one transaction:

- `money.ledger_entries` is the immutable source of truth. Every transfer has
  one negative and one positive entry in the same asset; a deferred database
  constraint rejects an incomplete or non-zero-sum journal.
- `money.balances` is the fast authorization cache. Account rows and balance
  rows are locked in lexical account-id order before mutation, preventing
  opposite-direction transfer deadlocks.

`money_private.post_transfer(...)` is the internal posting primitive. Raw
agent payment remains ungranted to the application role. Instead, the role can
call `request_agent_payment(...)`, which evaluates the active mandate and then
either posts autonomously, creates a durable owner approval, or records a
stable denial. The decision, budget and daily counters, seen-payee state,
authorization evidence, journal entries, receipt, and outbox events commit in
one transaction. `resolve_approval(...)` settles only the exact stored tuple
the owner reviewed. Confirmed funding belongs to the isolated
`money_treasury_worker` role.

The primitive beneath those policy commands reserves actor-scoped
idempotency, verifies operation authority, checks available funds, writes both
journal entries, updates both balances, creates independently hashed receipt
evidence, and enqueues an outbox event atomically. It never performs an HTTP
or blockchain call while holding locks.

Migration `0003_control_plane.sql` adds the signed product boundary: accepted
Ed25519 request envelopes reserve actor-scoped nonces in Postgres, public-key
identity onboarding is retry-safe, key rotation is owner-bound, browser
session tokens are stored only as hashes, and all balance/activity/receipt
views are tenant-scoped security-definer functions. This makes authentication
and the private control plane safe across multiple API replicas; run it with
`npm run api:db`.

Migration `0004_marketplace.sql` moves the two-sided service economy into the
same transactional boundary. Providers publish immutable, retry-safe service
terms and can deactivate listings; sellers issue registry-priced challenges;
one agent can claim and pay each challenge; approval expiry is shortened to
the offer expiry; approved settlement binds back to the challenge in the same
transaction; and redemption is single-use. Provider refunds are linked to the
original receipt, serialized on that receipt, cumulatively capped at the
purchase amount, and never restore mandate counters. The migration preserves
the pre-v0.7 request-hash and receipt-hash shape for non-refund transfers, so
in-flight retries and historical reconciliation remain valid during a live
upgrade.

Migration `0005_external_settlement.sql` moves x402 outflow into the same
transactional boundary. It binds policy to canonical host plus destination,
stores payment authorizations as application-encrypted ciphertext, atomically
creates either an exact owner approval or a pending debit, and permits only a
verified confirmation to make that debit final. A separate least-privilege
worker uses `FOR UPDATE SKIP LOCKED` to reverse expired pending debits. The
confirmation and reversal functions lock the same lifecycle row, so only one
can win. Reversals restore the agent balance but deliberately do not restore
mandate counters. Historical non-external request and receipt hashes remain
byte-for-byte compatible across the v0.7 to v0.8 upgrade.

Migration `0006_x402_v2_activation.sql` adds the production-oriented x402 v2
boundary. Policy first creates an unsigned `prepared` intent (or an unsigned
owner approval); the HSM signs only immediately before a second atomic policy
check and debit. The migration stores the normalized non-economic signing
context needed to reproduce the seller's exact offer after a restart, pins the
authorization to its mandate and protocol version, adds rotatable ciphertext
key IDs, and keeps historical v0.8 retries byte-for-byte compatible. Pending
and confirmed authorization ciphertext can be enumerated and replaced only
through narrow key-rotation functions; the plaintext hash and economic tuple
cannot change.

Migration `0007_treasury.sql` adds the external asset perimeter. A webhook
identity can enqueue only a signed provider event envelope. A separate
treasury worker re-fetches Column's event and ACH object before applying a
settled funding credit, exact funding return, or payout transition. Returns
may overdraw a user only through this evidence-bound command; the exact
exposure is tracked and the owner's active user/agent/provider family is
frozen until recovery plus explicit review. Payout requests atomically reserve
funds at `external:payout`; workers claim with `FOR UPDATE SKIP LOCKED`, commit,
then call the provider. Definitive rejection reverses once, while ambiguous
outcomes retain the reserve, enter manual review, and open all spend breakers.
Reviewed resolutions and every breaker/configuration transition are retained
as append-only operational evidence; restoring controls is a separate admin
action and never happens as a side effect of resolving a payout.
Fresh bank and six-decimal stablecoin observations are reconciled against
external-boundary journal balances and uncertain in-flight outflows.

Migration `0008_compliance_risk.sql` adds the customer and counterparty risk
perimeter. Every user account receives a compliance subject; provider results
are append-only hashes plus bounded normalized non-PII facts. Approval requires
current identity/business and sanctions evidence (plus beneficial-owner
evidence for businesses). Restricted subjects freeze their whole active
user/agent/provider family, while evidence-bound refunds and reversals can
still restore money without silently unfreezing it. Funding, cross-owner pay,
x402 debit, and payout reserve evaluate compliance and velocity inside the
same transaction as posting. An allow decision is bound to the exact request
hash and linked one-to-one to the resulting transfer; stale callers cannot
bypass the wrapper because a journal trigger checks the transaction-local
decision. Daily buckets lock in deterministic order, and event/review workers
claim bounded batches with `FOR UPDATE SKIP LOCKED`.

`money_private.post_transfer_kernel(...)` is the generalized posting kernel
under the current schema. It is not granted to the application role. The old
`post_transfer(...)` signature remains a compatibility wrapper; application
traffic receives only narrow marketplace commands such as
`request_challenge_payment(...)` and `issue_refund(...)`.

Run `db/roles.sql` separately as an administrator. Production login roles
should inherit exactly one narrow role: `money_app`, `money_treasury`,
`money_treasury_worker`, `money_treasury_ingress`, `money_payout_worker`, `money_reconciler`,
`money_worker`, `money_key_rotation`, `money_ops`, `money_compliance_admin`,
`money_compliance_worker`, `money_compliance_ingress`, `money_risk_worker`, or
`money_compliance_ops`. They should never own the schema or receive
direct journal/balance write privileges; the application role cannot directly
read tenant financial tables either. Tenant-scoped mandate and approval reads
also go through reviewed functions, so the role can power owner and agent
views without receiving unrestricted table access.

See `docs/TREASURY.md` and `docs/COMPLIANCE.md` for process isolation,
provider evidence, deployment, reconciliation, incident handling, and
non-code launch requirements.
