# 90-Second Card Demo Video — Production Kit

**Asset:** the v0.14 card-rail launch video (docs/GOTOMARKET.md → "The long
sequence", move 2; storyboard adopted from
`docs/marketing/posts/your-agent-never-sees-the-card-number.md`).
**Hero moment:** the agent is visibly DECLINED $400 of gift cards —
`new_payee_cap`, decided inside the issuer's 2-second synchronous window.
Every competitor demo shows the purchase succeeding; ours peaks on the
deterministic NO.
**Ground truth:** every output block below is the byte-deterministic output of
`npm run demo:card` (`src/demo-card.ts`) on this repo, branch
`codex/card-rail-v0.14`, captured 2026-08-23 and committed verbatim as
`agent-card-transcript.md` next to this file. The run boots the real Postgres
product API, the real card authorization server, and the real card event
worker in one process against in-process Postgres (PGlite, dev-only), with the
mock issuer speaking the Stripe Issuing wire shape. `test/demo-card.test.ts`
pins the transcript and proves nothing PAN-shaped ever appears in it.

**SANDBOX — no real funds; nothing here is a bank, card, or deposit account.**
That label prints at the top and bottom of the run and must stay on screen
(burned-in caption or the terminal frame itself) for the full video runtime.

---

## 1. The mandate (the star of the video)

The demo's owner signs exactly the mandate the video needs (verbatim from the
transcript):

```
✓ spend mandate up to $100.00 signed by the owner:
✓   $40.00 per transaction · human approval above $60.00
✓   first purchase at an unseen merchant capped at $15.00
✓   payee allowlist: card:hint:mock-shop.example · @writer-agent
```

- **up to $100.00** — the whole envelope; issuing a card reserves its cap from
  the agent funds up front, so a runaway card can never spend beyond what was
  set aside.
