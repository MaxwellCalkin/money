# The card rail (reserved cards)

v0.14 adds migration `0012` and `src/cards/*`: a virtual-card rail shaped like
the x402 and treasury rails. A human funds an owner account and grants a
mandate; an agent asks for a **reserved card** bound to that mandate; issuing
the card reserves its full cap from the agent's funds (one `card_reserve`
transfer, one receipt, at most one exact-tuple owner approval); a separate,
minimally-privileged authorization process answers the issuer's synchronous
`issuing_authorization.request` by locking one `cards` row and running a fixed
decline ladder; clearings, voids and refunds arrive through a durable inbox
whose worker re-fetches every event from the issuer before any ledger command.
The card number never enters model context: MCP tools return the last4 plus, in
`token` mode only, a runtime-only checkout token (reveal mode defaults to
`none`).

The cap is never a balance agentmoney holds. In sandbox nothing is money; in a
live shape the money sits with the issuer's licensed program and the cap is a
spend mandate our kernel enforces over it. "Issuing a card reserves its full
cap from the mandate; the unspent remainder returns to the agent's funds when
the card closes; mandate authority is never restored."

The JSONL showcase path (`npm run api`, `src/core/*`) has **no card support**;
the rail exists only on the Postgres kernel and its signed API
(`npm run api:db`).

## Lifecycle

Card states are `prepared`, `approval_required`, `cancelled`, `pending`,
`confirmed`, `reversed`; each authorization is `declined`, `pending`,
`confirmed`, or `reversed`. Transitions are trigger-protected (immutable card
terms, write-once provider material, no deletes on any card table).

```text
POST /cards (agent-signed, idempotency-keyed)
       |
       v
prepare: mandate ladder (no_mandate, mandate_expired, payee_not_allowed,
         budget, daily_cap) against the CAP, in the database
       |
       +-------------------------+
       |                         |
       v                         v
   prepared               approval_required
       |                         |
       |            owner approves the exact tuple
       |            (agent, external:card, cap, "card:<hint>")
       +------------+------------+
                    |
                    v
   issuer creates the virtual card OUTSIDE the transaction
   (Idempotency-Key = card id; a retry can never mint a second card)
                    |
                    v
   activate: atomic recheck + card_reserve posts the FULL CAP
   from the agent's funds to external:card, with receipt + risk decision
                    |
                    v
                 pending  <---- authorizations hold/settle against the reserve
                    |
          +---------+----------+
          |                    |
   settled anything       nothing settled
   (close/expiry:         (close/expiry:
    remainder released)    full cap released)
          |                    |
          v                    v
      confirmed             reversed
```

A denial after the issuer create closes the issuer card best-effort; the
durable path is `list_cards_awaiting_issuer_close`, which the event worker
drains until the issuer confirms the cancel. Revoking the mandate cancels
`prepared`/`approval_required` cards immediately and sets
`close_requested_at` on `pending` ones; the reserve is released by
`finalize_card` once no authorization holds remain.

## Agent HTTP flow

All `/cards` routes require the agent's Ed25519 request signature and answer
with `cache-control: no-store`.

1. The agent requests a card:

```json
POST /cards
{
  "idempotencyKey": "task-123-shop-card",
  "capUsd": 29,
  "merchantHint": "mock-shop.example",
  "singleUse": true,
  "expiresInSeconds": 3600,
  "mccAllowlist": ["5734"]
}
```

(`capMicros` is accepted instead of `capUsd`; the cap is bounded at $10,000,
the lifetime at 60 seconds to 30 days, and `mccAllowlist` is optional, 1-32
four-digit codes.)

2. The response is one of:
   - `200 {status:"active", card:{id, last4, expMonth, expYear, capMicros, merchantHint, expiresAt, state}, receiptId, checkoutToken?}` —
     the reserve posted; `checkoutToken` appears only in `token` reveal mode
     and only on a fresh (non-replayed) activation;
   - `202 {status:"approval_required", cardId, approval, note}` — the cap is
     above the mandate's escalation line; the owner inbox shows
     "Agent X wants a card for up to $29.00 at mock-shop.example, expires in
     60 min";
   - `402 {status:"denied", code, reason}` — a stable policy denial
     (`per_tx_cap`, `new_payee_cap`, `budget`, `daily_cap`,
     `payee_not_allowed`, `compliance_required`, ...);
   - `409 idempotency_conflict` — the same key with different card terms;
   - `503 card_bridge_unavailable` (no issuer adapter configured) or
     `503 treasury_unavailable` (card spend paused by the operator).
