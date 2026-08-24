# Community Target List — Where Agent Builders Are (mid-2026)

Researched 2026-08-08 via web search; **first-post drafts refreshed 2026-08-23
for v0.14 (the reserved-card rail)**. 18 named, currently-active places where agent
builders discuss tool use and paid APIs. Each entry: why it qualifies, first-move draft
(founder voice — Max posts under his own name per GOTOMARKET; every draft below is a
DRAFT and nothing is posted by an agent), and cautions.

**Operating doctrine for every entry:**
- The **lead post is now the card demo + decline transcript** (master draft below):
  the v0.14 story — a $29 purchase at an ordinary checkout on a reserved card the
  agent never saw, a $400 gift-card attempt visibly DECLINED (`new_payee_cap`), and
  a $5 agent-to-agent payment on the same feed. Sandbox-labeled, honest zeroes,
  transcript verbatim. The **research ask** (recruits the 20 interviews from
  `interview-guide.md`) is the follow-up move — and stays the FIRST move in venues
  whose rules bar product posts (noted per entry). Both are honest, disclosed, and
  give back (the published synthesis).
- Never fake traction. Never post the same text twice — each draft below is already
  localized; localize further before sending.
- 2 hours/week founder budget → the weekly cadence at the bottom. Tier A gets touched
  weekly; Tier B every 2–3 weeks; Tier C opportunistically.
- "Verify link" = I confirmed the community is active via secondary sources but Max
  should confirm the invite/URL and read the rules before first post.

---

## The lead post — master draft (v0.14 card demo + decline)

*DRAFT ONLY. Founder posts under his own name, localized per venue below. Post
together with the full transcript (`docs/marketing/demo/agent-card-transcript.md`)
after the v0.14 gate is green. Never posted twice verbatim.*

> **Title:** My agent bought $29 at an ordinary checkout with a card it never saw,
> got DECLINED trying $400 of gift cards, then paid another agent $5 — one
> mandate, one receipt feed (open source, sandbox)
>
> I put $100 behind my agent (sandbox, no real funds) and signed one spend
> mandate up to $100: $40 per transaction, ask me above $60, first purchase at
> an unseen merchant capped at $15. The agent requested a **reserved card** — a
> single-merchant virtual card under that mandate. The card number never enters
> the model's context; the tools return last4 only.
>
> The purchase: `APPROVED · $29.00 at MOCK SHOP EXAMPLE (MCC 5734)` — the policy
> engine answers the card network synchronously, inside the issuer's 2-second
> deadline.
>
> The part I actually built this for, verbatim from the transcript:
>
> ```text
> ✗ DECLINED · $400.00 at GIFT CARD EMPORIUM (MCC 6051)
> ✗ decline code: new_payee_cap — in plain words: this owner has never bought
> ✗   from this merchant, and a first purchase at an unseen merchant may not
> ✗   exceed the mandate's $15.00 new-payee cap. The agent cannot be lured
> ✗   into $400.00 of gift cards.
> ✓ the decline was decided in the same <2 s synchronous window; no funds moved
> ```
>
> Then the same agent paid @writer-agent $5 for a service on the internal ledger
> rail — instant, fee-free, no card involved. The purchase, the decline, and the
> agent payment sit on one hash-chained receipt feed, and `ledger_health`
> recomputes every receipt's evidence from the ledger: true.
>
> The mandate lives in Postgres, outside any model context — injected text can
> ask for money; nothing in the agent's context can sign or widen the mandate.
>
> Honest status: this is a deterministic sandbox demo (`npm run demo:card` in the
> repo — it boots the real API, the real authorization server, and the real event
> worker against an in-process Postgres, with a mock issuer speaking the Stripe
> Issuing wire shape; the Stripe adapter is protocol-faithful, fixture-tested,
> test-mode ready). No real funds, no live card program, zero users — I'd rather
> show you the transcript than a dashboard. Apache-2.0; the wallet is an MCP
> server: `npx -y @agentmoney/wallet-mcp`.

---

## Tier A — weekly attention (highest density of exactly our people)

