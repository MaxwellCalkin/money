import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { enforceProductionPreflight } from "../deploy/preflight.ts";
import { PostgresCards } from "../db/cards.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import { readBoundedInteger } from "../treasury/runtime.ts";
import {
  CardIssuerApiError,
  CardIssuerEvidenceError,
  CardIssuerRequestError,
  issuerEventObjectKind,
  normalizeIssuerEvent,
  type CardIssuer,
} from "./issuer.ts";
import { createCardIssuerFromEnv, readCardOvercaptureBps } from "./runtime.ts";

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
  return (error instanceof Error ? error.message : "card event failed").slice(0, 1_000);
}

function retrySeconds(attempts: number): number {
  return Math.min(21_600, Math.max(5, 2 ** Math.min(attempts, 14)));
}

/** Evidence that can never be applied dead-letters immediately, and a card
 * dead letter trips the treasury breaker inside fail_card_provider_event.
 * Out-of-order arrivals (P0002), serialization retries (40001), and the
 * documented revoke/clearing deadlock (40P01) are always retried. */
function permanentCardEvidenceFailure(error: unknown): boolean {
  if (error instanceof CardIssuerEvidenceError || error instanceof CardIssuerRequestError) return true;
  if (error instanceof CardIssuerApiError) return !error.retryable && error.status !== 404;
  const code = databaseCode(error);
  if (code === "P0002" || code === "40001" || code === "40P01") return false;
  return code === "22023" || code === "55000";
}

export interface CardEventClaim {
  inboxId: bigint;
  provider: string;
  providerEventId: string;
  attempts: number;
}

export interface CardEventWorkerOptions {
  overcaptureBps?: number;
}

/** Strict order: fetch the event from the issuer, fetch the current object it
 * points at, then run exactly one database command, then acknowledge the
 * claim. The ingress bytes never moved money; only re-fetched issuer evidence
 * does. */
export async function processCardEventClaim(
  cards: PostgresCards,
  issuer: CardIssuer,
  workerId: string,
  claim: CardEventClaim,
  options: CardEventWorkerOptions = {},
): Promise<"completed" | "ignored"> {
  if (claim.provider !== issuer.provider) {
    throw new Error(`unsupported card provider ${claim.provider}`);
  }
  const event = await issuer.getEvent(claim.providerEventId);
  if (event.id !== claim.providerEventId) {
    throw new CardIssuerEvidenceError("issuer returned a different provider event id");
  }
  const objectKind = issuerEventObjectKind(event.type);
  const objectId = typeof event.data.object.id === "string" ? event.data.object.id : "";
  let current: unknown;
  if (objectKind === "authorization") {
    current = await issuer.getAuthorization(objectId);
  } else if (objectKind === "transaction") {
    current = await issuer.getTransaction(objectId);
  }
  const normalized = normalizeIssuerEvent(event, current);

  if (normalized.kind === "clearing") {
    await cards.settleAuthorization({
      provider: claim.provider,
      providerEventId: normalized.providerEventId,
      providerAuthorizationRef: normalized.authorizationRef,
      settledMicros: normalized.settledMicros,
      occurredAt: normalized.occurredAt,
      payloadHash: normalized.payloadHash,
      canonicalPayload: normalized.canonicalPayload,
      overcaptureBps: options.overcaptureBps ?? 0,
    });
    await cards.completeEvent(workerId, claim.inboxId, "completed");
    return "completed";
  }
  if (normalized.kind === "void") {
    await cards.voidAuthorization({
      provider: claim.provider,
      providerEventId: normalized.providerEventId,
      providerAuthorizationRef: normalized.authorizationRef,
      occurredAt: normalized.occurredAt,
      payloadHash: normalized.payloadHash,
      canonicalPayload: normalized.canonicalPayload,
    });
    await cards.completeEvent(workerId, claim.inboxId, "completed");
    return "completed";
  }
  if (normalized.kind === "refund") {
    await cards.refundAuthorization({
      provider: claim.provider,
      providerEventId: normalized.providerEventId,
      providerRefundRef: normalized.refundRef,
      providerAuthorizationRef: normalized.authorizationRef,
      amountMicros: normalized.amountMicros,
      occurredAt: normalized.occurredAt,
      payloadHash: normalized.payloadHash,
      canonicalPayload: normalized.canonicalPayload,
    });
    await cards.completeEvent(workerId, claim.inboxId, "completed");
    return "completed";
  }
  if (normalized.kind === "authorization_created") {
    const ours = await cards.authorizationByRef(claim.provider, normalized.authorizationRef);
    if (normalized.approved) {
      // Fail-closed proof that the issuer-side timeout default is not
      // "approve": an approval we never decided (or decided differently)
      // halts card spend immediately and parks the evidence for review.
      if (!ours || ours.state === "declined" || ours.amountMicros !== normalized.amountMicros) {
        const reason = "card authorization approved without an agentmoney decision";
        await cards.tripBreaker(
          `${reason}: ${normalized.authorizationRef} (event ${normalized.providerEventId})`.slice(0, 500),
        );
        throw new CardIssuerEvidenceError(reason);
      }
      await cards.completeEvent(workerId, claim.inboxId, "completed");
      return "completed";
    }
    if (ours && ours.state === "pending") {
      // We answered approved but the issuer's authoritative record says the
      // authorization was not approved (timeout, issuer-side decline). The
      // hold can never clear; release it with the created event as evidence.
      await cards.voidAuthorization({
        provider: claim.provider,
        providerEventId: normalized.providerEventId,
        providerAuthorizationRef: normalized.authorizationRef,
        occurredAt: normalized.occurredAt,
        payloadHash: normalized.payloadHash,
        canonicalPayload: normalized.canonicalPayload,
      });
      await cards.completeEvent(workerId, claim.inboxId, "completed");
      return "completed";
    }
    if (ours && ours.state === "confirmed") {
      // Direct issuer evidence that we settled a hold the issuer says was
      // never approved: halt card spend and park the evidence for review,
      // exactly like an approval that arrives without our decision.
      const reason = "card authorization settled without issuer approval";
      await cards.tripBreaker(
        `${reason}: ${normalized.authorizationRef} (event ${normalized.providerEventId})`.slice(0, 500),
      );
      throw new CardIssuerEvidenceError(reason);
    }
    await cards.completeEvent(workerId, claim.inboxId, "ignored");
    return "ignored";
  }
  if (normalized.kind === "card_closed") {
    const card = await cards.byProviderRef(claim.provider, normalized.providerCardRef);
    if (card && !card.issuerClosedAt) {
      await cards.markIssuerClosed(card.cardId, normalized.providerCardRef);
      await cards.completeEvent(workerId, claim.inboxId, "completed");
      return "completed";
    }
    await cards.completeEvent(workerId, claim.inboxId, "ignored");
    return "ignored";
  }
  await cards.completeEvent(workerId, claim.inboxId, "ignored");
  return "ignored";
}

