import { randomBytes } from "node:crypto";
import { generateAgentKeypair } from "../core/identity.ts";
import { PostgresCompliance, type ComplianceOperator } from "../db/compliance.ts";
import { PostgresDatabase } from "../db/postgres.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const connectionString = process.env.MONEY_COMPLIANCE_ADMIN_DATABASE_URL;
  const name = arg("name");
  const handle = arg("handle")?.toLowerCase();
  const role = arg("role") as ComplianceOperator["role"] | undefined;
  const reviewReference = arg("review-reference");
  const reason = arg("reason") ?? "named compliance operator provisioned";
  if (!connectionString || !name || !handle || !role || !reviewReference
    || !["analyst", "supervisor", "administrator"].includes(role)) {
    throw new Error(
      "MONEY_COMPLIANCE_ADMIN_DATABASE_URL and --name, --handle, --role, "
      + "--review-reference are required",
    );
  }
  const keys = generateAgentKeypair();
  const operatorId = `cop_${randomBytes(12).toString("base64url")}`;
  const db = new PostgresDatabase({
    connectionString,
    applicationName: "money-compliance-operator-setup",
    maxConnections: 1,
  });
  try {
    const operator = await new PostgresCompliance(db).registerOperator({
      id: operatorId,
      name,
      handle,
      publicKey: keys.publicKey,
      role,
      reviewReference,
      reason,
    });
    console.log(`registered @${operator.handle} as ${operator.role} (${operator.id})`);
    console.log();
    console.log("Save this signing credential in the approved secrets manager. It is shown once:");
    console.log(JSON.stringify({
      MONEY_COMPLIANCE_OPERATOR_ID: operator.id,
      MONEY_COMPLIANCE_OPERATOR_KEY: keys.privateKey,
    }));
    console.log();
    console.log("Mint a browser session with npm run compliance:login.");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
