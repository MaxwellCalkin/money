/**
 * DEVELOPMENT-ONLY compliance approval for the local walkthrough.
 *
 * The Postgres kernel fails closed: migration 0008 refuses funding until the
 * owner has current reviewed identity and sanctions evidence. In production
 * that evidence comes from the hosted Persona flow and named reviewers. For a
 * local walkthrough this CLI writes the same deterministic non-PII evidence
 * the integration tests use, through the admin database boundary.
 *
 * It refuses NODE_ENV=production, and in a real deployment the application
 * roles cannot write compliance evidence at all (db/roles.sql), so this tool
 * only works where the operator already holds admin database credentials.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run dev:approve -- --user usr_xxxxxxxx [--tier standard]
 */
import { createHash, randomUUID } from "node:crypto";
import { PostgresCompliance, type RiskTier } from "./db/compliance.ts";
import { PostgresDatabase } from "./db/postgres.ts";

const hash = (value: string) => createHash("sha256").update(value).digest();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(`--${flag}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("dev:approve is a development walkthrough tool and refuses to run in production");
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required (the local development database)");
  const userId = arg("user");
  if (!userId) throw new Error("--user <account id> is required (printed by npm run onboard)");
  const tier = arg("tier") ?? "standard";
  if (!["low", "standard", "high"].includes(tier)) {
    throw new Error("--tier must be low, standard, or high");
  }

  const db = new PostgresDatabase({ connectionString, applicationName: "money-dev-approve", maxConnections: 1 });
  try {
    const compliance = new PostgresCompliance(db);
    const observedAt = new Date(Date.now() - 1_000);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    try {
      await compliance.beginVerification({
        userId,
        subjectType: "individual",
        countryCode: "US",
        expectedSingleMicros: 5_000_000_000n,
        expectedMonthlyMicros: 50_000_000_000n,
      });
    } catch (error) {
      const message = messageOf(error);
      // Re-running against an already-approved subject is the documented
      // recovery path once the +7-day review clock lapses: skip straight to
      // fresh evidence and re-approval, which the kernel permits.
      if (message.includes("cannot be changed through onboarding")) {
        console.log(`subject ${userId} already has a compliance profile; refreshing evidence and review clock`);
      } else if (message.includes("compliance subject not found") || message.includes("account")) {
        throw new Error(
          `account ${userId} does not exist in this database — run npm run onboard first, and check DATABASE_URL points at the same database the API uses`,
        );
      } else {
        throw error;
      }
    }
    // Fresh result refs per run: the kernel refuses a reused provider result
    // ref with different evidence, and a re-run IS different evidence.
    const runRef = randomUUID();
    for (const kind of ["identity", "sanctions"] as const) {
      await compliance.recordEvidence({
        subjectAccountId: userId,
        kind,
        provider: "development",
        providerResultRef: `${kind}-${userId}-${runRef}`,
        decision: "clear",
        evidenceHash: hash(`${kind}:${userId}:${runRef}`),
        listVersion: `${kind}-dev-v1`,
        observedAt,
        expiresAt,
        normalized: kind === "identity" ? { identityVerified: true } : { matches: 0 },
      });
    }
    const subject = await compliance.approveSubject({
      subjectAccountId: userId,
      riskTier: tier as Exclude<RiskTier, "prohibited">,
      nextReviewAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      reviewReference: `DEV-WALKTHROUGH-${userId}`,
      reason: "development walkthrough approval (dev:approve)",
    });
    console.log(`subject ${userId} is now ${subject.state} (${tier} tier) with development evidence`);
    console.log(`resume onboarding: npm run onboard -- --user ${userId}`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
