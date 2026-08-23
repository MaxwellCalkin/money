import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PostgresCards } from "../src/db/cards.ts";
import { createCardAuthorizationApp } from "../src/cards/authorization-server.ts";
import {
  CardIssuerEvidenceError,
  CardIssuerRequestError,
  centsToMicros,
  microsToCents,
  normalizeIssuerEvent,
  parseIssuerAuthorizationRequest,
  signIssuerWebhook,
  verifyIssuerWebhook,
} from "../src/cards/issuer.ts";
import { createMockIssuerNetwork, MockIssuer, MockIssuerHonestyError } from "../src/cards/mock-issuer.ts";

const SECRET = "whsec_mock_fixture_secret_00000001";
const ROTATED = "whsec_mock_fixture_secret_00000002";
const ENDPOINT = "we_mock_fixture";

function requestEvent(overrides: {
  eventId?: string;
  amount?: unknown;
  currency?: unknown;
  mcc?: unknown;
  name?: unknown;
  networkId?: unknown;
  country?: unknown;
  card?: unknown;
  authorization?: unknown;
} = {}) {
  return {
    id: overrides.eventId ?? "evt_fixture_0001",
    object: "event",
    created: 1_766_000_000,
    livemode: false,
    type: "issuing_authorization.request",
    data: {
      object: {
        id: overrides.authorization ?? "iauth_fixture_0001",
        object: "issuing.authorization",
        approved: false,
        card: overrides.card ?? { id: "ic_fixture_0001", object: "issuing.card" },
        currency: "usd",
        merchant_data: {
          category_code: overrides.mcc ?? "5734",
          name: overrides.name ?? "MOCK SHOP EXAMPLE",
          ...(overrides.networkId !== undefined ? { network_id: overrides.networkId } : {}),
          ...(overrides.country !== undefined ? { country: overrides.country } : { country: "US" }),
        },
        pending_request: {
          amount: overrides.amount ?? 2_900,
          currency: overrides.currency ?? "usd",
          is_amount_controllable: false,
        },
        status: "pending",
      },
    },
  };
}

function issuerWorld(cards: Partial<PostgresCards>) {
  const app = createCardAuthorizationApp(cards as PostgresCards, {
    provider: "mock", secrets: [SECRET, ROTATED], endpointId: ENDPOINT,
  });
  const issuer = new MockIssuer();
  const network = createMockIssuerNetwork({
    secret: SECRET, issuer, authorizationApp: app, eventsApp: app,
  });
  return { app, issuer, network };
}

async function issuerCard(issuer: MockIssuer, cardId = "11111111-1111-4111-8111-111111111111") {
  const material = await issuer.createCard({
    cardId, capMicros: 100_000_000n, expiresAt: new Date("2027-01-01T00:00:00Z"),
    merchantHint: "mock-shop.example", singleUse: true, agentId: "agt_mock", ownerId: "usr_mock",
  });
  return material.providerCardRef;
}

