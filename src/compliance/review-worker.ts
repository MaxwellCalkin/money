import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { PostgresCompliance } from "../db/compliance.ts";
import { PostgresDatabase } from "../db/postgres.ts";

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string
) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export async function runComplianceReviewSweep(
  compliance: PostgresCompliance,
  limit = 100
) {
  return compliance.sweepExpired(limit);
}

export async function startComplianceReviewWorker() {
  const connectionString = process.env.MONEY_RISK_WORKER_DATABASE_URL;
  if (!connectionString) throw new Error("MONEY_RISK_WORKER_DATABASE_URL is required");
  const db = new PostgresDatabase({
    connectionString,
    applicationName: `money-compliance-reviews:${hostname()}:${process.pid}`,
    maxConnections: 1,
  });
  const compliance = new PostgresCompliance(db);
  const intervalMs = boundedInteger(
    process.env.MONEY_COMPLIANCE_REVIEW_INTERVAL_MS,
    60_000,
    1_000,
    2_147_483_647,
    "MONEY_COMPLIANCE_REVIEW_INTERVAL_MS"
  );
  const limit = boundedInteger(
    process.env.MONEY_COMPLIANCE_REVIEW_BATCH_SIZE,
    100,
    1,
    500,
    "MONEY_COMPLIANCE_REVIEW_BATCH_SIZE"
  );
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      const result = await runComplianceReviewSweep(compliance, limit);
      if (result.restrictedSubjects > 0 || result.expiredCounterparties > 0) {
        console.log(JSON.stringify({ event: "compliance_expiry_sweep", ...result }));
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    await db.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startComplianceReviewWorker().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
