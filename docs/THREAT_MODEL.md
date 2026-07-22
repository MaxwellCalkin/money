# Threat model

## Purpose and status

This document defines the security boundary for Money v0.13: a closed-loop
agent payment network with bank and stablecoin rails only at its edges. It is a
release requirement, not a claim that the system is ready for customer funds.
The exact candidate still must pass `docs/RELEASES.md`, and a real launch still
depends on the legal, bank, compliance, safeguarding, infrastructure, and
operating controls described in the other deployment documents.

The model assumes an agent can be fully manipulated by hostile instructions.
The model does not trust a model's intent, chain of thought, tool description,
seller response, webhook payload, RPC response, browser, or operator assertion
as authorization by itself.

## Protected assets and invariants

The system is secure only while all of these remain true:

1. **Conservation:** each posted transfer has exactly two immutable journal
   entries whose signed sum is zero. Cached balances are derivatives and can be
   recomputed from the journal.
2. **No overspend:** a debit cannot exceed available balance, and concurrent
   requests cannot evade deterministic account locking.
3. **Bounded agency:** an agent can spend only under a current owner-signed
   mandate. Budget, daily and per-transaction limits, payee rules, expiry,
   escalation, and compliance decisions are evaluated outside model context.
4. **Exact authorization:** signatures, permits, approvals, idempotency keys,
   challenges, and external authorizations bind to the intended actor, source,
   destination, asset, amount, operation, and relevant deadline.
5. **Replay safety:** an exact retry returns the prior result; changed terms
   under the same replay key fail. A retry cannot post or redeem twice.
6. **Tenant isolation:** an owner, agent, provider, reviewer, worker, or service
   can access only the data and commands assigned to that identity and role.
7. **Evidence integrity:** receipts, risk decisions, provider events, evidence
   sets, review actions, restrictions, treasury controls, and reconciliation
   snapshots remain attributable and append-only where required.
8. **Fail-closed uncertainty:** ambiguous compliance, payout, signer, chain,
   provider, or reconciliation states do not become spendable funds or an
   automatic approval.
9. **Custody separation:** customer assets remain in approved external custody;
   the product ledger records beneficial balances. Application processes do not
   gain schema ownership, raw posting authority, or another service's secrets.
10. **Minimum disclosure:** provider PII and one-time payment material are not
    persisted or forwarded beyond the exact purpose and origin that require
    them.

## Actors and trust boundaries

| Boundary | Potentially hostile input | Authority retained behind the boundary |
|---|---|---|
| Owner ceremony | Device, browser, session token, signed request | Owner identity, mandate grants, exact approvals, provider creation, payout destinations |
| Agent runtime and MCP | Prompt, tool result, URL, DNS, 402 challenge, seller body | Agent key and only the mandate already granted to that agent |
| Public product API | Signed bodies, nonces, pagination, identifiers | Tenant-scoped database commands; no raw journal posting or schema ownership |
| Seller/provider API | Listings, prices, challenges, redemption and refunds | Provider-owned services and earned balances only |
| PostgreSQL | Concurrent and replayed commands, compromised application process | Immutable journal, row locks, atomic policy/risk decisions, role allowlists |
| Treasury ingress | Unordered or duplicated Column webhooks | Event enqueue only; no authenticated refetch credentials or money movement |
| Treasury workers | Provider API responses and ambiguous timeouts | Narrow funding, payout, return, reconciliation, and breaker commands |
| Compliance ingress | Persona webhook bytes and timestamps | Event enqueue only; no evidence interpretation or subject approval |
| Compliance workers and desk | Refetched provider state, reviewer commands | Narrow evidence, case, restriction, and maker/checker commands |
| External x402 edge | Seller requirements, facilitator response, RPC view | Remote signing, encrypted authorization release, confirmation or reversal |
| Build and deployment | Dependencies, actions, image layers, environment files | Exact release artifact, segregated service credentials, production preflight |

TLS termination, secret storage, HSM policy, PostgreSQL administration, network
policy, backups, observability, and sponsor-bank custody sit outside this
repository. A deployment that collapses those boundaries invalidates this
model even if the application code is unchanged.

## Primary payment flows

### Internal agent payment

```text
hostile task or tool output
          |
          v
agent-signed exact request + replay key
          |
          v
identity / nonce / mandate / compliance checks
          |
          v
deterministic row locks + balance and policy recheck
          |
          v
two journal entries + receipt + risk decision + outbox
                  one database transaction
```

