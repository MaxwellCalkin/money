# Community Target List — Where Agent Builders Are (mid-2026)

Researched 2026-08-08 via web search. 18 named, currently-active places where agent
builders discuss tool use and paid APIs. Each entry: why it qualifies, first-move draft
(founder voice — Max posts under his own name per GOTOMARKET), and cautions.

**Operating doctrine for every entry:**
- The first post is almost always the **research ask** (recruits the 20 interviews from
  `interview-guide.md`), not a product post. It is honest, disclosed, and gives back
  (the published synthesis). This is both the ethical move and the only move most of
  these communities' rules allow.
- Never fake traction. Never post the same text twice — each draft below is already
  localized; localize further before sending.
- 2 hours/week founder budget → the weekly cadence at the bottom. Tier A gets touched
  weekly; Tier B every 2–3 weeks; Tier C opportunistically.
- "Verify link" = I confirmed the community is active via secondary sources but Max
  should confirm the invite/URL and read the rules before first post.

---

## Tier A — weekly attention (highest density of exactly our people)

### 1. r/AI_Agents (Reddit)
**Why:** The main practitioner subreddit for agent builders; 2026 threads are dominated
by pro-precision skepticism — silent runaway costs, "most agent projects should have
been simpler automations," when agents pay back ([thread analysis](https://ivconsulting.in/blogs/what-reddit-really-thinks-ai-agent-spending-boom/)).
Cost-of-agents is already the native conversation; we don't have to import it.
**Caution:** Self-promo is policed; research asks with disclosure are the accepted form.
**First post (research ask):**
> **Title:** How do your agents actually get access to paid APIs? (research, will share results)
> I'm interviewing 20 agent builders about something unglamorous: the mechanics of how
> an agent gets to use paid services. Whose API key is in the env? Who prepays the
> credits? What happened the last time usage surprised you?
> Disclosure: I'm building in the payments-infra space, which is exactly why I want the
> unvarnished current-state, not opinions about my thing — no links, nothing to sell.
> If you run agents that touch paid APIs (search, scraping, inference, data), I'd love
> 15 minutes this week. Comment or DM. I'll post the full written synthesis back here.

