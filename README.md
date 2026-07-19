# money — Venmo for agents

A closed-loop payment network where AI agents pay each other and pay APIs/CLIs, at will, under a user-signed spending envelope. Users set money aside; agents spend it — very high volumes of very low-cost transactions, settled as ledger rows: instant, fee-free, sub-cent capable.

## Why closed-loop

When both sides of a transaction are on the same ledger, a payment is a database row. That's the only architecture that serves the agent economy's real shape (July 2026: ~75M machine payments/month averaging $0.32 on x402) — no card rail can touch sub-cent economics, and no on-chain rail beats a ledger row's latency. External rails (cards, stablecoins, banks) matter only at the edges: top-up and cash-out. This is how PayPal, Alipay, and M-Pesa actually won.

## Core design principles

1. **The envelope is the security boundary, not the model's judgment.** Spending limits live in a deterministic policy engine outside any model context. Injected text can ask; nothing in an agent's context can sign or widen a mandate.
2. **Hold authorization, not money** (production posture: FBO account at a sponsor bank; this prototype simulates the boundary as the `external:funding` account).
3. **Prefunding buys the speed.** Authorization is a local policy + balance check — no external round-trip on the hot path.
4. **Exactly-once by construction.** Idempotency keys on every transfer; 402 challenges pay-once/redeem-once. Agents retry by default — the network must shrug.

## What's here (v0.8)

| Piece | File | What it does |
|---|---|---|
| Ledger | `src/core/ledger.ts` | Double-entry over integer micro-dollars, idempotency-keyed, zero-sum invariant |
| Policy | `src/core/policy.ts` | Mandates (budget, per-tx cap, daily cap, escalation line, new-payee throttle, allowlist, expiry) → single-use permits bound to exact payee+amount |
| Receipts | `src/core/receipts.ts` | Hash-chained evidence log; tamper detection |
| Persistence | `src/core/store.ts` | Append-only JSONL event log; replay rebuilds everything and refuses tampered logs |
| Production money kernel | `db/migrations/`, `src/db/` | Postgres double-entry journal plus atomic mandate evaluation, exact-tuple approvals, marketplace challenges, cumulative refunds, durable external settlement, policy evidence, deterministic row locking, actor-scoped idempotency, reconciliation, and SKIP LOCKED workers |
| Identity | `src/core/identity.ts` | Ed25519 keys for owners, agents, and providers; every mutation is verified against the registered key |
| Network | `src/core/network.ts` | Accounts + public handles, funding, agent payments, durable approvals, seller services, mandates, and 402 challenges |
| Service registry | `src/core/network.ts`, `src/db/marketplace.ts` | Provider-owned `@handle/service` listings, registry-authoritative prices, safe shutdown, and public keyset pagination |
| Seller SDK | `src/seller/middleware.ts` | Reusable Hono paywall plus a provider-signed client for challenges, receipt redemption, and partial refunds |
| HTTP API | `src/server/api.ts` | Hono server on **:4021** — agent, owner, provider, catalog, and merchant APIs plus demo paid endpoints |
| Postgres signed API | `src/server/postgres-api.ts` | Multi-instance-safe Ed25519 auth, durable nonce replay defense, hashed owner sessions, internal and external payments, provider catalog, 402 challenge/redeem, refunds, tenant-scoped state, and the private dashboard |
| Owner control plane | `src/server/dashboard.ts` | Private, session-gated balances, activity, services, mandates, and an exact-payment approval inbox |
| Database operations | `src/server/database-ops.ts` | Liveness, schema readiness, and token-gated ledger reconciliation on **:4022**; deliberately no ungoverned payment route |
| x402 boundary | `src/bridge/`, `src/db/external.ts` | Allowlisted x402 v1 authorizations, AES-256-GCM header custody, HSM-friendly retry recovery, exact external approvals, verifier-gated confirmation, and automatic journal reversal |
| MCP server | `src/mcp/server.ts` | `money_balance`, `money_pay`, `money_fetch` (auto-pays internal 402s AND external x402 sellers within mandate), `money_feed` |
| Demo | `src/demo.ts` | The full story end-to-end (10 sections), including a separately authenticated seller joining and earning through the network |

## Run it

```bash
npm install
npm test         # ledger/policy/network/persistence/identity invariants
npm run demo     # the whole story in one script
npm run api      # the HTTP server on :4021 (durable: data/events.jsonl)
```

### Run the production money kernel

The database path requires Node 20+ and PostgreSQL 18. Start the local database
and transaction pool (the committed password is intentionally local-only):

```bash
docker compose up -d postgres pgbouncer
export DATABASE_URL=postgres://money:money-dev-only@127.0.0.1:5432/money
npm run db:migrate
npm run db:reconcile
npm run db:test
npm run api:db
npm run external:worker
```

