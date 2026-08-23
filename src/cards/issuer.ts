import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** The card rail speaks the Stripe Issuing wire shape. The mock issuer and the
 * real adapter (CP6) both produce these objects; the parsers here are the only
 * place untrusted issuer bytes become typed values, and every parser fails
 * closed. Cents <-> micros conversion lives here too so no caller does it by
 * hand. */

/** Pinned API version sent back on every authorization response and used by
 * the Stripe adapter. UNVERIFIED against the live sandbox (see spec section 3). */
export const ISSUER_API_VERSION = "2025-03-31.basil";
/** Stripe signs both the synchronous authorization request and async events
 * with the same header format: `t=<unix seconds>,v1=<hex hmac>[,v1=<hex>]`. */
export const ISSUER_SIGNATURE_HEADER = "stripe-signature";
export const ISSUER_REQUEST_EVENT_TYPE = "issuing_authorization.request";
export const MICROS_PER_CENT = 10_000n;
/** $10,000,000 in cents: far above the $10,000 card cap ceiling, so anything
 * larger is a malformed request rather than a purchase. */
export const MAX_ISSUER_AMOUNT_CENTS = 1_000_000_000;
const MIN_WEBHOOK_SECRET_LENGTH = 24;
const MAX_WEBHOOK_SECRET_LENGTH = 512;
const DEFAULT_TOLERANCE_SECONDS = 300;

export interface IssuerCardMaterial {
  providerCardRef: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

/** Returned only by `revealCard`, only to the API process, only inside a
 * single-use reveal. Never logged, never stored, never placed in an event. */
export interface IssuerCardSecrets {
  pan: string;
  cvc: string;
  expMonth: number;
  expYear: number;
}

export interface IssuerCreateCardInput {
  cardId: string;
  capMicros: bigint;
  expiresAt: Date;
  merchantHint: string;
  singleUse: boolean;
  agentId: string;
  ownerId: string;
}

export interface IssuerEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

export interface IssuerAuthorization extends Record<string, unknown> {
  id: string;
  status: "pending" | "closed" | "reversed";
  approved: boolean;
  amount: number;
  currency: string;
  cardRef: string;
  requestHistory: Array<{ approved: boolean; reason?: string }>;
}

export interface IssuerTransaction extends Record<string, unknown> {
  id: string;
  type: "capture" | "refund";
  amount: number;
  currency: string;
  authorizationRef: string;
  cardRef: string;
}

export interface IssuerCard extends Record<string, unknown> {
  id: string;
  status: "active" | "inactive" | "canceled";
  last4: string;
  expMonth: number;
  expYear: number;
}

/** Three-credential split mirrors Column: the API process creates, closes, and
 * reveals; the event worker only reads events and objects; the authorization
 * ingress holds no issuer credential at all. */
export interface CardIssuer {
  readonly provider: string;
  createCard(input: IssuerCreateCardInput): Promise<IssuerCardMaterial>;
  closeCard(providerCardRef: string): Promise<void>;
  revealCard(providerCardRef: string): Promise<IssuerCardSecrets>;
  getEvent(eventId: string): Promise<IssuerEvent>;
  getAuthorization(providerAuthorizationRef: string): Promise<IssuerAuthorization>;
  getTransaction(providerTransactionRef: string): Promise<IssuerTransaction>;
}

export class CardIssuerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly responseBody?: string,
  ) {
    super(message);
    this.name = "CardIssuerApiError";
  }
}

/** A synchronous authorization request that does not match the contract. The
 * ingress answers `approved:false` with decline code `invalid_request` and
 * never reaches the database. */
export class CardIssuerRequestError extends Error {
  readonly code = "invalid_request" as const;
  constructor(message: string) {
    super(message);
    this.name = "CardIssuerRequestError";
  }
}

/** Issuer evidence that can never be applied (terms disagree, unsupported
 * sign, unsupported currency). The worker dead-letters it, which trips the
 * treasury breaker, instead of retrying forever. */
export class CardIssuerEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardIssuerEvidenceError";
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CardIssuerRequestError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 255, min = 1): string {
  if (typeof value !== "string" || value.length < min || value.length > max
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CardIssuerRequestError(`${name} must be a printable string of ${min}-${max} characters`);
  }
  return value;
}

