import { createHash, randomUUID } from "node:crypto";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { describe, expect, it, vi } from "vitest";
import { createCardAuthorizationApp } from "../src/cards/authorization-server.ts";
import { signIssuerWebhook, type CardIssuer } from "../src/cards/issuer.ts";
import { createMockIssuerNetwork, MockIssuer } from "../src/cards/mock-issuer.ts";
import { drainIssuerCloses, processCardEventClaim, runCardEventBatch } from "../src/cards/event-worker.ts";
import { PostgresCards } from "../src/db/cards.ts";
import { PostgresControlPlane } from "../src/db/control-plane.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { PostgresPolicy } from "../src/db/policy.ts";
import { PostgresTreasury } from "../src/db/treasury.ts";
import { approveComplianceFixture, clearCounterpartyFixture } from "./helpers/compliance-fixture.ts";

const SECRET = "whsec_worker_fixture_secret_0001";
const ENDPOINT = "we_worker_fixture";
const WORKER = "card-event-worker";

function transactionObject(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ipi_w_0001", object: "issuing.transaction", amount: -2_900, authorization: "iauth_w_0001",
    card: "ic_w_0001", cardholder: "ich_mock", created: 1_766_000_000, currency: "usd",
    livemode: false, type: "capture", ...overrides,
  };
}

function authorizationObject(approved: boolean, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "iauth_w_0001", object: "issuing.authorization", amount: approved ? 2_900 : 0, approved,
    card: "ic_w_0001", cardholder: "ich_mock", created: 1_766_000_000, currency: "usd", livemode: false,
    request_history: [{ approved, reason: approved ? "webhook_approved" : "webhook_timeout" }],
    status: approved ? "pending" : "closed", ...overrides,
  };
}

function issuerEvent(type: string, object: Record<string, unknown>, id = "evt_w_0001") {
  return { id, object: "event", type, created: 1_766_000_000, data: { object }, livemode: false };
}

function claimOf(providerEventId: string, attempts = 1) {
  return { inboxId: 7n, provider: "mock", providerEventId, attempts };
}

