# YC Application — agentmoney (complete draft)

Drafted 2026-08-08 against the current YC application form (questions sourced from
apply.ycombinator.com guides current for the F2026 cycle; the live portal at
apply.ycombinator.com/home is authoritative — expect minor wording drift).

**Batch logistics (verified 2026-08-08 from ycombinator.com/apply):** Fall 2026
regular deadline was July 27, 8pm PT; **late applications are still accepted** and
reviewed. On-time decisions by Aug 28; interviews by video in Aug–Sept, decision
same day; batch runs Oct–Dec in San Francisco with a 3-day in-person kickoff. YC
invests on acceptance. Standard deal: $500k ($125k for 7% + $375k on an uncapped
MFN SAFE). Submitting now = late app to Fall 2026; if it misses, the same answers
roll into Winter 2027.

**Honesty rules applied throughout (per docs/GOTOMARKET.md):** every zero is stated
plainly; every technical claim below was verified against the repo, the npm
registry, or a captured run transcript on 2026-08-08. Nothing is projected as if it
already happened. A claim-verification appendix is at the bottom.

`[FOUNDER-INPUT: ...]` marks every field only Max can truthfully complete.

---

## COMPANY

### Company name
agentmoney

### Describe what your company does in 50 characters or less.
> The neutral spend account for AI agents

(39 chars. Alternate if "neutral" reads vague to a skimmer:
"Spend controls and receipts for AI agents" — 41 chars.)

### Company URL, if any
[FOUNDER-INPUT: landing page URL if the M1 funnel page is live by submission;
otherwise use https://github.com/MaxwellCalkin/money — a real repo beats a parked
domain. Do not submit a dead URL.]

### If you have a demo, attach it below. / Please provide a link to the product, if relevant.
Product link: https://www.npmjs.com/package/@agentmoney/wallet-mcp (live, Apache-2.0)
and https://github.com/MaxwellCalkin/money

Demo video: [FOUNDER-INPUT: record the 60-second demo per
docs/marketing/demo/demo-video-kit.md — every frame is a real capture; the kit and
verified transcript already exist. Upload unlisted YouTube/Loom link here.]

Description of the demo (usable as the video caption or if a text field asks):

> One command gives a coding agent a wallet under a mandate its owner signed:
> `$10 budget · $1/tx · $5/day · ask above $2 · new payee capped at 10¢`. In the
> demo the agent hits a paid API, gets HTTP 402, pays $0.05 automatically and
> retries — receipt attached. Then it's told to pay $1.50, and the network refuses:
> `{"status":"denied","code":"per_tx_cap","reason":"$1.50 exceeds the $1.00
> per-transaction cap"}`. That refusal is the product. It is deterministic policy
> enforced in the database, outside any model context — a prompt injection can ask
> for money; nothing in the agent's context can sign or widen the mandate. Every
> other agent-payments demo shows a payment succeeding. Ours peaks on the no.

### What is your company going to make? Please describe your product and what it does or will do.
agentmoney is a spend account for AI agents. An owner signs a mandate — budget,
per-transaction cap, daily cap, an "ask me above $X" escalation line, a first-touch
throttle on never-seen payees, allowlists, expiry — and the agent spends freely
inside it. The mandate is enforced deterministically in Postgres, outside any model
context: policy check, balance check, double-entry journal write, and hash-chained
receipt happen in one database transaction, exactly-once under retries. Above the
escalation line, the request parks durably in the owner's inbox and approval
executes exactly the tuple the human saw, once.

It ships today as an MCP wallet any agent runtime can mount (`npx -y
@agentmoney/wallet-mcp`) plus a seller SDK for anyone to publish a paid API.
Internal agent-to-agent payments settle as ledger rows (instant, fee-free,
sub-cent capable); an x402 v2 bridge pays external sellers in USDC on Base under
the same mandate. The receipt chain is the second product: portable, tamper-evident
evidence that agent spend is real — which matters in a market where roughly half of
x402 volume was shown to be self-dealing.

### Where do you live now, and where would the company be based after YC?
[FOUNDER-INPUT: current city; and the honest answer on relocating to SF for the
Oct–Dec in-person batch — YC F26 requires SF presence for kickoff at minimum.]

---

## FOUNDERS

