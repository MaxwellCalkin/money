import {
  CardIssuerApiError,
  ISSUER_REQUEST_EVENT_TYPE,
  ISSUER_SIGNATURE_HEADER,
  parseIssuerAuthorization,
  parseIssuerTransaction,
  signIssuerWebhook,
  type CardIssuer,
  type IssuerAuthorization,
  type IssuerCardMaterial,
  type IssuerCardSecrets,
  type IssuerCreateCardInput,
  type IssuerEvent,
  type IssuerTransaction,
} from "./issuer.ts";

/** Sandbox mock of a Stripe-shaped issuer network. No real funds; nothing here
 * is a bank, card, or deposit account. It speaks the exact wire shapes the
 * real adapter will speak, and it is honest: it never approves a purchase our
 * authorization server did not approve, never reuses an authorization id,
 * refuses to move money on a card it does not know, and treats an accepted
 * unsigned or stale delivery as a test failure. */

const MOCK_PROVIDER = "mock";
/** Luhn-valid network test PAN (sandbox only). Returned exclusively by
 * revealCard; it never appears in any event or authorization object. */
const MOCK_TEST_PAN = "4242424242424242";
const MOCK_TEST_CVC = "123";
const MAX_VERIFICATION_CENTS = 100;

export class MockIssuerHonestyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MockIssuerHonestyError";
  }
}

interface MockCardState {
  ref: string;
  cardId: string;
  agentId: string;
  status: "active" | "canceled";
  last4: string;
  expMonth: number;
  expYear: number;
  termsKey: string;
}

interface MockMerchant {
  descriptor: string;
  mcc: string;
  networkId?: string;
  country?: string;
}

interface MockAuthorizationState {
  ref: string;
  cardRef: string;
  amountCents: number;
  approved: boolean;
  status: "pending" | "closed" | "reversed";
  merchant: MockMerchant;
  createdAtSeconds: number;
  requestHistory: Array<{ approved: boolean; reason: string; amount: number; currency: "usd"; created: number }>;
  capturedCents: number;
  refundedCents: number;
  transactionRefs: string[];
}

interface MockTransactionState {
  ref: string;
  type: "capture" | "refund";
  amountCents: number;
  authorizationRef: string;
  cardRef: string;
  createdAtSeconds: number;
}

interface MockEventState {
  id: string;
  type: string;
  createdAtSeconds: number;
  objectSnapshot: Record<string, unknown>;
  rawBody: string;
  target: "authorization" | "events";
}

export interface MockDeliveryApp {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

export interface MockDeliveryResult {
  delivered: boolean;
  status?: number;
  body?: unknown;
}

export interface MockPurchaseOutcome {
  approved: boolean;
  reason: string;
  authorizationRef?: string;
  requestEventId?: string;
  createdEventId?: string;
  responseStatus?: number;
  responseBody?: unknown;
  declineCode?: string;
  createdDelivery?: MockDeliveryResult;
}

export interface MockPurchaseInput {
  amountCents: number;
  descriptor: string;
  mcc: string;
  networkId?: string;
  country?: string;
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

/** In-memory Stripe-shaped issuer. Cards are created with an Idempotency-Key
 * equal to our card id: the same card id always resolves to the same issuer
 * card, and the same key with different terms is refused like Stripe refuses
 * a reused idempotency key. */
export class MockIssuer implements CardIssuer {
  readonly provider = MOCK_PROVIDER;
  private readonly cards = new Map<string, MockCardState>();
  private readonly cardsByIdempotencyKey = new Map<string, MockCardState>();
  private readonly authorizations = new Map<string, MockAuthorizationState>();
  private readonly transactions = new Map<string, MockTransactionState>();
  private readonly events = new Map<string, MockEventState>();
  private counter = 0;
  /** Set by createMockIssuerNetwork so issuer-side lifecycle (card cancel)
   * emits the async events a real issuer would. */
  network?: MockIssuerNetwork;