function prefixedId(value: unknown, prefix: string, name: string): string {
  const id = text(value, name, 255, prefix.length + 1);
  if (!id.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new CardIssuerRequestError(`${name} must be a ${prefix} identifier`);
  }
  return id;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new CardIssuerRequestError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function usd(value: unknown, name: string): "usd" {
  if (value !== "usd") throw new CardIssuerRequestError(`${name} must be usd`);
  return "usd";
}

/** Stripe expands `card` on authorizations but sends the id string on
 * transactions; both spell the same issuer card reference. */
function cardRef(value: unknown, name: string): string {
  if (typeof value === "string") return prefixedId(value, "ic_", name);
  return prefixedId(object(value, name).id, "ic_", `${name}.id`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function centsToMicros(cents: number): bigint {
  if (!Number.isSafeInteger(cents)) throw new CardIssuerRequestError("cents must be a safe integer");
  return BigInt(cents) * MICROS_PER_CENT;
}

export function microsToCents(micros: bigint): number {
  if (micros % MICROS_PER_CENT !== 0n) throw new Error("amount is not a whole number of cents");
  const cents = micros / MICROS_PER_CENT;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("amount exceeds the safe cent range");
  }
  return Number(cents);
}

export function parseIssuerEvent(value: unknown): IssuerEvent {
  const row = object(value, "issuer event");
  if (row.object !== undefined && row.object !== "event") {
    throw new CardIssuerRequestError("issuer event.object must be event");
  }
  const data = object(row.data, "issuer event.data");
  return {
    id: text(row.id, "event.id", 255, 3),
    type: text(row.type, "event.type", 100),
    created: integer(row.created, "event.created", 0, 4_102_444_800),
    data: { object: object(data.object, "event.data.object") },
  };
}

export function parseIssuerAuthorization(value: unknown): IssuerAuthorization {
  const row = object(value, "issuer authorization");
  if (row.object !== undefined && row.object !== "issuing.authorization") {
    throw new CardIssuerRequestError("authorization.object must be issuing.authorization");
  }
  const status = text(row.status, "authorization.status", 16);
  if (status !== "pending" && status !== "closed" && status !== "reversed") {
    throw new CardIssuerRequestError("authorization.status is not supported");
  }
  if (typeof row.approved !== "boolean") {
    throw new CardIssuerRequestError("authorization.approved must be boolean");
  }
  const history = Array.isArray(row.request_history) ? row.request_history : [];
  return {
    ...row,
    id: prefixedId(row.id, "iauth_", "authorization.id"),
    status,
    approved: row.approved,
    amount: integer(row.amount, "authorization.amount", 0, MAX_ISSUER_AMOUNT_CENTS),
    currency: usd(row.currency, "authorization.currency"),
    cardRef: cardRef(row.card, "authorization.card"),
    requestHistory: history.map((entry, index) => {
      const item = object(entry, `authorization.request_history[${index}]`);
      if (typeof item.approved !== "boolean") {
        throw new CardIssuerRequestError("authorization.request_history approved must be boolean");
      }
      return {
        approved: item.approved,
        ...(typeof item.reason === "string" ? { reason: text(item.reason, "request_history.reason", 64) } : {}),
      };
    }),
  };
}

export function parseIssuerTransaction(value: unknown): IssuerTransaction {
  const row = object(value, "issuer transaction");
  if (row.object !== undefined && row.object !== "issuing.transaction") {
    throw new CardIssuerRequestError("transaction.object must be issuing.transaction");
  }
  const type = text(row.type, "transaction.type", 16);
  if (type !== "capture" && type !== "refund") {
    throw new CardIssuerRequestError("transaction.type is not supported");
  }
  const authorization = typeof row.authorization === "string"
    ? row.authorization
    : object(row.authorization, "transaction.authorization").id;
  return {
    ...row,
    id: prefixedId(row.id, "ipi_", "transaction.id"),
    type,
    amount: integer(row.amount, "transaction.amount", -MAX_ISSUER_AMOUNT_CENTS, MAX_ISSUER_AMOUNT_CENTS),
    currency: usd(row.currency, "transaction.currency"),
    authorizationRef: prefixedId(authorization, "iauth_", "transaction.authorization"),
    cardRef: cardRef(row.card, "transaction.card"),
  };
}

/** Card objects are parsed without their secret fields: even if an issuer ever
 * expanded `number`/`cvc` into an event, nothing downstream could see them. */
export function parseIssuerCard(value: unknown): IssuerCard {
  const { number: _number, cvc: _cvc, ...row } = object(value, "issuer card");
  if (row.object !== undefined && row.object !== "issuing.card") {
    throw new CardIssuerRequestError("card.object must be issuing.card");
  }
  const status = text(row.status, "card.status", 16);
  if (status !== "active" && status !== "inactive" && status !== "canceled") {
    throw new CardIssuerRequestError("card.status is not supported");
  }
  const last4 = text(row.last4, "card.last4", 4, 4);
  if (!/^[0-9]{4}$/.test(last4)) throw new CardIssuerRequestError("card.last4 must be four digits");
  return {
    ...row,
    id: prefixedId(row.id, "ic_", "card.id"),
    status,
    last4,
    expMonth: integer(row.exp_month, "card.exp_month", 1, 12),
    expYear: integer(row.exp_year, "card.exp_year", 2026, 2100),
  };
}

export interface IssuerAuthorizationRequest {
  eventId: string;
  authorizationRef: string;
  providerCardRef: string;
  amountCents: number;
  amountMicros: bigint;
  currency: "usd";
  merchantDescriptor: string;
  merchantMcc: string;
  merchantNetworkId?: string;
  merchantCountry?: string;
}

/** Fail-closed parser of the synchronous `issuing_authorization.request`
 * event. Anything outside the contract throws `CardIssuerRequestError`; the
 * ingress turns that into an `invalid_request` decline without a DB call. */
export function parseIssuerAuthorizationRequest(raw: unknown): IssuerAuthorizationRequest {
  const event = parseIssuerEvent(raw);
  if (event.type !== ISSUER_REQUEST_EVENT_TYPE) {
    throw new CardIssuerRequestError(`event.type must be ${ISSUER_REQUEST_EVENT_TYPE}`);
  }
  const authorization = event.data.object;
  if (authorization.object !== undefined && authorization.object !== "issuing.authorization") {
    throw new CardIssuerRequestError("authorization.object must be issuing.authorization");
  }
  const authorizationRef = prefixedId(authorization.id, "iauth_", "authorization.id");
  const providerCardRef = cardRef(authorization.card, "authorization.card");
  if (authorization.currency !== undefined) usd(authorization.currency, "authorization.currency");
  const pending = object(authorization.pending_request, "authorization.pending_request");
  const amountCents = integer(pending.amount, "pending_request.amount", 0, MAX_ISSUER_AMOUNT_CENTS);
  usd(pending.currency, "pending_request.currency");
  const merchant = object(authorization.merchant_data, "authorization.merchant_data");
  const merchantMcc = text(merchant.category_code, "merchant_data.category_code", 4, 4);
  if (!/^[0-9]{4}$/.test(merchantMcc)) {
    throw new CardIssuerRequestError("merchant_data.category_code must be four digits");
  }
  const merchantDescriptor = text(merchant.name, "merchant_data.name", 100).trim();
  if (!merchantDescriptor) throw new CardIssuerRequestError("merchant_data.name must not be blank");
  const request: IssuerAuthorizationRequest = {
    eventId: event.id,
    authorizationRef,
    providerCardRef,
    amountCents,
    amountMicros: centsToMicros(amountCents),
    currency: "usd",
    merchantDescriptor,
    merchantMcc,
  };
  if (merchant.network_id !== undefined && merchant.network_id !== null) {
    request.merchantNetworkId = text(merchant.network_id, "merchant_data.network_id", 64);
  }
  if (merchant.country !== undefined && merchant.country !== null) {
    const country = text(merchant.country, "merchant_data.country", 3, 2);
    if (!/^[A-Z]{2,3}$/.test(country)) {
      throw new CardIssuerRequestError("merchant_data.country must be an upper-case ISO code");
    }
    request.merchantCountry = country;
  }
  return request;
}

export function assertIssuerWebhookSecrets(secrets: readonly string[]): readonly string[] {
  if (secrets.length < 1 || secrets.length > 4 || secrets.some((secret) => typeof secret !== "string"
    || secret.length < MIN_WEBHOOK_SECRET_LENGTH || secret.length > MAX_WEBHOOK_SECRET_LENGTH
    || secret.trim() !== secret || /[\r\n]/.test(secret))) {
    throw new Error(`one to four issuer webhook secrets of ${MIN_WEBHOOK_SECRET_LENGTH}-${MAX_WEBHOOK_SECRET_LENGTH} characters are required`);
  }
  return Object.freeze([...new Set(secrets)]);
}

export function signIssuerWebhook(rawBody: Uint8Array | string, secret: string, timestampSeconds: number): string {
  const signature = createHmac("sha256", secret)
    .update(`${timestampSeconds}.`, "utf8")
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody)
    .digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

/** Verifies `t=<unix>,v1=<hex>` over `${t}.${rawBody}` against each of the
 * configured secrets (rotation exactly like MONEY_COMPLIANCE_WEBHOOK_SECRETS).
 * The timestamp is judged by the ingress process clock; the database clock
 * stays authoritative for card and mandate expiry. */
export function verifyIssuerWebhook(input: {
  rawBody: Uint8Array;
  signatureHeader?: string | null;
  secrets: readonly string[];
  toleranceSeconds?: number;
  now?: Date;
}): boolean {
  const secrets = assertIssuerWebhookSecrets(input.secrets);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isSafeInteger(tolerance) || tolerance < 30 || tolerance > 900) {
    throw new Error("issuer webhook tolerance must be an integer between 30 and 900 seconds");
  }
  const header = input.signatureHeader;
  if (!header || header.length > 2_048) return false;
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "t") {
      if (timestamp !== undefined && timestamp !== value) return false;
      timestamp = value;
    } else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) {
      signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === undefined || !/^\d{10}$/.test(timestamp) || signatures.length < 1 || signatures.length > 8) {
    return false;
  }
  const sentAt = Number(timestamp);
  const now = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  if (!Number.isSafeInteger(sentAt) || Math.abs(now - sentAt) > tolerance) return false;
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.`, "utf8").update(input.rawBody).digest();
    for (const signature of signatures) {
      const presented = Buffer.from(signature, "hex");
      matched = (presented.length === expected.length && timingSafeEqual(presented, expected)) || matched;
    }
  }
  return matched;
}

export type IssuerObjectKind = "authorization" | "transaction" | "card";

/** Which issuer object the worker must re-fetch before normalizing an event.
 * Unknown event types fetch nothing and are ignored. */
export function issuerEventObjectKind(eventType: string): IssuerObjectKind | undefined {
  if (eventType === "issuing_authorization.created" || eventType === "issuing_authorization.updated") return "authorization";
  if (eventType === "issuing_transaction.created") return "transaction";
  if (eventType === "issuing_card.updated") return "card";
  return undefined;
}

interface NormalizedBase {
  providerEventId: string;
  eventType: string;
  occurredAt: Date;
  payloadHash: Buffer;
  canonicalPayload: Record<string, unknown>;
}

export type NormalizedIssuerEvent =
  | (NormalizedBase & {
    kind: "clearing";
    authorizationRef: string;
    transactionRef: string;
    providerCardRef: string;
    settledMicros: bigint;
  })
  | (NormalizedBase & {
    kind: "refund";
    authorizationRef: string;
    refundRef: string;
    providerCardRef: string;
    amountMicros: bigint;
  })
  | (NormalizedBase & {
    kind: "void";
    authorizationRef: string;
    providerCardRef: string;
  })
  | (NormalizedBase & {
    kind: "authorization_created";
    authorizationRef: string;
    providerCardRef: string;
    approved: boolean;
    amountMicros: bigint;
    reason?: string;
  })
  | (NormalizedBase & {
    kind: "card_closed";
    providerCardRef: string;
  })
  | (NormalizedBase & {
    kind: "ignored";
    reason: string;
  });

/** Normalize an event the worker fetched with issuer credentials, binding the
 * immutable terms of the separately fetched current object. The persisted
 * canonical payload is the immutable event snapshot only, so retries after a
 * crash hash identically even after the live object has advanced. `current`
 * is required for authorization and transaction events; card events carry
 * enough in the authenticated event itself. */
export function normalizeIssuerEvent(eventInput: unknown, currentInput?: unknown): NormalizedIssuerEvent {
  const event = parseIssuerEvent(eventInput);
  const canonicalPayload = {
    event: { id: event.id, type: event.type, created: event.created, data: { object: event.data.object } },
  };
  const base: NormalizedBase = {
    providerEventId: event.id,
    eventType: event.type,
    occurredAt: new Date(event.created * 1_000),
    payloadHash: createHash("sha256").update(canonicalJson(canonicalPayload)).digest(),
    canonicalPayload,
  };
  const kind = issuerEventObjectKind(event.type);
  if (kind === undefined) {
    return { ...base, kind: "ignored", reason: `unsupported issuer event type ${event.type}` };
  }

  if (kind === "transaction") {
    const snapshot = parseIssuerTransaction(event.data.object);
    const current = parseIssuerTransaction(currentInput);
    if (snapshot.id !== current.id || snapshot.type !== current.type || snapshot.amount !== current.amount
      || snapshot.currency !== current.currency || snapshot.authorizationRef !== current.authorizationRef
      || snapshot.cardRef !== current.cardRef) {
      throw new CardIssuerEvidenceError("issuer event and current transaction disagree on immutable terms");
    }
    if (snapshot.type === "capture") {
      // Stripe books captures as negative cardholder amounts (UNVERIFIED; see
      // spec section 3). A positive capture is evidence we cannot apply.
      if (snapshot.amount > 0) {
        throw new CardIssuerEvidenceError("issuer capture carries an unsupported sign");
      }
      return {
        ...base, kind: "clearing", authorizationRef: snapshot.authorizationRef, transactionRef: snapshot.id,
        providerCardRef: snapshot.cardRef, settledMicros: centsToMicros(-snapshot.amount),
      };
    }
    if (snapshot.amount <= 0) {
      throw new CardIssuerEvidenceError("issuer refund carries an unsupported sign");
    }
    return {
      ...base, kind: "refund", authorizationRef: snapshot.authorizationRef, refundRef: snapshot.id,
      providerCardRef: snapshot.cardRef, amountMicros: centsToMicros(snapshot.amount),
    };
  }

  if (kind === "authorization") {
    const snapshot = parseIssuerAuthorization(event.data.object);
    const current = parseIssuerAuthorization(currentInput);
    if (snapshot.id !== current.id || snapshot.cardRef !== current.cardRef || snapshot.currency !== current.currency) {
      throw new CardIssuerEvidenceError("issuer event and current authorization disagree on immutable terms");
    }
    if (event.type === "issuing_authorization.created") {
      if (snapshot.approved !== current.approved) {
        throw new CardIssuerEvidenceError("issuer event and current authorization disagree on approval");
      }
      const reason = snapshot.requestHistory.at(-1)?.reason;
      return {
        ...base, kind: "authorization_created", authorizationRef: snapshot.id, providerCardRef: snapshot.cardRef,
        approved: snapshot.approved, amountMicros: centsToMicros(snapshot.amount),
        ...(reason ? { reason } : {}),
      };
    }
    if (snapshot.status === "reversed") {
      if (current.status !== "reversed") {
        throw new CardIssuerEvidenceError("issuer reports a reversal the current authorization does not show");
      }
      return { ...base, kind: "void", authorizationRef: snapshot.id, providerCardRef: snapshot.cardRef };
    }
    return { ...base, kind: "ignored", reason: `authorization update to ${snapshot.status} moves no money` };
  }

  const snapshot = parseIssuerCard(event.data.object);
  if (currentInput !== undefined) {
    const current = parseIssuerCard(currentInput);
    if (current.id !== snapshot.id) {
      throw new CardIssuerEvidenceError("issuer event and current card disagree on immutable terms");
    }
    if (snapshot.status === "canceled" && current.status !== "canceled") {
      throw new CardIssuerEvidenceError("issuer reports a cancellation the current card does not show");
    }
  }
  if (snapshot.status === "canceled") {
    return { ...base, kind: "card_closed", providerCardRef: snapshot.id };
  }
  return { ...base, kind: "ignored", reason: `card update to ${snapshot.status} moves no money` };
}