describe("issuer webhook verification", () => {
  const rawBody = Buffer.from(JSON.stringify(requestEvent()), "utf8");
  const now = new Date(1_766_000_000_000);
  const at = Math.floor(now.getTime() / 1_000);

  it("accepts any configured secret and refuses forged, unsigned, and stale deliveries", () => {
    expect(verifyIssuerWebhook({
      rawBody, signatureHeader: signIssuerWebhook(rawBody, SECRET, at), secrets: [SECRET, ROTATED], now,
    })).toBe(true);
    expect(verifyIssuerWebhook({
      rawBody, signatureHeader: signIssuerWebhook(rawBody, ROTATED, at), secrets: [SECRET, ROTATED], now,
    })).toBe(true);
    // Multiple v1 entries: any valid one matches, like Stripe key rotation.
    const doubled = `${signIssuerWebhook(rawBody, ROTATED, at)},v1=${"0".repeat(64)}`;
    expect(verifyIssuerWebhook({ rawBody, signatureHeader: doubled, secrets: [ROTATED], now })).toBe(true);

    expect(verifyIssuerWebhook({ rawBody, secrets: [SECRET], now })).toBe(false);
    expect(verifyIssuerWebhook({ rawBody, signatureHeader: "", secrets: [SECRET], now })).toBe(false);
    expect(verifyIssuerWebhook({
      rawBody, signatureHeader: signIssuerWebhook(rawBody, "whsec_wrong_secret_000000000", at), secrets: [SECRET], now,
    })).toBe(false);
    expect(verifyIssuerWebhook({
      rawBody: Buffer.from("{\"tampered\":true}"), signatureHeader: signIssuerWebhook(rawBody, SECRET, at),
      secrets: [SECRET], now,
    })).toBe(false);
    expect(verifyIssuerWebhook({
      rawBody, signatureHeader: `t=${at},v1=nothex`, secrets: [SECRET], now,
    })).toBe(false);
    expect(verifyIssuerWebhook({
      rawBody, signatureHeader: `v1=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`,
      secrets: [SECRET], now,
    })).toBe(false);
    // Stale and future timestamps beyond the tolerance are refused.
    expect(verifyIssuerWebhook({
      rawBody, signatureHeader: signIssuerWebhook(rawBody, SECRET, at - 301), secrets: [SECRET], now,
    })).toBe(false);
    expect(verifyIssuerWebhook({
      rawBody, signatureHeader: signIssuerWebhook(rawBody, SECRET, at + 301), secrets: [SECRET], now,
    })).toBe(false);
    expect(verifyIssuerWebhook({
      rawBody, signatureHeader: signIssuerWebhook(rawBody, SECRET, at - 301),
      secrets: [SECRET], toleranceSeconds: 400, now,
    })).toBe(true);
    // Two different t= values in one header never verify.
    expect(verifyIssuerWebhook({
      rawBody, signatureHeader: `t=${at - 1},${signIssuerWebhook(rawBody, SECRET, at)}`, secrets: [SECRET], now,
    })).toBe(false);
    expect(() => verifyIssuerWebhook({ rawBody, signatureHeader: "t=1,v1=00", secrets: [] }))
      .toThrow(/one to four issuer webhook secrets/);
    expect(() => verifyIssuerWebhook({ rawBody, signatureHeader: "t=1,v1=00", secrets: ["short"] }))
      .toThrow(/one to four issuer webhook secrets/);
  });
});

describe("issuer authorization request parser", () => {
  it("parses the Stripe issuing_authorization.request shape into integer micros", () => {
    const parsed = parseIssuerAuthorizationRequest(requestEvent({ networkId: "1234567890" }));
    expect(parsed).toEqual({
      eventId: "evt_fixture_0001",
      authorizationRef: "iauth_fixture_0001",
      providerCardRef: "ic_fixture_0001",
      amountCents: 2_900,
      amountMicros: 29_000_000n,
      currency: "usd",
      merchantDescriptor: "MOCK SHOP EXAMPLE",
      merchantMcc: "5734",
      merchantNetworkId: "1234567890",
      merchantCountry: "US",
    });
    expect(centsToMicros(2_900)).toBe(29_000_000n);
    expect(microsToCents(29_000_000n)).toBe(2_900);
    expect(() => microsToCents(29_000_001n)).toThrow(/whole number of cents/);
    // The card reference also arrives unexpanded as a plain id string.
    expect(parseIssuerAuthorizationRequest(requestEvent({ card: "ic_fixture_0002" })).providerCardRef)
      .toBe("ic_fixture_0002");
  });

  it("fails closed on anything outside the contract", () => {
    const reject = (value: unknown) =>
      expect(() => parseIssuerAuthorizationRequest(value)).toThrow(CardIssuerRequestError);
    reject(requestEvent({ amount: -1 }));
    reject(requestEvent({ amount: 29.5 }));
    reject(requestEvent({ amount: "2900" }));
    reject(requestEvent({ currency: "eur" }));
    reject(requestEvent({ mcc: "573" }));
    reject(requestEvent({ mcc: "57345" }));
    reject(requestEvent({ mcc: "573a" }));
    reject(requestEvent({ name: "X".repeat(101) }));
    reject(requestEvent({ name: "" }));
    reject(requestEvent({ name: "line\nbreak" }));
    reject(requestEvent({ name: "   " }));
    reject(requestEvent({ networkId: "x".repeat(65) }));
    reject(requestEvent({ country: "usa" }));
    reject(requestEvent({ country: "U" }));
    reject(requestEvent({ card: { id: "card_not_issuing" } }));
    reject(requestEvent({ authorization: "auth_wrong_prefix" }));
    reject({ ...requestEvent(), type: "issuing_authorization.created" });
    const noPending = requestEvent();
    delete (noPending.data.object as { pending_request?: unknown }).pending_request;
    reject(noPending);
    reject("not an object");
    reject(null);
  });
});

