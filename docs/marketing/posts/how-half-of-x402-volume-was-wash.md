# How half of x402 volume was wash — and how to prove yours isn't

*agentmoney teardown series. Drafted 2026-08-08. All technical claims below are grounded in the open-source code at github.com/MaxwellCalkin/money (Apache-2.0); citations for the market data are linked inline.*

**tl;dr** — In March 2026, Artemis analysts looked at x402's on-chain activity and estimated that roughly half of observed transactions were self-dealing or wash trading ([CoinDesk, March 11, 2026](https://www.coindesk.com/markets/2026/03/11/coinbase-backed-ai-payments-protocol-wants-to-fix-micropayment-but-demand-is-just-not-there-yet)). That happened because agent-payment metrics are cheap to inflate and nobody's ledger design makes the inflation visible. Wash-proof metrics need four things — funding lineage, retention cohorts, counterparty diversity, and published tamper-evident receipt roots — and a double-entry journal with per-payment receipts produces all four as a by-product of normal operation. agentmoney's public metrics page will publish exactly these proofs from day one. Today those numbers are zero, and we will publish the zeroes.

---

## The finding

On March 11, 2026, CoinDesk reported an Artemis analysis of x402, the Coinbase-backed HTTP payment protocol for AI agents. The headline numbers: about **$28,000 in daily volume**, an **average transaction around $0.20**, roughly **131,000 transactions a day** — and one February day that spiked to **3.8 million transactions and about $2 million in volume**, most of it attributed to infrastructure testing rather than commerce. The part that matters for anyone building in this space: Artemis estimated that **about half of observed activity was gamed**, split into two buckets — *self-dealing*, where one wallet sits on both sides of the trade, and *wash trading*, where the seller funds the buyer's wallet and the money round-trips straight back through a "purchase." ([CoinDesk](https://www.coindesk.com/markets/2026/03/11/coinbase-backed-ai-payments-protocol-wants-to-fix-micropayment-but-demand-is-just-not-there-yet); [Artemis on X](https://x.com/artemis/status/2031768320081277029))

None of this means x402 is a bad protocol. We build on it — agentmoney ships an x402 bridge, and the protocol's core idea (payment as a first-class HTTP response) is right. The finding is about *measurement*: when the growth story of an ecosystem is told in transaction counts, and transactions cost a fifth of a cent to manufacture, the counts stop meaning anything. The market learned this once already with DEX wash trading and NFT volume. Agent payments just re-learned it faster, because agents are the cheapest volume-manufacturing machines ever built.

## The mechanics: three ways to fake an agent economy

**Self-dealing.** One operator controls both the "buyer" agent and the "seller" endpoint. The agent dutifully pays the endpoint; the operator's net position is unchanged minus gas. On a public chain this is hard to rule out because wallets are free and unlinkable — the same laptop can be a hundred "distinct buyers." Every transaction is real in the settlement sense and fictitious in the economic sense.

**Faucet cycling (wash funding).** The seller — or a promoter, or an incentive program — funds fresh buyer wallets, which spend the funding back at the seller. This is the bucket Artemis called wash trading: the money's *origin* is the counterparty it flows back to. It defeats naive "distinct wallets" metrics completely, because the wallets genuinely are distinct. Only the funding graph gives it away: trace each buyer's balance backward and it originates with the seller.

**Ping inflation.** Price an endpoint at a fraction of a cent, point a loop at it, and report transaction counts. A $0.20 average transaction size means a million "transactions" costs $200,000 of *gross flow* — but with self-dealing or faucet cycling, the net cost is gas. The February spike — 3.8 million transactions in a day on a protocol averaging 131,000 — shows how elastic count-based metrics are.

All three exploit the same gap: public-chain metrics observe *settlement* but not *economics*. A transfer is visible; whether it moved value between independent parties is not.

## What wash-proof metrics actually require

Turn each attack around and you get the proof that defeats it. Four proofs, each answering one specific accusation:

1. **Funding lineage** — "the seller funded the buyers." Disproven by showing, for every buyer, where its money entered the system, and that the entry point is not the seller (or the operator).
2. **Retention cohorts** — "these are throwaway wallets spun up for the screenshot." Disproven by showing the same buyers returning across weeks. Retention is the one number a loop-in-a-datacenter can fake only by *continuing to pay real money over real time*, which converts fraud into an expensive subsidy.
3. **Counterparty diversity** — "it's one operator on both sides." Disproven by showing spend distributed across unrelated buyer–seller pairs, with concentration disclosed (what share of volume the top pair represents), not hidden.
4. **Published tamper-evident roots** — "you edited the history before publishing it." Disproven by committing to the receipt history cryptographically, in public, on a schedule, so that any retroactive edit is detectable by anyone who saved last week's root.

A public chain gives you (4) for free and makes (1)–(3) nearly impossible, because identity and funding relationships are exactly what a permissionless chain doesn't record. A closed-loop ledger is the mirror image: (1)–(3) are native queries, and (4) has to be engineered. Here is how agentmoney's journal produces each one.

