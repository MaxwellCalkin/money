# Customer Discovery Kit — 20 Problem Interviews with Agent Builders

Prepared 2026-08-08 for the M2 "Discovery before recruiting" line in `docs/GOTOMARKET.md`.
Founder-voice artifact: Max runs these; the agent synthesizes (see `synthesis-template.md`).

**Objective.** Learn, from people who actually run agents, (1) what agents consume that
costs money, (2) how access to paid things is provisioned today, (3) how far builders
already delegate spend and what stops them going further, (4) which policy and evidence
primitives they'd need — WITHOUT pitching agentmoney. Pilots get recruited against these
findings, not cold.

**Hypotheses under test** (never read these to the interviewee; the questions below are
written so the interviewee can falsify them):

- H1: Agents already consume paid third-party services mid-run (search, scraping,
  inference, data) at meaningful frequency.
- H2: The dominant provisioning workaround is a human's shared API key or prepaid
  platform credits, and it causes real incidents (surprise bills, leaked keys, dead runs).
- H3: Builders will delegate bounded spend to agents if the bound is deterministic and
  outside the model — but today they either watch every run or cap via prepayment.
- H4: Someone other than the builder (manager, client, finance) eventually asks what the
  agent did/spent, which makes receipts and refusals valuable.

**Anti-goals.** No feature pitches, no "would you use X?" questions, no demo until the
final 90 seconds and only if they ask or as a thank-you. A compliment is not data.

---

## 1. Screener (2 minutes, async — DM/comment thread)

Qualify with five questions. Target mix across the 20:

| Quota | Target |
|---|---|
| Coding-agent users (Claude Code / Cursor / Cline / Copilot agent mode) | ~8 |
| Framework builders (LangGraph / CrewAI / AG2 / Mastra / custom) | ~8 |
| Wildcards (n8n/automation, agent-native experiments, x402 sellers) | ~4 |
| Of the 20: currently paying for ≥1 third-party API their agent calls | ≥10 |
| Of the 20: building for someone else (users, team, client) not just self | ≥10 |

Screener questions:

1. In the last 3 months, have you built or run an AI agent that calls external tools or
   APIs (not just chat)? → must be **yes**.
2. What do you build with — Claude Code, Cursor, LangGraph, CrewAI, something custom? (record)
3. Do any of the services your agent touches cost money per use? (record; "no" is still
   a valid cohort — avoidance is a finding)
4. Is this for work, a product you ship, or personal projects? (record)
5. Up for a 15-minute call this week? I'm doing research interviews, not selling anything.

Disqualify: people who have only *read about* agents; vendors who want to sell to us
(log them separately — some are seller-side pipeline for M2).

## 2. Recruiting script (paste-ready)

> Hey — I'm doing a short research project on how people who build AI agents handle the
> tools and APIs those agents use, especially paid ones. 15 minutes, no pitch, I'm in
> build-and-learn mode myself and I'll share the written synthesis with everyone who
> talks to me. Would this week work?

If asked "what are you building?": be honest and brief — "payments/spend-control
infrastructure for agents — which is exactly why I don't want to pitch it; I need the
unvarnished version of how you do things today." Honesty is the brand; hiding it reads
as market research spam.

Consent line at booking or call start: "OK if I take notes / record for my own use only?
Nothing gets published with your name unless you explicitly OK it later."

---

## 3. The 15-minute guide (time-boxed)

Print this page. The bolded questions are the spine; everything else is optional probes.
Ask about the **last specific time**, never about the future. Silence is a tool — let
them fill it.

### 0:00–1:00 — Frame

"Thanks — 15 minutes, I'll watch the clock. I'm researching how agent builders handle
external services, especially paid ones. I want stories about what actually happened,
not predictions. Nothing to sell you today. OK to take notes?"

### 1:00–4:00 — The agent and what it consumes

- **"Walk me through the most recent agent you built or ran that did something useful.
  What was it doing?"**
- **"During a run, what outside services does it touch?"** (list them out loud with the
  interviewee — this list is the raw material for the 'what agents buy' artifact)
- Probe: "Which of those cost money — per call, per month, credits?"
- Probe: "How often does that agent actually run?" (daily? on demand? cron?)

*Listening for: concrete services + frequency. Write down every named vendor.*

### 4:00–7:30 — How paid access is provisioned today (workaround archaeology)

- **"Pick one paid service it uses. How did the agent get access to it — mechanically,
  what happened?"** (expected answers: my personal API key in an env var, a shared org
  key, a platform's prepaid credits, a proxy/gateway someone runs, OAuth)
- **"Who pays that bill, and what do they see about what the agent used?"**
- **"Tell me about the last time usage or cost surprised you."** Probe: "What did you
  change the next day?"
- Probe: "Has an agent ever died mid-run because a key was invalid, a quota ran out, or
  credit hit zero? What did that cost you?"

*Listening for: workaround archetype, incident stories with numbers, who feels the pain
(builder vs. payer vs. ops).*

### 7:30–11:00 — Delegation of spend

- **"Has an agent ever needed something mid-run it had no access to — a dataset, an API,
  compute, content? What did it do, and what did you do?"**
- **"When one of your agents needs a NEW paid service today, walk me through the steps
  from 'it needs it' to 'it has it'."** (count the human steps out loud)