describe("card event worker", () => {
  it("re-fetches the event then the object before the command and acknowledges only afterward", async () => {
    const event = issuerEvent("issuing_transaction.created", transactionObject());
    const getEvent = vi.fn(async () => event);
    const getTransaction = vi.fn(async () => transactionObject());
    const issuer = { provider: "mock", getEvent, getTransaction } as unknown as CardIssuer;
    const settleAuthorization = vi.fn(async () => ({ status: "confirmed", replayed: false }));
    const completeEvent = vi.fn(async () => undefined);
    const cards = {
      claimEvents: vi.fn(async () => [claimOf("evt_w_0001")]),
      settleAuthorization, completeEvent, failEvent: vi.fn(async () => undefined),
    } as unknown as PostgresCards;

    expect(await runCardEventBatch(cards, issuer, WORKER, 10, { overcaptureBps: 100 })).toEqual({
      claimed: 1, completed: 1, ignored: 0, failed: 0,
    });
    expect(getEvent.mock.invocationCallOrder[0]).toBeLessThan(getTransaction.mock.invocationCallOrder[0]!);
    expect(getTransaction.mock.invocationCallOrder[0]).toBeLessThan(settleAuthorization.mock.invocationCallOrder[0]!);
    expect(settleAuthorization.mock.invocationCallOrder[0]).toBeLessThan(completeEvent.mock.invocationCallOrder[0]!);
    expect(settleAuthorization).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      provider: "mock", providerEventId: "evt_w_0001", providerAuthorizationRef: "iauth_w_0001",
      settledMicros: 29_000_000n, overcaptureBps: 100,
      payloadHash: expect.any(Buffer), canonicalPayload: expect.objectContaining({ event: expect.anything() }),
    }));
    expect(completeEvent).toHaveBeenCalledWith(WORKER, 7n, "completed");
  });

  it("retries an out-of-order clearing (P0002) without dead-lettering it", async () => {
    const event = issuerEvent("issuing_transaction.created", transactionObject());
    const issuer = {
      provider: "mock", getEvent: vi.fn(async () => event), getTransaction: vi.fn(async () => transactionObject()),
    } as unknown as CardIssuer;
    const failEvent = vi.fn(async () => undefined);
    const cards = {
      claimEvents: vi.fn(async () => [claimOf("evt_w_0001")]),
      settleAuthorization: vi.fn(async () => {
        throw Object.assign(new Error("card authorization does not exist yet for this clearing"), { code: "P0002" });
      }),
      completeEvent: vi.fn(async () => undefined),
      failEvent,
    } as unknown as PostgresCards;
    expect(await runCardEventBatch(cards, issuer, WORKER, 10)).toEqual({ claimed: 1, completed: 0, ignored: 0, failed: 1 });
    expect(failEvent).toHaveBeenCalledWith(WORKER, 7n, expect.any(String), expect.any(Number), false);
  });

  it("dead-letters at 25 attempts and on evidence that can never apply", async () => {
    const event = issuerEvent("issuing_transaction.created", transactionObject());
    const makeIssuer = () => ({
      provider: "mock", getEvent: vi.fn(async () => event), getTransaction: vi.fn(async () => transactionObject()),
    }) as unknown as CardIssuer;
    const makeCards = (error: Error, attempts: number) => {
      const failEvent = vi.fn(async () => undefined);
      const cards = {
        claimEvents: vi.fn(async () => [claimOf("evt_w_0001", attempts)]),
        settleAuthorization: vi.fn(async () => { throw error; }),
        completeEvent: vi.fn(async () => undefined),
        failEvent,
      } as unknown as PostgresCards;
      return { cards, failEvent };
    };

    // Attempt 25 with a transient error: the dead-letter path itself trips the
    // treasury breaker inside money_private.fail_card_provider_event.
    const transient = makeCards(new Error("issuer unreachable"), 25);
    expect(await runCardEventBatch(transient.cards, makeIssuer(), WORKER, 10)).toEqual(expect.objectContaining({ failed: 1 }));
    expect(transient.failEvent).toHaveBeenCalledWith(WORKER, 7n, "issuer unreachable", expect.any(Number), true);

    const overCapture = makeCards(
      Object.assign(new Error("clearing exceeds the authorized amount tolerance"), { code: "22023" }), 1,
    );
    expect(await runCardEventBatch(overCapture.cards, makeIssuer(), WORKER, 10)).toEqual(expect.objectContaining({ failed: 1 }));
    expect(overCapture.failEvent).toHaveBeenCalledWith(WORKER, 7n, expect.stringContaining("tolerance"), expect.any(Number), true);

    const reversed = makeCards(
      Object.assign(new Error("authorization was reversed before clearing"), { code: "55000" }), 1,
    );
    await runCardEventBatch(reversed.cards, makeIssuer(), WORKER, 10);
    expect(reversed.failEvent).toHaveBeenCalledWith(WORKER, 7n, expect.any(String), expect.any(Number), true);

    const transientFirst = makeCards(new Error("issuer unreachable"), 3);
    await runCardEventBatch(transientFirst.cards, makeIssuer(), WORKER, 10);
    expect(transientFirst.failEvent).toHaveBeenCalledWith(WORKER, 7n, expect.any(String), expect.any(Number), false);
  });

  it("trips the treasury breaker on an issuer approval without an agentmoney decision", async () => {
    const run = async (ours: unknown) => {
      const event = issuerEvent("issuing_authorization.created", authorizationObject(true));
      const issuer = {
        provider: "mock",
        getEvent: vi.fn(async () => event),
        getAuthorization: vi.fn(async () => authorizationObject(true)),
      } as unknown as CardIssuer;
      const authorizationByRef = vi.fn(async () => ours);
      const tripBreaker = vi.fn(async () => undefined);
      const completeEvent = vi.fn(async () => undefined);
      const failEvent = vi.fn(async () => undefined);
      const cards = {
        claimEvents: vi.fn(async () => [claimOf("evt_w_0001")]),
        authorizationByRef, tripBreaker, completeEvent, failEvent,
      } as unknown as PostgresCards;
      const result = await runCardEventBatch(cards, issuer, WORKER, 10);
      return { result, authorizationByRef, tripBreaker, completeEvent, failEvent };
    };

    for (const ours of [
      undefined,
      { state: "declined", amountMicros: 29_000_000n },
      { state: "pending", amountMicros: 28_000_000n },
    ]) {
      const { result, authorizationByRef, tripBreaker, completeEvent, failEvent } = await run(ours);
      expect(result).toEqual({ claimed: 1, completed: 0, ignored: 0, failed: 1 });
      expect(tripBreaker).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("approved without an agentmoney decision"),
      );
      expect(authorizationByRef.mock.invocationCallOrder[0]).toBeLessThan(tripBreaker.mock.invocationCallOrder[0]!);
      expect(completeEvent).not.toHaveBeenCalled();
      expect(failEvent).toHaveBeenCalledWith(WORKER, 7n, expect.any(String), expect.any(Number), true);
    }

    // A consistent approval acknowledges without touching the breaker.
    const consistent = await run({ state: "pending", amountMicros: 29_000_000n });
    expect(consistent.result).toEqual({ claimed: 1, completed: 1, ignored: 0, failed: 0 });
    expect(consistent.tripBreaker).not.toHaveBeenCalled();
    expect(consistent.completeEvent).toHaveBeenCalledWith(WORKER, 7n, "completed");
  });

  it("releases our pending hold when the issuer's record says the authorization was not approved", async () => {
    const event = issuerEvent("issuing_authorization.created", authorizationObject(false));
    const issuer = {
      provider: "mock",
      getEvent: vi.fn(async () => event),
      getAuthorization: vi.fn(async () => authorizationObject(false)),
    } as unknown as CardIssuer;
    const voidAuthorization = vi.fn(async () => ({ status: "reversed", replayed: false }));
    const completeEvent = vi.fn(async () => undefined);
    const cards = {
      claimEvents: vi.fn(async () => [claimOf("evt_w_0001")]),
      authorizationByRef: vi.fn(async () => ({ state: "pending", amountMicros: 29_000_000n })),
      voidAuthorization, completeEvent, tripBreaker: vi.fn(async () => undefined),
      failEvent: vi.fn(async () => undefined),
    } as unknown as PostgresCards;

    expect(await runCardEventBatch(cards, issuer, WORKER, 10)).toEqual({ claimed: 1, completed: 1, ignored: 0, failed: 0 });
    expect(voidAuthorization).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      provider: "mock", providerEventId: "evt_w_0001", providerAuthorizationRef: "iauth_w_0001",
    }));
    expect(voidAuthorization.mock.invocationCallOrder[0]).toBeLessThan(completeEvent.mock.invocationCallOrder[0]!);

    // Without a pending hold there is nothing to release: the decline is the
    // issuer's own record of its timeout default.
    const ignoredCards = {
      claimEvents: vi.fn(async () => [claimOf("evt_w_0001")]),
      authorizationByRef: vi.fn(async () => undefined),
      voidAuthorization: vi.fn(), completeEvent: vi.fn(async () => undefined),
      failEvent: vi.fn(async () => undefined),
    } as unknown as PostgresCards;
    expect(await runCardEventBatch(ignoredCards, issuer, WORKER, 10)).toEqual({ claimed: 1, completed: 0, ignored: 1, failed: 0 });
  });

  it("trips the treasury breaker when a settled hold was never issuer-approved", async () => {
    const event = issuerEvent("issuing_authorization.created", authorizationObject(false));
    const issuer = {
      provider: "mock",
      getEvent: vi.fn(async () => event),
      getAuthorization: vi.fn(async () => authorizationObject(false)),
    } as unknown as CardIssuer;
    const authorizationByRef = vi.fn(async () => ({ state: "confirmed", amountMicros: 29_000_000n }));
    const tripBreaker = vi.fn(async () => undefined);
    const completeEvent = vi.fn(async () => undefined);
    const failEvent = vi.fn(async () => undefined);
    const voidAuthorization = vi.fn();
    const cards = {
      claimEvents: vi.fn(async () => [claimOf("evt_w_0001")]),
      authorizationByRef, tripBreaker, completeEvent, failEvent, voidAuthorization,
    } as unknown as PostgresCards;

    expect(await runCardEventBatch(cards, issuer, WORKER, 10)).toEqual({ claimed: 1, completed: 0, ignored: 0, failed: 1 });
    expect(tripBreaker).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("settled without issuer approval"),
    );
    expect(authorizationByRef.mock.invocationCallOrder[0]).toBeLessThan(tripBreaker.mock.invocationCallOrder[0]!);
    expect(voidAuthorization).not.toHaveBeenCalled();
    expect(completeEvent).not.toHaveBeenCalled();
    // Evidence that can never be applied dead-letters immediately.
    expect(failEvent).toHaveBeenCalledWith(WORKER, 7n, expect.any(String), expect.any(Number), true);

    // A released (reversed) hold is consistent with the issuer's decline and
    // stays an acknowledgment, not a breaker trip.
    const reversedCards = {
      claimEvents: vi.fn(async () => [claimOf("evt_w_0001")]),
      authorizationByRef: vi.fn(async () => ({ state: "reversed", amountMicros: 29_000_000n })),
      tripBreaker: vi.fn(async () => undefined),
      completeEvent: vi.fn(async () => undefined),
      failEvent: vi.fn(async () => undefined),
      voidAuthorization: vi.fn(),
    };
    expect(await runCardEventBatch(reversedCards as unknown as PostgresCards, issuer, WORKER, 10)).toEqual({
      claimed: 1, completed: 0, ignored: 1, failed: 0,
    });
    expect(reversedCards.tripBreaker).not.toHaveBeenCalled();
    expect(reversedCards.completeEvent).toHaveBeenCalledWith(WORKER, 7n, "ignored");
  });

  it("mismatched provider claims and worker lease violations surface as failures", async () => {
    const failEvent = vi.fn(async () => undefined);
    const cards = {
      claimEvents: vi.fn(async () => [{ inboxId: 9n, provider: "stripe-issuing", providerEventId: "evt_x_0001", attempts: 1 }]),
      failEvent,
    } as unknown as PostgresCards;
    const issuer = { provider: "mock", getEvent: vi.fn() } as unknown as CardIssuer;
    expect(await runCardEventBatch(cards, issuer, WORKER, 10)).toEqual({ claimed: 1, completed: 0, ignored: 0, failed: 1 });
    expect(failEvent).toHaveBeenCalledWith(WORKER, 9n, expect.stringContaining("unsupported card provider"), expect.any(Number), false);
  });

  it("drains issuer-side closes in order and isolates per-card failures", async () => {
    const awaitingIssuerClose = vi.fn(async () => [
      { cardId: "card-1", agentId: "agt", provider: "mock", providerCardRef: "ic_w_0001", state: "reversed" },
      { cardId: "card-2", agentId: "agt", provider: "mock", providerCardRef: "ic_w_0002", state: "confirmed" },
      { cardId: "card-3", agentId: "agt", provider: "other", providerCardRef: "ic_w_0003", state: "reversed" },
    ]);
    const closeCard = vi.fn(async (ref: string) => {
      if (ref === "ic_w_0001") throw new Error("issuer unavailable");
    });
    const markIssuerClosed = vi.fn(async () => true);
    const cards = { awaitingIssuerClose, markIssuerClosed } as unknown as PostgresCards;
    const issuer = { provider: "mock", closeCard } as unknown as CardIssuer;

    expect(await drainIssuerCloses(cards, issuer, 50)).toEqual({ drained: 3, closed: 1, failed: 2 });
    expect(awaitingIssuerClose).toHaveBeenCalledWith(50);
    expect(markIssuerClosed).toHaveBeenCalledExactlyOnceWith("card-2", "ic_w_0002");
    expect(awaitingIssuerClose.mock.invocationCallOrder[0]).toBeLessThan(closeCard.mock.invocationCallOrder[0]!);
    expect(closeCard.mock.invocationCallOrder[1]).toBeLessThan(markIssuerClosed.mock.invocationCallOrder[0]!);
  });

  it("marks an issuer-initiated cancellation once and ignores it afterwards", async () => {
    const cardObject = {
      id: "ic_w_0001", object: "issuing.card", status: "canceled", last4: "4242", exp_month: 12, exp_year: 2030,
    };
    const event = issuerEvent("issuing_card.updated", cardObject);
    const issuer = { provider: "mock", getEvent: vi.fn(async () => event) } as unknown as CardIssuer;
    const markIssuerClosed = vi.fn(async () => true);
    const completeEvent = vi.fn(async () => undefined);
    const byProviderRef = vi.fn(async () => ({ cardId: "card-1", agentId: "agt", state: "pending", heldMicros: 0n }));
    const cards = {
      claimEvents: vi.fn(async () => [claimOf("evt_w_0001")]),
      byProviderRef, markIssuerClosed, completeEvent, failEvent: vi.fn(async () => undefined),
    } as unknown as PostgresCards;
    expect(await runCardEventBatch(cards, issuer, WORKER, 10)).toEqual({ claimed: 1, completed: 1, ignored: 0, failed: 0 });
    expect(markIssuerClosed).toHaveBeenCalledExactlyOnceWith("card-1", "ic_w_0001");

    byProviderRef.mockResolvedValueOnce({ cardId: "card-1", agentId: "agt", state: "pending", heldMicros: 0n, issuerClosedAt: new Date() } as never);
    expect(await runCardEventBatch(cards, issuer, WORKER, 10)).toEqual({ claimed: 1, completed: 0, ignored: 1, failed: 0 });
    expect(markIssuerClosed).toHaveBeenCalledTimes(1);
  });
});

