import { createHash } from "node:crypto";
import { PostgresCompliance, type RiskTier } from "../../src/db/compliance.ts";
import type { SqlExecutor } from "../../src/db/database.ts";

const hash = (value: string) => createHash("sha256").update(value).digest();

/**
 * Supplies deterministic, non-PII compliance evidence for integration tests
 * whose subject is the payment behavior rather than onboarding itself.
 */
export async function approveComplianceFixture(
  db: SqlExecutor,
  userId: string,
  riskTier: Exclude<RiskTier, "prohibited"> = "standard"
) {
  const compliance = new PostgresCompliance(db);
  const observedAt = new Date(Date.now() - 1_000);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
  await compliance.beginVerification({
    userId,
    subjectType: "individual",
    countryCode: "US",
    expectedSingleMicros: 5_000_000_000n,
    expectedMonthlyMicros: 50_000_000_000n,
  });
  await compliance.recordEvidence({
    subjectAccountId: userId,
    kind: "identity",
    provider: "fixture",
    providerResultRef: `identity-${userId}`,
    decision: "clear",
    evidenceHash: hash(`identity:${userId}`),
    listVersion: "identity-v1",
    observedAt,
    expiresAt,
    normalized: { identityVerified: true },
  });
  await compliance.recordEvidence({
    subjectAccountId: userId,
    kind: "sanctions",
    provider: "fixture",
    providerResultRef: `sanctions-${userId}`,
    decision: "clear",
    evidenceHash: hash(`sanctions:${userId}`),
    listVersion: "screening-v1",
    observedAt,
    expiresAt,
    normalized: { matches: 0 },
  });
  return compliance.approveSubject({
    subjectAccountId: userId,
    riskTier,
    nextReviewAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
    reviewReference: `CASE-${userId}`,
    reason: "fixture evidence reviewed",
  });
}

export async function clearCounterpartyFixture(
  db: SqlExecutor,
  canonicalRef: string,
  kind: "wallet" | "bank_destination" | "merchant" | "domain" = "wallet"
) {
  const compliance = new PostgresCompliance(db);
  const refHash = createHash("sha256").update(canonicalRef).digest("hex").slice(0, 24);
  const counterparty = await compliance.registerCounterparty({
    kind,
    canonicalRef,
    label: `Fixture ${kind}`,
    provider: "fixture",
    providerRef: `${kind}-${refHash}`,
  });
  return compliance.recordCounterpartyScreening({
    counterpartyId: counterparty.id,
    state: "clear",
    evidenceHash: hash(`counterparty:${canonicalRef}`),
    listVersion: "screening-v1",
    screenedAt: new Date(Date.now() - 1_000),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
  });
}

export async function linkTreasuryDestinationFixture(
  db: SqlExecutor,
  destinationId: string,
  canonicalRef: string
) {
  const counterparty = await clearCounterpartyFixture(
    db,
    canonicalRef,
    "bank_destination"
  );
  await new PostgresCompliance(db).linkTreasuryDestination({
    destinationId,
    counterpartyId: counterparty.id,
    reviewReference: "FIXTURE-DESTINATION-REVIEW",
  });
  return counterparty;
}