### 1. r/AI_Agents (Reddit)
**Why:** The main practitioner subreddit for agent builders; 2026 threads are dominated
by pro-precision skepticism — silent runaway costs, "most agent projects should have
been simpler automations," when agents pay back ([thread analysis](https://ivconsulting.in/blogs/what-reddit-really-thinks-ai-agent-spending-boom/)).
Cost-of-agents is already the native conversation; we don't have to import it.
**Caution:** Self-promo is policed; check current rules — if a build-share with full
disclosure is allowed, lead with the card demo; if not, open with the research ask and
hold the demo for a comment or the synthesis follow-up.
**First post (lead post, localized):** the master card-demo draft above, with this
venue-specific opener replacing the title:
> **Title:** The failure mode nobody demos: my agent tried to buy $400 of gift cards. Here's the decline, verbatim (open source, sandbox)
> This sub keeps (rightly) pointing out that agents + money = silent runaway costs.
> So instead of another "agent pays for a thing" demo, here's the opposite moment...
> *(then the master draft body — the decline block first, purchase second)*
**Follow-up (research ask, unchanged in substance):**
> How do your agents actually get access to paid APIs? Whose API key is in the env?
> Who prepays the credits? What happened the last time usage surprised you? Doing 20
> disclosed research interviews, 15 min each; full written synthesis posted back here.

