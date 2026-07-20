import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { PostgresCompliance, type ComplianceEventClaim } from "../db/compliance.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import { ComplianceProviderClient, ComplianceProviderError } from "./provider.ts";

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number, name: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function databaseCode(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === "object"; depth += 1) {
    const candidate = cursor as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    cursor = candidate.cause;
  }
  return undefined;
}

function retrySeconds(attempts: number): number {
  return Math.min(21_600, Math.max(5, 2 ** Math.min(attempts, 14)));
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : "compliance event failed").slice(0, 1_000);
}

function permanentFailure(error: unknown): boolean {
  if (error instanceof ComplianceProviderError) return !error.retryable && error.status !== 404;
  const code = databaseCode(error);
  if (code === "P0002" || code === "40001" || code === "40P01") return false;
  return error instanceof Error && (
    error.message.includes("different result id")
    || error.message.includes("raw identity field")
    || error.message.includes("reused with different evidence")
    || error.message.includes("unsupported evidence kind")
    || error.message.includes("invalid decision")
    || error.message.includes("expires before")
  );
}

export async function processComplianceEventClaim(
  compliance: PostgresCompliance,
  provider: ComplianceProviderClient,
  workerId: string,
  claim: ComplianceEventClaim
) {
  if (claim.provider !== provider.provider) {
    throw new Error(`unsupported compliance provider ${claim.provider}`);
  }
  const result = await provider.getResult(claim.providerResultRef);
  const evidence = await compliance.recordEvidence({
    subjectAccountId: result.subjectAccountId,
    kind: result.kind,
    provider: provider.provider,
    providerResultRef: result.id,
    decision: result.decision,
    evidenceHash: result.evidenceHash,
    ...(result.listVersion ? { listVersion: result.listVersion } : {}),
    observedAt: result.observedAt,
    expiresAt: result.expiresAt,
    normalized: result.normalized,
  });
  await compliance.completeEvent(workerId, claim.inboxId, evidence.evidenceId);
  return { evidenceId: evidence.evidenceId, subjectState: evidence.subjectState };
}

export async function runComplianceEventBatch(
  compliance: PostgresCompliance,
  provider: ComplianceProviderClient,
  workerId: string,
  limit = 25
) {
  const claims = await compliance.claimEvents(workerId, limit);
  let completed = 0;
  let failed = 0;
  for (const claim of claims) {
    try {
      await processComplianceEventClaim(compliance, provider, workerId, claim);
      completed += 1;
    } catch (error) {
      const dead = claim.attempts >= 25 || permanentFailure(error);
      await compliance.failEvent(workerId, claim.inboxId, message(error), retrySeconds(claim.attempts), dead);
      failed += 1;
    }
  }
  return { claimed: claims.length, completed, failed };
}

export async function startComplianceEventWorker() {
  const connectionString = process.env.MONEY_COMPLIANCE_WORKER_DATABASE_URL;
  const providerName = process.env.MONEY_COMPLIANCE_PROVIDER;
  const baseUrl = process.env.MONEY_COMPLIANCE_PROVIDER_URL;
  const apiKey = process.env.MONEY_COMPLIANCE_PROVIDER_API_KEY;
  if (!connectionString || !providerName || !baseUrl || !apiKey) {
    throw new Error(
      "MONEY_COMPLIANCE_WORKER_DATABASE_URL, MONEY_COMPLIANCE_PROVIDER, " +
      "MONEY_COMPLIANCE_PROVIDER_URL, and MONEY_COMPLIANCE_PROVIDER_API_KEY are required"
    );
  }
  const db = new PostgresDatabase({
    connectionString, applicationName: "money-compliance-events", maxConnections: 2,
  });
  const compliance = new PostgresCompliance(db);
  const provider = new ComplianceProviderClient({
    provider: providerName, baseUrl, apiKey,
    allowInsecureLocalhost: process.env.NODE_ENV !== "production",
  });
  const workerId = `${hostname()}:${process.pid}:compliance-events`;
  const intervalMs = boundedInteger(
    process.env.MONEY_COMPLIANCE_EVENT_INTERVAL_MS, 1_000, 250, 2_147_483_647,
    "MONEY_COMPLIANCE_EVENT_INTERVAL_MS"
  );
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      const batch = await runComplianceEventBatch(compliance, provider, workerId);
      if (batch.claimed === 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    await db.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startComplianceEventWorker().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