3. `POST /cards/:id/resume` recovers after a crash: a `prepared` card retries
   activation, an `approval_required` card returns its approval status, and a
   `pending` card returns its state (plus a fresh checkout token in `token`
   mode, within the bounded reveal budget).
4. `GET /cards/:id` returns the card and its last 20 authorizations.
   `POST /cards/:id/close` requests close; the unspent remainder returns to
   the agent's funds once no holds remain.
5. `POST /cards/:id/reveal {checkoutToken}` exists only in `token` mode (`404`
   otherwise) — see PAN custody below.

Owners see and control the same cards: `GET /owner/cards`,
`POST /owner/cards/:id/close`, and the standard
`/owner/approvals/:id/approve|reject` routes, which detect card approvals and
create/cancel the issuer card around the atomic
`resolve_card_approval` recheck-and-reserve.

The MCP wallet exposes exactly three card tools — `money_card_create`,
`money_card_status`, `money_card_close` — over these routes. There is no
reveal tool and no checkout tool.

## Authorization decision order

The ingress (`src/cards/authorization-server.ts`, its own process and the
`money_card_ingress` database role) answers
`POST /webhooks/:provider/authorization` inside the issuer's synchronous
deadline with an internal decision budget of 1,500 ms. Before any database
call: raw-body size cap, timestamped HMAC verification (`t=<unix>,v1=<hex>`
over `${t}.${rawBody}`, 1-4 rotating secrets, 300 s default tolerance,
`timingSafeEqual`), then a fail-closed parse of the
`issuing_authorization.request` shape — any violation answers
`approved:false` with decline code `invalid_request` and no row. A forged or
stale signature is `401` with no row at all.

`decide_card_authorization` then locks exactly one `cards` row by
`(provider, provider_card_ref)`, reads the mandate with `for key share`,
uses integer arithmetic only, and never touches accounts, balances, or
transfers. Replays by `(provider, provider_event_id)` return the stored
decision. The payee key is computed in SQL —
`card:<mcc>:<network_id | descriptor-slug | unknown>` via
`card_policy_payee` — so TypeScript can never choose the key a decision is
judged by. The ladder, in fixed order:

1. `card_not_active` — no such card, not `pending`, or close requested
2. `card_expired`
3. `treasury_breaker` — `card_spend_enabled` is false (operator pause or a
   tripped treasury breaker)
4. `mandate_revoked`
5. `mandate_expired`
6. `duplicate_authorization` — this authorization ref already has a
   non-declined row (incremental authorizations are declined in v0.14)
7. `mcc_not_allowed` — the card's `mccAllowlist` excludes the merchant MCC
8. `payee_not_allowed` — `card_payee_allowed(mandate.payee_allowlist,
   real_key, hint)`: exact match, `card:<mcc>:*`, `card:*:<merchant_key>`,
   or `card:hint:<hint>` patterns
9. `merchant_lock` — the card is already locked to a different real merchant
   key (first approved purchase locks it)
10. `single_use` — a single-use card already has a non-verification hold or
    clearing (skipped for verification authorizations)
11. `new_payee_cap` — the real merchant key is unseen on the mandate and the
    amount exceeds the new-payee throttle (skipped for verification
    authorizations)
12. `card_cap` — `held + settled + amount > cap` (the invariant
    `held + settled <= cap` also holds as a table constraint)

An approval inserts a `pending` hold (`reverse_after = now + auth TTL`),
adds the amount to `held_micros`, locks the card to the merchant key, and
marks the key seen on the mandate. A **verification authorization**
(<= $1) proves the card exists, not that the owner spends there: it neither
locks the card nor marks the merchant seen nor consumes single-use, and a
declined authorization never marks a payee seen. Any exception or a decision
past the internal deadline answers `approved:false` with code `system`. The
webhook timestamp is judged by the ingress process clock; the database clock
stays authoritative for card and mandate expiry, so a stale-but-valid event
cannot approve an expired card.

The new-payee throttle therefore binds twice: on the `card:hint:<host>` key
at reserve time and on the SQL-computed real merchant key at authorization
time.

## What the worker proves

