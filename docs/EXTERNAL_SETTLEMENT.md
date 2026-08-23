# External x402 settlement

v0.9 turns x402 v2 EIP-3009 payments into a durable, policy-governed edge
rail. The internal Postgres ledger remains the authorization source of truth;
the external USDC transfer is independently proven before the debit becomes
final.

The production adapter currently pins two exact/EVM assets:

- Base Sepolia (`eip155:84532`) USDC for deployment testing.
- Base mainnet (`eip155:8453`) USDC for a future controlled launch.

The older x402 v1 implementation remains for local compatibility tests. The
command-line production path enables v2 only; mock mode is refused when
`NODE_ENV=production`.

The card rail (`docs/CARD_RAIL.md`) is the sibling edge for ordinary
merchants: the same prepare -> approve -> atomic-recheck -> pending -> worker
pattern, with the reserve posted at issue instead of a signature at spend.
Sub-$5 machine-to-machine flows stay here on x402; reserved cards carry the
$5-$500 merchant flows.

## Lifecycle

```text
PAYMENT-REQUIRED
       |
       v
normalize hostile input + pin network, token, decimals, domain and method
       |
       v
prepare durable unsigned intent + evaluate mandate
       |
       +-------------------------+
       |                         |
       v                         v
   prepared               approval_required
       |                         |
       |                  owner approves exact tuple
       |                         |
       +------------+------------+
                    |
                    v
          HSM signs fresh EIP-3009 authorization
                    |
                    v
       atomic policy recheck + ledger debit
                    |
                    v
                 pending
                    |
          +---------+----------+
          |                    |
   chain proof verified   deadline expires
          |                    |
          v                    v
      confirmed             reversed
```

No signature is created while an intent waits for human approval. Signing
happens outside a database transaction, immediately before the short atomic
activation transaction. Activation rechecks the mandate, balance, payee and
all caps; a revoked or exhausted mandate cannot be rescued by a signature
created milliseconds earlier.

`pending -> confirmed` and `pending -> reversed` lock the same lifecycle row.
A confirmer and the reversal worker may race, but both outcomes cannot commit.
A reversal writes a second immutable double-entry transfer and restores the
available balance. It deliberately does not restore total or daily mandate
authority.

## Agent HTTP flow

1. The agent fetches a URL and receives a base64 x402 v2
   `PAYMENT-REQUIRED` header.
2. It decodes the challenge and sends the selected offer to the signed Money
   API. For example:

```json
{
  "url": "https://data.example/report",
  "x402Version": 2,
  "resource": {
    "url": "https://data.example/report",
    "description": "daily report",
    "mimeType": "application/json"
  },
  "requirement": {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "50000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x209693bc6afc0c5328ba36faf03c514ef312287c",
    "maxTimeoutSeconds": 60,
    "extra": {
      "assetTransferMethod": "eip3009",
      "name": "USDC",
      "version": "2"
    }
  },
  "extensions": {},
  "idempotencyKey": "task-123-report-v1"
}
```

3. `POST /pay-external` returns either:
   - `200` with the exact `paymentHeader`, `paymentHeaderName` and
     `settlementHeaderName` after an atomic debit;
   - `202` with a durable owner approval and no signature or plaintext
     payment header; or
   - a stable denial.
4. The agent retries the seller with
   `PAYMENT-SIGNATURE: <paymentHeader>`.
5. It sends the seller's complete base64 `PAYMENT-RESPONSE` value to
   `POST /pay-external/:externalId/confirm` as
   `{ "settlement": "<base64>" }`. A raw transaction hash is not accepted.

The API exposes `POST /pay-external/:externalId/resume`. Only the paying agent
can recover the original header, and recovery never signs or debits twice.
The MCP client also uses an agent-scoped, indexed unresolved-resource lookup
to rediscover the external ID after restart, even when the agent has hundreds
of concurrent purchases. If the seller declares the x402 payment-identifier extension,
the payload includes a stable identifier derived from the Money idempotency
key so a repeated seller request can be deduplicated.

`money_fetch` canonicalizes the resource URL before it becomes an idempotency
map key, requires HTTPS for public destinations, rejects private/reserved
literal and resolved DNS targets, pins the checked address into the request
socket while retaining the hostname's TLS identity, and reads bounded response
bodies. Automatic redirect following is disabled. An unauthenticated redirect
is surfaced as a validated target for a new call; a receipt or
`PAYMENT-SIGNATURE` is never
forwarded to a redirect target. Trusted local CLIs require an exact-origin
`MONEY_FETCH_PRIVATE_ORIGINS` opt-in whose addresses are all loopback,
RFC1918, CGNAT, or IPv6 ULA. Link-local metadata and other reserved ranges
remain unreachable even when listed.

