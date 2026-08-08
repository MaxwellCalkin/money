# What Can an Agent Buy TODAY — x402 Market Scan (2026-08-08)

Pilot shopping list for the M1 gate ("one real mainnet x402 payment to a third-party
seller we don't operate, tx hash published beside its signed receipt") and raw material
for interview probes and pilot recruiting. All claims sourced from public pages found
2026-08-08; **re-verify each price against the live 402 challenge before demo day** —
registry rows go stale.

## 1. Market shape (honest numbers)

- Last-30-days snapshot as of May 30, 2026: **3.69M transactions, $1.11M volume,
  ~$0.30 average price, 189.9k buyers, 43k sellers** — volume collapsed from the
  speculative peak while transaction count *rose*, i.e. noise left, real machine
  usage stayed ([x402 Inc. market analysis](https://note.com/x402inc/n/nfd6227f13b55)).
- Cumulative protocol stats cited at Agentic.Market launch (April 2026): 165M+
  transactions, ~$50M+ volume, 480k+ agents
  ([Coinbase launch post](https://www.coinbase.com/developer-platform/discover/launches/agentic-market)).
- The wash caveat we market against: public analyses showed roughly half of historical
  x402 volume was self-dealing (per our GOTOMARKET review). Genuine demand concentrates
  in **machine-readable data consumed by agents** and **LLM/inference gateways** — the
  two categories our pilots should buy from.

## 2. Where agents find things to buy (discovery layers)

| Directory | What it is | Notes |
|---|---|---|
| [x402 Bazaar](https://docs.cdp.coinbase.com/x402/bazaar) | Coinbase CDP's machine-readable index: prices, limits, example calls | Free to list — our M2 founder-run endpoint goes here |
| [Agentic.Market](https://www.coinbase.com/developer-platform/discover/launches/agentic-market) | Curated public directory (Apr 2026): ~70 services in 7 categories (reasoning, data, media, search, social, infra, trading), live per-listing metrics (calls, unique payers, last-active) | No API keys/accounts; each listing shows pricing + example call — use its live metrics to pick genuinely-active sellers |
| [usdc.org/x402 registry](https://usdc.org/x402) | Circle's registry of sites accepting x402 USDC | Source of the seller table below |
| [awesome-x402](https://github.com/xpaysh/awesome-x402) | Community-maintained list | Long tail; freshness varies |

## 3. Live sellers with real pricing (the shopping list)

Verified-price rows first (price seen in provider docs), then registry-listed rows
(price per registry, verify live).

### Data / search / scraping — the genuine-demand core

| Seller | What the agent buys | Price | Network | Source |
|---|---|---|---|---|
| **Exa** | `/search` (instant/auto/fast) | **$0.007/req** (deep $0.012, deep-reasoning $0.015; +$0.001/result for summaries) | Base + Solana, USDC | [Exa x402 guide](https://exa.ai/docs/reference/x402-guide) |
| **Exa** | `/contents` (page text/highlights/summary) | **$0.001/page** | Base + Solana | same |
| **Firecrawl** | scrape → clean markdown; also `/v1/x402/search` | **~$0.01/scrape** | Base | [Coinbase case study](https://www.coinbase.com/developer-platform/discover/case-studies/firecrawl) |
| **Zyte** | full-stack scraping w/ anti-bot bypass, no account | pay per page | Base | [usdc.org registry](https://usdc.org/x402) |
| **twit.sh** | real-time X/Twitter data, X-v2-compatible JSON | pay per request (was $207/22k tx ≈ ~$0.009 avg in May-2026 data) | Base | [twit.sh](https://twit.sh/), [market analysis](https://note.com/x402inc/n/nfd6227f13b55) |
| **StableEnrich** | aggregated enrichment (Apollo, Clado, Exa, Firecrawl, Google Maps, Serper, Whitepages) | per call (top seller by volume: $3.12k/108k tx ≈ ~$0.03 avg) | Base | [market analysis](https://note.com/x402inc/n/nfd6227f13b55) |
| **CoinGecko** | crypto market data | **$0.01/req** | Base | [usdc.org registry](https://usdc.org/x402) |
| **Neynar** | Farcaster social data | **$0.01/req** | Base | same |
| **Nansen AI** | on-chain research | per query | Base | [market analysis](https://note.com/x402inc/n/nfd6227f13b55) |
| **Token Metrics / DappLooker / Einstein AI / Heurist** | crypto analytics, on-chain intel, agent skills | per call/query | Base | [usdc.org registry](https://usdc.org/x402) |
| **weather.hugen.tokyo** | weather API (JP) | per call (~$0.0126 avg observed) | Base | [market analysis](https://note.com/x402inc/n/nfd6227f13b55) |

### Inference / compute

| Seller | What the agent buys | Price | Network | Source |
|---|---|---|---|---|
| **BlockRun** | 41–55 LLMs (GPT/Claude/Gemini/DeepSeek), OpenAI-compatible, plus live-data APIs + code exec; MCP available | **from $0.003/req**; paid models from $0.10/M tokens; provider cost + 5% | Base + Solana | [blockrun.ai](https://blockrun.ai/), [SDK](https://github.com/BlockRunAI/blockrun-llm-ts) |
| **Hyperbolic** | GPU inference | pay per millisecond | Base | [usdc.org registry](https://usdc.org/x402) |
| **HYRE Agent** | DeFi intelligence | per call ($1.42k/32k tx ≈ ~$0.044 avg) | Base | [market analysis](https://note.com/x402inc/n/nfd6227f13b55) |

### Infrastructure / storage / content / real-world

| Seller | What the agent buys | Price | Network | Source |
|---|---|---|---|---|
| **Pinata** | IPFS storage/uploads | **$0.10/GB** | Base | [usdc.org registry](https://usdc.org/x402) |
| **Browserbase** | serverless cloud browser sessions | per session | Base | same |
| **Stack Overflow** | content access for AI crawlers | pay per crawl | Base | same |
| **Bitrefill** | gift cards, mobile top-ups, eSIMs (real-world goods!) | varies | Base | same |
| **kenoodl verify** | external code-claim verification for coding agents | **$0.10/req** | Base | [kenoodl.com/agentic-market](https://kenoodl.com/agentic-market/) |
| **tip.md** | tipping repos/sites | user-set | Base | [usdc.org registry](https://usdc.org/x402) |
| **Postera** | agent publishing, pay-per-read | per read | Base | same |
| **x402.org demo endpoint** | protocol smoke test | <$0.01 | Base | same |

### Rails and facilitators (context, not purchases)

Coinbase CDP facilitator (1,000 tx/mo free then $0.001/tx; Base, Polygon, Arbitrum,
World, Solana) · Stripe x402 private preview (1.5%/charge, USDC on Base, fiat
settlement) · Circle Gateway (batched nanopayments) · Cloudflare Monetization Gateway
(early access) · thirdweb (0.3%) · PayAI (10k settlements/mo free) · AWS AgentCore
buyer-side orchestration (preview) — [wavect comparison, facts verified 2026-07-12](https://wavect.io/blog/x402-payments-comparison-2026/),
[Coinbase+AWS](https://www.coinbase.com/blog/coinbase-and-aws-let-publishers-accept-agents-as-customers-via-x402).
Platform caps exist (Coinbase Payments MCP session caps, Stripe agent approvals) —
none are neutral, none produce portable wash-proof evidence; that stays our wedge.

## 4. The pilot purchase sequence (maps to M1 gate, ≤$0.25/tx, ≤$10 total float)

1. **Dry run** — x402.org demo endpoint on Base Sepolia (regression env per GTM), then
   the same on mainnet (<$0.01): proves plumbing, not economics.
2. **First real third-party buy** — **Exa `/search` at $0.007**: cheapest genuinely
   useful purchase from a major seller we don't operate; result is demo-visible
   (agent researches something mid-task in Claude Code). Publish tx hash + signed
   receipt → this alone satisfies the M1 payment clause.
3. **Second buy, different category** — **Firecrawl scrape ~$0.01** or **CoinGecko
   $0.01**: shows the wallet works across sellers, not one integration.
4. **The REFUSAL shot (hero moment)** — mandate with per-tx cap **$0.05**; agent
   attempts **kenoodl verify at $0.10** (a real third-party price, not a strawman) →
   deterministic refusal, receipt of the refusal, owner escalation inbox shows the
   exact tuple. Then the owner approves, and the exact approved payment executes.
   Every competitor demo shows success; ours shows the *no*, then the governed *yes*.
5. **New-payee throttle shot** — first-touch payment to a never-seen seller capped at
   cents: attempt BlockRun ($0.003 — passes) vs. attempt HYRE (~$0.04 avg — blocked on
   first touch). Real sellers, real prices, no faked endpoints.
6. **Recurring-workflow candidate for M2 retention** — BlockRun (inference is a daily
   need; $5 lasts thousands of requests) or Exa+Firecrawl in a daily research agent:
   the "each active in ≥3 distinct weeks" gate needs a purchase someone repeats.

Budget check: the full sequence above costs well under $1 of the ~$15 float; caps
(≤$0.25/tx) hold for every listed purchase.

## 5. Gaps the scan exposes (interview probes + positioning ammo)

- Fiat-priced API giants (OpenAI, Google Maps proper, Twilio) still sell via
  cards/invoices, not x402 — resellers (BlockRun, StableEnrich) arbitrage the gap.
  If interviews show budgets live there (likely), that is the M2 pivot lane already
  named in GOTOMARKET: mandate real-world API spend where budgets exist.
- Firecrawl added x402 after a community ask for exactly our story — "let AI agents
  pay per scrape autonomously (no shared API keys)"
  ([firecrawl issue #3279](https://github.com/firecrawl/firecrawl/issues/3279));
  same ask pending at Exa's MCP server ([exa-mcp-server #253](https://github.com/exa-labs/exa-mcp-server/issues/253)).
  Sellers are being pushed toward agent-native payments by their own users — those
  issue threads are literally lists of people to interview.
- Nobody in the table above offers buyer-side policy beyond "pay or don't" — pricing is
  seller-set, enforcement is wallet-side. The mandate layer remains unoccupied ground.