`POST /webhooks/:provider/events` only verifies the signature and enqueues an
envelope (`202`); those bytes never move money. The event worker
(`src/cards/event-worker.ts`, role `money_card_worker`, read-only issuer
credential) claims inbox rows with `SKIP LOCKED` leases and, per claim,
re-fetches the event from the issuer, re-fetches the object it points at
(authorization or transaction), normalizes both fail-closed, runs exactly one
database command, then acknowledges the claim:

- **clearing** (`issuing_transaction.created`, type `capture`):
  `pending -> confirmed`; `held -= amount`, `settled += settled_micros`;
  the cleared amount must stay within the authorized amount plus
  `MONEY_CARD_OVERCAPTURE_BPS` (default 0) and within the card's remaining
  reserve, else it fails as unapplicable evidence; a single-use card gets
  `close_requested_at` and finalizes inline once no holds remain;
- **void** (`issuing_authorization.updated`, status `reversed`):
  `pending -> reversed`, `held -= amount`;
- **refund** (type `refund`): the authorization must be `confirmed`;
  cumulative refunds are bounded by its settled amount; the credit posts as a
  `card_refund` transfer back to the agent's funds with its own receipt;
  `mandates.spent_micros` is untouched; replays dedupe on the provider
  refund ref;
- **authorization_created** with `approved:true` and no matching agentmoney
  `pending` decision (or a different amount) **trips the treasury breaker** —
  the fail-closed proof that the issuer-side timeout default is not
  "approve"; with `approved:false` against our `pending` hold, the hold is
  voided (issuer-side timeout/decline); `approved:false` against a
  `confirmed` clearing also trips the breaker;
- **card_closed** records the issuer-side cancellation.

Out-of-order arrivals (`P0002`, e.g. a clearing before its authorization row)
retry without dead-lettering; evidence that can never apply dead-letters
immediately; and any card event dead-letter (including the 25-attempt cap)
trips the treasury breaker. Dead events are resolved only through the
append-only reviewed `resolve_card_provider_event` command. The worker also
drains issuer-side closes for cards whose ledger state is already terminal.

`ledger_health()` recomputes the card clause on every check: every
`pending|confirmed|reversed` card has a matching `card_reserve` transfer with
the `externalPayee` receipt envelope, terminal cards with a remainder have
their `card_release`, `held` equals the sum of pending holds, and `settled`
equals the sum of confirmed clearings.

## PAN custody (`none` | `token`; `pan` deferred)

`MONEY_CARD_REVEAL_MODE` has exactly two values:

- **`none`** (default, hosted-beta setting): no reveal surface exists at all.
  Card creation returns no token and `POST /cards/:id/reveal` is `404`.
- **`token`**: activation returns a single-use **checkout token** (32 random
  bytes, HMAC-hashed at rest with `MONEY_CARD_REVEAL_TOKEN_KEY`, 10-minute
  TTL, at most 3 reveals per card, bound in the kernel to both the issuing
  agent and the card id — a mismatch fails closed *before* the token is
  consumed, so a mistaken card id never burns a bounded reveal).

There is deliberately no `pan` mode and no MCP reveal tool.

**Host-side fill contract:** in `token` mode the model hands the
`checkoutToken` to the host runtime (the orchestrator, never the model
itself), which redeems it once via `POST /cards/:id/reveal {checkoutToken}`
with the agent's signature and fills the merchant's payment form outside
model context. The PAN is returned exactly once with `cache-control:
no-store`, is never stored or logged, and every reveal emits an
owner-visible `card.revealed` event. A failed issuer reveal returns a
deliberately detail-free error so no response body can carry card material.
Even the issuer-object parsers strip `number`/`cvc` fields before anything
downstream can see them.

## Reserved-card accounting

Issuing a card reserves its **full cap** from the agent's funds: one
`card_reserve` transfer from the agent to the `external:card` boundary
account, one hash-chained receipt whose evidence envelope carries the
`card:hint:<host>` payee, one atomic risk decision, and
`mandates.spent_micros += cap`. Authorizations then hold and settle inside
that reserve without touching the ledger; only three operations post
journal rows: `card_reserve` (issue), `card_release` (the unspent
`cap - settled` back to the agent on close/expiry), and `card_refund`
(issuer-evidenced refunds). Release and refund credit the agent's funds but
**never restore mandate authority** — `spent_micros` is monotone, exactly as
x402 reversals and marketplace refunds behave, so cooperating merchants
cannot recycle an agent's spending envelope.

## Compliance counterparty policy