The owner, seller, and compliance login/onboarding clients apply the same
HTTPS-or-explicit-loopback and bare-origin rule to configured control-plane
URLs. They refuse redirects, time out stalled requests, and parse JSON only
after enforcing a response-size ceiling so signed headers cannot be carried to
an unexpected origin.

## What the verifier proves

Seller and facilitator response fields are treated as claims, not evidence.
The independent RPC verifier checks all of the following before confirmation:

- the network is configured and the transaction has the required depth;
- the seller-reported payer and network match the signed authorization;
- the EIP-712 signature is valid for the pinned USDC domain and payer;
- the transaction calls the allowlisted token's
  `transferWithAuthorization` method;
- calldata exactly matches `from`, `to`, value, validity window and nonce;
- the receipt succeeded and contains the exact ERC-20 `Transfer` log; and
- the destination, amount, asset and network match the durable intent.

The enabled method is EIP-3009 only. Permit2, ERC-7710, arbitrary tokens,
smart-wallet wrappers and seller-selected EIP-712 domains are rejected.

## Authorization custody and rotation

Postgres stores only AES-256-GCM ciphertext, a SHA-256 plaintext hash and the
key ID. Associated data binds the ciphertext to every durable economic term
and both authorization deadlines. Decryption authenticates the envelope,
recomputes the hash, decodes the official x402 payload and rechecks it against
the database tuple before release.

Configure a versioned keyring rather than a single long-lived key:

```text
MONEY_EXTERNAL_HEADER_KEYS={"2026-07":"<32-byte-base64>","2026-06":"<32-byte-base64>"}
MONEY_EXTERNAL_HEADER_ACTIVE_KEY_ID=2026-07
```

Run re-encryption under a login inheriting only `money_key_rotation`:

```bash
npm run external:rotate-keys
```

The command reads only the fields needed to authenticate the existing
ciphertext, verifies the plaintext hash, encrypts with the active key, and
uses a compare-and-swap database function. It cannot read balances or move
money. Keep old key material in the rotation process until it reports no
remaining candidates; then remove the old key from API and rotation keyrings.

## Deployment contract

Run migrations with a schema-owner connection, then apply `db/roles.sql` as a
database administrator. Use separate login roles for the API, reversal
worker, key rotation, treasury and operations processes.

```bash
npm run db:migrate
npm run api:db
npm run external:worker
```

External routes open only when all three production capabilities exist:

1. a nonzero remote EVM signer address, HTTPS HSM/key-service endpoint, and
   separately rotatable bearer credential;
2. an authorization-encryption keyring with an active key; and
3. an independent HTTPS RPC configuration for every enabled network.

The remote signer receives EIP-712 typed data plus the configured public
address and returns `{ "signature": "0x..." }`. The client refuses redirects,
bounds or cancels the response, rejects URL-embedded credentials and query
parameters, and verifies the signature locally against the configured address
before accepting it. Production requires a 32+ character bearer credential.
Raw private keys are permitted only for local development and are refused in
production.

Example environment shape:

```text
MONEY_EVM_SIGNER_URL=https://signer.internal.example/x402
MONEY_EVM_SIGNER_ADDRESS=0x...
MONEY_EVM_SIGNER_TOKEN=...
MONEY_EVM_RPC_URLS={"eip155:84532":{"url":"https://rpc.example","confirmations":2}}
```

The application never performs an HSM or RPC call while holding a money or
lifecycle lock. The API role can prepare, activate, approve, confirm and read
its scoped payment data. It cannot post raw transfers, reverse payments,
rotate ciphertext or read the external table. The reversal worker can only
sweep. The key-rotation role can only list rotation candidates and replace a
ciphertext when the plaintext hash is unchanged.

## Release boundary

This is a real protocol and verification adapter, not permission to deploy
customer funds. A live launch still requires at least:

- a funded and reconciled treasury wallet with alerting and exposure limits;
- sponsor-bank/FBO top-up and payout integration;
- KYC/KYB, sanctions, fraud, safeguarding and money-transmission controls;
- RPC/provider redundancy and production HSM policy;
- seller-response recovery testing for servers that do not support payment
  identifiers; and
- incident, dispute and reconciliation runbooks.

Until those controls exist, use Base Sepolia or the explicit local mock. Do
not infer production financial readiness from protocol-green tests.