export async function runCardEventBatch(
  cards: PostgresCards,
  issuer: CardIssuer,
  workerId: string,
  limit = 25,
  options: CardEventWorkerOptions = {},
) {
  const claims = await cards.claimEvents(workerId, limit);
  let completed = 0;
  let ignored = 0;
  let failed = 0;
  for (const claim of claims) {
    try {
      const outcome = await processCardEventClaim(cards, issuer, workerId, claim, options);
      if (outcome === "completed") completed += 1;
      else ignored += 1;
    } catch (error) {
      const dead = claim.attempts >= 25 || permanentCardEvidenceFailure(error);
      await cards.failEvent(workerId, claim.inboxId, errorMessage(error), retrySeconds(claim.attempts), dead);
      failed += 1;
    }
  }
  return { claimed: claims.length, completed, ignored, failed };
}

/** Cards whose terminal state we already settled still owe an issuer-side
 * cancel; a single failing card must not block the rest of the drain. */
export async function drainIssuerCloses(cards: PostgresCards, issuer: CardIssuer, limit = 100) {
  const awaiting = await cards.awaitingIssuerClose(limit);
  let closed = 0;
  let failed = 0;
  for (const card of awaiting) {
    if (card.provider !== issuer.provider) {
      // Re-drained every interval until an operator intervenes: without this
      // line a provider switch would spin on the old provider's cards silently.
      console.error(
        `issuer close skipped for card ${card.cardId}: provider ${card.provider} does not match ${issuer.provider}`,
      );
      failed += 1;
      continue;
    }
    try {
      await issuer.closeCard(card.providerCardRef);
      await cards.markIssuerClosed(card.cardId, card.providerCardRef);
      closed += 1;
    } catch (error) {
      console.error(`issuer close failed for card ${card.cardId}: ${errorMessage(error)}`);
      failed += 1;
    }
  }
  return { drained: awaiting.length, closed, failed };
}

export async function startCardEventWorker() {
  enforceProductionPreflight("card-events");
  const connectionString = process.env.MONEY_CARD_WORKER_DATABASE_URL;
  const apiKey = process.env.MONEY_CARD_EVENT_API_KEY;
  if (!connectionString || !apiKey) {
    throw new Error("MONEY_CARD_WORKER_DATABASE_URL and MONEY_CARD_EVENT_API_KEY are required");
  }
  const db = new PostgresDatabase({
    connectionString, applicationName: "money-card-events", maxConnections: 2,
  });
  const cards = new PostgresCards(db);
  const issuer = createCardIssuerFromEnv(process.env, { role: "worker" });
  const workerId = `${hostname()}:${process.pid}:card-events`;
  const intervalMs = readBoundedInteger(
    process.env.MONEY_CARD_EVENT_INTERVAL_MS, 1_000, 250, 2_147_483_647, "MONEY_CARD_EVENT_INTERVAL_MS",
  );
  const drainIntervalMs = readBoundedInteger(
    process.env.MONEY_CARD_CLOSE_DRAIN_INTERVAL_MS, 5_000, 1_000, 2_147_483_647, "MONEY_CARD_CLOSE_DRAIN_INTERVAL_MS",
  );
  const options: CardEventWorkerOptions = { overcaptureBps: readCardOvercaptureBps(process.env) };
  let stopping = false;
  let lastDrain = 0;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      const result = await runCardEventBatch(cards, issuer, workerId, 25, options);
      if (Date.now() - lastDrain >= drainIntervalMs) {
        try {
          await drainIssuerCloses(cards, issuer);
        } catch (error) {
          console.error(`issuer close drain failed: ${errorMessage(error)}`);
        }
        lastDrain = Date.now();
      }
      if (result.claimed === 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    await db.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startCardEventWorker().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