describe("card authorization ingress", () => {
  const nowSeconds = () => Math.floor(Date.now() / 1_000);

  function signedRequest(body: string, overrides: { path?: string; signature?: string | false } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (overrides.signature !== false) {
      headers["stripe-signature"] = overrides.signature ?? signIssuerWebhook(body, SECRET, nowSeconds());
    }
    return { method: "POST", headers, body };
  }

  function appWith(cards: Partial<PostgresCards>, options: { decisionDeadlineMs?: number; maxBodyBytes?: number } = {}) {
    return createCardAuthorizationApp(cards as PostgresCards, {
      provider: "mock", secrets: [SECRET], endpointId: ENDPOINT, ...options,
    });
  }

  const requestBody = JSON.stringify({
    id: "evt_ingress_0001", object: "event", created: nowSeconds(), type: "issuing_authorization.request",
    data: {
      object: {
        id: "iauth_ingress_0001", object: "issuing.authorization", approved: false, currency: "usd",
        card: { id: "ic_ingress_0001" },
        merchant_data: { category_code: "5734", name: "MOCK SHOP EXAMPLE", country: "US" },
        pending_request: { amount: 2_900, currency: "usd" },
        status: "pending",
      },
    },
  });

  it("answers one decision per request and shields every uncertain path as a decline", async () => {
    const decideAuthorization = vi.fn(async () => ({
      decision: "approved" as const, authorizationId: "a-1", cardId: "c-1", replayed: false,
    }));
    const app = appWith({ decideAuthorization });
    const approved = await app.request("/webhooks/mock/authorization", signedRequest(requestBody));
    expect(approved.status).toBe(200);
    expect(approved.headers.get("stripe-version")).toBe("2025-03-31.basil");
    expect(approved.headers.get("cache-control")).toBe("no-store");
    expect(await approved.json()).toEqual({
      approved: true,
      metadata: { agentmoney_decision: "approved", agentmoney_card: "c-1" },
    });
    expect(decideAuthorization).toHaveBeenCalledTimes(1);

    decideAuthorization.mockResolvedValueOnce({
      decision: "declined", declineCode: "new_payee_cap", authorizationId: "a-2", cardId: "c-1", replayed: false,
    } as never);
    const declined = await app.request("/webhooks/mock/authorization", signedRequest(requestBody));
    expect(await declined.json()).toEqual({
      approved: false,
      metadata: { agentmoney_decision: "declined", agentmoney_card: "c-1", agentmoney_decline_code: "new_payee_cap" },
    });

    decideAuthorization.mockRejectedValueOnce(new Error("database is down"));
    const failed = await app.request("/webhooks/mock/authorization", signedRequest(requestBody));
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({
      approved: false, metadata: { agentmoney_decision: "declined", agentmoney_decline_code: "system" },
    });
  });

  it("declines a malformed request without a database call", async () => {
    const decideAuthorization = vi.fn();
    const app = appWith({ decideAuthorization });
    const malformed = JSON.stringify({ ...JSON.parse(requestBody) as Record<string, unknown>, type: "not_a_request" });
    const response = await app.request("/webhooks/mock/authorization", signedRequest(malformed));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      approved: false, metadata: { agentmoney_decision: "declined", agentmoney_decline_code: "invalid_request" },
    });
    const negative = requestBody.replace("\"amount\":2900", "\"amount\":-1");
    expect((await (await app.request("/webhooks/mock/authorization", signedRequest(negative))).json() as {
      metadata: Record<string, string>;
    }).metadata.agentmoney_decline_code).toBe("invalid_request");
    const unparseable = await app.request("/webhooks/mock/authorization", signedRequest("{not json"));
    expect((await unparseable.json() as { metadata: Record<string, string> }).metadata.agentmoney_decline_code)
      .toBe("invalid_request");
    expect(decideAuthorization).not.toHaveBeenCalled();
  });

  it("answers a decline when the decision misses the internal deadline", async () => {
    const decideAuthorization = vi.fn(() => new Promise<never>(() => undefined));
    const app = appWith({ decideAuthorization }, { decisionDeadlineMs: 25 });
    const response = await app.request("/webhooks/mock/authorization", signedRequest(requestBody));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      approved: false, metadata: { agentmoney_decision: "declined", agentmoney_decline_code: "system" },
    });
  });

  it("refuses forged signatures, oversized bodies, and unknown providers without touching the database", async () => {
    const decideAuthorization = vi.fn();
    const enqueueEvent = vi.fn();
    const app = appWith({ decideAuthorization, enqueueEvent });

    const forged = await app.request("/webhooks/mock/authorization", signedRequest(requestBody, {
      signature: signIssuerWebhook(requestBody, "whsec_wrong_secret_000000000001", nowSeconds()),
    }));
    expect(forged.status).toBe(401);
    const unsigned = await app.request("/webhooks/mock/authorization", signedRequest(requestBody, { signature: false }));
    expect(unsigned.status).toBe(401);
    const stale = await app.request("/webhooks/mock/authorization", signedRequest(requestBody, {
      signature: signIssuerWebhook(requestBody, SECRET, nowSeconds() - 3_600),
    }));
    expect(stale.status).toBe(401);
    const wrongProvider = await app.request("/webhooks/stripe-issuing/authorization", signedRequest(requestBody));
    expect(wrongProvider.status).toBe(404);
    const wrongProviderEvents = await app.request("/webhooks/stripe-issuing/events", signedRequest(requestBody));
    expect(wrongProviderEvents.status).toBe(404);

    const bounded = appWith({ decideAuthorization, enqueueEvent }, { maxBodyBytes: 64 });
    const large = await bounded.request("/webhooks/mock/authorization", signedRequest("x".repeat(65)));
    expect(large.status).toBe(413);

    expect((await app.request("/health/live")).status).toBe(200);
    expect(decideAuthorization).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it("stores only the event envelope on the events route and moves no money", async () => {
    const enqueueEvent = vi.fn(async () => ({ inboxId: 3n, replayed: false, state: "queued" }));
    const settleAuthorization = vi.fn();
    const app = appWith({ enqueueEvent, settleAuthorization });
    const eventBody = JSON.stringify({
      id: "evt_ingress_async_0001", object: "event", created: nowSeconds(),
      type: "issuing_transaction.created", data: { object: transactionObject() },
    });
    const accepted = await app.request("/webhooks/mock/events", signedRequest(eventBody));
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ accepted: true, replayed: false });
    expect(enqueueEvent).toHaveBeenCalledExactlyOnceWith({
      provider: "mock", providerEventId: "evt_ingress_async_0001", endpointId: ENDPOINT,
      deliveryHash: createHash("sha256").update(eventBody).digest(),
    });
    expect(settleAuthorization).not.toHaveBeenCalled();

    const invalid = await app.request("/webhooks/mock/events", signedRequest("{\"id\":42}"));
    expect(invalid.status).toBe(400);
  });
});

