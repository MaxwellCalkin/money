import { pathToFileURL } from "node:url";
import { enforceProductionPreflight } from "../deploy/preflight.ts";
import { PostgresCards } from "./cards.ts";
import { PostgresExternal } from "./external.ts";
import { PostgresDatabase } from "./postgres.ts";

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`expected an integer between ${min} and ${max}`);
  }
  return parsed;
}

export async function sweepExternalOnce(
  external: PostgresExternal,
  limit = 100
): Promise<Array<{ externalId: string; reversalTransferId: string }>> {
  return external.sweep(limit);
}

/** Expires pending card authorizations past their clearing window first, then
 * releases cards that are closed or expired and hold nothing, so a card never
 * releases its remainder while an authorization could still clear. */
export async function sweepCardsOnce(
  cards: PostgresCards,
  limit = 100
): Promise<{
  expiredAuthorizations: Array<{ authorizationId: string; cardId: string }>;
  finalizedCards: Array<{ cardId: string; state: string; releaseTransferId?: string }>;
}> {
  const expiredAuthorizations = await cards.sweepAuthorizations(limit);
  const finalizedCards = await cards.sweepCards(limit);
  return { expiredAuthorizations, finalizedCards };
}

/** Separate least-privilege worker. It never receives API identity keys,
 * wallet material, ciphertext keys, issuer credentials, or table-write
 * privileges. */
export async function startExternalReversalWorker() {
  enforceProductionPreflight("external-worker");
  const intervalMs = boundedInteger(process.env.MONEY_EXTERNAL_SWEEP_INTERVAL_MS, 5_000, 100, 60_000);
  const batchSize = boundedInteger(process.env.MONEY_EXTERNAL_SWEEP_BATCH, 100, 1, 1_000);
  const db = new PostgresDatabase({
    connectionString: process.env.MONEY_WORKER_DATABASE_URL ?? process.env.DATABASE_URL,
    applicationName: "money-external-reversal-worker",
    maxConnections: 2,
  });
  const external = new PostgresExternal(db);
  const cards = new PostgresCards(db);
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  try {
    while (!stopping) {
      const reversed = await sweepExternalOnce(external, batchSize);
      if (reversed.length > 0) {
        console.log(`reversed ${reversed.length} expired external payment(s)`);
      }
      const swept = await sweepCardsOnce(cards, batchSize);
      if (swept.expiredAuthorizations.length > 0) {
        console.log(`expired ${swept.expiredAuthorizations.length} card authorization(s)`);
      }
      if (swept.finalizedCards.length > 0) {
        console.log(`released ${swept.finalizedCards.length} closed or expired card(s)`);
      }
      if (stopping) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        const timer = setTimeout(resolve, intervalMs);
        const prior = wake;
        wake = () => {
          clearTimeout(timer);
          prior();
        };
      });
      wake = undefined;
    }
  } finally {
    await db.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startExternalReversalWorker().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