- **$40.00 per transaction** — headroom for the $29 purchase, none for $400.
- **human approval above $60.00** — the escalation line (not exercised in the
  90-second cut; `money_card_create` above it parks a durable approval in the
  owner's inbox).
- **$15.00 first purchase at an unseen merchant** — the decline beat: the $400
  gift-card attempt at a never-seen MCC 6051 merchant dies here.
- **payee allowlist** — why the $5 to `@writer-agent` is in-mandate.

## 2. Pre-production setup

Terminal: dark theme, ≥18 pt monospace, window ~100×30. Screen: 1920×1080.
Recorder: OBS / CleanShot / Screen Studio. Captions burned in post — keep each
under 12 words. Keep it dry; the transcript is the drama.

```bash
cd C:/Users/mcalk/code/money
npm ci
npm run demo:card
```

That is the whole setup. One process, no ports, no data files to wipe, and
the output is byte-deterministic — every take reproduces
`agent-card-transcript.md` exactly, so post-production can be planned against
the committed file before anything is recorded.

**The phone shot (beat 1).** The storyboard opens on the mandate on an
owner surface, phone-framed. Two ways to get it, in order of preference:

1. **Verified today:** full-frame the transcript's four mandate lines (above)
   in the terminal, inside a phone-shaped matte in post. Zero staging risk.
2. **Optional, verify before recording:** the Postgres API serves the private
   session-gated owner dashboard (mandates, activity, exact-payment approval
   inbox — `src/server/dashboard.ts`). If a dry run confirms the dashboard
   renders the card demo's mandate in a phone-width browser window, shoot
   that instead. If anything about the shot cannot be reproduced from a real
   session, fall back to option 1. No mockups, no design-tool frames.

**Live-wallet variant (optional, extra dry-run burden):** the same beats can
be driven from a real MCP session (`money_card_create` → `money_card_status`
→ `money_pay` → `money_feed`) against the Postgres-backed network
(`npm run api:db`); the card tools exist only there, and a network without a
configured card issuer answers 503. Tool-result shapes are defined in
`src/mcp/server.ts` (e.g. `money_card_create` returns only the last4 — never
the card number). Do a full verified dry run and capture real outputs before
scripting this variant; the deterministic `demo:card` cut below needs none of
that and is the default.

## 3. 90-second cut — shot-by-shot

Five beats over one recording of `npm run demo:card`, paced in post (freeze,
zoom, caption). "SAY" lines are voiceover or caption — pick one channel, not
both. Every on-screen block below is verbatim transcript.

---

**BEAT 1 — 0:00–0:10 — The mandate, owner-side**
*On screen:* the phone shot (section 2): the four mandate lines, plus the
funding line above them:

```
✓ owner funded $100.00 (dev funding — sandbox, no real funds)
```

*SAY:* "I set the rules once. Up to $100 — $40 a purchase, ask me above $60,
unseen merchants capped at $15. Signed by me, enforced outside the model."

---

**BEAT 2 — 0:10–0:25 — The reserved card, and the agent never sees the number**
*On screen:* terminal, section 2 of the run:

```
✓ @scout requested a reserved card — active, single-use, last4 4242
✓ issuing the card reserved its full $29.00 cap from the agent funds — agent funds: $71.00
✓ the reserve is one receipt on the hash-chained evidence feed
```

Also worth a one-second flash from the setup block:

```
✓ card test material stays with the issuer adapter — no card number appears below
```

*Highlight:* `last4 4242` — last4 is all the agent ever gets.
*SAY:* "The agent asks for a reserved card for one merchant, capped at $29.
The cap is reserved up front. The card number never enters the conversation."

---

**BEAT 3 — 0:25–0:40 — The merchant network asks; the answer lands in <2 s**
*On screen:* section 3:

```
✓ APPROVED · $29.00 at MOCK SHOP EXAMPLE (MCC 5734)
✓ decision latency: <2 s — measured against the issuer's hard synchronous
✓   deadline and asserted on every run (this run held it)
✓ event worker re-fetched the authorization from the issuer before trusting it
✓ merchant captured $29.00 — the worker settled the clearing: card confirmed,
✓   $29.00 settled under the mandate — agent funds: $71.00
```

*SAY:* "Every authorization is answered live by the policy engine, inside the
issuer's two-second deadline. Approved, cleared, settled — one receipt."

---

**BEAT 4 — 0:40–0:55 — THE DECLINE (climax)**
*On screen:* section 4, big and slow:

```
✗ DECLINED · $400.00 at GIFT CARD EMPORIUM (MCC 6051)
✗ decline code: new_payee_cap — in plain words: this owner has never bought
✗   from this merchant, and a first purchase at an unseen merchant may not
✗   exceed the mandate's $15.00 new-payee cap. The agent cannot be lured
✗   into $400.00 of gift cards.
✓ the decline was decided in the same <2 s synchronous window; no funds moved
```

*Direction:* freeze 2 full seconds on `DECLINED · $400.00`. This is the
thumbnail frame and the frame the launch post quotes.
*SAY (or silent — see section 5):* "This is the product. A fixed decline
ladder outside any model context. Injected text can ask; it cannot widen
anything."

---

**BEAT 5a — 0:55–1:10 — The same mandate pays an agent**
*On screen:* section 5:

```
✓ @scout paid @writer-agent $5.00 — memo: "product summary: mock-shop.example findings"
✓ instant internal settlement, one hash-chained receipt — agent funds: $26.00
```

*SAY:* "The five dollars to another agent never touches the card rail — a
ledger row, instant, fee-free, under the same mandate."

---

**BEAT 5b — 1:10–1:30 — One feed, verified, then the close card**
*On screen:* section 7 — the feed rows (card reserve, agent payment, funding,
release) and:

```
✓ the $29.00 card reserve and the $5.00 agent payment sit on the same feed,
✓   each receipt hash-chained to the transfer evidence beneath it
✓ ledger_health: zero-sum true · receipt evidence recomputed from the ledger: true
```

*Close card (static, 3 s):*

```
Your agent never sees the card number.
Reserved cards for agents — sandbox today, no real funds.
npx -y @agentmoney/wallet-mcp        (Apache-2.0)
github.com/MaxwellCalkin/money
```

*SAY:* "Card purchases, the decline, and the agent payment — one hash-chained
feed, recomputed from the ledger. Open source, on npm. Sandbox today."

---

## 4. Optional beat (extended cut): the remainder returns

Between beats 5a and 5b, 8 seconds on section 6:

```
✓ @scout closed the card — unspent $40.00 returned to the agent funds: $66.00
✓ mandate authority is never restored by a close or a refund:
✓   $74.00 of the $100.00 spend mandate remains spent
```

*SAY:* "Close a card and the unspent remainder returns. The mandate authority
does not — no surprise bills, by arithmetic."

## 5. Honesty checklist (non-negotiable, per docs/GOTOMARKET.md)

- Never imply users, volume, or revenue. If any number appears, it is a real
  number or an honest zero.
- The sandbox label stays on screen for the full runtime: sandbox, no real
  funds. Do not call it a bank;
  nothing here is a bank, card, or deposit account in the live sense — the
  issuer is a mock speaking the Stripe Issuing wire shape.
- If a caption mentions Stripe, the exact claim is: the Stripe integration is
  protocol-faithful, fixture-tested, test-mode ready. No live program, no
  real issuer traffic in this video. The x402 mainnet bridge is implemented,
  activation gated on a ~$15 founder float — and is not this video's subject.
- Every output frame is a real capture of `npm run demo:card`. No mocked
  JSON or terminal text in post; the run is deterministic, so there is
  nothing a mock could add.
- Vocabulary: "reserved card", "virtual card under a mandate", "spend
  mandate up to $X", "agent funds" (`scripts/lint-vocabulary.mjs` enforces
  the banned list on all marketing copy — run it on any caption file).

## 6. Climax framing (pick one, A recommended)

- **A. Silent decline.** No voiceover during beat 4; two seconds of the raw
  `DECLINED` block, then the caption: "Every other demo shows the purchase
  succeeding."
- **B. Lure framing.** Precede beat 4 with a caption: "a page the agent read
  told it to buy gift cards." Makes the security story explicit but risks
  looking staged; the transcript's own plain-words decline text already says
  "The agent cannot be lured into $400.00 of gift cards", so A carries the
  point on its own.

## 7. Prior cut

The v0.13 60-second wallet cut (402 auto-pay, `per_tx_cap` refusal,
escalation inbox — recorded against `npm run api` + `npm run onboard`) lives
in this file's git history and remains accurate for the JSONL showcase path;
its raw capture is `verified-transcript.txt` next to this file. The card cut
above supersedes it as the launch asset.