  nextRef(prefix: string): string {
    this.counter += 1;
    return `${prefix}_mock_${String(this.counter).padStart(4, "0")}`;
  }

  async createCard(input: IssuerCreateCardInput): Promise<IssuerCardMaterial> {
    if (!input.cardId || input.capMicros <= 0n || !input.merchantHint || !input.agentId) {
      throw new CardIssuerApiError("mock issuer refused an invalid card request", 400, false);
    }
    const validExpiresAt = input.expiresAt instanceof Date && Number.isFinite(input.expiresAt.getTime())
      ? input.expiresAt : undefined;
    const termsKey = JSON.stringify({
      capMicros: input.capMicros.toString(), singleUse: input.singleUse,
      merchantHint: input.merchantHint, agentId: input.agentId,
      expiresAt: validExpiresAt ? validExpiresAt.toISOString() : "invalid",
    });
    const existing = this.cardsByIdempotencyKey.get(input.cardId);
    if (existing) {
      if (existing.termsKey !== termsKey) {
        throw new CardIssuerApiError("mock issuer idempotency key was reused with different card terms", 400, false);
      }
      return {
        providerCardRef: existing.ref, last4: existing.last4,
        expMonth: existing.expMonth, expYear: existing.expYear,
      };
    }
    const expires = validExpiresAt ?? new Date(Date.now() + 3_600_000);
    const card: MockCardState = {
      ref: this.nextRef("ic"),
      cardId: input.cardId,
      agentId: input.agentId,
      status: "active",
      last4: MOCK_TEST_PAN.slice(-4),
      expMonth: expires.getUTCMonth() + 1,
      expYear: Math.min(2100, Math.max(2026, expires.getUTCFullYear() + 3)),
      termsKey,
    };
    this.cards.set(card.ref, card);
    this.cardsByIdempotencyKey.set(input.cardId, card);
    return { providerCardRef: card.ref, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear };
  }

  async closeCard(providerCardRef: string): Promise<void> {
    const card = this.cards.get(providerCardRef);
    if (!card) throw new CardIssuerApiError("mock issuer card not found", 404, false);
    if (card.status === "canceled") return;
    card.status = "canceled";
    await this.network?.emitCardUpdated(card.ref);
  }

  async revealCard(providerCardRef: string): Promise<IssuerCardSecrets> {
    const card = this.cards.get(providerCardRef);
    if (!card) throw new CardIssuerApiError("mock issuer card not found", 404, false);
    if (card.status !== "active") {
      throw new CardIssuerApiError("mock issuer card is canceled", 400, false);
    }
    return { pan: MOCK_TEST_PAN, cvc: MOCK_TEST_CVC, expMonth: card.expMonth, expYear: card.expYear };
  }

  async getEvent(eventId: string): Promise<IssuerEvent> {
    const event = this.events.get(eventId);
    if (!event) throw new CardIssuerApiError("mock issuer event not found", 404, false);
    return {
      id: event.id, type: event.type, created: event.createdAtSeconds,
      data: { object: deepClone(event.objectSnapshot) },
    };
  }

  async getAuthorization(providerAuthorizationRef: string): Promise<IssuerAuthorization> {
    const authorization = this.authorizations.get(providerAuthorizationRef);
    if (!authorization) throw new CardIssuerApiError("mock issuer authorization not found", 404, false);
    return parseIssuerAuthorization(this.authorizationObject(authorization));
  }

  async getTransaction(providerTransactionRef: string): Promise<IssuerTransaction> {
    const transaction = this.transactions.get(providerTransactionRef);
    if (!transaction) throw new CardIssuerApiError("mock issuer transaction not found", 404, false);
    return parseIssuerTransaction(this.transactionObject(transaction));
  }

  card(providerCardRef: string): MockCardState | undefined {
    return this.cards.get(providerCardRef);
  }

