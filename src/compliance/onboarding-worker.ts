import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { enforceProductionPreflight } from "../deploy/preflight.ts";
import {
  PostgresCompliance,
  type ComplianceVerificationClaim,
} from "../db/compliance.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import { ComplianceProviderError, type ComplianceProvider } from "./provider.ts";
import { createComplianceProviderFromEnv } from "./runtime.ts";
import {
  encryptHostedVerificationUrl,
  parseComplianceSessionKeyring,
  type ComplianceSessionKeyring,
} from "./session-cipher.ts";

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function retrySeconds(attempts: number, error?: unknown): number {
  const backoff = Math.min(21_600, Math.max(5, 2 ** Math.min(attempts, 14)));
  return error instanceof ComplianceProviderError && error.retryAfterSeconds !== undefined
    ? Math.min(86_400, Math.max(backoff, error.retryAfterSeconds))
    : backoff;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "hosted verification creation failed").slice(0, 1_000);
}

function permanent(error: unknown): boolean {
  if (error instanceof ComplianceProviderError) return !error.retryable;
  return error instanceof Error && (
    error.message.includes("untrusted hosted URL")
    || error.message.includes("expiry is outside")
    || error.message.includes("profile is invalid")
    || error.message.includes("returned invalid JSON")
    || error.message.includes("response is too large")
    || error.message.includes("non-inquiry resource")
    || error.message.includes("bound to a different subject")
    || error.message.includes("used a different template")
    || error.message.includes("must be an object")
    || error.message.includes("must be a non-empty string")
  );
}

export async function processComplianceVerificationClaim(
  compliance: PostgresCompliance,
  provider: ComplianceProvider,
  keyring: ComplianceSessionKeyring,
  workerId: string,
  claim: ComplianceVerificationClaim,
) {
  if (claim.provider !== provider.provider) {
    throw new Error(`unsupported compliance provider ${claim.provider}`);
  }
  const inquiry = await provider.createInquiry({
    sessionId: claim.id,
    subjectAccountId: claim.subjectAccountId,
    subjectType: claim.subjectType,
    countryCode: claim.countryCode,
  });
  const binding = {
    sessionId: claim.id,
    subjectAccountId: claim.subjectAccountId,
    provider: claim.provider,
    expiresAt: inquiry.expiresAt,
  };
  const encrypted = encryptHostedVerificationUrl(inquiry.hostedUrl, keyring, binding);
  const session = await compliance.completeVerificationSession({
    workerId,
    sessionId: claim.id,
    providerInquiryRef: inquiry.id,
    hostedUrlCiphertext: encrypted.ciphertext,
    hostedUrlHash: createHash("sha256").update(inquiry.hostedUrl, "utf8").digest(),
    encryptionKeyId: encrypted.keyId,
    expiresAt: inquiry.expiresAt,
  });
  return { sessionId: session.id, expiresAt: session.expiresAt };
}

export async function runComplianceOnboardingBatch(
  compliance: PostgresCompliance,
  provider: ComplianceProvider,
  keyring: ComplianceSessionKeyring,
  workerId: string,
  limit = 25,
) {
  const expired = await compliance.expireVerificationSessions(100);
  const claims = await compliance.claimVerificationSessions(workerId, limit);
  let completed = 0;
  let failed = 0;
  for (const claim of claims) {
    try {
      await processComplianceVerificationClaim(compliance, provider, keyring, workerId, claim);
      completed += 1;
    } catch (error) {
      await compliance.failVerificationSession({
        workerId,
        sessionId: claim.id,
        error: safeMessage(error),
        retrySeconds: retrySeconds(claim.attempts, error),
        dead: claim.attempts >= 25 || permanent(error),
      });
      failed += 1;
    }
  }
  return { claimed: claims.length, completed, failed, expired };
}

export async function startComplianceOnboardingWorker() {
  enforceProductionPreflight("compliance-onboarding");
  const connectionString = process.env.MONEY_COMPLIANCE_ONBOARDING_DATABASE_URL;
  const encodedKeys = process.env.MONEY_COMPLIANCE_SESSION_KEYS;
  const activeKeyId = process.env.MONEY_COMPLIANCE_SESSION_ACTIVE_KEY_ID;
  if (!connectionString || !encodedKeys || !activeKeyId) {
    throw new Error(
      "MONEY_COMPLIANCE_ONBOARDING_DATABASE_URL and compliance session keyring are required",
    );
  }
  const db = new PostgresDatabase({
    connectionString,
    applicationName: "money-compliance-onboarding",
    maxConnections: 2,
  });
  const compliance = new PostgresCompliance(db);
  const provider = createComplianceProviderFromEnv();
  const keyring = parseComplianceSessionKeyring(encodedKeys, activeKeyId);
  const workerId = `${hostname()}:${process.pid}:compliance-onboarding`;
  const intervalMs = boundedInteger(
    process.env.MONEY_COMPLIANCE_ONBOARDING_INTERVAL_MS,
    1_000,
    250,
    2_147_483_647,
    "MONEY_COMPLIANCE_ONBOARDING_INTERVAL_MS",
  );
  const batchSize = boundedInteger(
    process.env.MONEY_COMPLIANCE_ONBOARDING_BATCH_SIZE,
    25,
    1,
    100,
    "MONEY_COMPLIANCE_ONBOARDING_BATCH_SIZE",
  );
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      const batch = await runComplianceOnboardingBatch(
        compliance, provider, keyring, workerId, batchSize,
      );
      if (batch.claimed === 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    await db.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startComplianceOnboardingWorker().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