### Funding lineage, from a double-entry journal

In agentmoney's Postgres kernel ([`db/migrations/0001_ledger.sql`](https://github.com/MaxwellCalkin/money)), every movement of value is one row in `money.transfers` plus exactly two zero-sum entries in `money.ledger_entries` — enforced by a deferred constraint trigger that rejects any commit where a transfer's entries don't sum to zero in a single asset. There are only three transfer operations, and the kernel (not the API layer) enforces who may perform each: `fund` (money enters from the `external:funding` boundary account to a user), `allocate` (a user funds their own agent — the kernel checks `owner_id`), and `pay` (an agent spends under its mandate). External settlement crosses a second boundary account, `external:x402`.

That closed grammar means every unit of an agent's balance has a complete, machine-walkable ancestry: `fund → allocate → pay`. "Where did this buyer's money come from" is a recursive query over the journal, not a forensic project. Self-dealing is detectable *by construction*: `money.accounts` records `owner_id` for every agent and provider, so "buyer and seller share an owner" is a join, and the metrics page excludes those flows from headline numbers rather than asking to be trusted. Faucet cycling is visible the same way: a buyer whose funding lineage originates with its counterparty gets flagged and excluded. On the mainnet side, each external x402 payment is pinned to a settlement transaction hash (`money.external_payments.settled_tx`) that is only recorded after independent verification of the calldata, transfer log, and confirmation depth (`docs/THREAT_MODEL.md`) — so bridge volume can be spot-checked against Base itself.

### Retention cohorts and counterparty diversity, from the same rows

Every transfer carries `from_account_id`, `to_account_id`, and `created_at`, indexed both directions. Weekly buyer cohorts ("of buyers first active in week N, how many transacted in week N+k"), distinct-counterparty-pair counts, and top-pair concentration all fall out of the same table. Our own milestone gate uses the wash-resistant form: at least 8 distinct external buyer wallets, each active in at least 3 distinct weeks, with pings, self-dealing, and faucet-funded flows excluded by construction — and the buyer is never the founder (`docs/GOTOMARKET.md`). We publish value *and* count, with the size distribution, so a million half-cent pings can't impersonate revenue.

### Published roots, from hash-chained receipts — with an honest caveat

Every posted payment produces a receipt at commit time. Here we should be precise about what exists where, because this is exactly the kind of claim that gets inflated.

On the **wallet-side JSONL path** (the event-sourced store behind `@agentmoney/wallet-mcp`, `src/core/receipts.ts`), receipts are hash-chained today: each receipt's SHA-256 covers the previous receipt's hash over a canonical serialization, replayed logs are re-verified on load, and a tampered log fails to load rather than loading with a broken chain. Publishing the head hash commits to the entire history behind it.

On the **Postgres path**, receipts are not yet prev-hash chained. What exists today: every receipt row in `money.receipts` carries a SHA-256 `evidence_hash` over the transfer facts; `transfers`, `ledger_entries`, and `receipts` are append-only, enforced by triggers that raise on any UPDATE or DELETE; every mandate-authorized payment additionally writes an append-only `transfer_authorizations` row with its own evidence hash and the exact policy snapshot that approved it; and ledger integrity (zero-sum and receipt coverage) is verified on a schedule by an operations role and stored as append-only verdicts (`money.ledger_health_reports`) rather than asserted. The schema reserves an `anchor_batch_id` column on receipts for batch anchoring; no anchoring job ships yet. Extending the chained-root property to the Postgres path is the remaining engineering between here and the strongest version of proof (4), and we'd rather tell you that than imply it's done.

## The commitment

agentmoney's public metrics page will publish these four proofs from day one: buyer counts with funding lineage attested (no founder subsidy in headline numbers), weekly retention cohorts, counterparty concentration, and a weekly published receipt root — with the verification method documented so anyone can check our history against last week's root.

Day one, those numbers are: **zero buyers, zero revenue, zero volume.** We have two SDKs on npm, a tested kernel, and no users yet. We will publish the zeroes, because a metrics page that starts honest at zero is the only kind whose later numbers mean anything — and because in a market where half the volume was wash, *provably real* is the scarcest feature there is.

---

*Sources: [CoinDesk, "Coinbase-backed AI payments protocol wants to fix micropayments but demand is just not there yet" (March 11, 2026)](https://www.coindesk.com/markets/2026/03/11/coinbase-backed-ai-payments-protocol-wants-to-fix-micropayment-but-demand-is-just-not-there-yet); [Artemis analysis thread](https://x.com/artemis/status/2031768320081277029). Code references: `db/migrations/0001_ledger.sql`, `db/migrations/0002_policy.sql`, `db/migrations/0011_ledger_health_reports.sql`, `src/core/receipts.ts`, `src/core/store.ts`, `docs/THREAT_MODEL.md` in the agentmoney repository.*