class EmbeddedPostgres implements TransactionalDatabase {
  constructor(readonly pg: PGliteInterface) {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryRows<T>> {
    const result = await this.pg.query<T>(text, [...values]);
    return { rows: result.rows, affectedRows: result.affectedRows };
  }

  async executeScript(text: string): Promise<void> {
    await this.pg.exec(text);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (transaction: Transaction) => work({
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = []
      ): Promise<QueryRows<R>> => {
        const result = await transaction.query<R>(text, [...values]);
        return { rows: result.rows, affectedRows: result.affectedRows };
      },
      executeScript: async (text: string) => {
        await transaction.exec(text);
      },
    }));
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

describe("card rail wire-to-ledger loop", () => {
  it("carries an authorization from the mock network through the worker into the ledger", async () => {
    const db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    try {
      await runMigrations(db);
      const control = new PostgresControlPlane(db);
      const ledger = new PostgresLedger(db);
      const policy = new PostgresPolicy(db);
      const treasury = new PostgresTreasury(db);
      const cards = new PostgresCards(db);
      await treasury.configureControls({
        fundingEnabled: true, payoutsEnabled: true, externalSpendEnabled: true,
        maxPayoutMicros: 100_000_000_000n, maxPendingPayoutMicros: 1_000_000_000_000n,
        maxOpenExposureMicros: 100_000_000_000n, maxReconciliationVarianceMicros: 1_000_000n,
        reason: "test fixture enables treasury controls",
      });
      await treasury.setCardSpendEnabled(true, "test fixture enables card spend");

      const key = (name: string) => `public-key-card-worker-${name}-${"x".repeat(24)}`;
      const owner = await control.registerIdentity({
        id: "usr_cwrk00001", kind: "user", name: "Owner", handle: "owner-cwrk", publicKey: key("owner"),
      });
      const agent = await control.registerIdentity({
        actorId: owner.id, id: "agt_cwrk00001", kind: "agent", ownerId: owner.id,
        name: "Scout", handle: "scout-cwrk", publicKey: key("agent"),
      });
      await approveComplianceFixture(db, owner.id);
      await clearCounterpartyFixture(db, "card:hint:mock-shop.example", "merchant");
      await ledger.postTransfer({
        actorId: owner.id, operation: "fund", idempotencyKey: "cwrk-fund",
        from: "external:funding", to: owner.id, amountMicros: 1_000_000_000n,
      });
      await ledger.postTransfer({
        actorId: owner.id, operation: "allocate", idempotencyKey: "cwrk-allocate",
        from: owner.id, to: agent.id, amountMicros: 1_000_000_000n,
      });
      await policy.grantMandate({
        userId: owner.id, agentId: agent.id, budgetMicros: 1_000_000_000n,
        perTxCapMicros: 1_000_000_000n, dailyCapMicros: 1_000_000_000n,
        escalateAboveMicros: 1_000_000_000n, newPayeeCapMicros: 1_000_000_000n,
        expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: "cwrk-mandate",
      });

      const app = createCardAuthorizationApp(cards, { provider: "mock", secrets: [SECRET], endpointId: ENDPOINT });
      const issuer = new MockIssuer();
      const network = createMockIssuerNetwork({ secret: SECRET, issuer, authorizationApp: app, eventsApp: app });

      const issueCard = async (idempotencyKey: string, capMicros: bigint, singleUse: boolean) => {
        const prepared = await cards.prepare({
          cardId: randomUUID(), agentId: agent.id, idempotencyKey, capMicros, singleUse,
          merchantHint: "mock-shop.example", expiresAt: new Date(Date.now() + 3_600_000),
        });
        expect(prepared.status).toBe("prepared");
        const material = await issuer.createCard({
          cardId: prepared.cardId!, capMicros, expiresAt: new Date(Date.now() + 3_600_000),
          merchantHint: "mock-shop.example", singleUse, agentId: agent.id, ownerId: owner.id,
        });
        const activated = await cards.activate({ agentId: agent.id, cardId: prepared.cardId!, provider: "mock", ...material });
        expect(activated.status).toBe("posted");
        return { cardId: prepared.cardId!, ref: material.providerCardRef };
      };

      // Single-use card: authorize on the wire, settle through the worker,
      // finalize, and drain the issuer-side close.
      const single = await issueCard("cwrk-single", 50_000_000n, true);
      const purchase = await network.purchase(single.ref, {
        amountCents: 2_900, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734", country: "US",
      });
      expect(purchase).toEqual(expect.objectContaining({ approved: true, reason: "webhook_approved" }));
      expect((purchase.responseBody as { metadata: Record<string, string> }).metadata.agentmoney_card).toBe(single.cardId);
      expect(await runCardEventBatch(cards, issuer, WORKER)).toEqual({ claimed: 1, completed: 1, ignored: 0, failed: 0 });

      const capture = await network.capture(purchase.authorizationRef!, 2_900);
      expect(await runCardEventBatch(cards, issuer, WORKER)).toEqual({ claimed: 1, completed: 1, ignored: 0, failed: 0 });
      expect(await cards.get(agent.id, single.cardId)).toEqual(expect.objectContaining({
        state: "confirmed", heldMicros: 0n, settledMicros: 29_000_000n, closeReason: "single-use card cleared",
      }));
      expect(await ledger.balance(agent.id)).toBe(1_000_000_000n - 29_000_000n);
      expect(await ledger.balance("external:card")).toBe(29_000_000n);

      // A redelivered capture event is a replayed envelope, not a second claim.
      await network.replay(capture.eventId);
      expect(await runCardEventBatch(cards, issuer, WORKER)).toEqual({ claimed: 0, completed: 0, ignored: 0, failed: 0 });

      const drained = await drainIssuerCloses(cards, issuer);
      expect(drained).toEqual({ drained: 1, closed: 1, failed: 0 });
      expect(issuer.card(single.ref)?.status).toBe("canceled");
      // The issuer-side cancel event arrives afterwards and is already applied.
      expect(await runCardEventBatch(cards, issuer, WORKER)).toEqual({ claimed: 1, completed: 0, ignored: 1, failed: 0 });

      const refund = await network.refund(capture.transactionRef, 900);
      expect(await runCardEventBatch(cards, issuer, WORKER)).toEqual({ claimed: 1, completed: 1, ignored: 0, failed: 0 });
      expect(await ledger.balance(agent.id)).toBe(1_000_000_000n - 29_000_000n + 9_000_000n);
      expect(refund.transactionRef).toMatch(/^ipi_mock_/);

      // Multi-use card: an expired authorization releases its hold via the
      // issuing_authorization.updated -> void path.
      const multi = await issueCard("cwrk-multi", 20_000_000n, false);
      const held = await network.purchase(multi.ref, { amountCents: 500, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734" });
      expect(held.approved).toBe(true);
      expect(await runCardEventBatch(cards, issuer, WORKER)).toEqual({ claimed: 1, completed: 1, ignored: 0, failed: 0 });
      expect((await cards.get(agent.id, multi.cardId))?.heldMicros).toBe(5_000_000n);
      await network.expire(held.authorizationRef!);
      expect(await runCardEventBatch(cards, issuer, WORKER)).toEqual({ claimed: 1, completed: 1, ignored: 0, failed: 0 });
      expect((await cards.get(agent.id, multi.cardId))?.heldMicros).toBe(0n);

      // The issuer times out waiting for our answer: the signed request was
      // still delivered, so our database committed a pending hold, but the
      // discarded response never approved anything issuer-side. The worker
      // releases the hold through the real void SQL from the approved=false
      // issuing_authorization.created event.
      network.timeoutNext();
      const timedOut = await network.purchase(multi.ref, { amountCents: 700, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734" });
      expect(timedOut).toEqual(expect.objectContaining({ approved: false, reason: "webhook_timeout" }));
      expect((await cards.get(agent.id, multi.cardId))?.heldMicros).toBe(7_000_000n);
      expect(await runCardEventBatch(cards, issuer, WORKER)).toEqual({ claimed: 1, completed: 1, ignored: 0, failed: 0 });
      expect((await cards.get(agent.id, multi.cardId))?.heldMicros).toBe(0n);
      expect((await cards.authorizationByRef("mock", timedOut.authorizationRef!))?.state).toBe("reversed");

      const closed = await cards.closeCard(agent.id, multi.cardId, "done");
      expect(closed.state).toBe("reversed");
      expect(await drainIssuerCloses(cards, issuer)).toEqual({ drained: 1, closed: 1, failed: 0 });
      expect(await ledger.balance(agent.id)).toBe(1_000_000_000n - 29_000_000n + 9_000_000n);
      expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
    } finally {
      await db.close();
    }
  }, 120_000);
});
