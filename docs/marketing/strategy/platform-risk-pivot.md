# Pre-committed contingency: if the platforms ship mandate-grade policy

Status: pre-drafted, dormant. Fires within ONE WEEK of a confirmed trigger
(GOTOMARKET operating principle 4). This document is written in advance so the
pivot is a checklist execution, not a panic. Nothing here requires new
engineering; the pivot is narrative, packaging, and sequencing.

## What counts as "mandate-grade" (so the tripwire is falsifiable)

A platform trigger fires only when a shipped, documented feature (not an
announcement, waitlist, or blog promise) includes **at least three** of:

1. Deterministic enforcement outside the model context (not prompt-level).
2. A human-escalation line where approval executes an exact, immutable
   payee+amount tuple (not a generic "confirm?" dialog).
3. A first-touch / new-payee throttle.
4. Payee allowlists or equivalent destination policy.
5. Durable approvals that survive restart and settle exactly once.

Session caps (max per-call, max per-session — what Coinbase Payments MCP ships
today) are **not** mandate-grade. Model-usage/token budget caps (what Claude
Code's gateway spend limits are) are **not** payments policy at all — do not
false-trigger on them.

## The three tripwires, and the pivot each one fires

The destination is the same in all three cases — reposition as:

> **The neutral, cross-runtime, cross-rail policy and evidence plane for
> agent spend.** Policy no single platform matches, enforced outside the
> model, portable across runtimes and rails, with hash-chained receipts that
> prove the traffic is real.

What differs per trigger is which leg leads the argument.

### T1 — Anthropic or OpenAI ship native tool-spend budgets

- **What it kills:** "your runtime has no spend controls" as a pitch line.
- **What survives:** a runtime budget dies at the runtime's edge. It doesn't
  travel with the agent to Cursor/Cline/anything MCP, doesn't span rails
  (internal ledger rows + external x402), and produces platform-siloed logs,
  not portable hash-chained receipts.
- **Lead leg:** NEUTRALITY. Pitch line: "Anthropic's budget governs Anthropic's
  runtime. Your agent's mandate should govern your agent — everywhere it runs."
- **Explicit move:** stop headlining budget/per-tx caps (now commodity there);
  headline escalation-with-exact-tuple-approval, new-payee throttle, and the
  receipt chain — verified shipped in `src/core/policy.ts` / `src/core/receipts.ts`.

### T2 — Coinbase Payments MCP adds mandate-grade policy

- **What it kills:** "session caps vs. a real mandate" teardown (retire it same day).
- **What survives:** Coinbase is one company's wallet on one rail family, and it
  operates the x402 ecosystem whose volume was shown ~half wash (CoinDesk/
  Artemis, March 2026). It cannot be the neutral referee of its own metrics.
- **Lead leg:** EVIDENCE + rail neutrality. Pitch line: "Policy from the house
  is still the house. agentmoney is the neutral plane: closed-loop ledger rows
  at sub-cent cost, x402 when you go external, and receipts an auditor can
  verify without trusting us — or them."
- **Explicit move:** accelerate M3's open mandate spec (RFC + test vectors) to
  week one of the pivot — a "policy plane" claim requires a spec others can adopt.

### T3 — Stripe Link agent limits ship

- **What it kills:** "consumer agent wallets have no limits" as a contrast.
- **What survives:** Link is card-rail consumer checkout (one-time cards /
  Shared Payment Tokens inside ChatGPT-style flows). Card economics cannot
  serve 75M/month machine payments averaging $0.32; sub-cent M2M is
  structurally ours (ledger rows), and Stripe's controls live inside Stripe's
  account, not with the agent.
- **Lead leg:** cross-RAIL neutrality + machine economics. Pitch line: "Stripe
  governs what agents buy from stores. We govern what agents pay machines —
  sub-cent, exactly-once, provable."

## The one-week execution checklist (agent drafts, founder posts)

- **Day 0–1 — Pitch + hero.** Swap `site/index.html` hero to the pre-written
  Variant B (neutrality-forward) in `site/copy-variants.md`, subhead merged
  with Variant C's evidence line. New one-liner everywhere: "the neutral
  cross-runtime, cross-rail policy and evidence plane for agent spend."
- **Day 1–2 — Packages.** Update npm descriptions: `@agentmoney/wallet-mcp` →
  "the portable policy sidecar for any MCP runtime — works beside, not inside,
  platform wallets"; `@agentmoney/seller-sdk` description unchanged. README
  first line updated to the new one-liner.
- **Day 2–3 — Listings.** Re-copy the five directory listings in
  `docs/marketing/listings/` against the new frame.
- **Day 3–5 — The teardown, inverted.** Draft "what [platform] shipped, what
  it actually enforces, and what still needs a neutral plane" — factual,
  side-by-side, no hype, crediting them where real. Founder posts under his
  own name. This is the highest-leverage asset of the week: the trigger event
  is the news cycle, and we are the credible commentary.
- **Day 5–7 — Spec.** If T2 (or any two triggers), publish the mandate-format
  RFC draft repo (M3 milestone pulled forward; drafting only — still inside
  the ~10% engineering cap since it's documentation of shipped behavior).

## What does NOT change — ever, under any trigger

- **The kernel.** The Postgres money kernel, deterministic policy engine,
  exactly-once payments, exact-tuple approvals, single-use permits. It is the
  product in every framing.
- **The receipts.** Hash-chained, wash-proof, honest zeroes. Under T2 this
  becomes the whole company.
- **The seller SDK.** Sellers need a paywall + refunds regardless of whose
  policy governs the buyer.
- **The gates.** M2's buyer-side retention gate, the kill criteria, the
  honesty rules, fail-closed posture, and the ~10% engineering cap all stand.
  A platform shipping policy is a positioning event, not an engineering event.

## Monthly tripwire checklist (first Monday; log date + verdict per row)

Last re-score 2026-08-23 (v0.14 card-rail panel; verdicts unverified, best
score 2.5/5 — no trigger). **Next scheduled re-score: 2026-10-22.** Rows to
watch since the card rail shipped: Stripe Link standing rules, the Coinbase
policy engine, Crossmint guardrails, and the Mercury API.

Verdict per row: `caps-only` / `partial` / `MANDATE-GRADE` (three+ criteria
above, shipped and documented). Any MANDATE-GRADE verdict starts the one-week
clock.

- [ ] **Anthropic / Claude Code** — CHANGELOG at
      github.com/anthropics/claude-code (`CHANGELOG.md`) and anthropic.com/news.
      Note: "gateway spend limits" = model-usage billing caps, NOT payments
      policy. Watch specifically for tool-call payment budgets or an MCP
      payment-policy primitive.
- [ ] **OpenAI** — platform.openai.com/docs/changelog and
      developers.openai.com/commerce (ACP checkout + key-concepts specs).
      Watch for agent spend budgets beyond Instant Checkout's per-purchase
      user confirmation.
- [ ] **Coinbase Payments MCP** — docs.cdp.coinbase.com/payments-mcp/welcome,
      npm "versions" tab for `@coinbase/payments-mcp`, and
      github.com/coinbase/x402 releases. Today: max-per-call / max-per-session
      caps. Watch for escalation flows, payee allowlists, first-touch throttles.
- [ ] **Stripe** — docs.stripe.com/changelog and
      docs.stripe.com/agentic-commerce/concepts, plus stripe.com/blog. Watch
      for shipped consumer-settable agent limits and autonomous-spend windows
      on Link/SPTs (announced as "planned" as of mid-2026).
- [ ] **Google AP2** — github.com/google-agentic-commerce/AP2 releases. Their
      "Mandates" are the closest naming collision; watch for enforcement
      tooling (not just protocol objects) and any runtime adoption.
- [ ] **Sweep** — one search: "agent payments spending controls" news, past
      month. Anything new that meets the mandate-grade bar from an entity with
      distribution counts as a trigger.

Discipline: announcements, waitlists, and rebranded session caps do NOT start
the clock — shipped docs do. When in doubt, run the five-criteria test above
and record the row-by-row answer in the log.