  authorizationState(ref: string): MockAuthorizationState | undefined {
    return this.authorizations.get(ref);
  }

  transactionState(ref: string): MockTransactionState | undefined {
    return this.transactions.get(ref);
  }

  eventState(id: string): MockEventState | undefined {
    return this.events.get(id);
  }

  recordAuthorization(state: MockAuthorizationState): void {
    if (this.authorizations.has(state.ref)) {
      throw new MockIssuerHonestyError(`authorization id ${state.ref} was already used`);
    }
    this.authorizations.set(state.ref, state);
  }

  recordTransaction(state: MockTransactionState): void {
    this.transactions.set(state.ref, state);
  }

  recordEvent(state: MockEventState): void {
    this.events.set(state.id, state);
  }

  /** The card object embedded in events. It never carries the PAN or CVC. */
  cardObject(providerCardRef: string): Record<string, unknown> {
    const card = this.cards.get(providerCardRef);
    if (!card) throw new MockIssuerHonestyError(`mock issuer does not know card ${providerCardRef}`);
    return {
      id: card.ref, object: "issuing.card", status: card.status, last4: card.last4,
      exp_month: card.expMonth, exp_year: card.expYear, livemode: false,
    };
  }

  authorizationObject(state: MockAuthorizationState, pendingRequest?: { amount: number }): Record<string, unknown> {
    return {
      id: state.ref,
      object: "issuing.authorization",
      amount: state.approved ? state.amountCents : 0,
      approved: state.approved,
      authorization_method: "online",
      card: this.cardObject(state.cardRef),
      cardholder: "ich_mock",
      created: state.createdAtSeconds,
      currency: "usd",
      livemode: false,
      merchant_amount: state.approved ? state.amountCents : 0,
      merchant_currency: "usd",
      merchant_data: {
        category_code: state.merchant.mcc,
        name: state.merchant.descriptor,
        ...(state.merchant.networkId !== undefined ? { network_id: state.merchant.networkId } : {}),
        ...(state.merchant.country !== undefined ? { country: state.merchant.country } : {}),
      },
      metadata: {},
      pending_request: pendingRequest
        ? { amount: pendingRequest.amount, currency: "usd", is_amount_controllable: false, merchant_amount: pendingRequest.amount, merchant_currency: "usd" }
        : null,
      request_history: state.requestHistory.map((entry) => ({ ...entry })),
      status: state.status,
      transactions: [...state.transactionRefs],
    };
  }

  transactionObject(state: MockTransactionState): Record<string, unknown> {
    return {
      id: state.ref,
      object: "issuing.transaction",
      amount: state.amountCents,
      authorization: state.authorizationRef,
      card: state.cardRef,
      cardholder: "ich_mock",
      created: state.createdAtSeconds,
      currency: "usd",
      livemode: false,
      merchant_amount: state.amountCents,
      merchant_currency: "usd",
      type: state.type,
    };
  }
}

type DeliveryMode = "signed" | "unsigned" | "stale";

export interface MockIssuerNetworkOptions {
  secret: string;
  issuer?: MockIssuer;
  authorizationApp?: MockDeliveryApp;
  authorizationUrl?: string;
  eventsApp?: MockDeliveryApp;
  eventsUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Seconds beyond which a stale() delivery is guaranteed to be refused. */
  staleBySeconds?: number;
}

/** Signed delivery views for negative tests. The network still enforces its
 * honesty rules: an unsigned or stale request that our server accepts is a
 * broken authorization server, so the network throws instead of proceeding. */
export interface MockIssuerNetworkDeliveryView {
  purchase(providerCardRef: string, input: MockPurchaseInput): Promise<MockPurchaseOutcome>;
  replay(eventId: string): Promise<MockDeliveryResult>;
}

export class MockIssuerNetwork {
  readonly issuer: MockIssuer;
  private readonly secret: string;
  private readonly authorizationTarget?: { app?: MockDeliveryApp; url?: string };
  private readonly eventsTarget?: { app?: MockDeliveryApp; url?: string };
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly staleBySeconds: number;
  private timeoutArmed = false;
  private insufficientBalanceArmed = false;