Application traffic should use PgBouncer on port `6432`; migrations and
administrative work should connect directly on `5432`. Transaction pooling is
safe here because the application uses transaction-local settings and
transaction-level advisory locks, never session-local state.

The Postgres kernel stores micros as signed 64-bit integers (not JavaScript
numbers), locks both account rows in deterministic order, writes exactly two
zero-sum journal entries, updates cached balances, creates receipt evidence,
and enqueues an outbox event in one transaction. Exact retries return the same
transfer and receipt; changed terms return an idempotency conflict. Normal
application credentials can register identities, allocate owner funds,
grant/revoke mandates, request policy-governed agent payments, and resolve
owner approvals. They cannot invoke raw agent payment, generic posting, or
treasury funding.

For operations health, set `MONEY_OPS_TOKEN` and run `npm run ops:db`.
`GET /health/live` and `GET /health/ready` are safe for probes;
`GET /ops/reconcile` requires that bearer token.

The policy, marketplace, and external-settlement Postgres gateways are
`src/db/policy.ts`, `src/db/marketplace.ts`, and `src/db/external.ts`; the signed product API is
`src/server/postgres-api.ts` (`npm run api:db`). It covers identity onboarding,
durable replay-safe authentication, owner sessions, allocation, mandates,
agent payments, exact owner approvals, key rotation, provider service
publishing, public discovery, registry-priced 402 challenges, single-use
redemption, cumulative-capped refunds, durable external x402 settlement,
scoped balances/activity, and the private dashboard. The ops service
intentionally exposes no payment endpoint.

External routes fail closed unless a wallet, a 32-byte header-encryption key,
and an independent settlement verifier are all configured. `POST
/pay-external` stores only AES-256-GCM ciphertext plus a plaintext-header hash,
then returns the original authorization after an atomic debit. The agent sends
the seller's complete settlement response to `POST
/pay-external/:id/confirm`; the verifier runs before the short database
transaction, and confirmation races safely against the SKIP LOCKED reversal
worker. See `docs/EXTERNAL_SETTLEMENT.md` for the API and deployment contract.

For local protocol-shaped testing only, set `MONEY_EXTERNAL_MOCK=true` and a
stable `MONEY_EXTERNAL_HEADER_KEY` (32 bytes, base64 or 64 hex characters).
Mock mode is refused when `NODE_ENV=production`. A deployed process must
inject a real EIP-712 wallet/HSM adapter and facilitator or chain verifier.

Owner-signed `/fund` is disabled on the Postgres API by default because real
top-ups belong to a separately credentialed treasury integration. For an
explicit local-only walkthrough, start it with
`MONEY_ALLOW_DEV_FUNDING=true npm run api:db`; never enable that switch in a
deployed environment.

The dashboard is private. Export the `MONEY_USER_ID` and `MONEY_OWNER_KEY`
printed during onboarding, then mint an eight-hour browser session:

```bash
npm run dashboard:login
```

Open the fragment-token link it prints. The long-lived owner key never enters
browser storage, financial reads are tenant-scoped, and logging out revokes the
in-memory session immediately.

### Give a Claude Code agent a wallet

Start the API (`npm run api`), then in another terminal:

```bash
npm run onboard    # creates user + agent + mandate, prints the MCP config
```

Or wire it manually — add to `.mcp.json`:

```json
{
  "mcpServers": {
    "money": {
      "command": "npx",
      "args": ["tsx", "C:/Users/mcalk/code/money/src/mcp/server.ts"],
      "env": {
        "MONEY_API": "http://127.0.0.1:4021",
        "MONEY_AGENT_ID": "agt_xxxxxxxx",
        "MONEY_AGENT_KEY": "<base64 Ed25519 private key from onboarding — keep out of git>"
      }
    }
  }
}
```

The agent can then check its balance, pay other agents, and fetch 402-gated URLs that get paid automatically inside its mandate.

### Publish a paid API

Provider identities are created by an owner, then use their own signing key to
publish services and redeem receipts. After `npm run onboard`, export the
`MONEY_USER_ID` and `MONEY_OWNER_KEY` it prints, then run:

```bash
npm run onboard:seller -- \
  --handle research-cloud \
  --slug market-report \
  --endpoint https://seller.example/report \
  --price 0.05
```

The command prints `MONEY_PROVIDER_ID`, `MONEY_PROVIDER_KEY`, and
`MONEY_SERVICE_ID`. It writes the provider key and stable registration keys to
the gitignored `.money/` directory before contacting the network, so an
interrupted run can be repeated without orphaning the handle or duplicating the
service. Mount the reusable Hono middleware on the registered route:

```ts
import { Hono } from "hono";
import { createMoneySellerClient, moneyPaid } from "./src/seller/middleware.ts";

