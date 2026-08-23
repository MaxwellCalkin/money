# Stripe Issuing readiness kit (founder pastes; agent never sees keys)

Prepared 2026-08-23 for v0.14. Two parts: (A) the 20-minute test-mode setup
that unlocks recording real `issuing_authorization.request` traffic against
our authorization server, and (B) the application narrative for
stripe.com/contact/embedded-finance ("Cards for your platform / Issuing for
agents") — the only lawful path to customers' funds and consumer use.

Everything marked **UNVERIFIED** is taken from public documentation or panel
research and was not confirmed against the live product this session; confirm
each in the Dashboard while doing the steps and correct this file.

## A. Test-mode setup (P0, $0, ~20 minutes)

1. **Create a Stripe account** (sole proprietor is enough for test mode).
   Enter nothing the agent can see; keys stay in local env files.
2. **Enable Issuing in test mode.** Dashboard -> search "Issuing" -> enable
   the test-mode program (self-serve, no sales contact needed for test mode).
3. **Create one test cardholder** (Issuing -> Cardholders -> New). Type
   `individual` is fine in test mode. Record the cardholder id — it becomes
   `MONEY_CARD_STRIPE_CARDHOLDER_ID`. All agent cards are issued under this
   one cardholder until the platform track exists.
4. **Set the real-time authorization timeout default to DECLINE.**
   Issuing settings -> real-time authorizations. **UNVERIFIED:** that this
   default is Dashboard-configurable and that a timeout then produces
   `request_history.reason=webhook_timeout` with `approved=false`. Our event
   worker independently trips the treasury breaker if any approval arrives
   without our decision, so the system does not depend on this being right —
   but confirm and record it.
5. **Create a webhook endpoint** (Developers -> Webhooks) subscribed to:
   - `issuing_authorization.request` (the synchronous decision)
   - `issuing_authorization.created`, `issuing_authorization.updated`
   - `issuing_transaction.created`
   - `issuing_card.updated`
   Record the endpoint id (`we_...`) and signing secret (`whsec_...`).
6. **Create a restricted key for the event worker** (Developers -> API keys ->
   Create restricted key): read access to Events, Issuing Authorizations,
   Issuing Transactions, and write access to Issuing Cards (the worker drains
   card cancels). **UNVERIFIED:** exact scope names and whether these scopes
   suffice for `GET /v1/events/{id}`; adjust after the first 403.
   A second question to answer while there: whether
   `expand[]=number&expand[]=cvc` on `GET /v1/issuing/cards/{id}` is
   permitted with a restricted key, or requires the full secret key (the API
   process uses the secret key for reveal either way; reveal mode stays
   `none` in the hosted beta).
7. **Forward test traffic** to the local authorization server:

```bash
stripe listen --forward-to localhost:4027/webhooks/stripe-issuing/authorization
# separate terminal, async events:
stripe listen --forward-to localhost:4027/webhooks/stripe-issuing/events
```

8. **Environment** (fill locally; never into chat or the repo):

```text
# api process
MONEY_CARD_PROVIDER=stripe-issuing
MONEY_CARD_ISSUER_BASE_URL=https://api.stripe.com
MONEY_CARD_ISSUER_API_KEY=sk_test_...
MONEY_CARD_STRIPE_CARDHOLDER_ID=<cardholder id from step 3>
MONEY_CARD_REVEAL_MODE=none

# card-authorization process
MONEY_CARD_INGRESS_DATABASE_URL=<money_card_ingress login>
MONEY_CARD_PROVIDER=stripe-issuing
MONEY_CARD_WEBHOOK_SECRETS=["whsec_..."]
MONEY_CARD_WEBHOOK_ENDPOINT_ID=we_...

# card-events process
MONEY_CARD_WORKER_DATABASE_URL=<money_card_worker login>
MONEY_CARD_PROVIDER=stripe-issuing
MONEY_CARD_EVENT_API_KEY=rk_test_...
MONEY_CARD_ISSUER_BASE_URL=https://api.stripe.com
```

9. **What this unlocks:** recording the real
   `issuing_authorization.request` decision loop and the fixture set in
   `test/fixtures/stripe-issuing/` — including the wire details the adapter
   currently takes from public docs (**UNVERIFIED** until recorded): the
   `Stripe-Version` value (`2025-03-31.basil`) accepted on the webhook
   response and API pin; the `Stripe-Signature` header format and 300 s
   tolerance on `issuing_authorization.request`; `pending_request.amount`
   and `merchant_data.network_id` presence on test-helper authorizations;
   whether webhook-reply `metadata` must be string-valued; the
   `issuing_transaction.created` sign convention for captures vs refunds;
   and whether `lifecycle_controls[cancel_after][payment_count]` exists as a
   create parameter (the adapter deliberately does not send it — single-use
   is enforced by our decline ladder plus the `per_authorization` limit).
   Also rehearse cutover: test-mode cardholder/card identifiers will not
   survive go-live, and they live in our ledger's provider columns.

## B. Application narrative — "Cards for your platform / Issuing for agents"

Submit via stripe.com/contact/embedded-finance (P1, ~15 minutes, weeks of
latency). Paste-adapt:

> **What we're building.** agentmoney is a policy plane for AI-agent spending.
> A business owner funds an account and signs a spend mandate ("up to $100,
> per-purchase cap $40, ask me above $60, new merchants throttled to $15");
> their agent then requests a single-merchant virtual card whose cap is
> reserved from that mandate up front — a **reserved card**. Our
> authorization webhook answers every `issuing_authorization.request` in
> real time against the mandate: merchant category, merchant allowlist,
> merchant lock, single-use, first-merchant throttle, cap. The card number
> never enters the AI model's context.
>
> **Commercial use.** Today the program is our own entity's commercial agent
> spend (APIs, data, compute) under standard Issuing, demonstrated to
> customers in sandbox only. We are applying for the platform track so each
> customer becomes a connected account funding its own Issuing balance from
> its own bank — agentmoney never receives, pools, nets, or pays out user
> funds, and no consumer use occurs before the consumer track is approved.
>
> **Controls already built and tested** (public repo, 300+ tests, live-
> Postgres release gate): deterministic mandates enforced in the database
> outside any model context; exact-tuple human approvals above the
> escalation line; a global spend circuit breaker any anomaly trips (an
> issuer approval without our matching decision halts card spend
> immediately); Persona KYC/KYB and sanctions perimeter with fail-closed
> counterparty screening per merchant; hash-chained receipts for every
> reserve, clearing, refund, and release; segregated credentials — the
> webhook ingress holds no API key, the event worker holds a read-only key,
> and every issuer event is re-fetched with our own credentials before any
> ledger change.
>
> **Volumes, honestly.** Zero live card volume today. Targets: 20 real
> authorizations at ordinary merchants in the founder-entity beta
> (<= $500 exposure, weeks 2-8), then $10k/month card volume across 100
> funded owner accounts within two quarters of platform approval.
>
> **Why Stripe.** The synchronous authorization webhook, test-mode
> self-serve, and the Connect path to per-owner balances map one-to-one
> onto the control system we already ship.

**Vocabulary note for everything customer-facing:** Stripe's Issuing
marketing guidance restricts how card programs may be described
(docs.stripe.com/issuing/compliance-us — **UNVERIFIED** this session, cited
from the regulatory digest). Our enforced lexicon (docs/CARD_RAIL.md,
`npm run lint:vocabulary`) already bans the restricted descriptors; the
approved term is "reserved card" and the sandbox label is mandatory
everywhere.

**Pricing posture** (for the call, not the form): $0.10 per virtual card,
transaction fees waived to $500k then 0.2% + $0.20, interchange share
negotiable — **UNVERIFIED** beyond the self-serve blog; treat as an opening
model, not a quote.

**Hedge:** Lithic sandbox signup (app.lithic.com/signup, P2, ~10 minutes) as
the second-adapter seam; its auth-stream approach is nearly isomorphic to the
webhook contract (its exact timeout budget is **UNVERIFIED**). Hand sandbox
keys plus the auth-stream HMAC secret over env later; the `CardIssuer`
interface keeps that adapter to one file.