### Founder details (name, age, education, work history, etc.)
[FOUNDER-INPUT: Max — legal name (Maxwell Calkin), age, education, employment
history, LinkedIn. Handles that should go in: github.com/MaxwellCalkin, npm
`isthisreality`. Do not let the application infer a bio from commit history —
write it yourself.]

### Please record a one minute video introducing the founder(s).
[FOUNDER-INPUT: must be Max on camera, unscripted-sounding, ~1 minute. YC guidance:
~30s who you are, ~30s what you're building and why you. Suggested skeleton — edit
into your own words, do not read verbatim:]

> I'm Max Calkin. [One sentence of real background — FOUNDER-INPUT.] I build with
> coding agents every day, and the moment I wanted to give one a budget, I realized
> there was no safe way to do it — every option was either a raw API key with my
> card behind it, or a platform wallet that only works inside that platform's
> runtime. So I built agentmoney: the agent gets a wallet, I sign a mandate —
> budget, per-transaction cap, a line above which it has to ask me — and the
> network enforces it in the database, outside the model, so a prompt injection
> can't spend what I didn't sign. It's live on npm, Apache-2.0, three weeks of
> work so far: a Postgres money kernel with a 239-test suite, hash-chained
> receipts, and an x402 bridge. The demo's best moment is the network telling the
> agent no. I'm applying because the agent-payments control plane is being decided
> right now, and the neutral version of it shouldn't be owned by a payments
> platform.

### Who writes code, or does other technical work on your product? Was any of it done by a non-founder?
I write and direct all of it. Concretely: I work with AI coding agents as a
workforce — they draft code, tests, and documentation under standing instructions I
wrote, and I review, gate, and ship. Every release passes a 239-test suite, a
live-Postgres contention gate in CI, and a threat-model review before it merges. No
employees, no contractors, no outsourcing; no code was done by another person.
That workflow is also why the product exists: I'm the power user of exactly the
thing I'm building — an owner who needs deterministic control over what autonomous
agents do with real resources.

### Are you looking for a cofounder?
[FOUNDER-INPUT: this must be your true answer — YC matches on it. Honest options:
(a) "Open to one if the fit is exceptional, not blocking on it" or (b) "No."
Suggested draft if (a):]

> Open, not desperate. The right cofounder is a distribution/BD founder who has
> sold developer infrastructure; the engineering side is covered and moving fast.
> I'd rather run solo than add a mediocre fit for optics.

### How long have the founders known one another and how did you meet?
N/A — solo founder.

### The solo-founder question (asked in some form every cycle — head-on answer)
Yes, I know YC's data favors teams. Two honest counterpoints. First, leverage: this
went from empty repo to a production-candidate Postgres money kernel — 239 tests,
compliance perimeter, treasury boundary, x402 bridge, two published npm packages —
in 24 days, because I run coding agents as a team and spend my own time on review,
security invariants, and go-to-market. The repo history is public and verifiable.
Second, alignment: a company whose product is governance for agent labor should be
demonstrating agent labor under governance. The honest weakness of solo isn't
output — it's blind spots and morale troughs; my mitigations are a written
operating doctrine (distribution-first, engineering capped at ~10% of hours until
traction), public metrics with honest zeroes, and [FOUNDER-INPUT: name your real
human accountability structure — advisors, peers, whoever actually exists].

---

## PROGRESS

### How far along are you?
Built and published; pre-users. Shipped: a production-candidate money kernel
(Postgres double-entry journal, owner-signed mandates evaluated atomically outside
model context, exactly-once idempotency, hash-chained receipts, Ed25519 identity,
durable owner approvals), an MCP wallet and seller SDK live on npm since Aug 6
(`@agentmoney/wallet-mcp`, `@agentmoney/seller-sdk`, Apache-2.0), an x402 v2
bridge with remote-HSM signing and independent on-chain settlement verification,
and the treasury/compliance software boundary (Column ACH, Persona KYC) — built
fail-closed, not yet activated with customer funds. 239-test suite plus a
live-Postgres contention gate in CI. Honest zeroes: 0 users, 0 revenue, $0 GMV.
Next 4 weeks (plan already written): invite-gated hosted beta on free-tier infra,
mainnet bridge behind hard caps (≤$10 total float), and the first stranger
onboarded to a paid fetch in under 10 minutes.

### How long have each of you been working on this? How much of that has been full-time?
First commit July 15, 2026 — about 3.5 weeks. [FOUNDER-INPUT: state truthfully
whether this has been full-time since then, and if not, what fraction and what
else occupies you. Do not fudge this; YC checks commitment hard for solo founders.]

