import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { enforceProductionPreflight } from "../deploy/preflight.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import { PostgresTreasury } from "../db/treasury.ts";
import { ColumnApiError, ColumnClient, columnPayoutState } from "./column.ts";
import { readBoundedInteger } from "./runtime.ts";

function message(error: unknown): string {
  return (error instanceof Error ? error.message : "payout submission failed").slice(0, 1_000);
}

function retrySeconds(attempt: number): number {
  return Math.min(21_600, Math.max(5, 2 ** Math.min(attempt, 14)));
}

function definitiveRejection(error: ColumnApiError): boolean {
  return error.status === 400 || error.status === 404 || error.status === 422;
}

export interface ColumnPayoutSource {
  bankAccountId?: string;
  accountNumberId?: string;
}

/** Claims are committed before this function is called. No database lock is
 * held over the provider request. Column receives a deterministic idempotency
 * key derived from the immutable payout UUID. */
export async function runTreasuryPayoutBatch(
  treasury: PostgresTreasury,
  column: ColumnClient,
  workerId: string,
  source: ColumnPayoutSource,
  limit = 25
) {
  const claims = await treasury.claimPayouts(workerId, limit);
  let submitted = 0;
  let reversed = 0;
  let retrying = 0;
  let manualReview = 0;
  for (const claim of claims) {
    if (claim.provider !== "column" || claim.asset !== "USD") {
      await treasury.markPayoutManualReview(workerId, claim.payoutId, undefined, `unsupported payout route ${claim.provider}/${claim.asset}`);
      manualReview += 1;
      continue;
    }
    try {
      const transfer = await column.createAchPayout({
        payoutId: claim.payoutId,
        ...(source.bankAccountId ? { sourceBankAccountId: source.bankAccountId } : {}),
        ...(source.accountNumberId ? { sourceAccountNumberId: source.accountNumberId } : {}),
        counterpartyId: claim.providerRef,
        amountMicros: claim.amountMicros,
      });
      const state = columnPayoutState(transfer.status);
      if (!state) {
        await treasury.markPayoutManualReview(workerId, claim.payoutId, transfer.id, `unsupported Column payout state ${transfer.status}`);
        manualReview += 1;
        continue;
      }
      const result = await treasury.recordPayoutSubmission(workerId, claim.payoutId, transfer.id, state);
      if (result.state === "failed" || result.state === "returned" || result.state === "cancelled") reversed += 1;
      else submitted += 1;
    } catch (error) {
      if (error instanceof ColumnApiError && definitiveRejection(error)) {
        await treasury.failPayoutSubmission(workerId, claim.payoutId, message(error));
        reversed += 1;
      } else if (error instanceof ColumnApiError && error.retryable) {
        await treasury.releasePayoutClaim(workerId, claim.payoutId, message(error), retrySeconds(claim.attempts));
        retrying += 1;
      } else {
        // A successful-but-malformed response, auth failure, or invariant
        // mismatch may hide a created transfer. Never blind-retry it.
        await treasury.markPayoutManualReview(workerId, claim.payoutId, undefined, message(error));
        manualReview += 1;
      }
    }
  }
  return { claimed: claims.length, submitted, reversed, retrying, manualReview };
}

export async function startTreasuryPayoutWorker() {
  enforceProductionPreflight("treasury-payouts");
  const connectionString = process.env.MONEY_PAYOUT_DATABASE_URL;
  const apiKey = process.env.MONEY_COLUMN_PAYOUT_API_KEY;
  const bankAccountId = process.env.MONEY_COLUMN_PAYOUT_BANK_ACCOUNT_ID;
  const accountNumberId = process.env.MONEY_COLUMN_PAYOUT_ACCOUNT_NUMBER_ID;
  if (!connectionString || !apiKey) throw new Error("MONEY_PAYOUT_DATABASE_URL and MONEY_COLUMN_PAYOUT_API_KEY are required");
  if ((!bankAccountId && !accountNumberId) || (bankAccountId && accountNumberId)) {
    throw new Error("configure exactly one MONEY_COLUMN_PAYOUT_BANK_ACCOUNT_ID or MONEY_COLUMN_PAYOUT_ACCOUNT_NUMBER_ID");
  }
  const db = new PostgresDatabase({ connectionString, applicationName: "money-treasury-payouts", maxConnections: 2 });
  const treasury = new PostgresTreasury(db);
  const column = new ColumnClient({ apiKey });
  const workerId = `${hostname()}:${process.pid}:treasury-payouts`;
  const source: ColumnPayoutSource = {
    ...(bankAccountId ? { bankAccountId } : {}),
    ...(accountNumberId ? { accountNumberId } : {}),
  };
  const intervalMs = readBoundedInteger(process.env.MONEY_PAYOUT_INTERVAL_MS, 1_000, 250, 2_147_483_647, "MONEY_PAYOUT_INTERVAL_MS");
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      const result = await runTreasuryPayoutBatch(treasury, column, workerId, source);
      if (result.claimed === 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    await db.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startTreasuryPayoutWorker().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
