# Security policy

Money is a pre-production financial-network prototype. No released version is
currently approved for customer funds, and no branch should be treated as a
supported production service merely because its tests pass.

The repository-specific security model, trust boundaries, residual risks, and
release evidence are documented in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).
Operational launch blockers are documented in [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md),
[`docs/TREASURY.md`](docs/TREASURY.md), and
[`docs/RELEASES.md`](docs/RELEASES.md).

## Reporting a vulnerability

Do not put vulnerabilities, credentials, customer information, provider
payloads, wallet material, or exploit details in an issue or pull request.

While this repository is private, collaborators should use a
[draft GitHub repository security advisory](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/fix-reported-vulnerabilities/create-repository-advisory)
when the repository exposes that feature:

1. Open **Security → Advisories → New draft security advisory**. If that path
   is absent, stop and use the pre-arranged private incident channel instead.
2. Describe the affected commit and deployment shape, impact, preconditions,
   and the smallest safe reproduction.
3. Include logs only after removing secrets, personal data, signatures,
   authorization headers, payment headers, and full provider payloads.
4. State whether money movement, authorization custody, compliance evidence,
   or reconciliation may already have been affected.

Do not assume repository-advisory support merely because the repository is
private. If advisory access is unavailable, use the private incident channel
pre-arranged with the project owner; do not fall back to a public report or an
ordinary issue. A monitored security contact, a tested intake path, and an
escalation roster are mandatory before any external beta. This file
deliberately does not invent an unmonitored address.

## Initial handling

The first responder should preserve evidence and assume compromise can cross
service boundaries. Do not destroy or rewrite the journal, receipt chain,
provider inbox, operator evidence, treasury-control events, or deployment logs.

For a suspected live incident:

1. Disable new funding, payouts, and external x402 activation with the existing
   treasury circuit breakers. Freeze affected account families when the scope
   is narrower than the whole network.
2. Revoke compromised owner, agent, provider, operator, database, API, HSM,
   webhook, and encryption credentials. Rotation must retain old decryption
   material until all durable ciphertext using it has been accounted for.
3. Stop the affected ingress or worker without granting another service its
   credentials. Keep webhook capture isolated from evidence interpretation and
   money movement.
4. Reconcile the immutable money journal against cached balances, pending
   external settlements, bank balances, and stablecoin balances. Treat any
   uncertainty as exposure, not as a successful payment.
5. Preserve exact image digests, configuration provenance, provider event IDs,
   database transaction evidence, and relevant chain proofs before remediation.
6. Use two-person review before restoring a breaker, releasing a compliance
   restriction, or resolving an ambiguous payout.

Provider notifications, legal reporting, customer communications, sanctions
escalation, and sponsor-bank escalation depend on the incident and deployment
jurisdiction. Those procedures and named owners must exist before launch.

## Disclosure and remediation rules

- Fixes for money movement, authorization, tenant isolation, compliance
  evidence, webhook authenticity, signer custody, reconciliation, or release
  provenance require a regression test that proves the original failure mode.
- Never weaken a fail-closed control to restore availability. Route uncertain
  states to review, reserve, reversal, or a disabled perimeter.
- Never reuse an exposed secret, nonce domain, idempotency key, encryption key
  identifier, or release image tag after remediation.
- Publish a fixed image by immutable digest only after the complete release
  gates in `docs/RELEASES.md` pass for the exact commit.
- Record residual risk, affected versions or commits, detection coverage,
  rotation scope, reconciliation results, and the restoration decision in the
  private advisory.

There is no bug bounty or public disclosure timeline yet. Those are launch
requirements, not promises this private prototype can currently make.