  constructor(options: MockIssuerNetworkOptions) {
    if (!options.secret || options.secret.length < 24) {
      throw new Error("mock issuer network requires a signing secret of at least 24 characters");
    }
    this.secret = options.secret;
    this.issuer = options.issuer ?? new MockIssuer();
    this.issuer.network = this;
    if (options.authorizationApp && options.authorizationUrl) {
      throw new Error("configure the authorization target as an app or a URL, not both");
    }
    if (options.eventsApp && options.eventsUrl) {
      throw new Error("configure the events target as an app or a URL, not both");
    }
    this.authorizationTarget = options.authorizationApp
      ? { app: options.authorizationApp }
      : options.authorizationUrl ? { url: options.authorizationUrl } : undefined;
    this.eventsTarget = options.eventsApp
      ? { app: options.eventsApp }
      : options.eventsUrl ? { url: options.eventsUrl } : undefined;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.staleBySeconds = options.staleBySeconds ?? 3_600;
  }

  /** Arms an issuer-side timeout for the next purchase: the signed
   * authorization request is still delivered to our server, but the response
   * is discarded and the issuer records webhook_timeout with approved=false.
   * Any hold our database committed must be released by the worker via the
   * approved=false issuing_authorization.created event. */
  timeoutNext(): void {
    this.timeoutArmed = true;
  }

  insufficientBalanceNext(): void {
    this.insufficientBalanceArmed = true;
  }

  unsigned(): MockIssuerNetworkDeliveryView {
    return {
      purchase: (ref, input) => this.purchaseWithMode(ref, input, "unsigned"),
      replay: (eventId) => this.replayWithMode(eventId, "unsigned"),
    };
  }

  stale(): MockIssuerNetworkDeliveryView {
    return {
      purchase: (ref, input) => this.purchaseWithMode(ref, input, "stale"),
      replay: (eventId) => this.replayWithMode(eventId, "stale"),
    };
  }

  purchase(providerCardRef: string, input: MockPurchaseInput): Promise<MockPurchaseOutcome> {
    return this.purchaseWithMode(providerCardRef, input, "signed");
  }

  /** Card-on-file verification authorization: at most $1.00. */
  async verification(providerCardRef: string, input: Omit<MockPurchaseInput, "amountCents"> & { amountCents?: number }): Promise<MockPurchaseOutcome> {
    const amountCents = input.amountCents ?? 0;
    if (amountCents > MAX_VERIFICATION_CENTS) {
      throw new MockIssuerHonestyError(`a verification authorization is at most ${MAX_VERIFICATION_CENTS} cents`);
    }
    return this.purchaseWithMode(providerCardRef, { ...input, amountCents }, "signed");
  }

  replay(eventId: string): Promise<MockDeliveryResult> {
    return this.replayWithMode(eventId, "signed");
  }

  private nowSeconds(): number {
    return Math.floor(this.now().getTime() / 1_000);
  }

  private signatureFor(rawBody: string, mode: DeliveryMode): string | undefined {
    if (mode === "unsigned") return undefined;
    const at = mode === "stale" ? this.nowSeconds() - this.staleBySeconds : this.nowSeconds();
    return signIssuerWebhook(rawBody, this.secret, at);
  }

  private async deliver(
    target: { app?: MockDeliveryApp; url?: string } | undefined,
    path: string,
    rawBody: string,
    mode: DeliveryMode,
  ): Promise<MockDeliveryResult> {
    if (!target) return { delivered: false };
    const signature = this.signatureFor(rawBody, mode);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signature !== undefined) headers[ISSUER_SIGNATURE_HEADER] = signature;
    const init: RequestInit = { method: "POST", headers, body: rawBody };
    const response = target.app
      ? await target.app.request(path, init)
      : await this.fetcher(new URL(path, target.url), init);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (mode !== "signed" && response.status !== 401) {
      throw new MockIssuerHonestyError(
        `authorization server accepted a ${mode} delivery with HTTP ${response.status}; it must refuse with 401`,
      );
    }
    return { delivered: true, status: response.status, body };
  }

