# Public wash-proof metrics

The public metrics page is the receipts journal speaking for itself: a
deliberately unauthenticated surface that publishes aggregates, the funding
lineage of every settled spend, and weekly chain roots that let anyone holding
a receipt re-derive inclusion offline. It exists because the agent-payments
market has a demonstrated wash problem — public analysis found roughly half of
observed x402 volume was self-dealing — and because the honest answer to that
is evidence, not assertion. Honest zeroes are published as zeroes; the
artifact itself is the product demo.

Service: `public-metrics` (`src/server/metrics.ts`, `npm run metrics:public`),
port `4028` (`MONEY_METRICS_PORT`). Database surface: migration
`db/migrations/0013_public_metrics.sql`; role grants in `db/roles.sql`.

## What is published

`GET /` (and `GET /metrics`) render a self-contained HTML page — no external
scripts, styles, or fonts; correct in dark and light color schemes — and
`GET /metrics.json` serves the same document (`cache-control: public,
max-age=60`):

| Field | Meaning |
| --- | --- |
| `generatedAt` | UTC generation time of the document |
| `distinctFundedAgents` | distinct agent accounts that ever received an owner allocation |
| `distinctPaidProviders` | distinct provider (seller) accounts that were ever actually paid — registering a listing without traffic does not count |
| `operationClasses[]` | transfer count and volume (micros, as strings) per operation class |
| `fundingLineage` | the wash-proof split described below |
| `weekly[]` | per ISO week (UTC, Monday start, most recent 26 weeks): `week`, `weekStart`, `transfers`, `volumeMicros`, `activeAgents` (distinct agents that sent any transfer that week), `chainRoot` |
| `cohorts[]` | retention cohorts over the same 26-week window: each row is `{cohortWeek, weekStart, cohortSize, activeByWeek}` where the cohort is the set of agents whose first-ever active week was `cohortWeek` and `activeByWeek[k]` counts how many of them were active `k` weeks later (`activeByWeek[0]` equals `cohortSize`). Counts only, never identities |
| `sandbox` | `true` unless a real-money deployment explicitly sets `MONEY_METRICS_SANDBOX_LABEL=false`; the page renders a prominent "sandbox, no real funds" banner while true |

Operation classes partition `money.transfers.operation`:

| Class | Operations |
| --- | --- |
| `funding` | `fund` — the development/sandbox funding path |
| `treasury` | `funding_settlement`, `funding_return`, `payout_hold`, `payout_reversal` — provider-verified settlement legs |
| `card` | `card_reserve`, `card_release`, `card_refund` |
| `external` | `external_debit`, `external_reversal` — x402 |
| `internal` | everything else (`pay`, `allocate`, `refund`) |

**What is never published**, by construction and by test: account ids,
handles, memos, policy payees, merchant descriptors or hints, individual
transfer amounts, or timestamps of individual transfers. One honest caveat at
low volume: an aggregate over exactly one transfer (a week or operation class
with `transfers: 1`) necessarily equals that transfer's amount, and a receipt
holder learns their own receipt's ISO week from `weekBucket` — inherent to
publishing honest small numbers rather than suppressing them, and it exposes
an amount only to the extent the aggregate *is* the single amount, never
which account moved it. The serving database role (`money_metrics`) can
execute exactly two functions and holds zero table or view selects, so even a
fully compromised metrics process cannot query account-level data.

## Why it is wash-proof

Two mechanisms, both machine-checkable:

1. **Funding lineage.** Money enters this ledger through exactly two doors:
   the development/sandbox funding path (`fund`) and provider-verified
   external settlement (`funding_settlement`, evidence-checked against the
   provider before posting; `funding_return` subtracts). An owner family's
   external funding is additionally net of its payouts (`payout_hold` minus
   `payout_reversal`, floored at zero), so a settle → payout → re-settle
   cycle counts the same dollars once, never N times. A third income door —
   `pay` credits an agent receives from a *different* owner family's agent —
   counts as dev/sandbox funding for the recipient family: peer income can
   never manufacture external lineage, so founder money routed through an
   intermediary family and re-spent stays labeled dev/sandbox no matter how
   many hops it takes. Every spend (`pay`, `external_debit`, `card_reserve`
   — net of `card_release`, `card_refund`, and marketplace `refund` credits,
   so a reservation that was later released or a purchase that was refunded
   drops back out; refunds are kernel-locked to the original payer and capped
   at the original receipt, so they restore the family's own prior spend
   rather than importing new lineage) is attributed to its owner family's
   funding mix, proportionally, with the external share rounded *down*,
   **capped at the external settlement the family actually received**, and
   any spend that cannot be traced to verified external settlement counted
   as dev/sandbox-funded. The conservative direction always points at us:
   founder-subsidized or play-dollar traffic is labeled, never laundered
   into "real" volume. Both Artemis wash patterns — same-wallet self-dealing
   and seller-funded buyers — surface here: a seller family's verified
   settlement can label at most that same amount of its spend as external,
   and money it receives from other families' agents lands in the dev bucket
   before it is ever re-spent.