describe("mock issuer network", () => {
  it("creates cards idempotently and refuses a reused key with different terms", async () => {
    const issuer = new MockIssuer();
    const ref = await issuerCard(issuer);
    const replay = await issuer.createCard({
      cardId: "11111111-1111-4111-8111-111111111111", capMicros: 100_000_000n,
      expiresAt: new Date("2027-01-01T00:00:00Z"), merchantHint: "mock-shop.example",
      singleUse: true, agentId: "agt_mock", ownerId: "usr_mock",
    });
    expect(replay.providerCardRef).toBe(ref);
    await expect(issuer.createCard({
      cardId: "11111111-1111-4111-8111-111111111111", capMicros: 999n,
      expiresAt: new Date("2027-01-01T00:00:00Z"), merchantHint: "mock-shop.example",
      singleUse: true, agentId: "agt_mock", ownerId: "usr_mock",
    })).rejects.toMatchObject({ status: 400, retryable: false });
    // A recomputed expiry on the same idempotency key is a changed body, and
    // is refused exactly like Stripe refuses a reused Idempotency-Key.
    await expect(issuer.createCard({
      cardId: "11111111-1111-4111-8111-111111111111", capMicros: 100_000_000n,
      expiresAt: new Date("2027-06-01T00:00:00Z"), merchantHint: "mock-shop.example",
      singleUse: true, agentId: "agt_mock", ownerId: "usr_mock",
    })).rejects.toMatchObject({ status: 400, retryable: false });

    const secrets = await issuer.revealCard(ref);
    expect(secrets.pan).toMatch(/^\d{16}$/);
    expect(secrets.pan.slice(-4)).toBe(replay.last4);
    await issuer.closeCard(ref);
    await issuer.closeCard(ref);
    await expect(issuer.revealCard(ref)).rejects.toMatchObject({ status: 400 });
    await expect(issuer.getEvent("evt_missing")).rejects.toMatchObject({ status: 404, retryable: false });
  });

  it("authorizes over the wire, replays deterministically, and keeps authorization ids single-use", async () => {
    const decideAuthorization = vi.fn(async (_input: unknown) => ({ decision: "approved" as const, authorizationId: "a-1", cardId: "c-1", replayed: false }));
    const { issuer, network } = issuerWorld({ decideAuthorization, enqueueEvent: vi.fn(async () => ({ inboxId: 1n, replayed: false, state: "queued" })) });
    const ref = await issuerCard(issuer);

    const outcome = await network.purchase(ref, {
      amountCents: 2_900, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734", networkId: "1234567890", country: "US",
    });
    expect(outcome).toEqual(expect.objectContaining({
      approved: true, reason: "webhook_approved", responseStatus: 200,
      authorizationRef: expect.stringMatching(/^iauth_mock_/), requestEventId: expect.stringMatching(/^evt_mock_/),
    }));
    expect(decideAuthorization).toHaveBeenCalledExactlyOnceWith({
      provider: "mock",
      providerEventId: outcome.requestEventId,
      providerAuthorizationRef: outcome.authorizationRef,
      providerCardRef: ref,
      amountMicros: 29_000_000n,
      merchantDescriptor: "MOCK SHOP EXAMPLE",
      merchantMcc: "5734",
      merchantNetworkId: "1234567890",
      merchantCountry: "US",
      authTtlSeconds: 604_800,
    });
    expect((await issuer.getAuthorization(outcome.authorizationRef!)).status).toBe("pending");

    // Replay re-delivers the identical stored bytes under a fresh signature.
    decideAuthorization.mockResolvedValueOnce({ decision: "approved", authorizationId: "a-1", cardId: "c-1", replayed: true });
    const replayed = await network.replay(outcome.requestEventId!);
    expect(replayed.status).toBe(200);
    expect(decideAuthorization).toHaveBeenCalledTimes(2);
    expect(decideAuthorization.mock.calls[1]![0]).toEqual(decideAuthorization.mock.calls[0]![0]);

    const capture = await network.capture(outcome.authorizationRef!, 2_900);
    expect(capture.transactionRef).toMatch(/^ipi_mock_/);
    await expect(network.capture(outcome.authorizationRef!)).rejects.toThrow(MockIssuerHonestyError);
    await expect(network.void(outcome.authorizationRef!)).rejects.toThrow(/single-use/);
    await expect(network.refund(outcome.authorizationRef!, 100)).rejects.toThrow(/capture transaction/);
    await expect(network.refund(capture.transactionRef, 3_000)).rejects.toThrow(/cannot exceed the captured amount/);
    const refund = await network.refund(capture.transactionRef, 900);
    await expect(network.refund(refund.transactionRef, 900)).rejects.toThrow(/capture transaction/);
    await expect(network.refund(capture.transactionRef, 2_000)).resolves.toEqual(expect.objectContaining({ delivered: true }));
    await expect(network.refund(capture.transactionRef, 1)).rejects.toThrow(/cannot exceed the captured amount/);
  });

  it("never lets an unsigned or stale delivery through and treats acceptance as a broken server", async () => {
    const decideAuthorization = vi.fn();
    const { issuer, network } = issuerWorld({ decideAuthorization });
    const ref = await issuerCard(issuer);
    const purchase = { amountCents: 1_000, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734" };

    const unsigned = await network.unsigned().purchase(ref, purchase);
    expect(unsigned).toEqual(expect.objectContaining({ approved: false, reason: "webhook_error", responseStatus: 401 }));
    const stale = await network.stale().purchase(ref, purchase);
    expect(stale).toEqual(expect.objectContaining({ approved: false, reason: "webhook_error", responseStatus: 401 }));
    expect(decideAuthorization).not.toHaveBeenCalled();

    const permissive = createMockIssuerNetwork({
      secret: SECRET,
      issuer,
      authorizationApp: { request: async () => new Response(JSON.stringify({ approved: true }), { status: 200 }) },
    });
    await expect(permissive.unsigned().purchase(ref, purchase)).rejects.toThrow(MockIssuerHonestyError);
    await expect(permissive.stale().purchase(ref, purchase)).rejects.toThrow(/must refuse with 401/);
  });

  it("declines honestly on canceled cards, timeouts, and insufficient balance without inventing approvals", async () => {
    const decideAuthorization = vi.fn(async () => ({ decision: "approved" as const, replayed: false }));
    const enqueueEvent = vi.fn(async () => ({ inboxId: 1n, replayed: false, state: "queued" }));
    const { issuer, network } = issuerWorld({ decideAuthorization, enqueueEvent });
    const ref = await issuerCard(issuer);
    const purchase = { amountCents: 500, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734" };

    // A timed-out webhook still delivers the signed request — our server
    // decides and may commit a hold — but the response is discarded, the
    // issuer records webhook_timeout, and nothing was approved issuer-side.
    network.timeoutNext();
    const timedOut = await network.purchase(ref, purchase);
    expect(timedOut).toEqual(expect.objectContaining({ approved: false, reason: "webhook_timeout" }));
    expect(decideAuthorization).toHaveBeenCalledTimes(1);
    expect(timedOut.responseStatus).toBeUndefined();
    expect(timedOut.responseBody).toBeUndefined();
    expect((await issuer.getAuthorization(timedOut.authorizationRef!)).requestHistory)
      .toEqual([expect.objectContaining({ approved: false, reason: "webhook_timeout" })]);

    network.insufficientBalanceNext();
    const broke = await network.purchase(ref, purchase);
    expect(broke).toEqual(expect.objectContaining({ approved: false, reason: "insufficient_funds" }));
    expect(decideAuthorization).toHaveBeenCalledTimes(1);

    await expect(network.verification(ref, { descriptor: "MOCK SHOP EXAMPLE", mcc: "5734", amountCents: 101 }))
      .rejects.toThrow(/at most 100 cents/);
    const verification = await network.verification(ref, { descriptor: "MOCK SHOP EXAMPLE", mcc: "5734" });
    expect(verification.approved).toBe(true);
    expect(decideAuthorization).toHaveBeenCalledTimes(2);
    expect(decideAuthorization).toHaveBeenLastCalledWith(expect.objectContaining({ amountMicros: 0n }));

    await issuer.closeCard(ref);
    const canceled = await network.purchase(ref, purchase);
    expect(canceled).toEqual(expect.objectContaining({ approved: false, reason: "card_inactive" }));
    expect(decideAuthorization).toHaveBeenCalledTimes(2);
    // Every declined attempt still produced an issuing_authorization.created event.
    expect(canceled.createdEventId).toMatch(/^evt_mock_/);
    await expect(network.purchase("ic_unknown", purchase)).rejects.toThrow(MockIssuerHonestyError);
  });

  it("normalizes issuer events into micros and binds the separately fetched object", async () => {
    const decideAuthorization = vi.fn(async () => ({ decision: "approved" as const, replayed: false }));
    const enqueueEvent = vi.fn(async () => ({ inboxId: 1n, replayed: false, state: "queued" }));
    const { issuer, network } = issuerWorld({ decideAuthorization, enqueueEvent });
    const ref = await issuerCard(issuer);
    const outcome = await network.purchase(ref, { amountCents: 2_900, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734" });
    expect(outcome.approved).toBe(true);

    const created = normalizeIssuerEvent(
      await issuer.getEvent(outcome.createdEventId!),
      await issuer.getAuthorization(outcome.authorizationRef!),
    );
    expect(created).toEqual(expect.objectContaining({
      kind: "authorization_created", approved: true, authorizationRef: outcome.authorizationRef,
      providerCardRef: ref, amountMicros: 29_000_000n, reason: "webhook_approved",
      payloadHash: expect.any(Buffer),
    }));

    const capture = await network.capture(outcome.authorizationRef!, 2_500);
    const clearing = normalizeIssuerEvent(
      await issuer.getEvent(capture.eventId),
      await issuer.getTransaction(capture.transactionRef),
    );
    expect(clearing).toEqual(expect.objectContaining({
      kind: "clearing", authorizationRef: outcome.authorizationRef, transactionRef: capture.transactionRef,
      settledMicros: 25_000_000n, eventType: "issuing_transaction.created",
    }));
    // The persisted canonical payload is the immutable event snapshot only, so
    // a retry after the live object advanced hashes identically.
    const again = normalizeIssuerEvent(
      await issuer.getEvent(capture.eventId),
      await issuer.getTransaction(capture.transactionRef),
    );
    expect(again.payloadHash.equals(clearing.payloadHash)).toBe(true);

    const tamperedCurrent = { ...(await issuer.getTransaction(capture.transactionRef)), amount: -2_400 };
    expect(() => normalizeIssuerEvent(issuerEventClone(issuer, capture.eventId), tamperedCurrent))
      .toThrow(CardIssuerEvidenceError);

    const refund = await network.refund(capture.transactionRef, 1_000);
    const refundNormalized = normalizeIssuerEvent(
      await issuer.getEvent(refund.eventId),
      await issuer.getTransaction(refund.transactionRef),
    );
    expect(refundNormalized).toEqual(expect.objectContaining({
      kind: "refund", refundRef: refund.transactionRef, authorizationRef: outcome.authorizationRef,
      amountMicros: 10_000_000n,
    }));

    const second = await network.purchase(ref, { amountCents: 700, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734" });
    const voided = await network.void(second.authorizationRef!);
    expect(normalizeIssuerEvent(
      await issuer.getEvent(voided.eventId),
      await issuer.getAuthorization(second.authorizationRef!),
    )).toEqual(expect.objectContaining({ kind: "void", authorizationRef: second.authorizationRef }));

    await issuer.closeCard(ref);
    const closedEventId = lastEventId(issuer);
    expect(normalizeIssuerEvent(await issuer.getEvent(closedEventId))).toEqual(expect.objectContaining({
      kind: "card_closed", providerCardRef: ref,
    }));

    expect(normalizeIssuerEvent({
      id: "evt_unknown_kind", type: "issuing_dispute.created", created: 1_766_000_000, data: { object: { id: "idp_1" } },
    })).toEqual(expect.objectContaining({ kind: "ignored" }));

    // No PAN ever appears in any recorded event payload.
    for (const eventId of allEventIds(issuer)) {
      expect(JSON.stringify(await issuer.getEvent(eventId))).not.toMatch(/\d{13,19}/);
    }
  });
});

function issuerEventClone(issuer: MockIssuer, eventId: string) {
  const state = issuer.eventState(eventId)!;
  return { id: state.id, type: state.type, created: state.createdAtSeconds, data: { object: state.objectSnapshot } };
}

function allEventIds(issuer: MockIssuer): string[] {
  const ids: string[] = [];
  for (let index = 1; index < 200; index += 1) {
    const id = `evt_mock_${String(index).padStart(4, "0")}`;
    if (issuer.eventState(id)) ids.push(id);
  }
  return ids;
}

function lastEventId(issuer: MockIssuer): string {
  const ids = allEventIds(issuer);
  return ids[ids.length - 1]!;
}
