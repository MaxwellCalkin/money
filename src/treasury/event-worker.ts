import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { PostgresDatabase } from "../db/postgres.ts";
import { PostgresTreasury } from "../db/treasury.ts";
import { ColumnApiError, ColumnClient, normalizeColumnEvent, type ColumnEvent } from "./column.ts";
import { readBoundedInteger } from "./runtime.ts";

function databaseCode(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === "object"; depth += 1) {
    const candidate = cursor as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    cursor = candidate.cause;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "treasury event failed").slice(0, 1_000);
}

function retrySeconds(attempts: number): number {
  return Math.min(21_600, Math.max(5, 2 ** Math.min(attempts, 14)));
}

function permanentProviderEvidenceFailure(error: unknown): boolean {
  if (error instanceof ColumnApiError) return !error.retryable && error.status !== 404;
  const code = databaseCode(error);
  if (code === "P0002" || code === "40001" || code === "40P01") return false;
  return error instanceof Error && (
    error.message.includes("disagree on immutable terms")
    || error.message.includes("only USD ACH credits")
    || error.message.includes("provider event id was reused")
  );
}

export interface TreasuryEventClaim {
  inboxId: bigint;
  provider: string;
  providerEventId: string;
  attempts: number;
}

/** Provider calls occur before the short database command transaction. The
 * event endpoint and current transfer are both authenticated reads. */
export async function processTreasuryEventClaim(
  treasury: PostgresTreasury,
  column: ColumnClient,
  workerId: string,
  claim: TreasuryEventClaim
) {
  if (claim.provider !== "column") throw new Error(`unsupported treasury provider ${claim.provider}`);
  const event = await column.getEvent(claim.providerEventId);
  if (event.id !== claim.providerEventId) throw new Error("Column returned a different provider event id");
  const objectId = typeof event.data.id === "string" ? event.data.id : "";
  if (!objectId) throw new Error("Column event does not identify an ACH transfer");
  const current = await column.getAchTransfer(objectId);
  const normalized = normalizeColumnEvent(event, current);

  if (normalized.kind === "funding_settled") {
    await treasury.settleFunding({
      provider: normalized.provider, providerEventId: normalized.providerEventId,
      eventType: normalized.eventType, providerTransferId: normalized.providerTransferId,
      providerRouteRef: normalized.providerRouteRef, asset: normalized.asset,
      amountMicros: normalized.amountMicros, occurredAt: normalized.occurredAt,
      payloadHash: normalized.payloadHash, canonicalPayload: normalized.canonicalPayload,
    });
    await treasury.completeEvent(workerId, claim.inboxId, "completed");
    return "completed" as const;
  }
  if (normalized.kind === "funding_returned") {
    await treasury.returnFunding({
      provider: normalized.provider, providerEventId: normalized.providerEventId,
      eventType: normalized.eventType, providerTransferId: normalized.providerTransferId,
      asset: normalized.asset, amountMicros: normalized.amountMicros,
      reason: normalized.reason ?? "Column ACH funding returned",
      occurredAt: normalized.occurredAt, payloadHash: normalized.payloadHash,
      canonicalPayload: normalized.canonicalPayload,
    });
    await treasury.completeEvent(workerId, claim.inboxId, "completed");
    return "completed" as const;
  }
  if (normalized.kind === "payout_transition") {
    await treasury.transitionPayout({
      provider: normalized.provider, providerEventId: normalized.providerEventId,
      eventType: normalized.eventType, providerTransferId: normalized.providerTransferId,
      providerState: normalized.providerState, asset: normalized.asset,
      amountMicros: normalized.amountMicros, occurredAt: normalized.occurredAt,
      payloadHash: normalized.payloadHash, canonicalPayload: normalized.canonicalPayload,
    });
    await treasury.completeEvent(workerId, claim.inboxId, "completed");
    return "completed" as const;
  }
  await treasury.completeEvent(workerId, claim.inboxId, "ignored");
  return "ignored" as const;
}