2. **Weekly chain roots.** Every transfer emits a receipt whose 32-byte
   `evidence_hash` commits to the transfer's terms. The root is **chained**:
   starting from the empty byte string, each receipt's evidence-hash bytes
   are folded in `transfer_seq` order —
   `root_i = SHA256(root_{i-1} ‖ evidenceHash_i)` — and the published root
   for a week is the chain value after the last receipt belonging to that
   week or earlier. The chain is cumulative over **all** history, so
   retroactively inserting, deleting, or rewriting a receipt changes every
   subsequent root; third parties who saved earlier roots (or their own
   receipts) can catch it. The chained form also lets the server maintain a
   checkpoint and fold in only new receipts per refresh instead of re-hashing
   the whole journal.

## Re-derive a root

Given the set of receipts up to a week's end (each `{transferSeq,
evidenceHash}`), sort ascending by `transferSeq` and fold the raw 32-byte
hashes into the chain, starting from the empty byte string:

```js
import { createHash } from "node:crypto";

const receipts = [/* { transferSeq: 1n, evidenceHash: "9f0c…" }, … */];
receipts.sort((a, b) => (a.transferSeq < b.transferSeq ? -1 : 1));
let root = Buffer.alloc(0);
for (const receipt of receipts) {
  root = createHash("sha256")
    .update(root)
    .update(Buffer.from(receipt.evidenceHash, "hex"))
    .digest();
}
console.log(root.toString("hex")); // must equal the published chainRoot
```

Weeks are ISO weeks in UTC: a transfer belongs to the week of
`date_trunc('week', created_at at time zone 'utc')`, labeled
`IYYY-"W"IW` (for example `2026-W34`). A week's end is the start of the
following Monday, UTC. Empty weeks are published with zero counts and carry
the same root as the previous week — honest zeroes, not gaps.

## Verify a receipt

Receipt ids are unguessable UUIDs; verification is lookup by exact id only,
and no listing or enumeration endpoint exists anywhere on this surface:

```
curl -s https://<host>/receipts/<receipt-id>/verify
```

A known receipt answers `200`:

```json
{
  "exists": true,
  "transferSeq": "42",
  "evidenceHash": "9f0c…64 hex chars…",
  "operationClass": "internal",
  "weekBucket": "2026-W34"
}
```

— and nothing else. `transferSeq` is the receipt's position in the chain:
verify that the `evidenceHash` you hold matches, then re-derive the
`weekBucket`'s published `chainRoot` with your receipt included at that
position. An unknown or malformed id answers a uniform `404`.

## Deployment contract

- **Process:** `public-metrics` in `src/deploy/preflight.ts`. It must hold
  exactly one credential — `MONEY_METRICS_DATABASE_URL`, a passworded
  non-owner login for the `money_metrics` role over `sslmode=verify-full` —
  and every other secret in the system (the product `DATABASE_URL`, ops
  token, issuer keys, webhook secrets, keyrings) is rejected at boot.
- **Database role:** `money_metrics` may execute
  `money_private.public_metrics()` and `money_private.verify_receipt(uuid)`
  and nothing else — no table selects, no other functions, no usage on the
  `money` schema. Helper internals are granted to no role. `money_ops` may
  also execute both (it already reads the underlying tables) so operators can
  check the page before it goes public.
- **HTTP surface:** GET and HEAD only (405 otherwise), no request bodies, no
  cookies, no authentication; responses are bounded (the weekly series and
  cohorts are capped at 26 ISO weeks); `/metrics.json` and the page are
  cacheable for 60 seconds and the process holds an in-memory cache on the
  same window, bounding a hostile crawl at one aggregate refresh per minute.
  Refreshes are single-flight — concurrent requests share one in-flight
  database call — and a failed refresh is negatively cached for a few
  seconds, so a slow or failing database is never hammered with one
  aggregate query per request.
- **Bounded refresh cost:** every published aggregate lives in a derived
  cache advanced by one index-driven checkpoint pass over at most 12 × 5000
  new receipts per refresh: the chain roots and weekly aggregates
  (`money.metrics_chain_checkpoint`, `money.metrics_weekly`), the active
  sets and each agent's first active week (`money.metrics_week_agents`,
  `money.metrics_agent_first_week`), the per-class running totals
  (`money.metrics_class_totals`), the distinct funded-agent/paid-provider id
  sets with their counts row (`money.metrics_funded_agents`,
  `money.metrics_paid_providers`, `money.metrics_counts`), and the
  per-family funding-lineage rollup with its delta-maintained totals row
  (`money.metrics_owner_lineage`, `money.metrics_lineage_totals`). A refresh
  never re-hashes or re-scans receipt history — `public_metrics()` reads
  O(1) totals rows plus the 26-week window of the weekly and cohort caches —
  and a backlog converges across refreshes instead of blowing the statement
  timeout. The caches are deterministic functions of the journal and can be
  rebuilt from scratch by resetting the checkpoint and truncating the cache
  tables.
- **Topology:** internal Docker network, exposed only through the TLS edge
  (`deploy/compose.production.yaml`; beta routes `/metrics*` and
  `/receipts/*` via Caddy in `deploy/beta/`). In the beta profile the
  one-shot `roles` job applies `db/roles.sql` after migrations and binds
  `money_metrics_login` (password `BETA_METRICS_DB_PASSWORD`), which is the
  only identity the public process ever connects as — never the database
  owner. Health at `/health/live`.
- **Labeling:** `MONEY_METRICS_SANDBOX_LABEL` defaults to `true`; the beta
  never unsets it. Flipping it to `false` is a real-money launch decision,
  not a configuration nicety.
