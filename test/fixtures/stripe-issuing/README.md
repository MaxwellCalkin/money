# Stripe Issuing fixtures

Sandbox, no real funds; nothing here is a bank, card, or deposit account. Every
object in this directory was **recorded from Stripe's public documentation, not
from a live API call; verify against live test mode** before relying on any
field (spec section 3 lists the verification pass the founder runs with
`stripe listen`). CI never calls the Stripe sandbox: `test/card-stripe-issuing.test.ts`
serves these files through a stubbed `fetch`.

Items that MUST be re-verified when the founder records real test-mode traffic
and replaces these files:

- **`Stripe-Version: 2025-03-31.basil`** — the pinned constant
  (`ISSUER_API_VERSION` in `src/cards/issuer.ts`) is sent on every request and
  echoed by the authorization server. Unverified against the live sandbox.
- **Exact response shapes** — field lists, `request_history` entries,
  `merchant_data.network_id` presence, `pending_request` on test-helper
  authorizations, and the sign convention on `issuing_transaction.created`
  (`capture` recorded here as a **negative** cardholder amount; a positive
  capture is refused as unappliable evidence).
- **`expand[]=number&expand[]=cvc`** on `GET /v1/issuing/cards/{id}` — whether
  a restricted key may expand these fields (the client only allows reveal with
  the api-role secret key).
- **Restricted-key scopes for the worker** — read on `events`,
  `issuing_authorizations`, `issuing_transactions`, plus **write on
  `issuing_cards`**: the event worker's close drain (`drainIssuerCloses`) posts
  `status=canceled` with the worker credential.
- **Single-use** — per spec addendum 12 the client does **not** send
  `lifecycle_controls[cancel_after][payment_count]` (parameter unverified);
  single-use is enforced by our decline ladder plus the
  `spending_controls[spending_limits][0][interval]=per_authorization` limit
  that is sent.

Files:

| File | Serves | Notes |
|---|---|---|
| `card-created.json` | `POST /v1/issuing/cards` | virtual, active, $29.00 `per_authorization` limit, `metadata[agentmoney_card]`/`[agentmoney_agent]` |
| `card-revealed.json` | `GET /v1/issuing/cards/{id}?expand[]=number&expand[]=cvc` | Stripe's public test PAN `4242…4242`; never appears in any error path |
| `card-canceled.json` | `POST /v1/issuing/cards/{id}` `status=canceled` | |
| `authorization.json` | `GET /v1/issuing/authorizations/{id}` | closed, approved, `merchant_data` with `category_code`/`network_id`/`name`/`country` |
| `transaction-capture.json` | `GET /v1/issuing/transactions/{id}` | `type=capture`, amount `-2900` integer cents |
| `event-authorization-created.json` | `GET /v1/events/{id}` | `issuing_authorization.created` envelope |
| `error-rate-limited.json` | any endpoint, HTTP 429 | retryable |
| `error-server.json` | any endpoint, HTTP 5xx | retryable |