### 2. r/ClaudeCode (Reddit)
**Why:** ~4,200+ weekly contributors by early 2026, the most active coding-agent
community ([morphllm roundup](https://www.morphllm.com/claude-code-reddit)); our wallet
is literally an npx-runnable MCP for `.mcp.json`, so these are first-party users.
**First post:**
> **Title:** Those of you wiring MCP tools that cost money into Claude Code — how do you cap it?
> Genuine question, doing research interviews (not selling in this post). If Claude Code
> can call a tool that bills per use — search, scraping, an LLM gateway — what stops a
> long agentic session from quietly running up the bill? Env-var key and hope? Prepaid
> credits? Watching every run? Has anyone had a session surprise them on cost?
> I'm collecting 15-min interviews with builders on this and will share the synthesis.

### 3. r/mcp (Reddit)
**Why:** One of the two largest MCP communities alongside the Discord ([glama](https://glama.ai/blog/2025-02-28-mcp-api));
the MCP ecosystem passed ~5,000 community servers by March 2026. Tool-use plumbing talk
is the whole sub; paid tools are a recurring subtopic.
**First post:** same research ask as #2 but MCP-generic ("an MCP server that bills per
call") + one concrete question: "Are any of you shipping MCP servers you'd like to
charge for? How are you handling that today?" (this also quietly builds the seller-side
pipeline for M2).

### 4. Model Context Protocol Discord ("MCP Community", discord.com/invite/model-context-protocol…)
**Why:** ~13.5k members, the official community server for MCP builders
([discord.me/mcp](https://discord.me/mcp), [modelcontextprotocol.io/community/communication](https://modelcontextprotocol.io/community/communication)).
The people building tool servers are the people who will meter them.
**Caution:** The separate *Contributor* Discord is for spec work — do not recruit there.
**First move:** answer 2–3 questions in help channels first (earn presence), then in
the general/show-and-tell channel:
> Building research: I'm interviewing MCP builders about paid tools — servers that cost
> money per call (yours or third-party ones you wire in). How do you or your users
> handle keys/credits/limits today? 15-min chats, synthesis shared back here.
> Context, disclosed: I ship an open-source wallet MCP, but this ask is about how you do
> it *today*, not about my thing.

### 5. Cursor Community Forum (forum.cursor.com)
**Why:** Highly active through 2026 (MCP Apps in Cursor 2.6, ongoing MCP bug/limits
threads, an official "Share Your Experience with MCP Tools" megathread —
[forum.cursor.com](https://forum.cursor.com/t/share-your-experience-with-mcp-tools/148437)).
Cursor agent users are a named target segment.
**First move:** reply substantively in the MCP-experience megathread (that thread is
explicitly for this), then a Discussions post:
> **Title:** How are you handling MCP tools that cost money per call?
> Long-running agent sessions + metered tools (search APIs, scrapers, LLM gateways) =
> a bill nobody is watching mid-run. Curious what people actually do: personal API key
> in env? Team key? Prepaid credits and hope? Also collecting 15-min research
> interviews on this — will share what I learn in this thread.

### 6. x402 Discord (via x402.org)
**Why:** The builder community of the exact rail we bridge to — "thousands of builders,"
per [x402.org](https://x402.org/); also where live sellers hang out (pilot supply AND
the third-party seller we need for the M1 mainnet-payment gate).
**Different first move (product-forward is appropriate HERE, and only here + #14):**
> Hey all — I built an open-source agent wallet (MCP) where the owner signs a mandate
> (budget, per-tx cap, daily cap, ask-me-above line, new-payee throttle) and a
> deterministic policy engine outside the model enforces it; every payment gets a
> hash-chained receipt. I'm bridging it to x402 on Base behind hard caps (≤$0.25/tx)
> and want to make real sub-$0.25 buys against endpoints I don't operate, publishing
> each tx hash next to its signed receipt. Sellers with live endpoints: I'd love to buy
> from you this week. Also doing 15-min interviews with anyone selling or buying via
> x402 about what's actually working.

### 7. LangChain Community (Forum + Community Slack)
**Why:** Largest concentration of LLM-app builders; active LangGraph channels, staffed
by "LangChain Experts" volunteers ([langchain.com/community](https://www.langchain.com/community),
[join link](https://www.langchain.com/join-community)). LangGraph users are a named
target segment.
**First post (forum, question form — matches local norms):**
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
**The Show HN is held until the M1 demo is real.** Draft for then:
> **Show HN: An agent wallet that REFUSES — deterministic spend mandates for AI agents**
> Every agent-payments demo shows the payment succeeding. Here's the opposite: my agent
> tries a $0.40 call, its owner-signed mandate caps it at $0.25, and the policy engine
> (outside the model, injection can't widen it) refuses — with a hash-chained receipt
> of the refusal. Open-source (Apache-2.0), npm: @agentmoney/wallet-mcp. Real mainnet
> x402 purchase from a seller we don't operate, tx hash published beside the signed
> receipt. Honest status: invite-only testnet-labeled beta on a single free-tier VM.

---

## Tier B — every 2–3 weeks

### 9. r/ClaudeAI (Reddit)
**Why:** ~740k members by 2026 ([clauder-navi roundup](https://www.clauder-navi.com/en/claude-2026-reddit));
broader than r/ClaudeCode but MCP/agent posts perform. Use for the synthesis publication
and later the demo GIF, not the first research ask (r/ClaudeCode is more targeted).
**First post:** cross-post the r/ClaudeCode research ask only if r/ClaudeCode response
is thin; otherwise save this venue for the published "what agents actually buy" writeup.

### 10. r/LocalLLaMA (Reddit)
**Why:** Active 2026 agent/tool-use comparison threads ([aitooldiscovery](https://www.aitooldiscovery.com/guides/claude-code-reddit));
maximally cost-conscious builders — the people for whom metering and caps are visceral.
**First post:** research ask variant angled at cost: "Local-first people: when your
agents DO have to call paid cloud APIs, how do you fence the spend?"

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
**First move:** same as #4: help first, then the research ask in the appropriate channel.

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
| Mon | 30 min | ONE new research post in the next Tier-A venue (rotate 1→8); log it |
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