`card_reserve` is a regulated external outflow: `evaluate_transfer_risk`
requires an approved, unrestricted source subject **and** a cleared
counterparty row whose `canonical_ref_hash` is the SHA-256 of the card's
`card:hint:<host>` policy payee, and `assert_transfer_risk_decision` refuses
any `card_reserve` journal row without its atomic risk decision. Absent
either, the reserve **fails closed** with `compliance_required` — there is no
auto-clear, because counterparty screening rows are evidence objects
(evidence hash, list version, screened-at, expiry) and fabricating a `clear`
would falsify the compliance evidence chain.

Operations clears a merchant hint explicitly:
`registerCounterparty({kind: "merchant", canonicalRef: "card:hint:<host>",
...})` followed by `recordCounterpartyScreening({state: "clear", ...})`
under the compliance-admin role (tests and the demo use
`clearCounterpartyFixture(db, "card:hint:mock-shop.example", "merchant")`).
**Follow-up #1:** merchant-hint registration as a risk-worker policy with
real screening evidence — never a fake `clear` — is deliberately not built
in v0.14.

## Deployment contract

Two new processes join the topology, each with its own database login and
credential file; `db/roles.sql` creates `money_card_ingress` (execute on
exactly `decide_card_authorization` and `enqueue_card_provider_event`) and
`money_card_worker` (settle/void/refund/record/claim/complete/fail,
awaiting-close/mark-closed, and `trip_treasury_breaker`). Neither can
prepare, activate, or post a transfer; `money_app` can neither decide nor
settle. `npm run deploy:preflight -- card-authorization|card-events` and the
16-service `npm run verify:deployment` enforce the split.

| Service | Variable | Meaning |
|---|---|---|
| `api` (`npm run api:db`) | `MONEY_CARD_PROVIDER` | `stripe-issuing` or `mock`; unset disables `/cards` (503). `mock` is refused in production |
| | `MONEY_CARD_ISSUER_BASE_URL` | HTTPS issuer origin (production preflight) |
| | `MONEY_CARD_ISSUER_API_KEY` | create/close/reveal credential (16+ chars); held ONLY by the API |
| | `MONEY_CARD_STRIPE_CARDHOLDER_ID` | pre-created Issuing cardholder (stripe-issuing only) |
| | `MONEY_CARD_REVEAL_MODE` | `none` (default) or `token` |
| | `MONEY_CARD_REVEAL_TOKEN_KEY` | 32+ chars, required in `token` mode; hashes checkout tokens |
| | `MONEY_CARD_AUTH_TTL_SECONDS` | hold expiry, 60..2,592,000 (default 604,800) |
| | forbidden | `MONEY_CARD_WEBHOOK_SECRETS`, `MONEY_CARD_EVENT_API_KEY`, both card database URLs |
| `card-authorization` (`npm run cards:authorization`, :4027) | `MONEY_CARD_INGRESS_DATABASE_URL` | login inheriting `money_card_ingress` |
| | `MONEY_CARD_PROVIDER` | provider name in the webhook path |
| | `MONEY_CARD_WEBHOOK_SECRETS` | JSON array of 1-4 rotating secrets, each 24+ chars |
| | `MONEY_CARD_WEBHOOK_ENDPOINT_ID` | the issuer webhook endpoint identity |
| | `MONEY_CARD_WEBHOOK_TOLERANCE_SECONDS` | 30..600 (default 300) |
| | `MONEY_CARD_AUTH_TTL_SECONDS` | as above |
| | `CARD_AUTHORIZATION_PORT` | listen port (default 4027) |
| | forbidden | `MONEY_CARD_ISSUER_API_KEY`, `MONEY_CARD_EVENT_API_KEY`, `DATABASE_URL` |
| `card-events` (`npm run cards:events`) | `MONEY_CARD_WORKER_DATABASE_URL` | login inheriting `money_card_worker` |
| | `MONEY_CARD_PROVIDER` | issuer adapter selection |
| | `MONEY_CARD_EVENT_API_KEY` | read-only issuer event/object key (16+ chars) |
| | `MONEY_CARD_ISSUER_BASE_URL` | HTTPS issuer origin (production preflight) |
| | `MONEY_CARD_OVERCAPTURE_BPS` | clearing tolerance, 0..2,500 (default 0) |
| | `MONEY_CARD_EVENT_INTERVAL_MS`, `MONEY_CARD_CLOSE_DRAIN_INTERVAL_MS` | worker pacing |
| | forbidden | `MONEY_CARD_WEBHOOK_SECRETS`, `MONEY_CARD_ISSUER_API_KEY`, `DATABASE_URL` |

