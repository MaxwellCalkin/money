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

`money_private.post_transfer(...)` is the internal posting primitive. The
application role receives only account registration and owner allocation in
this milestone; raw agent payment stays ungranted until mandate evaluation is
inside the same transaction. Confirmed funding belongs to a separate treasury
role. The primitive reserves actor-scoped idempotency, verifies operation
authority, checks available funds, writes both journal entries, updates both
balances, creates independently hashed receipt evidence, and enqueues an
outbox event atomically. It never performs an HTTP or blockchain call while
holding locks.

Run `db/roles.sql` separately as an administrator. Production login roles
should inherit exactly one narrow role: `money_app`, `money_treasury`,
`money_worker`, or `money_ops`. They should never own the schema or receive
direct journal/balance write privileges; the application role cannot directly
read tenant financial tables either.