- **"Is there any spending your agents do today where you don't look at each individual
  transaction?"** If yes: "What bounds it?" If no: "What stops you?" (the named fear is
  a requirement, verbatim)
- Probe: "What's the most an agent-initiated action has ever cost you in one shot?"
- Probe (only if they run multi-agent systems): "When several agents share one budget or
  key, how do you tell who spent what?"

*Never ask "would you let your agent spend money?" — hypothetical. The past-tense
versions above get the truth.*

### 11:00–13:30 — Controls, trust, evidence

- **"When you handed the agent that key or credit, did you do anything to limit the
  damage if it went wrong? What, concretely?"** (spend alerts? scoped key? nothing?)
- **"Has an agent ever used money or quota in a way you didn't intend? Walk me through it."**
  (prompt injection, runaway loop, wrong endpoint, retry storm)
- **"Besides you, who ever asks what an agent did or spent?"** (manager, client, finance,
  security, auditor, nobody)
- **"After a run, what do you actually look at to know what it cost?"** (dashboard? the
  invoice at month end? nothing?)

*Listening for: whether any control is deterministic vs. vibes; whether evidence has an
audience; whether "nothing, I just trust it" is said with comfort or discomfort.*

### 13:30–15:00 — Rank, snowball, optional reveal

- **"Of everything we touched, what's the single most annoying part of how this works
  today?"** (their ranking, not ours)
- **"Who else do you know running agents that touch paid services? Intro or a name I can
  mention you sent me?"** (this is how 6 interviews become 20)
- "Want the written synthesis when I'm done?" (collect follow-up permission — this list
  is also the pilot waitlist seed, but do not say that)
- Only now, if they ask or as thanks: two honest sentences — "I'm building a neutral
  spend account for agents: the owner signs a mandate (budget, per-tx cap, ask-me-above
  line), a deterministic engine outside the model enforces it, and every payment gets a
  hash-chained receipt. There's an invite-only, testnet-labeled beta if you ever want to
  poke at it." Stop there. Log their reaction verbatim but treat it as color, not data.

---

## 4. Discipline rules (read before every call)

1. **Past tense beats future tense.** Every "would you…" gets rewritten to "when did you
   last…". If you can't, drop the question.
2. **Compliments are deflections.** "That sounds really useful" → "What do you do today
   instead?"
3. **Generics get grounded.** "We always have cost issues" → "Tell me about the most
   recent one."
4. **Numbers or it didn't hurt.** Chase the dollar figure, the hours lost, the number of
   human steps. Pain without a number is a shrug.
5. **If you pitch before 13:30, mark the interview as contaminated** in the notes
   (`pitched_early: true`) — its enthusiasm data is void; its factual data still counts.
6. **Unprompted beats prompted.** A policy need they name themselves (e.g. "I wish I
   could cap it per day") is gold; the same need after you suggest it is lead. Tag which.

## 5. Per-interview note template (5 min, immediately after the call)

```yaml
id: INT-##              # INT-01 … INT-20
date:
source_community:        # where recruited (see community-target-list.md)
runtime:                 # claude-code | cursor | cline | langgraph | crewai | custom | n8n | other
role:                    # hobbyist | indie | startup-eng | enterprise | agency
builds_for:              # self | team | customers
agents_described:        # one line each
services_consumed:       # EVERY named vendor/tool, paid or not — mark paid ones with $
paid_monthly_estimate:   # only if they said a number; never infer
who_pays:                # personal card | company | client | platform credits
provisioning_archetype:  # personal-key-in-env | shared-org-key | per-agent-key |
                         # prepaid-credits | proxy-gateway | human-in-loop | avoidance-built-own
worst_incident:          # verbatim-ish story + $ or hours if given
delegation_level:        # L0 human executes every purchase
                         # L1 agent uses pre-provisioned key, human watches runs
                         # L2 agent spends inside prepaid credit, human reviews after
                         # L3 agent spends under limits, human reviews exceptions only
                         # L4 agent acquires NEW services autonomously
delegation_blocker:      # the named fear, verbatim, if at L0–L2
policy_asks_unprompted:  # limits/caps/approvals/receipts THEY named
policy_asks_prompted:    # ones that surfaced only after a probe
evidence_audience:       # nobody | self | manager | finance | client | auditor
quotes:                  # >=3 verbatim quotes with context
top_annoyance:           # their own ranking from 13:30
referrals:               # names/handles
followup_ok:             # yes/no + email/handle
pitched_early: false
interviewer_errors:      # leading questions you caught yourself asking
```

## 6. Logistics

- **Cadence:** 2 founder hours/week (per GOTOMARKET division of labor). Realistic pace:
  2–3 interviews/week booked from community posts (see `community-target-list.md`),
  done in weeks 1–8 of M2. Front-load recruiting; interviews snowball via referrals.
- **Scheduling:** a single "15-minute research chat" booking link; buffer 10 min after
  each for notes. Calls > async text — but accept async written answers from otherwise
  unreachable good-fit people (tag `async: true`; weigh slightly lower).
- **Recording:** notes by default; record only with explicit consent.
- **Compensation:** none — the promised synthesis writeup is the compensation, and it
  doubles as an M2 distribution artifact. Never offer beta credits as inducement (it
  selects for freebie-hunters and violates the honest-zeroes ethos).
- **Stop condition:** after 20, or earlier if the last 4 interviews produced zero new
  tags in the synthesis rollup (saturation).
