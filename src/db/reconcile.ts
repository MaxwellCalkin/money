import { pathToFileURL } from "node:url";
import { PostgresLedger } from "./ledger.ts";
import { PostgresDatabase } from "./postgres.ts";

async function main() {
  const db = new PostgresDatabase({ applicationName: "money-reconcile", maxConnections: 1, statementTimeoutMs: 60_000 });
  try {
    const rows = await new PostgresLedger(db).reconcile();
    const mismatches = rows.filter((row) => !row.matches);
    if (mismatches.length > 0) {
      for (const row of mismatches) {
        console.error(`${row.accountId}/${row.asset}: cache=${row.cachedMicros} journal=${row.journalMicros}`);
      }
      throw new Error(`${mismatches.length} ledger balance mismatch(es)`);
    }
    console.log(`ledger reconciliation clean across ${rows.length} account/asset balances`);
  } finally {
    await db.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