The agent never receives a primitive that widens its own mandate. Human
approval authorizes one exact tuple and is consumed once; it is not a reusable
capability or a general budget increase.

### External x402 payment

```text
untrusted HTTPS resource and PAYMENT-REQUIRED
          |
          v
normalize and pin economic terms; prepare unsigned intent
          |
          v
policy / approval / compliance decision
          |
          v
remote HSM signs exact EIP-3009 authorization
          |
          v
atomic recheck and internal debit; encrypted header released
          |
          +------ verified calldata, receipt, log, depth ------> confirm
          |
          +------ deadline or definitive failure -------------> reverse
```

Signing outside the transaction prevents a slow signer from holding money
locks. The following atomic activation rechecks every mutable condition. A
seller or RPC assertion is insufficient: confirmation requires the pinned
network, token, method, signature, calldata, transfer log, amount, parties, and
confirmation depth to agree with the durable intent.

### Funding and payout

```text
raw authenticated webhook -> ingress-only inbox -> authenticated provider refetch
                                                   |
                                                   v
                                      exact lifecycle command
                                                   |
                         journal / reserve / return / freeze / breaker
```

Unordered and duplicate events are normal. An unknown transfer, changed
immutable term, ambiguous submission, return, stale balance, or reconciliation
variance fails closed. A payout reserves internal funds before provider I/O;
an ambiguous result stays reserved for reviewed resolution.

### Compliance evidence

```text
raw timestamped webhook -> ingress-only inbox -> authenticated sparse refetch
                                                   |
                                                   v
                         ordered evidence set + subject / restriction changes
                                      one database transaction
```

Persona account continuity binds an approved inquiry and later screening
reports to one opaque provider subject. A clear inquiry alone cannot activate a
subject without current screening evidence. Matches, provider errors, stale
evidence, unrelated reports, associated-person discovery, and conflicting or
out-of-order events route to review or restriction.

## Threat analysis