  /** Emits issuing_card.updated after an issuer-side cancel, like a real
   * issuer would; the worker treats it as card_closed evidence. */
  async emitCardUpdated(providerCardRef: string): Promise<MockDeliveryResult> {
    const snapshot = this.issuer.cardObject(providerCardRef);
    return this.recordAndDeliverEvent("issuing_card.updated", snapshot, "events");
  }

  private async recordAndDeliverEvent(
    type: string,
    objectSnapshot: Record<string, unknown>,
    target: "authorization" | "events",
    pathOverride?: string,
  ): Promise<MockDeliveryResult & { eventId: string }> {
    const eventId = this.issuer.nextRef("evt");
    const createdAtSeconds = this.nowSeconds();
    const rawBody = JSON.stringify({
      id: eventId, object: "event", created: createdAtSeconds,
      data: { object: objectSnapshot }, livemode: false, type,
    });
    this.issuer.recordEvent({
      id: eventId, type, createdAtSeconds, objectSnapshot: deepClone(objectSnapshot), rawBody, target,
    });
    const path = pathOverride ?? (target === "authorization"
      ? `/webhooks/${MOCK_PROVIDER}/authorization`
      : `/webhooks/${MOCK_PROVIDER}/events`);
    const delivery = await this.deliver(
      target === "authorization" ? this.authorizationTarget : this.eventsTarget,
      path, rawBody, "signed",
    );
    return { ...delivery, eventId };
  }

  private async purchaseWithMode(
    providerCardRef: string,
    input: MockPurchaseInput,
    mode: DeliveryMode,
  ): Promise<MockPurchaseOutcome> {
    const card = this.issuer.card(providerCardRef);
    if (!card) throw new MockIssuerHonestyError(`mock issuer does not know card ${providerCardRef}`);
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0) {
      throw new MockIssuerHonestyError("purchase amount must be a nonnegative integer of cents");
    }
    const merchant: MockMerchant = {
      descriptor: input.descriptor, mcc: input.mcc,
      ...(input.networkId !== undefined ? { networkId: input.networkId } : {}),
      ...(input.country !== undefined ? { country: input.country } : {}),
    };

    if (mode !== "signed") {
      // A forged or replayed-late delivery is not issuer traffic: nothing is
      // recorded network-side, and the server must refuse it outright.
      const state: MockAuthorizationState = {
        ref: this.issuer.nextRef("iauth"), cardRef: card.ref, amountCents: input.amountCents,
        approved: false, status: "closed", merchant, createdAtSeconds: this.nowSeconds(),
        requestHistory: [], capturedCents: 0, refundedCents: 0, transactionRefs: [],
      };
      const rawBody = JSON.stringify({
        id: this.issuer.nextRef("evt"), object: "event", created: this.nowSeconds(),
        data: { object: this.issuer.authorizationObject(state, { amount: input.amountCents }) },
        livemode: false, type: ISSUER_REQUEST_EVENT_TYPE,
      });
      const delivery = await this.deliver(this.authorizationTarget, `/webhooks/${MOCK_PROVIDER}/authorization`, rawBody, mode);
      return {
        approved: false, reason: "webhook_error",
        ...(delivery.status !== undefined ? { responseStatus: delivery.status } : {}),
        ...(delivery.body !== undefined ? { responseBody: delivery.body } : {}),
      };
    }

