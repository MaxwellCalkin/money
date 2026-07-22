## Outcome

Describe the user or operator outcome. State what remains deliberately out of
scope; avoid describing implementation activity as the outcome.

## Authority and money review

- [ ] No new money-moving path, or every new path has an exact operation,
      actor, source, destination, asset, amount, replay key, and authorization
      boundary.
- [ ] Journal conservation, available-balance, mandate, approval, refund,
      reversal, and concurrent-retry invariants are unchanged or have focused
      regression evidence.
- [ ] New or changed database functions begin revoked from `PUBLIC`; runtime
      grants remain operation-specific and effective-role tests cover both
      allowed and forbidden calls.
- [ ] No runtime process receives schema-owner, migration, raw-posting, or
      another service's database or provider authority.
- [ ] Ambiguous provider, chain, signer, compliance, payout, and reconciliation
      outcomes still fail closed.

## Boundary review

- [ ] New external URLs enforce the reviewed scheme, origin, redirect, timeout,
      response-size, DNS/address, TLS, and credential-forwarding policy.
- [ ] New webhook or queue inputs have authenticity, replay, ordering, lease,
      retry, dead-letter/review, and atomic-completion behavior.
- [ ] New durable sensitive values have minimization, encryption, associated
      data, key identity, rotation, retention, and log-redaction rules.
- [ ] New identity, signer, provider, asset, network, service credential, review
      action, or deployment process is reflected in `docs/THREAT_MODEL.md`.

## Database and compatibility

- [ ] Every schema change is an append-only numbered migration, preserves old
      data, is safe to retry through the migration runner, and has a reviewed
      rollback/forward-repair plan.
- [ ] `db/roles.sql`, service preflight allowlists, Compose credentials, build
      entries, documentation, and effective-role tests agree with the final
      command surface.
- [ ] API or protocol changes preserve explicit versioning and deterministic
      idempotent replay, or document a coordinated compatibility break.

## Verification evidence

- [ ] Dependency install used the committed lockfile.
- [ ] Typecheck, complete tests, production build, and dependency audit passed
      for this exact commit.
- [ ] PostgreSQL migrations, rerun/checksum behavior, roles, contention, and
      reconciliation passed when database behavior changed.
- [ ] The exact production image passed preflight and HIGH/CRITICAL scanning;
      its image identity, CycloneDX SBOM, scan report, and `SHA256SUMS` were
      retained when deployment or dependencies changed.
- [ ] Provider sandbox/testnet cases and failure recovery were exercised when an
      external contract changed.

Record commands, workflow links, database/image identities, provider fixture
IDs, and any intentionally unexecuted gate below. A checked box without
authoritative evidence is not a passed gate.
For release candidates, complete `docs/RELEASE_EVIDENCE_TEMPLATE.md` against
the exact candidate commit and image rather than expanding this pull-request
description into an informal release record.

## Rollout, containment, and residual risk

Describe rollout order, feature/breaker state, observability, reversal or
forward-repair procedure, credential rotation, and the fastest safe way to
remove the new authority. Link the incident/change reference for any temporary
exception, including owner and expiration.

Do not include secrets, personal data, provider payloads, signatures,
authorization headers, payment headers, or production database values.
