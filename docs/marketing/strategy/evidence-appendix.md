# Appendix — evidence links

*Companion to `wedge-memo.md`. All links located or re-checked 2026-08-08. Secondary sources are marked; prefer primaries in the deck. Repo paths refer to github.com/MaxwellCalkin (repo `money`) and are independently verifiable by any reader.*

## 1. The wash problem (the market weapon)

- CoinDesk, 2026-03-11 — Artemis analysis: roughly half of observed x402 transactions are gamed ("self-dealing": same wallet on both sides; "wash": seller funds the buyer's wallet, money returns immediately); recent snapshot ~131k tx/day, ~$28k volume, ~$0.20 average.
  https://www.coindesk.com/markets/2026/03/11/coinbase-backed-ai-payments-protocol-wants-to-fix-micropayment-but-demand-is-just-not-there-yet
- Artemis on X (the primary thread behind the CoinDesk piece): "Most of the x402 numbers circulating are noise."
  https://x.com/artemis/status/2031768320081277029
- Artemis x402 asset dashboard (live data): https://classic.artemis.ai/asset/x402
- x402 Inc. market analysis (May 2026 snapshot: 3.69M tx / $1.11M volume / ~$0.30 avg over 30 days — volume collapsed from the peak while tx count rose): https://note.com/x402inc/n/nfd6227f13b55
- Headline cumulative numbers the wash sits inside (Coinbase Agentic.Market launch, Apr 2026: 165M+ tx, ~$50M+ volume claimed): https://www.coinbase.com/developer-platform/discover/launches/agentic-market

## 2. Competitor primaries

**Stripe / OpenAI**
- Stripe blog — ACP as open standard: https://stripe.com/blog/developing-an-open-standard-for-agentic-commerce
- Stripe newsroom — Instant Checkout in ChatGPT, Shared Payment Token, Link: https://stripe.com/newsroom/news/stripe-openai-instant-checkout
- OpenAI — "Buy it in ChatGPT": https://openai.com/index/buy-it-in-chatgpt/
- Stripe x402 private preview terms (1.5%/charge, USDC on Base, fiat settlement) — via wavect comparison (secondary, facts verified 2026-07-12): https://wavect.io/blog/x402-payments-comparison-2026/

**Coinbase**
- Payments MCP launch: https://www.coinbase.com/developer-platform/discover/launches/payments-mcp
- Agentic Wallets launch (2026-02-11: MPC wallet, session caps, per-tx limits, gasless Base, x402 native, MCP for Claude/Codex/Gemini): https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets
- CDP Agentic Wallet MCP FAQ (the actual policy surface — session cap + per-tx limit): https://docs.cdp.coinbase.com/agentic-wallet/mcp/faq
- x402 Bazaar (facilitator/discovery): https://docs.cdp.coinbase.com/x402/bazaar

**Visa / Mastercard**
- Visa Intelligent Commerce (developer capability page): https://developer.visa.com/capabilities/visa-intelligent-commerce
- Announcement timeline — Mastercard Agent Pay 2025-04-29 (Agentic Tokens via MDES), Visa Intelligent Commerce 2025-04-30, Visa Trusted Agent Protocol live 2025-10-14 (secondary comparison): https://eco.com/support/en/articles/15192003-mastercard-agent-pay-vs-visa-trusted-agent-2026-compared
- PYMNTS — "Visa and Mastercard Put Tokens in Charge of AI Commerce" (secondary): https://www.pymnts.com/news/artificial-intelligence/2026/visa-and-mastercard-put-tokens-in-charge-of-ai-commerce/

**Skyfire**
- Product — KYA + payments: https://skyfire.xyz/product/
- KYAPay whitepaper (signed-JWT agent identity attached to HTTP requests): https://kyapay.org/whitepaper
- Launch coverage (agent authenticates itself as a genuine paying customer — the seller-side framing, in their own words): https://thefintechtimes.com/new-skyfire-solution-enables-ai-agents-to-authenticate-themselves-as-genuine-paying-customers/

**Payman**
- Product docs (manual approval, spending limits, payee protection; USD/USDC wallets; agents never hold funds — i.e., Payman does): https://docs.paymanai.com/overview/introduction
- Site: https://paymanai.com/

**Google AP2**
- Announcement (2025-09-16, 60+ partners incl. Mastercard, PayPal, Coinbase, Amex): https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol
- Spec site (Intent/Cart/Payment Mandates as W3C Verifiable Credentials; v0.2 as of Apr 2026): https://ap2-protocol.org/

## 3. Our verifiable assets (every claim in the memo maps to one of these)

**Live on npm (Apache-2.0, since 2026-08-06)**
- https://www.npmjs.com/package/@agentmoney/wallet-mcp — agent wallet MCP server, npx-runnable
- https://www.npmjs.com/package/@agentmoney/seller-sdk — zero-runtime-dependency paywall middleware + provider client

**Repo (paths as shipped in v0.13)**
- `src/core/policy.ts` + `src/db/policy.ts` — mandate primitives as claimed: budget, per-tx cap, daily cap, escalation line (`escalateAbove`), new-payee first-touch cap (`newPayeeCap`), payee allowlist, expiry; single-use permits with 60s TTL bound to (agent, payee, amount); grant/replay idempotency; supersede-on-regrant so revoke is a reliable kill switch. The `src/db` gateway enforces the same terms atomically in Postgres.
- `src/core/receipts.ts` — SHA-256 hash-chained receipts: each hash covers the previous receipt's hash; `verifyChain()` detects tampering from the break point forward; canonical serialization pinned for legacy verifiability.
- `docs/THREAT_MODEL.md` — the enforcement boundary in writing: "bounded agency" (policy evaluated outside model context), exact authorization tuples, replay safety, fail-closed uncertainty; plus the honest residual-gap list (no sponsor bank, no production customer funds, solo-operator control limits).
- `src/bridge/`, `src/db/external.ts`, `docs/EXTERNAL_SETTLEMENT.md` — x402 v2 exact/EVM path: remote-HSM signing, pinned Base USDC, sign-then-atomic-recheck-then-debit, independent calldata/log/depth verification before confirmation, automatic reversal worker. Implemented; mainnet activation behind hard caps (≤$10 float, ≤$0.25/tx) is the current milestone (M1), not yet live.
- `README.md` ("The mandate model", "Honest v0 shortcuts") — the public honesty ledger: what works, what is deliberately not claimed.
- `docs/GOTOMARKET.md` — milestone ladder, M3 moat milestone (open mandate spec + external adoption), platform-risk tripwire, kill criteria quoted in the pre-mortem.
- 239-test suite with a live-Postgres release gate (`npm run test:postgres-live`; pinned CI `postgres` job) — per `docs/GOTOMARKET.md` M0 and `docs/RELEASES.md`.

**Honest zeroes (as of 2026-08-08)**
- Users: 0. Revenue: $0. Mainnet GMV: $0. Nothing in the receipts journal is faked, including the absence of traffic.

## 4. Demand-side context (what agents can actually buy today)

- Circle registry of x402 sellers: https://usdc.org/x402
- Verified prices for the pilot sequence — Exa $0.007/search (https://exa.ai/docs/reference/x402-guide), Firecrawl ~$0.01/scrape (https://www.coinbase.com/developer-platform/discover/case-studies/firecrawl), BlockRun from $0.003/req (https://blockrun.ai/), kenoodl verify $0.10/req (https://kenoodl.com/agentic-market/)
- Sellers being pushed toward agent-native payments by their own users: https://github.com/firecrawl/firecrawl/issues/3279 and https://github.com/exa-labs/exa-mcp-server/issues/253
- Full scan with the refusal-demo purchase sequence: repo `docs/marketing/discovery/x402-market-scan.md`