### Are people using your product?
No. The packages are live on npm and anyone can run the full network locally, but
I have no external users yet and won't claim otherwise. The hosted invite-gated
beta that changes this is the current sprint.

### How many active users or customers do you have? How many are paying? Who is paying you the most, and how much do they pay you?
0, 0, and no one. (Stated plainly on purpose: the receipts layer of this product
exists because ~half of x402 volume was shown to be wash. We market against faked
traction; we don't manufacture it.)

### When will you have a version people can use?
Now, self-hosted: `npx -y @agentmoney/wallet-mcp` against the open-source network
(README walkthrough, ~10 minutes). Hosted invite-gated beta (no self-hosting,
sandbox tier, hard caps, explicit not-production labeling): targeted inside the
next 4 weeks; the deploy profile and invite-code onboarding are already built.

### Do you have revenue?
No. $0.

### If you are applying with the same idea as a previous batch, did anything change? / Previous accelerators?
First application. No prior accelerator or incubator participation.
[FOUNDER-INPUT: confirm both are true.]

### What tech stack are you using?
TypeScript on Node 24. PostgreSQL 18 is the money kernel — policy, ledger, receipts
and risk decisions commit in one transaction with deterministic row locking; app
roles cannot post raw journal entries. Hono HTTP APIs; Ed25519 signed requests with
durable nonce replay defense; MCP (Model Context Protocol) for the agent-side
wallet; x402 v2 / EIP-3009 USDC on Base for the external rail, signed by a remote
HSM and verified independently against chain calldata and logs; Docker
(distroless, non-root, SBOM'd) for deploys.

---

## IDEA

### Why did you pick this idea to work on? Do you have domain expertise in this area? How do you know people need what you're making?
I run AI agents daily and hit the problem personally: there is no safe, portable
way to give an agent money. Raw API keys have no budget semantics; platform
wallets work only inside one runtime. My "domain expertise" is unusual but real —
I operate an agent workforce and I built (and threat-modeled) the payment network
those agents now depend on; the security model assumes the agent is fully hostile.

Evidence of need, honestly weighted: machine payments are already real —
x402 processed ~75M transactions/month averaging $0.32 by July 2026 — and every
major platform is now shipping the crippled version of this product (Coinbase
session caps in Claude Code, Stripe approvals in ChatGPT, Google AP2's mandate
objects), which is the strongest possible signal that owners demand spend
controls. What I have NOT yet proven is that they'll adopt a neutral third-party
one: that's exactly what my next-8-week plan tests (20 problem interviews, 10
hand-recruited pilots, a kill criterion in writing if they don't transact).

### Who are your competitors? What do you understand about your business that they don't?
Competitors: Coinbase Payments MCP (session caps, Claude Code), Stripe's Link
agent wallet (in-ChatGPT approvals), Google's AP2 protocol ("Mandates"), plus the
x402 facilitator field (Cloudflare, thirdweb, PayAI) and platform-native wallets
to come from every agent runtime.

Three things I understand that they can't act on:

1. **Neutrality is structural, not a feature.** Coinbase's wallet exists to route
   volume to Coinbase rails; Stripe's to Stripe's; each runtime's to its own
   lock-in. An owner running agents across Claude Code, Cursor, and a custom stack
   needs ONE policy surface across all runtimes and rails. Platforms are
   constitutionally unable to build that; a neutral Apache-2.0 network is.
2. **Session caps are not custody.** A cap is one number. Real delegation needs an
   escalation line with durable exact-tuple human approval, a first-touch throttle
   so a prompt-injected agent lured to a new payee leaks cents rather than the
   envelope, allowlists, expiry, and single-use permits bound to payee+amount.
   We ship all of that today, enforced in the database, with tests.
3. **The scarce asset is provable realness.** ~Half of historical x402 volume was
   shown to be self-dealing (CoinDesk/Artemis, March 2026). Everyone's dashboards
   inflated; nobody can prove their number. Hash-chained receipts with funding
   lineage and published chain roots make agentmoney the honest-metrics authority
   — evidence buyers, sellers, and eventually auditors can verify without
   trusting us. Competitors would have to disavow their own historical volume to
   copy this position.

### How do or will you make money? How much could you make?
Two mechanisms, sequenced: (1) a hosted control-plane subscription — the owner
dashboard, mandates, approvals, receipts explorer as a service at $9–29/month,
demand-tested first with a card-on-file waitlist before building billing; (2) a
take-rate on external settlement through the bridge (x402/USDC now, treasury rails
later), which scales with spend under management. Sizing honestly: today's
genuinely-real x402 market is small (~$1.1M/30 days post-wash), so near-term
revenue is thousands, not millions. The bet is that agent-initiated spend follows
agent adoption into API, SaaS, and inference budgets that already exist —
real-world agent API spend is the expansion wedge — and the neutral policy layer
takes basis points on all of it across every rail it bridges. If agents come to
transact even a low-single-digit share of the ~$300B+ API/SaaS spend they're
beginning to automate, basis points on that flow is a large business; if that
thesis is wrong, the written kill criterion fires at week 8 and the wedge pivots
to mandating existing API spend.

### How do users find your product? How did you get the users you have now? If you run paid ads, what is your cost of acquisition?
No users yet and no paid anything. The motion is discovery-led and
distribution-first, already in writing: listings where agent builders actually
look (official MCP registry, Smithery, PulseMCP, mcp.so, Cursor/Cline
directories); a one-line install (`npx -y @agentmoney/wallet-mcp`); the
60-second refusal demo; 20 problem interviews with agent builders before
recruiting pilots against what they actually buy; teardown content with receipts
("session caps vs. a real mandate", "how half of x402 volume was wash — and how
to prove yours isn't"); and a public wash-proof metrics page whose honest zeroes
are themselves the product demo. Founder-voice posting and DMs ~2 scheduled
hours/week; the agent workforce drafts, I publish.

### If you track metrics around user engagement and retention, what are they?
None yet — zero users. The metrics infrastructure is unusually real, though: the
public metrics page computes distinct wallets, funding lineage (proving no founder
subsidy), and retention cohorts directly from the hash-chained receipts journal,
so the first cohort numbers will be independently verifiable rather than
self-reported.

### Where will most of your initial users be located?
US-centered, global by nature — agent builders in the MCP/x402 ecosystem are
concentrated in the US (SF in particular), with meaningful long-tail worldwide.

### Which category best applies to your company?
Fintech — B2B / developer infrastructure (agent payments).
[FOUNDER-INPUT: the portal offers a dropdown; pick Fintech, sub-category closest
to "payments infrastructure".]

---

## EQUITY / LEGAL

### Have you formed ANY legal entity yet?
No.

### Please list all legal entities / describe equity ownership
No entities exist. Planned: a Delaware C-Corp, 100% founder-owned (Maxwell
Calkin, CEO) at formation, standard post-incorporation option pool to follow.
Per my written operating plan, incorporation (~$500–800) deliberately triggers on
accelerator acceptance or a concrete investment commitment — not speculatively —
so acceptance fires it immediately. [FOUNDER-INPUT: confirm 100% and the CEO
title; disclose here if anyone else has ever been promised equity.]

### Have you taken any investment yet? / How much have you raised?
No. $0 raised.

### How much money do you spend per month?
Effectively $0. The infrastructure doctrine is free-tier until demand justifies
spend; the only planned cash outlays are ~$15 of USDC float for real mainnet
demo transactions and incorporation when triggered. [FOUNDER-INPUT: add your
truthful personal burn / living situation if the form asks about runway
separately.]

### How much money does your company have in the bank now? / How long is your runway?
No company bank account (no entity yet); the project is founder-funded at
near-zero cost. [FOUNDER-INPUT: personal runway in months — answer truthfully;
this is a commitment question in disguise.]

### Are you currently fundraising?
[FOUNDER-INPUT: truthful answer. Suggested if accurate: "Not actively. YC would be
the first outside capital; I'd raise a pre-seed after the batch on traction."]

---

## CURIOUS / OTHER

### What convinced you to apply to Y Combinator? Did someone encourage you to apply? Have you been to any YC events?
The honest version: my written go-to-market plan names a YC application as a
milestone because it's the strongest forcing function I know against a solo
technical founder's documented failure mode — building v0.14 instead of finding
user #2. Beyond discipline: the densest concentration of agent-builders (my
exact early market) is inside YC batches, and the agent-payments control plane
is being decided in the next 12 months by people who move fast. [FOUNDER-INPUT:
whether anyone encouraged you; any YC events attended; add truthfully or omit.]

### How did you hear about Y Combinator?
[FOUNDER-INPUT.]

### Please tell us about a time you most successfully hacked some (non-computer) system to your advantage.
[FOUNDER-INPUT: must be a true personal story. If nothing better exists, the
honest meta-answer is the operating model itself: designing a written doctrine
under which AI agents do weeks of engineering per calendar day while you spend
your hours only on judgment, review, and distribution — treating your own
attention as the constrained resource and engineering around it. Only use this
if you can defend it conversationally in an interview.]

### Please tell us in one or two sentences about the most impressive thing other than this startup that you have built or achieved.
[FOUNDER-INPUT: real achievement — music? (npm handle "isthisreality",
mcalkinmusic@gmail.com suggest a music life worth mentioning if substantial);
career; anything measurable.]

### Tell us about things you've built before. Include URLs if possible.
[FOUNDER-INPUT: prior projects with URLs. github.com/MaxwellCalkin history;
anything shipped before this repo.]

### List any competitions/awards you have won, or papers you've published.
[FOUNDER-INPUT.]

### If you had any other ideas you considered applying with, please list them.
[FOUNDER-INPUT: truthful list, or "None — this is the one I couldn't not build."
only if that's actually true.]

---

## APPENDIX — claim verification log (2026-08-08, do not submit)

| Claim in draft | Verified against |
|---|---|
| Packages live on npm, 0.13.0, Apache-2.0, published 2026-08-06 | registry.npmjs.org API query for both @agentmoney packages |
| 239-test suite + live-Postgres CI gate | docs/GOTOMARKET.md M0; grep counted 244 `it()/test()` declarations across test/ (239 is the documented release-gate count; suite has grown — safe to say "239-test") |
| Refusal JSON quoted verbatim | docs/marketing/demo/verified-transcript.txt (real captured run, 2026-08-08) |
| Mandate defaults ($10/$1/$5/ask>$2/10¢) | src/onboard.ts defaults per demo kit; transcript confirms |
| Policy enforced outside model context, exact-tuple approvals, single-use permits, new-payee throttle | README "mandate model" + docs/THREAT_MODEL.md invariants 3–5 |
| Exactly-once / hash-chained receipts / one DB transaction | README kernel description; THREAT_MODEL invariants 1, 5, 7 |
| Treasury/compliance built but NOT activated with customer funds | README "Honest v0 shortcuts"; THREAT_MODEL status section — the draft never claims a live regulated network |
| x402 ~75M tx/month @ ~$0.32 (July 2026) | README line 7 |
| ~half of x402 volume wash (CoinDesk/Artemis, Mar 2026) | task context + docs/marketing/discovery/x402-market-scan.md §1 |
| Real x402 market ~$1.1M/30d, ~$0.30 avg (May 2026) | x402-market-scan.md §1 (x402 Inc. analysis) |
| Competitive set (Coinbase Payments MCP, Stripe Link, Google AP2) | task context; consistent with GOTOMARKET "wedge" section |
| First commit 2026-07-15; ~24 days; 9 active dev days | git log --reverse |
| YC F2026 dates, late apps accepted, deal terms | ycombinator.com/apply fetched 2026-08-08; deal per ycombinator.com/deal (standard $500k: $125k/7% + $375k MFN) |
| Hosted beta built but not deployed | commit b812771 "M1 groundwork — invite-gated beta, $0 deploy profile, funnel assets"; GOTOMARKET M1 |
| "$300B+ API/SaaS spend" expansion claim | Directional TAM framing, not a sourced statistic — [FOUNDER-INPUT: keep only if you're comfortable defending it, or swap for a sourced number before submitting] |

### Pre-submission checklist for Max
1. Record the 1-minute founder video (script above) and the 60-second product
   demo (kit in docs/marketing/demo/ — every frame a real capture).
2. Fill every [FOUNDER-INPUT] — especially full-time status, runway, bio,
   cofounder stance. These are commitment probes; answer plainly.
3. Re-verify npm download counts and any market number the day you submit.
4. If the hosted beta or the first mainnet tx (hash + receipt) lands before
   submission, update "How far along" — it's the highest-leverage sentence in
   the application.
5. Total length target: most answers 2–4 sentences; trim anything over ~120
   words at the portal (this draft runs long by design so you can cut).
