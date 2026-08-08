# Synthesis Template — 20 Agent-Builder Interviews

Agent-side artifact (per GOTOMARKET division of labor: founder interviews, agent
synthesizes). Fill from the per-interview YAML notes in `interview-guide.md` §5.
Output feeds three things: (1) the published **"what agents actually buy"** target list
(M2 deliverable), (2) pilot recruiting criteria, (3) the M2 kill/pivot decision.

## 1. Coding rubric (apply the same tags to every interview)

**What agents consume (tag every named service):**
`search` · `scraping` · `inference/llm` · `data-api` (market/social/geo/weather/…) ·
`compute/gpu` · `storage` · `browser-infra` · `comms` (sms/email) · `real-world-goods`
(gift cards, top-ups) · `content-access` (paywalled docs) · `verification/qa` · `other`

**Provisioning archetypes:**
`personal-key-in-env` · `shared-org-key` · `per-agent-key` · `prepaid-credits` ·
`proxy-gateway` · `human-in-loop-purchase` · `avoidance-built-own` · `no-paid-use`

**Pain events (only count events that actually happened):**
`surprise-bill` · `runaway-loop/retry-storm` · `key-leak-or-rotation-fire` ·
`run-died-at-limit` · `procurement-delay` · `no-attribution` (can't tell which
agent/task spent what) · `injection-or-abuse-scare` · `refund/dispute-dead-end`

**Intensity scale per pain event:** 1 = mentioned · 2 = caused a workflow change ·
3 = caused spend, a build, or an executive/finance escalation.

## 2. Rollup tables (the core artifact)

### 2a. What agents actually buy (n = 20)

| Consumption tag | # interviews | Named vendors (dedup) | Freq (runs/wk median) | Who pays | Best quote |
|---|---|---|---|---|---|
| search | | | | | |
| scraping | | | | | |
| inference/llm | | | | | |
| … | | | | | |

### 2b. Provisioning archetypes

| Archetype | # interviews | Typical runtime | Best quote | Observed failure |
|---|---|---|---|---|

### 2c. Pain events (frequency x intensity)

| Pain event | # occurrences | Σ intensity | $ figures heard | Quote |
|---|---|---|---|---|

### 2d. Delegation ladder distribution

| Level | Count | Blockers named verbatim (L0–L2 only) |
|---|---|---|
| L0 | | |
| L1 | | |
| L2 | | |
| L3 | | |
| L4 | | |

### 2e. Policy primitives demanded

Count **unprompted** and **prompted** separately — unprompted is demand, prompted is
polite agreement.

| Primitive (map to our mandate model) | Unprompted | Prompted | Quotes |
|---|---|---|---|
| total budget | | | |
| per-transaction cap | | | |
| daily/weekly cap | | | |
| ask-me-above / escalation | | | |
| new-payee throttle / allowlist | | | |
| receipts / audit trail | | | |
| refusal visibility ("show me what it tried") | | | |
| per-agent attribution | | | |
| something we DON'T have | | | |

The last row is the most important row in the document.

## 3. Decision thresholds (pre-committed, so the data decides)

Set BEFORE synthesis; grounded in the GOTOMARKET M2 gate and kill criteria.

- **Recruit-pilots signal:** ≥8/20 report a concrete pain event (intensity ≥2) around
  agent access to paid services in the last 90 days → recruit the first 10 pilots from
  the archetype+consumption cells with the highest Σ intensity, using the exact vendors
  they named as the demo path.
- **Demand-wedge check (feeds the M2 kill criterion):** if <4/20 have ANY paid
  third-party consumption by their agents today, x402-native demand is not real yet →
  strengthen the pre-drafted pivot: mandate/receipt layer over conventional API spend
  (search, scraping, inference on cards/invoices), where 2b says budgets already exist.
- **Delegation readiness:** count at L2+ = the real TAM for autonomous spend this
  quarter. If ≥6/20 are at L2+ already, autonomy is not the blocker — policy and
  attribution are; lead with refusal + receipts. If ≤3/20, lead with the escalation
  inbox (human approves, agent executes) as the on-ramp.
- **Evidence audience:** if ≥5/20 name an external evidence audience (finance, client,
  auditor), the wash-proof receipts page graduates from differentiator to headline.

## 4. Publication pass ("what agents actually buy" — public artifact)

- Publish counts, medians, and anonymized quotes only; get explicit OK for any named
  quote. Honest zeroes stay in ("0 of 20 had let an agent buy a NEW service
  autonomously" is a publishable, credibility-building sentence if true).
- Structure: 1-page summary → table 2a → archetype gallery (2b) with failure stories →
  delegation ladder chart → "what we're doing about it" (one paragraph, links to the
  invite beta). Post back to every community the interviewees came from (closes the
  loop promised in the recruiting script).

## 5. Interview quality audit (before trusting the data)

- `pitched_early` count: ___ / 20 (enthusiasm data from these is void)
- Leading-question incidents from `interviewer_errors`: ___
- Async responses: ___ (weigh lower)
- Source-community concentration: no single community >8/20 (else the sample is a bubble)
- Runtime mix vs. quota (interview-guide §1): met? If coding-agent users dominate,
  label conclusions accordingly — do not generalize to framework builders.