### 2. r/ClaudeCode (Reddit)
**Why:** ~4,200+ weekly contributors by early 2026, the most active coding-agent
community ([morphllm roundup](https://www.morphllm.com/claude-code-reddit)); our wallet
is literally an npx-runnable MCP for `.mcp.json`, so these are first-party users.
**First post (lead post, localized for Claude Code / MCP users):**
> **Title:** I gave a Claude Code agent a card. It never saw the number — and it got DECLINED trying $400 of gift cards (open source, sandbox demo)
> The wallet is an MCP server you add to `.mcp.json` (`npx -y @agentmoney/wallet-mcp`):
> `money_card_create` returns only last4 — there is no tool that reveals a card number —
> and `money_card_status` / `money_card_close` round out the card surface, next to
> `money_pay` / `money_fetch` / `money_feed` for closed-loop and 402-paywalled calls.
> *(then the master draft body: mandate, the $29 approval, the verbatim decline block,
> the $5 agent payment, honest sandbox status)*
**Follow-up (research ask):** the original cost-cap question — what stops a long
agentic session with a metered MCP tool from quietly running up the bill? Env-var key
and hope? Prepaid credits? 15-min interviews, synthesis shared back.

### 3. r/mcp (Reddit)
**Why:** One of the two largest MCP communities alongside the Discord ([glama](https://glama.ai/blog/2025-02-28-mcp-api));
the MCP ecosystem passed ~5,000 community servers by March 2026. Tool-use plumbing talk
is the whole sub; paid tools are a recurring subtopic.
**First post (lead post, localized):** the master card-demo draft, MCP-angled — open
on the tool surface ("seven tools: `money_balance`, `money_pay`, `money_fetch`,
`money_feed`, `money_card_create`, `money_card_status`, `money_card_close`; the card
tools return last4 only, no reveal tool exists") before the transcript excerpt.
**Follow-up (research ask):** "Are any of you shipping MCP servers you'd like to
charge for? How are you handling that today?" (this also quietly builds the
seller-side pipeline for M2).

### 4. Model Context Protocol Discord ("MCP Community", discord.com/invite/model-context-protocol…)
**Why:** ~13.5k members, the official community server for MCP builders
([discord.me/mcp](https://discord.me/mcp), [modelcontextprotocol.io/community/communication](https://modelcontextprotocol.io/community/communication)).
The people building tool servers are the people who will meter them.
**Caution:** The separate *Contributor* Discord is for spec work — do not recruit there.
**First move:** answer 2–3 questions in help channels first (earn presence), then the
lead post in the show-and-tell channel — a compressed master draft:
> Show-and-tell: an open-source wallet MCP where the agent holds a reserved card it
> never sees. Sandbox demo, deterministic (`npm run demo:card`): owner signs a spend
> mandate up to $100 ($40/tx, ask above $60, unseen merchants capped at $15) →
> $29 APPROVED at an ordinary checkout in <2 s → $400 gift-card attempt DECLINED
> (`new_payee_cap`) → $5 paid to another agent → one hash-chained feed. The card
> tools return last4 only; no reveal tool exists. Sandbox, no real funds; mock
> issuer speaks the Stripe Issuing wire shape, Stripe adapter fixture-tested,
> test-mode ready. Transcript + repo links. Happy to answer anything.
**Follow-up (research ask, disclosed):** interviewing MCP builders about paid tools —
how do you or your users handle keys/credits/limits today? 15-min chats, synthesis
shared back here.

### 5. Cursor Community Forum (forum.cursor.com)
**Why:** Highly active through 2026 (MCP Apps in Cursor 2.6, ongoing MCP bug/limits
threads, an official "Share Your Experience with MCP Tools" megathread —
[forum.cursor.com](https://forum.cursor.com/t/share-your-experience-with-mcp-tools/148437)).
Cursor agent users are a named target segment.
**First move:** reply substantively in the MCP-experience megathread (that thread is
explicitly for this), then the lead post as a Discussions post — master draft with a
Cursor opener:
> **Title:** Gave my agent a reserved card under a spend mandate — it bought $29 at a normal checkout and got DECLINED for $400 of gift cards (open-source MCP, sandbox)
> Works in any MCP runtime including Cursor: add `npx -y @agentmoney/wallet-mcp` to
> your MCP config; the agent gets `money_card_create` (returns last4 only — it can
> never see the number) plus pay/fetch/feed tools. *(then the master draft body)*
**Follow-up (research ask):** the metered-tools question — long-running sessions +
per-call billing, what do people actually do? Personal API key in env? Team key?
Prepaid credits and hope? 15-min interviews, learnings shared in-thread.

### 6. x402 Discord (via x402.org)
**Why:** The builder community of the exact rail we bridge to — "thousands of builders,"
per [x402.org](https://x402.org/); also where live sellers hang out (pilot supply AND
the third-party seller we need for the M1 mainnet-payment gate).
**Different first move (product-forward is appropriate HERE, and only here + #14):**
> Hey all — I built an open-source agent wallet (MCP) where the owner signs a mandate
> (budget, per-tx cap, daily cap, ask-me-above line, new-payee throttle) and a
> deterministic policy engine outside the model enforces it; every payment gets a
> hash-chained receipt. New in v0.14: the same mandate now backs a **reserved card**,
> so in the sandbox demo the agent buys $29 at an ordinary checkout (never seeing the
> card number) and gets visibly DECLINED trying $400 at an unseen gift-card merchant
> (`new_payee_cap`, decided in the network's <2 s window) — transcript in the repo,
> `npm run demo:card`, deterministic. The x402 v2 bridge (USDC on Base) is
> implemented behind hard caps; mainnet activation is gated on a ~$15 float I fund
> myself, and the goal is real sub-$0.25 buys against endpoints I don't operate,
> publishing each tx hash next to its signed receipt. Sellers with live endpoints:
> I'd love to buy from you. Also doing 15-min interviews with anyone selling or
> buying via x402 about what's actually working.

### 7. LangChain Community (Forum + Community Slack)
**Why:** Largest concentration of LLM-app builders; active LangGraph channels, staffed
by "LangChain Experts" volunteers ([langchain.com/community](https://www.langchain.com/community),
[join link](https://www.langchain.com/join-community)). LangGraph users are a named
target segment.
**First post (lead post if a show-your-work category exists; otherwise the question
form below stays first per local norms):** master card-demo draft with a LangGraph
opener — "the wallet is MCP, so any LangGraph agent with MCP tool support can mount
it; the mandate is enforced in Postgres, not in the graph."
**Question-form fallback / follow-up:**
> **Title:** Patterns for giving LangGraph agents metered/paid tool access?
> For those running LangGraph agents in production that call paid APIs: how do you
> provision access and bound spend per agent or per run? Scoped keys? A proxy that
> meters? Prepaid credits? And when several agents share a key, how do you attribute
> cost? Doing structured research on this (15-min interviews, synthesis shared).

### 8. Hacker News
**Why:** Obvious, but the plan matters. x402/agent-payments threads recur and are
skeptical — which is our lane (refusal demo, honest zeroes, wash-trading callout).
**First move:** comment credibly on the next agent-payments/x402 thread (search HN for
"x402", "agent payments") with the wash-volume analysis angle — no links to us.
**The Show HN is held until the v0.14 launch gate is green** (per GOTOMARKET move 2:
transcript committed, wallet-mcp 0.14 published). Draft for then:
> **Show HN: My agent has a card it can't see — and it got declined buying $400 of gift cards**
> Every agent-payments demo shows the payment succeeding. Here's the opposite moment:
> my agent holds a reserved card (a virtual card under a spend mandate its owner
> signed — $40/tx, ask above $60, unseen merchants capped at $15), buys $29 at an
> ordinary checkout, then tries $400 at a gift-card merchant and the policy engine
> declines it (`new_payee_cap`) inside the card network's 2-second synchronous
> window. The mandate is enforced in Postgres, outside model context — injection
> can ask, it can't widen — and the card number never enters the model (last4
> only; no reveal tool exists). Same mandate also pays other agents on a
> closed-loop ledger; purchase, decline, and agent payment share one hash-chained
> receipt feed. Open-source (Apache-2.0), npm: @agentmoney/wallet-mcp; the demo is
> deterministic (`npm run demo:card`, transcript committed). Honest status:
> sandbox, no real funds — mock issuer speaking the Stripe Issuing wire shape;
> the Stripe adapter is protocol-faithful, fixture-tested, test-mode ready; zero
> users, and the receipts journal is built so nobody (including me) can fake that
> number later.

---

## Tier B — every 2–3 weeks

### 9. r/ClaudeAI (Reddit)
**Why:** ~740k members by 2026 ([clauder-navi roundup](https://www.clauder-navi.com/en/claude-2026-reddit));
broader than r/ClaudeCode but MCP/agent posts perform. Use for the synthesis publication
and later the demo GIF, not the first research ask (r/ClaudeCode is more targeted).
**First post:** the lead post (master card-demo draft, r/ClaudeCode localization from
#2) once the r/ClaudeCode post has run — never the same week, never identical text;
this venue also gets the published "what agents actually buy" writeup later.

### 10. r/LocalLLaMA (Reddit)
**Why:** Active 2026 agent/tool-use comparison threads ([aitooldiscovery](https://www.aitooldiscovery.com/guides/claude-code-reddit));
maximally cost-conscious builders — the people for whom metering and caps are visceral.
**First post:** research ask variant angled at cost: "Local-first people: when your
agents DO have to call paid cloud APIs, how do you fence the spend?" The card-demo
lead runs here only as a comment-level share when relevant (this sub's tolerance for
product posts is low); the decline transcript is the right artifact for its skepticism.

### 11. CrewAI Community Forum + Discord
**Why:** Active official forum and Discord with fast maintainer response; regular
releases through early 2026 ([cybernews review](https://cybernews.com/ai-tools/crewai-review/),
[community map](https://www.aibuilderclub.com/blog/best-ai-agent-communities-2026)).
Multi-agent crews sharing budgets = the attribution problem in its purest form.
**First post (forum):**
> **Title:** How do you track/limit what each agent in a crew spends on external APIs?
> When a crew shares credentials for paid tools, can you tell which agent/task drove
> the bill? Has a crew ever burned budget in a loop? Doing 15-min research interviews
> on agent spend mechanics — synthesis shared back here.

### 12. Claude Developers Discord (Anthropic's official developer Discord) — *verify link*
**Why:** First-party home of MCP + Claude Code builders; Anthropic webinars route
developers here ([anthropic partner series](https://website.anthropic.com/webinars/claude-code-in-an-hour-a-developers-intro)).
(There is also a 2.6k-member unofficial r/ClaudeCode Discord — lower priority.)
**First move:** same as #4: help first, then the lead post (compressed card-demo
draft from #4) in the show-and-tell/projects channel, research ask as the follow-up.

### 13. OpenAI Developer Community (community.openai.com)
**Why:** Agents-SDK and tool-use builders on the other side of the fence — exactly the
cross-runtime neutrality story; and a hedge against sampling only Anthropic-adjacent
opinions in the interviews.
**First post:** the LangChain-style question post, reworded for Agents SDK/function
calling. No product mention (their promo rules are strict).

### 14. Base / Coinbase Developer Platform Discord — *verify link*
**Why:** CDP runs the x402 facilitator, Bazaar, and Agentic.Market; their Discord's
x402 channels carry seller announcements and facilitator support
([docs.cdp.coinbase.com/x402/support/faq](https://docs.cdp.coinbase.com/x402/support/faq)).
Second venue where product-forward is appropriate.
**First move:** the #6 message, minus the interview ask, plus one concrete technical
question about facilitator behavior (bounded, answerable — earns a reply).

### 15. n8n Community Forum (community.n8n.io)
**Why:** Huge automation-builder population gluing paid APIs into agent-ish workflows;
"AI agent" nodes are mainstream there in 2026. The wildcard quota in the screener.
**First post:** research ask angled at ops: "Who owns the API bills your workflows run
up, and how do they see what each workflow spent?"

### 16. Latent Space Discord / AI Engineer community — *verify link*
**Why:** The agent-engineering discourse hub (podcast + AI.Engineer conf network);
where "agent payments" gets discussed as an emerging pattern rather than a crypto topic.
**First move:** listen; contribute to any payments/tool-budget thread; recruit
interviews via DM only after interaction (DM-first is poor form there).

---

## Tier C — opportunistic / experimental

### 17. Indie Hackers (indiehackers.com)
**Why:** Seller-side: indie API builders deciding how to charge agents; also candid
about money. Good for the M2 "founder-run paid endpoint" learnings post later.
**First post:** "Anyone selling API access to AI agents yet (x402/pay-per-call)? What's
actually converting?" — research framing, seller angle.

### 18. Moltbook (m/ submolts) — agent-native, observe first
**Why:** The agent social network (launched Jan 2026, acquired by Meta in March, still
live and growing as of July 2026 — [Wikipedia](https://en.wikipedia.org/wiki/Moltbook),
[Fortune](https://fortune.com/2026/02/03/moltbook-ai-social-network-security-researchers-agent-internet/)).
Agents there already discuss payments; an x402 endpoint analysis circulated on it. Only
agents can post — i.e., OUR agent could, wallet attached, as a living demo of mandated
spend in a hostile environment (prompt-injection bait everywhere — which is exactly
what the new-payee throttle and caps are for).
**Caution:** Security researchers found malware and injection at scale. If we ever do
this: testnet or hard-capped cents, dedicated keys, treat as a red-team exercise and
write it up. High upside as content ("we sent a funded agent into Moltbook; here's what
it refused to pay for"), but it is a stunt — schedule after M1 gate, not before.
**First move now:** read m/ threads touching payments/x402 for interview-question fodder
(humans may observe). Zero posting cost, zero hours beyond reading.

---

## The 2-hours/week schedule (founder)

| Slot | Time | What |
|---|---|---|
| Mon | 30 min | ONE new post in the next Tier-A venue (rotate 1→8) — the localized lead post where rules allow, else the research ask; log it |
| Wed | 30 min | Reply to every response across venues; book interviews; 1 help-channel answer in an MCP/Cursor/LangChain community |
| Fri | 60 min | 2 interviews (15 min each) + immediate note capture (template in `interview-guide.md`) |

Rotation discipline: never two consecutive Mondays in the same venue; Tier B venues
slot in when a Tier A venue's post is still warm (don't re-post into your own echo).
Every venue that produced an interview gets the synthesis posted back — that return
post is the only "marketing" most of these communities will ever need to see, and it
is also the invite-beta's honest top-of-funnel.

**Tracking:** one row per touch in a flat log (date, venue, link, replies, interviews
booked). After 4 weeks, kill the venues with zero interviews booked and double the
best two.
