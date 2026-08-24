# Launch Copy — v0.14 card rail (founder posts under his own name)

**DRAFT — founder-voice copy stays in the repo. Nothing below is posted, and
no agent posts it; the founder does, after the v0.14 gate is green
(docs/GOTOMARKET.md → "The long sequence", move 2).**

Honest-voice rules applied throughout: no invented traction, no "trusted by",
honest zeroes stated outright, decline-first framing, every quoted output is a
verbatim line from the committed deterministic transcript
(`agent-card-transcript.md`, pinned byte-for-byte by `test/demo-card.test.ts`).
Sandbox demo: sandbox, no real funds.

## 280-character launch post (X / Bluesky / LinkedIn opener)

```
I gave my agent a $100 spend mandate. It made a $29 purchase at an ordinary checkout — and was DECLINED trying $400 of gift cards:

“decline code: new_payee_cap”

The agent never sees the card number. Sandbox, no real funds. Apache-2.0.

npx -y @agentmoney/wallet-mcp
```

Attach: the 90-second video (demo-video-kit.md), thumbnail = the frozen
`DECLINED · $400.00` frame, or the animated cast `agent-card-cast.svg`.
Reply 1 (thread continuation, optional): the GitHub link + "deterministic
sandbox demo against a mock issuer — `npm run demo:card` reproduces the
committed transcript byte for byte. Usage today is zero; the card rail
shipped this week."

## Show HN

**Title:**

```
Show HN: A virtual card for AI agents – the demo's climax is a $400 decline
```

**Body:**

```
I built agentmoney: an open-source closed-loop payment network for AI agents,
shipped as two Apache-2.0 npm packages — @agentmoney/wallet-mcp (an MCP server
that gives any agent runtime money_balance / money_pay / money_fetch with
automatic HTTP 402 payment / money_feed) and @agentmoney/seller-sdk (a Hono
paywall middleware with receipt redemption and refunds).

v0.14 adds the piece that makes agents useful at the overwhelming majority of
merchants — the ones that only take cards: a reserved card. The agent asks for a single-merchant virtual
card under a spend mandate its owner signed — up to $100, $40 per transaction,
human approval above $60, and a $15 cap on the first purchase at any merchant
the owner has never bought from. Issuing the card reserves its full cap from
the agent's funds up front, so a runaway card can never spend more than what
was already set aside. Closing it returns the unspent remainder; the mandate
authority spent is never restored. No surprise bills, by arithmetic.

The demo (npm run demo:card) deliberately peaks on the decline. The agent's
$29 card authorizes at an ordinary merchant inside the card network's
2-second synchronous deadline and settles; then a $400 gift-card attempt at
an unseen MCC 6051 merchant gets:

    ✗ DECLINED · $400.00 at GIFT CARD EMPORIUM (MCC 6051)
    ✗ decline code: new_payee_cap — in plain words: this owner has never bought
    ✗   from this merchant, and a first purchase at an unseen merchant may not
    ✗   exceed the mandate's $15.00 new-payee cap. The agent cannot be lured
    ✗   into $400.00 of gift cards.

Every authorization is answered live by a fixed decline ladder (card active,
mandate alive, merchant category, merchant lock, single-use, first-merchant
throttle, cap) in a policy engine outside any model context. Injected text
can ask for money; nothing in the agent's context can sign or widen a
mandate. And the agent never sees the card number: the MCP tools return only
the last4. Reveal mode defaults to none — no reveal surface exists at all —
and in token mode the host runtime (never the model) redeems a single-use,
10-minute checkout token outside the conversation. A test pins the demo
transcript and proves nothing PAN-shaped ever appears in agent-facing output.

The same mandate also pays other agents: the demo's agent pays a sibling $5
for a summary over the closed loop — instant, fee-free, and on the same
hash-chained receipt feed as the card reserve and the decline. The run ends
with the feed's evidence recomputed from the ledger: zero-sum true, receipts
true.

Try it in ~2 minutes (repo wants Node 24+; the published packages run on
Node 20+):

    git clone https://github.com/MaxwellCalkin/money && cd money
    npm ci
    npm run demo:card   # deterministic — reproduces the committed transcript
                        # byte for byte, sandbox, no real funds

Honest status, so nobody over-reads this: it is a sandbox. The demo's issuer
is an in-process mock speaking the Stripe Issuing wire shape; the Stripe
integration is protocol-faithful, fixture-tested, and test-mode ready, but
there is no live card program and no real funds anywhere —
nothing here is a bank, card, or deposit account.
The x402 mainnet bridge is implemented, with
activation gated on a ~$15 founder float. The ledger is real double-entry
(Postgres kernel) and the treasury/compliance boundary is implemented in
software but not activated with customer funds — a real launch needs an
issuing program, licensing work, and funded reserves that code can't provide.
Users today: zero. The card rail shipped this week.

What I'd genuinely like to hear from people building agents: what would your
agent buy with a card, and what decline would you need to watch happen before
you'd hand it a mandate?
```

**Submission notes:**
- Post the repo URL as the link; the body goes in the text field.
- First comment: the 90-second video + the animated cast, so the decline is
  one click away.
- Do not upvote-solicit; do not respond to traction questions with anything
  but real numbers ("zero users; the card rail shipped <date>").
- If someone runs `npm run demo:card` and posts output, that's the best
  possible thread — their transcript should match the committed one byte for
  byte; say so and verify.

## One-liner variants (bios, link previews, README badges)

- "Reserved cards for AI agents: a spend mandate the owner signs, a decline
  ladder at the authorization hop, and an agent that never sees the card
  number. Sandbox, no real funds. Apache-2.0."
- "Every agent-payments demo shows the purchase succeeding. Ours peaks when
  $400 of gift cards is DECLINED in under two seconds."
- "Issuing reserves, spending clears, closing returns the remainder — and the
  mandate authority is never restored. No surprise bills, by arithmetic."