    const state: MockAuthorizationState = {
      ref: this.issuer.nextRef("iauth"),
      cardRef: card.ref,
      amountCents: input.amountCents,
      approved: false,
      status: "pending",
      merchant,
      createdAtSeconds: this.nowSeconds(),
      requestHistory: [],
      capturedCents: 0,
      refundedCents: 0,
      transactionRefs: [],
    };
    this.issuer.recordAuthorization(state);

    let reason: string;
    let responseStatus: number | undefined;
    let responseBody: unknown;
    let requestEventId: string | undefined;

    if (card.status !== "active") {
      this.timeoutArmed = false;
      reason = "card_inactive";
    } else if (this.insufficientBalanceArmed) {
      this.insufficientBalanceArmed = false;
      reason = "insufficient_funds";
    } else if (!this.authorizationTarget) {
      this.timeoutArmed = false;
      reason = "webhook_error";
    } else {
      const timedOut = this.timeoutArmed;
      this.timeoutArmed = false;
      const eventId = this.issuer.nextRef("evt");
      requestEventId = eventId;
      const createdAtSeconds = this.nowSeconds();
      const rawBody = JSON.stringify({
        id: eventId, object: "event", created: createdAtSeconds,
        data: { object: this.issuer.authorizationObject(state, { amount: input.amountCents }) },
        livemode: false, type: ISSUER_REQUEST_EVENT_TYPE,
      });
      this.issuer.recordEvent({
        id: eventId, type: ISSUER_REQUEST_EVENT_TYPE, createdAtSeconds,
        objectSnapshot: deepClone(this.issuer.authorizationObject(state, { amount: input.amountCents })),
        rawBody, target: "authorization",
      });
      const delivery = await this.deliver(this.authorizationTarget, `/webhooks/${MOCK_PROVIDER}/authorization`, rawBody, mode);
      if (timedOut) {
        // The issuer stopped waiting before our answer arrived: the request
        // was delivered (our server may well have committed a pending hold),
        // but the response is discarded and the issuer records the timeout as
        // a decline. The async issuing_authorization.created event with
        // approved=false is the only signal our worker gets to release it.
        reason = "webhook_timeout";
      } else {
        responseStatus = delivery.status;
        responseBody = delivery.body;
        const body = delivery.body as { approved?: unknown } | undefined;
        if (delivery.status === 200 && body && body.approved === true) {
          state.approved = true;
          reason = "webhook_approved";
        } else if (delivery.status === 200 && body && body.approved === false) {
          reason = "webhook_declined";
        } else {
          reason = "webhook_error";
        }
      }
    }

    state.requestHistory.push({
      approved: state.approved, reason, amount: input.amountCents, currency: "usd", created: this.nowSeconds(),
    });
    if (!state.approved) state.status = "closed";

    const created = await this.recordAndDeliverEvent(
      "issuing_authorization.created", this.issuer.authorizationObject(state), "events",
    );
    const metadata = (responseBody as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    const declineCode = metadata && typeof metadata.agentmoney_decline_code === "string"
      ? metadata.agentmoney_decline_code : undefined;
    return {
      approved: state.approved,
      reason,
      authorizationRef: state.ref,
      ...(requestEventId !== undefined ? { requestEventId } : {}),
      createdEventId: created.eventId,
      ...(responseStatus !== undefined ? { responseStatus } : {}),
      ...(responseBody !== undefined ? { responseBody } : {}),
      ...(declineCode !== undefined ? { declineCode } : {}),
      createdDelivery: created,
    };
  }

