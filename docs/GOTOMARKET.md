# Go-to-market: the first million

Adopted 2026-08-08 after a three-lens adversarial review (investor, operator,
market). This is the standing goal the founder set and the agent pursues:
**take agentmoney to market and make the company worth its first million
dollars.** Honestly defined, that mark is crossed by whichever comes first:

1. **External validation money in** — ≥$25k on a SAFE from a non-friends-and-
   family investor at a market cap, or acceptance to a top accelerator; or
2. **Revenue** — ≥$1–2k MRR from the hosted tier or bridge take-rate; or
3. **Real usage** — $1M cumulative mainnet GMV through owner-signed mandates.

A literal "$1M valuation cap" is explicitly NOT the goal: 2026 pre-seed caps
run $3–10M+, so any credible check clears $1M — and a $1M cap would signal
distress. The binding question is whether anyone writes a check at all.

## The wedge (narrowed, post-review)

Platforms already ship basic owner-side caps (Coinbase Payments MCP session
caps in Claude Code; Stripe Link agent approvals; Google AP2 "Mandates").
What none of them can be is **neutral**, and what none of them produce is
**portable, wash-proof evidence**. The wedge:

> The neutral, cross-runtime, cross-rail spend account for AI agents, with
> deterministic policy no platform matches (escalation lines, new-payee
> throttles, allowlists, exact-tuple approvals) and hash-chained receipts
> that cryptographically prove the traffic is real.

The wash-proof point is a market weapon: public data showed ~half of x402
volume was self-dealing. Our receipts journal — funding lineage, retention
cohorts, published chain roots — makes agentmoney the ecosystem's honest
metrics authority. We market against the wash, never participate in it.

## Budget doctrine

$0 infrastructure until demand justifies spend, with exactly two pre-approved
exceptions, each gated on a trigger:

- **~$15 mainnet float** (founder's USDC on Base; gas is sub-cent): unlocks
  the only evidence class that counts — real money under a real mandate.
  This is transaction float, not infrastructure. Trigger: M1 bridge work done.
- **~$500–800 Delaware C-corp**: legally required before any SAFE. Trigger:
  accelerator acceptance or a concrete check commitment, never speculatively.

## Milestone ladder

### M0 — The asset (DONE)
Production-candidate Postgres money kernel (239-test suite, live-Postgres
release gate), published SDKs: `@agentmoney/wallet-mcp`,
`@agentmoney/seller-sdk` (Apache-2.0, npm, verified cold-install).

### M1 — The network exists and is findable (weeks 0–4)
The funnel ships here, not at M3 — these are acquisition instruments:

- **Hosted beta deploy profile** (agent): postgres + pgbouncer + api:db +
  external-worker + database-ops only; treasury/compliance routes fail closed
  with 503; **invite-code onboarding** (not open signup + rate limit — kills
  the abuse surface; pilots are hand-recruited anyway); sandbox tier spec:
  no KYC, hard caps, explicit "testnet/beta, not production" labeling.
- **Hosting** (founder signs up, agent deploys): Oracle Always Free sized to
  the new 2 OCPU/12GB limit; tenancy upgraded to Pay-As-You-Go with card on
  file while staying inside free limits ($0 actual — escapes idle
  reclamation and capacity lockouts). Treat the VM as cattle: tested
  rebuild-from-scratch script, nightly encrypted pg_dump to Cloudflare R2
  (free 10GB), UptimeRobot external monitoring, published restore drill.
  Honest SLA posture on the status page ("single free-tier VM, best-effort").
  Paid-hosting trigger: first dollar of real GMV.
- **Bridge to mainnet behind hard caps** (agent + founder's ~$15 float):
  Base mainnet, ≤$10 total float, ≤$0.25/tx, existing mandate engine
  enforcing. Base Sepolia demotes to regression environment.
- **Funnel assets** (agent, free hosting): landing page, waitlist, status
  page, public signed-receipts explorer, 60-second demo video — an agent
  pays a real endpoint under a mandate, then is visibly REFUSED over-cap.
  The refusal is the differentiator; every competitor demo shows success.
- **Distribution blitz** (agent drafts, founder posts): official MCP
  registry, Smithery, PulseMCP, mcp.so, Cursor/Cline directories; npm
  provenance publishing via GitHub Actions; README terminal-cast GIF.

**Gate:** a stranger onboards via invite and completes a paid fetch against
the hosted URL in under 10 minutes (measured), AND one real mainnet x402
payment to a third-party seller we don't operate — tx hash published beside
its signed receipt — AND a completed restore-from-backup drill.

### M2 — Strangers spend and return (weeks 2–10, overlaps M1)
- **Discovery before recruiting** (founder voice, agent synthesis): 20
  problem interviews with agent builders; published "what agents actually
  buy" target list. Pilots are recruited against it, not cold.
- **One genuinely useful founder-run paid endpoint** (agent builds on
  seller-sdk, priced at cost, listed in x402 Bazaar) so wallets have
  something worth buying. Founder-run supply + stranger buyers is legitimate
  bootstrap; "3+ external sellers" is demoted to opportunistic.
- **Public wash-proof metrics page** (agent, from the receipts journal):
  distinct wallets, funding lineage proving no founder subsidy, retention
  cohorts, weekly chain root. Honest zeroes are fine; the artifact itself
  is a product demo.

**Gate (buyer-side, retention-shaped, wash-resistant):** ≥8 distinct
external wallets (the BUYER is never the founder) each active in ≥3 distinct
weeks, ≥$50/week real USDC through the bridge, economically real
transactions only (pings/self-dealing/faucet excluded by construction).
**Kill criterion:** if <3 of the first 10 pilots transact in two separate
weeks, stop recruiting and return to interviews; if by week 8 no organic
non-founder buying exists on x402 anywhere, pivot the demand wedge to
mandating real-world API spend (search, scraping, inference) where budgets
already exist.

### M3 — Evidence someone else values it (weeks 8–16, overlaps M2)
- Case studies: named, reproducible, at least one real-money recurring
  workflow.
- **Moat milestone:** publish the mandate format as an open spec (RFC + test
  vectors, Apache-2.0, separate repo) and land ≥1 external adoption — a
  wallet, registry, or seller verifying mandate receipts. Without this,
  defensibility is an assertion.
- Teardown content (agent drafts, founder publishes): "session caps vs. a
  real mandate" (vs. Coinbase Payments MCP) and "how half of x402 volume
  was wash — and how to prove yours isn't."
- Revenue mechanism named and priced: hosted control-plane tier
  ($9–29/mo, card-on-file waitlist as a $0 demand test) and/or bridge
  take-rate — decided by M2 data, confirmed here.
- YC (or equivalent) application submitted — the cheapest credible
  first-million event and a forcing function against engineering gravity.

**Gate:** one design-partner letter WITH A NUMBER in it (paid pilot amount
or deployment commitment), or 25+ weekly-active wallets with week-over-week
retention published.

### M4 — First million on paper (months 3–7)
Primary: ≥$25k external check or accelerator acceptance (incorporation
trigger fires here). Secondary: $1–2k MRR. Tertiary: $1M cumulative mainnet
GMV. **Standing review at week 16:** if the M2 gate has never been touched,
this ladder gets a kill/pivot decision, not another engineering sprint.

## Operating principles

1. **Distribution-first.** Every weekly sprint ships ≥1 distribution
   artifact (listing, post draft, demo asset, metrics update). Engineering
   hardening is capped at ~10% of agent hours until M3 — the documented
   failure mode of this project is building v0.14 instead of finding user #2.
2. **Never fake traction.** Wash-proof by construction; honest zeroes.
3. **Fail-closed is the brand.** The security bar never drops; incidents
   get published post-mortems.
4. **Platform-risk tripwire** (monthly): Anthropic/OpenAI native spend
   controls, Coinbase Payments MCP policy depth, Stripe Link limits. If any
   ships mandate-grade policy, the pre-drafted pivot fires within a week:
   "the neutral cross-runtime policy and evidence plane."
5. **Division of labor.** Agent owns: engineering, deploy/rebuild/backup
   automation, the paid endpoint, metrics page, all drafts (listings,
   posts, applications, spec). Founder owns: accounts, keys, money
   decisions, the ~2 scheduled hours/week of posting/DMs/interviews under
   his own name, investor conversations, signatures. M2's critical path is
   founder-voice hours — the scarcest resource in this plan.