const app = new Hono();
app.get("/report", moneyPaid({
  networkUrl: process.env.MONEY_API!,
  providerId: process.env.MONEY_PROVIDER_ID!,
  providerKey: process.env.MONEY_PROVIDER_KEY!,
  serviceId: process.env.MONEY_SERVICE_ID!,
}), (c) => c.json({ report: "valuable machine-readable result" }));

const seller = createMoneySellerClient({
  networkUrl: process.env.MONEY_API!,
  providerId: process.env.MONEY_PROVIDER_ID!,
  providerKey: process.env.MONEY_PROVIDER_KEY!,
});

// Partial or full; the same key can be retried without issuing it twice.
await seller.refund({
  receiptId: "rcpt_...",
  amountMicros: 10_000,
  memo: "service credit",
  idempotencyKey: "refund-order-123-v1",
});
```

The public catalog is `GET /services`. Agents may also pay accounts by public
handle (for example `@research-cloud`) instead of copying opaque ids. Refunds
are tied to the original hash-chained receipt, cannot exceed the purchase, and
do not restore mandate budget (so cooperating buyer and seller accounts cannot
recycle an agent's spending authority).

## The mandate model

```
grant: budget $10 · per-tx $1 · daily $5 · ask-me-above $2 · new-payee first-touch 10¢ · expires 30d
```

- **Escalation**: above the ask-me line, the agent receives a durable `approval_required` intent. The owner inbox shows the stored payee, amount, and memo; approving executes that immutable tuple through a one-time permit ("approval is the mandate" — no gap between what the human saw and what executes). Requests survive restart, expire after 24 hours, and recover exactly once across a crash at settlement.
- **New-payee throttle**: the first payment to any unseen payee is capped at cents — including external x402 vendors, keyed on canonical host plus destination address. A prompt-injected agent lured to an attacker's endpoint can leak cents/day, not the envelope, and swapping `payTo` cannot inherit a vendor's trust. Payees inside the owner's own trust domain (the owner, sibling agents they own) are exempt — money paid to them never leaves the owner's accounts. Everything else (caps, budget, escalation) still applies to them.
- **Permits**: single-use, 60s TTL, bound to (agent, payee, amount). Replay and amount-inflation are structurally dead.

## Honest v0 shortcuts (the roadmap is the inverse)

- The complete showcase API still defaults to the local JSONL engine (`data/events.jsonl`; `MONEY_DATA` overrides it). The Postgres API now serves the signed identity, payment, approval, owner control plane, service marketplace, challenge, redemption, refund, and external x402 paths; new deployment work should target `api:db`.
- Postgres marketplace challenges are durable, claimed by at most one agent, paid once, and redeemed once; paid retries win over expiry. Expired unpaid rows are cleaned in bounded batches. At truly enormous anonymous-request volume, challenge issuance should move to signed stateless edge tokens so unpaid 402 traffic does not require one database write per offer.
- Identity is an Ed25519 keypair per account: agents sign spends and owners sign admin mutations over method+path+body+timestamp+nonce. The Postgres API records accepted nonces durably, rejects replay across replicas, makes public-key onboarding retry-safe, and revokes browser sessions when an owner rotates keys (→ RFC 9421 HTTP Message Signatures + `@authority` binding on the wire; keys chained to a KYC'd owner; signup rate-limiting and owner-key delivery off stdout).
- Browser access uses an eight-hour bearer session minted by an owner-signed request. Only SHA-256 token hashes are stored; sessions survive restart, cap at ten per owner, expire, revoke individually, and die on owner-key rotation (→ passkeys for the production owner ceremony).
- The JSONL product path is single-node and remains a showcase. The Postgres path is multi-instance-safe for ledger, mandate, approval, signed identity, nonce, session, tenant-scoped control-plane, marketplace, challenge, redemption, refunds, and the pending/confirmed/cancelled/reversed external state machine.
- External top-up is simulated. The repository ships a protocol-faithful x402 v1 client and mock wallet/seller, but the mock uses Ed25519 instead of EIP-712/secp256k1 and cannot certify chain finality. The production adapter is still required: real USDC wallet/HSM plus facilitator or chain verification on the selected network, followed by card/ACH top-up and payout through a sponsor-bank FBO program.
- The ledger can settle between accounts owned by different users, but this is still a development sandbox. Turning that path on for real customer funds requires the sponsor-bank/FBO, KYC/KYB, sanctions, fraud, safeguarding, and licensing program around it; code alone does not cross the money-transmission line.
- No subscriptions, sub-agent delegation, seller payouts, disputes, or insurance yet. Those are later programmable-commerce and risk layers after the internal marketplace and external settlement rail.

## The bigger picture

See the design brief (research + architecture + market map, July 2026): the artifact "The Agent Spend Account". The wedge: the neutral, dual-economy spend account for coding-agent runtimes — one balance paying both x402-style machine endpoints and fiat-priced metered providers, enforced outside the model, exactly-once, with one receipt feed.
