import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { enforceProductionPreflight } from "../deploy/preflight.ts";
import { PostgresCompliance, type ComplianceEventClaim } from "../db/compliance.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import { ComplianceProviderError, type ComplianceProvider } from "./provider.ts";
import { createComplianceProviderFromEnv } from "./runtime.ts";

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

function retrySeconds(attempts: number, error?: unknown): number {
  const backoff = Math.min(21_600, Math.max(5, 2 ** Math.min(attempts, 14)));
  return error instanceof ComplianceProviderError && error.retryAfterSeconds !== undefined
    ? Math.min(86_400, Math.max(backoff, error.retryAfterSeconds))
    : backoff;
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
    || error.message.includes("different primary result id")
    || error.message.includes("different inquiry id")
    || error.message.includes("different report id")
    || error.message.includes("different report type")
    || error.message.includes("raw identity field")
    || error.message.includes("reused with different evidence")
    || error.message.includes("unsupported evidence kind")
    || error.message.includes("invalid evidence set")
    || error.message.includes("invalid compliance evidence")
    || error.message.includes("invalid compliance event evidence")
    || error.message.includes("evidence set spans multiple subjects")
    || error.message.includes("evidence spans multiple subjects")
    || error.message.includes("duplicate result ids")
    || error.message.includes("evidence ordinal was reused")
    || error.message.includes("provider subject")
    || error.message.includes("evidence set changed on replay")
    || error.message.includes("invalid decision")
    || error.message.includes("expires before")
    || error.message.includes("response is too large")
    || error.message.includes("non-inquiry resource")
    || error.message.includes("invalid subject reference")
    || error.message.includes("unconfigured template")
    || error.message.includes("unconfigured report template")
    || error.message.includes("template id is invalid")
    || error.message.includes("inquiry reports relationship is invalid")
    || error.message.includes("inquiry account relationship is invalid")
    || error.message.includes("different inquiry account")
    || error.message.includes("unsupported Persona report")
    || error.message.includes("unsupported status")
    || error.message.includes("missing has-match")
    || error.message.includes("continuous-monitoring state")
    || error.message.includes("timestamp is in the future")
    || error.message.includes("too many report")
    || error.message.includes("evidence result reference is too long")
    || error.message.includes("is not a valid Persona")
    || error.message.includes("inquiry event reference")
    || error.message.includes("report event reference")
    || error.message.includes("report account relationship")
    || error.message.includes("must include exactly one account resource")
    || error.message.includes("included account does not match")
    || error.message.includes("watchlist report has no account")
    || error.message.includes("account id is invalid")
    || error.message.includes("different account id")
    || error.message.includes("account has an invalid subject reference")
    || error.message.includes("result reference is invalid")
    || error.message.includes("must be an object")
    || error.message.includes("must be a non-empty string")
  );
}

export async function processComplianceEventClaim(
  compliance: PostgresCompliance,
  provider: ComplianceProvider,
  workerId: string,
  claim: ComplianceEventClaim
) {
  if (claim.provider !== provider.provider) {
    throw new Error(`unsupported compliance provider ${claim.provider}`);
  }
  const results = await provider.getResults(claim.providerResultRef);
  if (results.length < 1 || results.length > 16) {
    throw new Error("compliance provider returned an invalid evidence set");
  }
  if (results[0]!.id !== claim.providerResultRef) {
    throw new Error("compliance provider evidence set has a different primary result id");
  }
  const subjectAccountId = results[0]!.subjectAccountId;
  const resultIds = new Set<string>();
  for (const result of results) {
    if (result.subjectAccountId !== subjectAccountId) {
      throw new Error("compliance provider evidence set spans multiple subjects");
    }
    if (resultIds.has(result.id)) {
      throw new Error("compliance provider evidence set contains duplicate result ids");
    }
    resultIds.add(result.id);
  }
  const evidence = await compliance.recordEventEvidenceSet({
    workerId,
    inboxId: claim.inboxId,
    items: results.map((result) => ({
      subjectAccountId: result.subjectAccountId,
      ...(result.providerSubjectRef
        ? { providerSubjectRef: result.providerSubjectRef }
        : {}),
      kind: result.kind,
      providerResultRef: result.id,
      decision: result.decision,
      evidenceHash: result.evidenceHash,
      ...(result.listVersion ? { listVersion: result.listVersion } : {}),
      observedAt: result.observedAt,
      expiresAt: result.expiresAt,
      normalized: result.normalized,
    })),
  });
  return {
    evidenceId: evidence.primaryEvidenceId,
    evidenceIds: evidence.evidenceIds,
    subjectState: evidence.subjectState,
  };
}

export async function runComplianceEventBatch(
  compliance: PostgresCompliance,
  provider: ComplianceProvider,
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
      try {
        await compliance.failEvent(
          workerId,
          claim.inboxId,
          message(error),
          retrySeconds(claim.attempts, error),
          dead,
        );
      } catch (failureError) {
        // A slow provider call can outlive a lease. If another worker has
        // reclaimed it, that worker owns the outcome and this process should
        // not turn the expected handoff into a crash loop.
        if (databaseCode(failureError) !== "42501") throw failureError;
      }
      failed += 1;
    }
  }
  return { claimed: claims.length, completed, failed };
}

export async function startComplianceEventWorker() {
  enforceProductionPreflight("compliance-events");
  const connectionString = process.env.MONEY_COMPLIANCE_WORKER_DATABASE_URL;
  if (!connectionString) throw new Error("MONEY_COMPLIANCE_WORKER_DATABASE_URL is required");
  const db = new PostgresDatabase({
    connectionString, applicationName: "money-compliance-events", maxConnections: 2,
  });
  const compliance = new PostgresCompliance(db);
  const provider = createComplianceProviderFromEnv();
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