export async function runTreasuryEventBatch(
  treasury: PostgresTreasury,
  column: ColumnClient,
  workerId: string,
  limit = 25
) {
  const claims = await treasury.claimEvents(workerId, limit);
  let completed = 0;
  let ignored = 0;
  let failed = 0;
  for (const claim of claims) {
    try {
      const outcome = await processTreasuryEventClaim(treasury, column, workerId, claim);
      if (outcome === "completed") completed += 1;
      else ignored += 1;
    } catch (error) {
      const dead = claim.attempts >= 25 || permanentProviderEvidenceFailure(error);
      await treasury.failEvent(workerId, claim.inboxId, errorMessage(error), retrySeconds(claim.attempts), dead);
      failed += 1;
    }
  }
  return { claimed: claims.length, completed, ignored, failed };
}

function canonicalEvent(event: ColumnEvent): string {
  return JSON.stringify({ id: event.id, created_at: event.created_at, type: event.type, data: event.data });
}

/** Reconcile webhook delivery with Column's authenticated event list. A
 * deliberate overlap makes timestamp boundaries safe; event IDs deduplicate. */
export async function pollMissedColumnEvents(
  treasury: PostgresTreasury,
  column: ColumnClient,
  now = new Date()
) {
  const prior = await treasury.pollCursor("column");
  const from = new Date((prior ?? new Date(now.getTime() - 10 * 60_000)).getTime() - 60_000);
  const through = new Date(now.getTime() - 30_000);
  if (through <= from) return { enqueued: 0, through };
  let startingAfter: string | undefined;
  let enqueued = 0;
  for (;;) {
    const events = await column.listWebhookEvents({
      createdGte: from, createdLt: through, limit: 100,
      ...(startingAfter ? { startingAfter } : {}),
    });
    for (const event of events) {
      await treasury.enqueueEvent({
        provider: "column", providerEventId: event.id, endpointId: "authenticated-poll",
        deliveryHash: createHash("sha256").update(canonicalEvent(event)).digest(),
      });
      enqueued += 1;
    }
    if (events.length < 100) break;
    const next = events.at(-1)?.id;
    if (!next || next === startingAfter) {
      const reason = "Column event-recovery pagination stalled; cursor was not advanced";
      await treasury.tripBreaker(reason);
      throw new Error(reason);
    }
    startingAfter = next;
  }
  await treasury.setPollCursor("column", through);
  return { enqueued, through };
}

export async function startTreasuryEventWorker() {
  const connectionString = process.env.MONEY_TREASURY_WORKER_DATABASE_URL;
  const apiKey = process.env.MONEY_COLUMN_EVENT_API_KEY;
  if (!connectionString || !apiKey) throw new Error("MONEY_TREASURY_WORKER_DATABASE_URL and MONEY_COLUMN_EVENT_API_KEY are required");
  const db = new PostgresDatabase({ connectionString, applicationName: "money-treasury-events", maxConnections: 2 });
  const treasury = new PostgresTreasury(db);
  const column = new ColumnClient({ apiKey });
  const workerId = `${hostname()}:${process.pid}:treasury-events`;
  const intervalMs = readBoundedInteger(process.env.MONEY_TREASURY_EVENT_INTERVAL_MS, 1_000, 250, 2_147_483_647, "MONEY_TREASURY_EVENT_INTERVAL_MS");
  const pollIntervalMs = readBoundedInteger(process.env.MONEY_TREASURY_POLL_INTERVAL_MS, 60_000, 60_000, 2_147_483_647, "MONEY_TREASURY_POLL_INTERVAL_MS");
  let stopping = false;
  let lastPoll = 0;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      const result = await runTreasuryEventBatch(treasury, column, workerId);
      if (Date.now() - lastPoll >= pollIntervalMs) {
        try {
          await pollMissedColumnEvents(treasury, column);
        } catch (error) {
          const reason = `Column event-recovery poll failed: ${errorMessage(error)}`;
          await treasury.tripBreaker(reason);
          console.error(reason);
        }
        lastPoll = Date.now();
      }
      if (result.claimed === 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    await db.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startTreasuryEventWorker().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