The operator switch is separate from configuration: card spend installs
**disabled** and is enabled explicitly with
`npm run treasury:setup -- card-spend enable --reason "<review>"` under the
treasury-admin role. Tripping any treasury breaker clears the flag;
`restore-controls` deliberately leaves it false so the operator re-enables
card spend as its own reviewed decision.

## Stripe test-mode setup

The mock issuer speaks the Stripe Issuing wire shape, so switching to test
mode is configuration. Founder-side steps (also in
`docs/marketing/strategy/stripe-issuing-apply.md`, with the unverified
details marked):

1. In the Stripe Dashboard, enable **Issuing** in test mode and create one
   test cardholder; record its cardholder id as
   `MONEY_CARD_STRIPE_CARDHOLDER_ID`.
2. Set the real-time authorization **timeout default to decline** (confirm in
   the Dashboard — our worker independently trips the breaker if an approval
   ever arrives without our decision, so this is tested, not assumed).
3. Create a webhook endpoint subscribed to `issuing_authorization.request`,
   `issuing_authorization.created`, `issuing_authorization.updated`,
   `issuing_transaction.created`, and `issuing_card.updated`.
4. Forward test traffic locally:

```bash
stripe listen --forward-to localhost:4027/webhooks/stripe-issuing/authorization
# and a second listener (or endpoint) for the async events route:
stripe listen --forward-to localhost:4027/webhooks/stripe-issuing/events
```

5. Environment (values from the Dashboard; never in the repo or chat):

```text
# api
MONEY_CARD_PROVIDER=stripe-issuing
MONEY_CARD_ISSUER_BASE_URL=https://api.stripe.com
MONEY_CARD_ISSUER_API_KEY=sk_test_...
MONEY_CARD_STRIPE_CARDHOLDER_ID=ich_...
MONEY_CARD_REVEAL_MODE=none
# card-authorization
MONEY_CARD_WEBHOOK_SECRETS=["whsec_..."]
MONEY_CARD_WEBHOOK_ENDPOINT_ID=we_...
# card-events
MONEY_CARD_EVENT_API_KEY=rk_test_...   # restricted read key: events, issuing
```

The adapter (`src/cards/stripe-issuing.ts`) pins `Stripe-Version`
`2025-03-31.basil`, creates virtual cards with a `per_authorization`
spending limit equal to the cap and `Idempotency-Key = card id`, cancels
with `status=canceled`, and reveals via `expand[]=number&expand[]=cvc` (api
role only, response never quoted into errors). It deliberately does **not**
send `lifecycle_controls[cancel_after][payment_count]` — the parameter is
unverified — so single-use is enforced by our decline ladder plus the
per-authorization limit. Several wire details (exact `Stripe-Version`
acceptance, signature header on test-helper authorizations, the capture sign
convention, restricted-key scopes, `expand` permissions with a restricted
key) are recorded in `test/fixtures/stripe-issuing/` from public
documentation and must be re-verified against the live sandbox before any
go-live; the fixtures README and spec section 3 list them.

## Release boundary

This is a working rail against a mock issuer plus a fixtures-tested Stripe
adapter, not permission to spend anyone's money. Everything in this document
runs in sandbox: **sandbox, no real funds; nothing here is a bank, card, or
deposit account.** A live card program still requires at least:

- a Stripe (or successor issuer) account and live Issuing approval, with the
  commercial-use boundary respected: standard Issuing programs are
  commercial-only, and no flow may exist in which a stranger pays agentmoney
  to fund a cap on agentmoney's own cards;
- a US business entity, and the platform track (per-owner connected
  accounts) before any customer funds a cap;
- the counterparty screening program behind the fail-closed
  `card:hint:<host>` policy above, operated with real evidence;
- issuer-side card inventory reconciliation (unknown issuer cards alarm and
  trip the breaker) — not built in v0.14 and recorded as residual risk in
  `docs/THREAT_MODEL.md`;
- the release gates in `docs/RELEASES.md` for the exact commit, including
  the live-Postgres role matrix and the no-PAN regression over every
  captured body and log line.

Until then, use the mock issuer or Stripe test mode. Do not infer readiness
for real card spend from green tests.
