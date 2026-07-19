# External x402 settlement

v0.8 makes an external machine payment a durable database state machine rather
than an in-memory bridge. The network keeps the low-latency internal ledger as
the authorization source of truth while treating stablecoin settlement as an
edge effect that must be independently proven.

## Lifecycle

```text
402 requirement
      |
      v
validate allowlist + hard cap + canonical host/destination
      |
      v
sign authorization -> AES-256-GCM encrypt -> policy transaction
      |                                      |
      |                         +------------+-------------+
      |                         |                          |
      |                  approval_required             pending
      |                         |                          |
      |                  approve | reject/expire           |
      |                         v                          |
      |                      pending                   cancelled
      |                         |
      +-------------------------+
                                |
                    +-----------+-----------+
                    |                       |
             verified settlement       deadline expires
                    |                       |
                    v                       v
                confirmed                reversed
```

`pending -> confirmed` and `pending -> reversed` lock the same
`money.external_payments` row. A seller verifier or reversal worker may race,
but both outcomes cannot commit. A reversal creates a second immutable
double-entry transfer and restores available balance; it never restores the
mandate's total or daily counters.

## Agent HTTP flow

1. The agent fetches a URL and receives an x402 v1 `accepts[]` requirement.
2. It signs `POST /pay-external` with:

```json
{
  "url": "https://data.example/report",
  "requirement": {
    "scheme": "exact",
    "network": "mock-local",
    "maxAmountRequired": "50000",
    "asset": "0x00000000000000000000000000000000000c0ffe",
    "payTo": "0x209693bc6afc0c5328ba36faf03c514ef312287c",
    "resource": "/report",
    "maxTimeoutSeconds": 60
  },
  "idempotencyKey": "task-123-report-v1"
}
```

3. A `200` response contains the original `paymentHeader`. A `202` response
contains an exact durable owner approval and no plaintext header. Retrying the
same tuple and key after approval returns the original header without a second
wallet/HSM signature.
4. The agent retries the seller with `X-PAYMENT: <paymentHeader>`.
5. It submits the seller's complete base64 `X-PAYMENT-RESPONSE` value:

```json
{ "settlement": "<base64 settlement response>" }
```

to `POST /pay-external/:externalId/confirm`. A raw transaction identifier is
not accepted. The configured verifier checks the facilitator or chain before
the database can transition the payment to `confirmed`.

## Security boundaries

- `(network, asset)` is selected from a server-side allowlist with pinned
  decimals. Seller-provided token metadata is never trusted.
- Every external transaction is hard-capped independently of the owner's
  mandate. Policy identity is `x402:<canonical-host>:<lowercase-payTo>`.
- The authorization ciphertext uses AES-256-GCM with a random 96-bit IV. Its
  associated data binds external id, agent, idempotency key, vendor,
  destination, asset, network, resource, amount, and both deadlines.
- PostgreSQL stores ciphertext and SHA-256 of the plaintext header. Header
  release decrypts, authenticates, hashes, decodes, and rechecks the exact
  durable tuple.
- The API performs no network call while holding a money or lifecycle lock.
  Settlement verification runs first; the final state transition is short.
- The application role can call narrow request/resolve/confirm/read functions
  but cannot invoke the posting kernel, reversal function, sweep function, or
  read the external table directly. The worker can only sweep and process its
  outbox grants.
- External lifecycle rows, transfers, ledger entries, and receipts are
  append-only. Reconciliation recomputes receipt hashes and cross-checks the
  debit, approval, receipt, and reversal tuple.

## Deployment contract

Run migrations with a schema-owner connection, then apply `db/roles.sql` as an
administrator. API and worker processes should use separate login roles.

```bash
npm run db:migrate
npm run api:db
npm run external:worker
```

The product API requires all three of these capabilities before external
routes open:

1. `externalWallet`: a signer whose address owns the settlement funds;
2. `externalHeaderKey`: 32 bytes from a secrets manager or KMS-backed envelope;
3. `verifyExternalSettlement`: a facilitator/chain verification adapter.

The factory accepts them in `createPostgresApi(...)`. The command-line server
ships only an explicit local mock (`MONEY_EXTERNAL_MOCK=true`) and refuses that
mode under `NODE_ENV=production`. Real EIP-712 signing, x402 v2 transport,
facilitator integration, treasury reconciliation, and key rotation are the
next rail-adapter milestone; none should be inferred from mock-green tests.