| Threat | Required control and current evidence | Residual risk / release condition |
|---|---|---|
| Prompt injection induces arbitrary spending | The model has only an agent key; database policy enforces the owner mandate and exact tuple. Tests cover caps, expiry, payees, escalation, replay, and approvals. | Compromise can spend the full authorized envelope. Defaults, owner UX, alerts, and rapid revocation must make that loss acceptable. |
| Agent, owner, provider, or reviewer signature replay | Signed requests bind method/path/body and durable nonces; database uniqueness and actor-scoped idempotency reject replay or changed terms. | Endpoint canonicalization and key rotation must remain regression-tested for every new mutation. |
| Concurrent double-spend or cap bypass | PostgreSQL locks account and policy rows deterministically and posts journal, receipt, risk evidence, and outbox atomically. | Must pass real PostgreSQL contention tests, not only in-process tests, for the exact release. |
| Application process posts arbitrary money movement | Raw posting functions are revoked from service roles; gateways expose operation-specific commands and set transaction-local actor context. | Effective privileges must be tested after every migration and role change. Database owners and migration credentials must never reach runtime services. |
| Cross-owner data or payment access | Signed identity plus tenant-scoped database functions and owner-session hashing constrain reads and mutations. | Browser compromise can use a live session. Production owner ceremony still needs passkeys, device recovery, step-up, and session-risk controls. |
| Malicious seller changes price, destination, asset, or challenge | Internal marketplace prices are registry-authoritative. External x402 normalization pins an allowlisted network, token, method, amount, recipient, deadlines, and URL before signing. | Seller collusion inside an authorized payee/budget remains an economic risk; reputation, disputes, refunds, and monitoring are incomplete. |
| Seller claims settlement without payment | Independent EVM verification checks signer, calldata, successful receipt, exact transfer log, and depth before final confirmation. | RPC quorum/redundancy and reorganization policy require production testing; a single configured RPC remains a trust dependency. |
| Signer or HSM endpoint is redirected, spoofed, or returns another key | Production requires HTTPS, a bare non-loopback URL, bearer credential, no redirects, bounded response, nonzero configured address, and local signature recovery. | HSM authorization policy, mutual authentication, egress policy, key ceremonies, quorum, and disaster recovery are deployment responsibilities. |
| SSRF, DNS rebinding, redirect credential theft, or oversized upstream body | `money_fetch` canonicalizes public HTTPS URLs, rejects private/reserved literal and resolved addresses, pins the vetted address to the socket, retains TLS hostname validation, refuses automatic redirects, never forwards credentials across origins, and bounds bodies. | Exact private-origin opt-ins intentionally grant access to trusted local services. Their operators assume that risk and must constrain the listener and agent mandate. Proxy and platform networking must preserve the tested semantics. |
| Forged, duplicated, delayed, or reordered treasury webhook | Raw-body HMAC, ingress-only credentials, durable deduplication, authenticated refetch, monotonic lifecycle commands, exact immutable-term checks, and reconciliation breakers. | Provider key compromise can create authentic-looking events and API state. Independent asset reconciliation and sponsor-bank escalation remain mandatory. |
| Forged or unrelated compliance result clears a customer | Timestamped rotating webhook HMAC, authenticated sparse refetch, immutable evidence hashes, atomic evidence sets, inquiry/report type and template allowlists, and Persona Account-ID continuity. | Business associated-person discovery is not owner verification; business activation remains fail-closed until every required person has linked KYC/screening. Provider/template contract tests are still required. |
| Compliance PII leaks into the product database or logs | The adapter normalizes only opaque references, hashes, expiry, list/template versions, and allowlisted decision facts; hosted URLs and external payment headers use authenticated encryption. | Provider payloads transit process memory and ingress. Log redaction, memory/core-dump policy, retention, privacy rights, and vendor controls are deployment obligations. |
| Payout destination is swapped or an ambiguous provider timeout is treated as failure | A signed owner/provider payout request must name a verified destination bound to that source account and a current screened bank counterparty. Destination setup/status and compliance linking are segregated treasury/compliance administration commands. Funds reserve before I/O; deterministic provider idempotency and manual-review state prevent blind retries or release. | Strong account-ownership verification, cooling periods, step-up authentication, beneficiary confirmation, and complete fraud operations remain launch blockers. |
| Insider combines incompatible powers | Separate database roles constrain API, ingress, workers, ops, compliance desk, migration, reconciliation, and key rotation; sensitive releases use maker/checker commands and append-only evidence. CODEOWNERS and the high-risk pull-request checklist route every authority change through explicit review evidence. | CODEOWNERS is not enforcement, and the current single owner is not independent control. Protected-branch rules, qualified independent reviewers, cloud/database/secret/HSM separation, monitored break-glass, and access reviews are required outside this repository. |
| Dependency, CI action, or image compromise | Lockfile, exact CI action commits, separately pinned Node builder and shell-less distroless runtime digests, source-revision label, numeric non-root read-only image, no-network production preflight, fixed Trivy version/cache policy, and a commit-named 90-day artifact containing image identity, CycloneDX SBOM, machine-readable blocking scan evidence, and a sorted SHA-256 manifest constrain the artifact. | Signed provenance, registry admission, long-term evidence retention, dependency-review policy, patch cadence, and an independent build environment are required before launch. |
| Denial of service exhausts database, workers, provider quotas, or memory | Bounded bodies, timeouts, pagination, worker leases, capped batches, readiness checks, retries, dead-letter/review states, and process separation limit local amplification. | Edge rate limits, queues, autoscaling, provider quotas, database capacity, DDoS protection, and overload testing are infrastructure requirements. Availability never permits bypassing a money or compliance control. |
| Journal, evidence, or backup is corrupted or selectively restored | Immutable journal/evidence, hash-linked receipts, migration checksums, reconciliation commands, and release-pinned migrations detect several classes of divergence. | Point-in-time recovery, encrypted backups, restore drills, region failure, clock integrity, forensic retention, and independent finance reports must be proven operationally. |

## Deliberately unavailable capabilities

The following gaps are security boundaries, not features that may be enabled by
configuration:

- no production raw private-key x402 signer;
- no runtime schema-owner or migration credential;
- no public or private arbitrary-URL fetch without the public-address policy or
  an exact trusted-private-origin grant;
- no owner-signed fake funding in production;
- no automatic business approval from associated-person discovery;
- no automatic clearance from an ambiguous, stale, errored, mismatched, or
  positive compliance result;
- no payout release from an uncertain provider submission;
- no production customer-fund claim based only on green software tests.

## Known residual product gaps

Before external beta or customer funds, owners must assign and verify concrete
controls for at least:

