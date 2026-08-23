# Agent Card Demo — Verified Transcript

**SANDBOX — no real funds; nothing here is a bank, card, or deposit account.**

**Asset:** the v0.14 card-rail funnel transcript (docs/GOTOMARKET.md → M1
headline: "fund → mandate → agent buys at an ordinary merchant → visibly
declined off-mandate → pays another agent → one feed").
**Ground truth:** every line below is the verbatim, byte-deterministic output
of `npm run demo:card` (`src/demo-card.ts`) on this repo, branch
`codex/card-rail-v0.14`, captured 2026-08-23. The demo boots the real Postgres
product API, the real card authorization server, and the real card event
worker in one process against an in-process Postgres (PGlite, dev-only), with
the mock issuer network speaking the Stripe Issuing wire shape. The transcript
is pinned by `test/demo-card.test.ts`, which also proves no 13–19 digit run
(nothing PAN-shaped) ever appears in the output.

What the transcript shows, in order:

1. An owner funds $100 (dev funding, sandbox) and signs a **spend mandate up
   to $100**: $40 per transaction, human approval above $60, a $15 first-purchase
   cap for unseen merchants, and an exact payee allowlist.
2. The agent requests a **reserved card** for $29 at `mock-shop.example` —
   issuing a card reserves its full cap from the agent funds; the unspent
   remainder returns when the card closes; mandate authority is never restored.
3. The merchant network asks in real time and agentmoney **approves $29 inside
   the issuer's 2-second synchronous deadline**, then the event worker
   re-fetches the clearing from the issuer and settles it.
4. A $400 gift-card attempt at an unseen MCC 6051 merchant is **visibly
   declined — `new_payee_cap`** — in the same synchronous window.
5. The agent **pays another agent $5 for a service** on the internal rail.
6. One feed carries both rails, and `ledger_health` recomputes every receipt's
   evidence from the ledger: zero-sum true, receipts true.

---

```text
agentmoney · reserved-card rail demo
SANDBOX — no real funds; nothing here is a bank, card, or deposit account.

━━ Setup: the sandbox network boots ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ migrations 0001-0012 applied to an in-process Postgres (PGlite, dev-only)
  ✓ treasury controls configured; operator enabled card spend
  ✓ mock issuer network online, speaking the Stripe Issuing wire shape
  ✓ card test material stays with the issuer adapter — no card number appears below

━━ 1 · Owner funds $100 and signs a spend mandate ━━━━━━━━━━━━━━━━━━
  ✓ owner @max onboarded; sandbox compliance fixture: owner cleared,
  ✓   mock-shop.example registered and screened clear as a merchant counterparty
  ✓ owner funded $100.00 (dev funding — sandbox, no real funds)
  ✓ $100.00 allocated to @scout — agent funds: $100.00
  ✓ spend mandate up to $100.00 signed by the owner:
  ✓   $40.00 per transaction · human approval above $60.00
  ✓   first purchase at an unseen merchant capped at $15.00
  ✓   payee allowlist: card:hint:mock-shop.example · @writer-agent
  ✓ sandbox fixture: mock-shop.example recorded as a previously seen merchant
  ✓   (unseen merchants stay throttled at $15.00 — watch the decline below)

━━ 2 · A reserved card: spend mandate up to $29.00 at mock-shop.example ━━━━
  ✓ @scout requested a reserved card — active, single-use, last4 4242
  ✓ issuing the card reserved its full $29.00 cap from the agent funds — agent funds: $71.00
  ✓ the reserve is one receipt on the hash-chained evidence feed

━━ 3 · The merchant network asks; agentmoney answers in real time ━━━━
  ✓ APPROVED · $29.00 at MOCK SHOP EXAMPLE (MCC 5734)
  ✓ decision latency: <2 s — measured against the issuer's hard synchronous
  ✓   deadline and asserted on every run (this run held it)
  ✓ event worker re-fetched the authorization from the issuer before trusting it
  ✓ merchant captured $29.00 — the worker settled the clearing: card confirmed,
  ✓   $29.00 settled under the mandate — agent funds: $71.00
  ✓ single-use card closed at the issuer after settlement

━━ 4 · $400 of gift cards at an unseen merchant: declined ━━━━━━━━━━
  ✓ @scout holds a second reserved card (multi-use), spend mandate up to $40.00
  ✓   at mock-shop.example — agent funds: $31.00
  ✗ DECLINED · $400.00 at GIFT CARD EMPORIUM (MCC 6051)
  ✗ decline code: new_payee_cap — in plain words: this owner has never bought
  ✗   from this merchant, and a first purchase at an unseen merchant may not
  ✗   exceed the mandate's $15.00 new-payee cap. The agent cannot be lured
  ✗   into $400.00 of gift cards.
  ✓ the decline was decided in the same <2 s synchronous window; no funds moved

━━ 5 · The agent pays another agent for a service ━━━━━━━━━━━━━━━━━━
  ✓ @scout paid @writer-agent $5.00 — memo: "product summary: mock-shop.example findings"
  ✓ instant internal settlement, one hash-chained receipt — agent funds: $26.00

━━ 6 · Close the standing card: the unspent remainder returns ━━━━━━
  ✓ @scout closed the card — unspent $40.00 returned to the agent funds: $66.00
  ✓ mandate authority is never restored by a close or a refund:
  ✓   $74.00 of the $100.00 spend mandate remains spent

━━ 7 · One feed, verified ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    external:card  → @scout           $40.00  release: card <card-id> unspent remainder
    @scout         → @writer-agent     $5.00  product summary: mock-shop.example findings
    @scout         → external:card    $40.00  card:mock-shop.example
    @scout         → external:card    $29.00  card:mock-shop.example
    @max           → @scout          $100.00
  ✓ the $29.00 card reserve and the $5.00 agent payment sit on the same feed,
  ✓   each receipt hash-chained to the transfer evidence beneath it
  ✓ ledger_health: zero-sum true · receipt evidence recomputed from the ledger: true

━━ Done ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  One spend mandate. A reserved card for an ordinary merchant, a hard
  decline for the one the owner never approved, and an agent paying an
  agent for a service — all on one verified feed.
  SANDBOX — no real funds; nothing here is a bank, card, or deposit account.

```

---

**SANDBOX — no real funds; nothing here is a bank, card, or deposit account.**
Re-generate with `npm run demo:card`; the output is deterministic, so a fresh
run reproduces this file's transcript byte for byte.