  async capture(authorizationRef: string, amountCents?: number): Promise<MockDeliveryResult & { transactionRef: string; eventId: string }> {
    const state = this.issuer.authorizationState(authorizationRef);
    if (!state) throw new MockIssuerHonestyError(`unknown authorization ${authorizationRef}`);
    if (!state.approved || state.status !== "pending") {
      throw new MockIssuerHonestyError(`authorization ${authorizationRef} is ${state.status}; issuer authorization ids are single-use`);
    }
    const cents = amountCents ?? state.amountCents;
    if (!Number.isSafeInteger(cents) || cents <= 0) {
      throw new MockIssuerHonestyError("capture amount must be a positive integer of cents");
    }
    state.status = "closed";
    state.capturedCents = cents;
    const transaction: MockTransactionState = {
      ref: this.issuer.nextRef("ipi"), type: "capture", amountCents: -cents,
      authorizationRef: state.ref, cardRef: state.cardRef, createdAtSeconds: this.nowSeconds(),
    };
    this.issuer.recordTransaction(transaction);
    state.transactionRefs.push(transaction.ref);
    const delivery = await this.recordAndDeliverEvent(
      "issuing_transaction.created", this.issuer.transactionObject(transaction), "events",
    );
    return { ...delivery, transactionRef: transaction.ref };
  }

  async void(authorizationRef: string): Promise<MockDeliveryResult & { eventId: string }> {
    return this.reverseAuthorization(authorizationRef, "voided by the merchant");
  }

  async expire(authorizationRef: string): Promise<MockDeliveryResult & { eventId: string }> {
    return this.reverseAuthorization(authorizationRef, "expired without capture");
  }

  private async reverseAuthorization(authorizationRef: string, note: string): Promise<MockDeliveryResult & { eventId: string }> {
    const state = this.issuer.authorizationState(authorizationRef);
    if (!state) throw new MockIssuerHonestyError(`unknown authorization ${authorizationRef}`);
    if (!state.approved || state.status !== "pending") {
      throw new MockIssuerHonestyError(`authorization ${authorizationRef} is ${state.status}; issuer authorization ids are single-use`);
    }
    state.status = "reversed";
    const snapshot = this.issuer.authorizationObject(state);
    (snapshot as Record<string, unknown>).reversal_note = note;
    return this.recordAndDeliverEvent("issuing_authorization.updated", snapshot, "events");
  }

  async refund(transactionRef: string, amountCents: number): Promise<MockDeliveryResult & { transactionRef: string; eventId: string }> {
    const capture = this.issuer.transactionState(transactionRef);
    if (!capture || capture.type !== "capture") {
      throw new MockIssuerHonestyError(`refunds reference a capture transaction; ${transactionRef} is not one`);
    }
    const state = this.issuer.authorizationState(capture.authorizationRef);
    if (!state) throw new MockIssuerHonestyError(`unknown authorization ${capture.authorizationRef}`);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new MockIssuerHonestyError("refund amount must be a positive integer of cents");
    }
    if (state.refundedCents + amountCents > state.capturedCents) {
      throw new MockIssuerHonestyError("refunds cannot exceed the captured amount");
    }
    state.refundedCents += amountCents;
    const refund: MockTransactionState = {
      ref: this.issuer.nextRef("ipi"), type: "refund", amountCents,
      authorizationRef: state.ref, cardRef: state.cardRef, createdAtSeconds: this.nowSeconds(),
    };
    this.issuer.recordTransaction(refund);
    state.transactionRefs.push(refund.ref);
    const delivery = await this.recordAndDeliverEvent(
      "issuing_transaction.created", this.issuer.transactionObject(refund), "events",
    );
    return { ...delivery, transactionRef: refund.ref };
  }

  private async replayWithMode(eventId: string, mode: DeliveryMode): Promise<MockDeliveryResult> {
    const event = this.issuer.eventState(eventId);
    if (!event) throw new MockIssuerHonestyError(`unknown event ${eventId}`);
    const path = event.target === "authorization"
      ? `/webhooks/${MOCK_PROVIDER}/authorization`
      : `/webhooks/${MOCK_PROVIDER}/events`;
    return this.deliver(
      event.target === "authorization" ? this.authorizationTarget : this.eventsTarget,
      path, event.rawBody, mode,
    );
  }
}

export function createMockIssuerNetwork(options: MockIssuerNetworkOptions): MockIssuerNetwork {
  return new MockIssuerNetwork(options);
}