- passkey-based owner authentication, recovery, step-up, device and session
  risk, and high-risk destination-change ceremonies;
- full beneficial-owner/control-person orchestration and linked evidence;
- account ownership, fraud scoring, transaction monitoring, disputes,
  complaints, refunds/chargebacks, losses, reserves, tax, and privacy rights;
- agent/seller reputation, abuse reporting, malicious-service removal, and
  compromised-agent containment beyond mandate revocation;
- multi-provider bank, compliance, RPC, and signer resilience with tested
  degraded modes;
- rate limiting, DDoS protection, observability, paging, SLOs, backup/restore,
  regional recovery, penetration testing, and red-team exercises;
- sponsor-bank/FBO approval, licensing, safeguarding, sanctions/BSA/AML,
  reporting, record retention, insurance, customer terms, and support staffing.

These gaps mean v0.13 can be a tested software milestone and still cannot be a
live regulated payment network.

## Release evidence

The release owner must retain evidence for the exact commit and image digest:

| Claim | Required evidence |
|---|---|
| Types and unit/integration contracts are coherent | Clean dependency install, typecheck, complete Vitest suite, and production build |
| Database invariants and role isolation hold | Fresh PostgreSQL migration through `0010`, idempotent rerun, role application, effective-privilege tests, contention and reconciliation suite |
| Deployed command surface matches the reviewed source | Image build, Compose render, every service preflight, health/readiness checks, and no cross-service credential leakage |
| Artifact has reviewed provenance and no blocking known vulnerability | Exact action commits and base-image digest, lockfile review, audit, source-revision-labeled image, retained image ID/CycloneDX/scan artifact, exact-image HIGH/CRITICAL result, and immutable registry digest after publication |
| Repository changes cannot bypass required review | Effective protected-branch/ruleset configuration, required exact-head `product`, `postgres`, and `image` checks, code-owner approval, stale-approval dismissal, conversation resolution, force-push/deletion denial, and audited break-glass evidence |
| Persona decisions preserve identity and evidence semantics | Sandbox matrix in `docs/RELEASES.md`, including duplicate/reordered/rotated-secret and monitoring cases |
| External authorization and settlement fail closed | Testnet HSM/RPC matrix in `docs/RELEASES.md`, including wrong key, redirect, timeout, oversized response, delayed confirmation, and reversal |
| Operators can contain and recover an incident | Breaker/freeze/revoke/rotate drills, ledger and asset reconciliation, ambiguous payout exercise, backup restore, and two-person restoration record |
| Non-code authority exists | Signed bank/provider contracts, counsel and compliance approval, named control owners, launch-jurisdiction matrix, and executive go/no-go record |

Missing, indirect, stale, differently configured, or differently versioned
evidence is a failed gate. A narrow unit test cannot prove a deployment-level
claim.

## Incident containment order

When money or evidence integrity is uncertain, responders should preserve
evidence and reduce authority in this order:

1. stop new funding, payouts, and external activation with global breakers;
2. freeze affected account families and revoke affected sessions, keys, and
   mandates;
3. isolate the compromised ingress, worker, API, signer, RPC, or provider while
   retaining durable queues and logs;
4. reconcile journal balances, pending/reserved transitions, bank assets,
   stablecoin assets, provider lifecycle state, and compliance evidence;
5. rotate credentials and encryption keys without orphaning durable
   ciphertext or destroying forensic linkage;
6. repair through append-only reversal, reviewed resolution, or a new migration
   rather than mutating historical evidence;
7. restore one perimeter at a time after independent two-person review and
   retain the decision record.

`SECURITY.md` defines the private reporting channel and first-response rules.
`docs/TREASURY.md` and `docs/COMPLIANCE.md` define the domain-specific
procedures. The deployment must replace document roles with named people and
tested escalation paths before launch.

## Maintaining this model

Any change that adds an asset, payment scheme, provider, signer, RPC, identity
type, mutable money command, data store, external URL, service credential,
review action, or deployment process must update this document in the same
change. The review must identify:

1. the new authority and protected asset;
2. hostile inputs and trust transitions;
3. exact authorization and replay binding;
4. atomicity, concurrency, timeout, and recovery behavior;
5. least-privilege role and secret placement;
6. observable evidence and emergency containment;
7. regression and deployment evidence that proves the control.

If those answers are absent, the change is not release-ready.
