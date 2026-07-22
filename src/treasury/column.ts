import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readBoundedResponseText } from "../core/bounded-response.ts";
import { isLoopbackHostname } from "../core/url-security.ts";
import type { TreasuryPayoutState } from "../db/treasury.ts";

const COLUMN_API = "https://api.column.com";
const MICROS_PER_CENT = 10_000n;
const MAX_COLUMN_BODY_BYTES = 512 * 1024;

export interface ColumnEvent {
  id: string;
  created_at: string;
  type: string;
  data: Record<string, unknown>;
}

export interface ColumnAchTransfer extends Record<string, unknown> {
  id: string;
  amount: number;
  account_number_id: string;
  bank_account_id: string;
  counterparty_id?: string | null;
  currency_code: string;
  is_incoming: boolean;
  status: string;
  type: string;
  created_at: string;
  updated_at: string;
  settled_at?: string | null;
  returned_at?: string | null;
  cancelled_at?: string | null;
  completed_at?: string | null;
}

export interface ColumnBankAccount extends Record<string, unknown> {
  id: string;
  currency_code: string;
  balances: {
    available_amount: number;
    holding_amount: number;
    locked_amount: number;
    pending_amount: number;
  };
  updated_at?: string;
}

export interface ColumnClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Tests may use a loopback HTTP fixture; production refuses plaintext. */
  allowInsecureLocalhost?: boolean;
  timeoutMs?: number;
}

export class ColumnApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly responseBody?: string
  ) {
    super(message);
    this.name = "ColumnApiError";
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 255): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function isoDate(value: unknown, name: string): string {
  const result = text(value, name, 100);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseAchTransfer(value: unknown): ColumnAchTransfer {
  const row = object(value, "Column ACH transfer");
  const transfer: ColumnAchTransfer = {
    ...row,
    id: text(row.id, "transfer.id"),
    amount: integer(row.amount, "transfer.amount"),
    account_number_id: text(row.account_number_id, "transfer.account_number_id"),
    bank_account_id: text(row.bank_account_id, "transfer.bank_account_id"),
    currency_code: text(row.currency_code, "transfer.currency_code", 3),
    is_incoming: row.is_incoming === true,
    status: text(row.status, "transfer.status", 64).toUpperCase(),
    type: text(row.type, "transfer.type", 16).toUpperCase(),
    created_at: isoDate(row.created_at, "transfer.created_at"),
    updated_at: isoDate(row.updated_at, "transfer.updated_at"),
  };
  if (typeof row.is_incoming !== "boolean") throw new Error("transfer.is_incoming must be boolean");
  if (row.counterparty_id !== undefined && row.counterparty_id !== null) {
    transfer.counterparty_id = text(row.counterparty_id, "transfer.counterparty_id");
  }
  for (const field of ["settled_at", "returned_at", "cancelled_at", "completed_at"] as const) {
    const value = row[field];
    if (value !== undefined && value !== null) transfer[field] = isoDate(value, `transfer.${field}`);
  }
  return transfer;
}

export function parseColumnEvent(value: unknown): ColumnEvent {
  const row = object(value, "Column event");
  return {
    id: text(row.id, "event.id"),
    created_at: isoDate(row.created_at, "event.created_at"),
    type: text(row.type, "event.type"),
    data: object(row.data, "event.data"),
  };
}

export function columnPayoutState(status: string): Exclude<TreasuryPayoutState, "queued" | "submitting"> | undefined {
  switch (status.toUpperCase()) {
    case "INITIATED":
    case "PENDING_SUBMISSION":
    case "SUBMITTED":
    case "SCHEDULED":
    case "PENDING_RETURN":
    case "MANUAL_REVIEW_APPROVED":
      return "submitted";
    case "SETTLED":
    case "COMPLETED":
      return "settled";
    case "RETURNED":
    case "RETURN_CONTESTED":
    case "RETURN_DISHONORED":
    case "RETURN_DISHONORED_FUNDS_UNLOCKED":
      return "returned";
    case "CANCELED":
    case "CANCELLED":
      return "cancelled";
    case "MANUAL_REVIEW":
      return "manual_review";
    default:
      return undefined;
  }
}

function sameImmutableTransfer(eventTransfer: ColumnAchTransfer, current: ColumnAchTransfer): boolean {
  return eventTransfer.id === current.id
    && eventTransfer.amount === current.amount
    && eventTransfer.account_number_id === current.account_number_id
    && eventTransfer.bank_account_id === current.bank_account_id
    && eventTransfer.currency_code === current.currency_code
    && eventTransfer.is_incoming === current.is_incoming
    && eventTransfer.type === current.type
    && eventTransfer.counterparty_id === current.counterparty_id;
}

export type NormalizedColumnEvent =
  | {
    kind: "funding_settled" | "funding_returned";
    provider: "column";
    providerEventId: string;
    eventType: string;
    providerTransferId: string;
    providerRouteRef: string;
    asset: "USD";
    amountMicros: bigint;
    occurredAt: Date;
    reason?: string;
    payloadHash: Buffer;
    canonicalPayload: Record<string, unknown>;
  }
  | {
    kind: "payout_transition";
    provider: "column";
    providerEventId: string;
    eventType: string;
    providerTransferId: string;
    providerState: Exclude<TreasuryPayoutState, "queued" | "submitting">;
    asset: "USD";
    amountMicros: bigint;
    occurredAt: Date;
    payloadHash: Buffer;
    canonicalPayload: Record<string, unknown>;
  }
  | {
    kind: "ignored";
    provider: "column";
    providerEventId: string;
    eventType: string;
    providerTransferId: string;
    reason: string;
    payloadHash: Buffer;
    canonicalPayload: Record<string, unknown>;
  };

/** Normalize only an event fetched with Column API credentials. The current
 * transfer is fetched separately and binds immutable economic fields. Event
 * data supplies historical state so out-of-order settle/return deliveries are
 * still processable after the live object has advanced. */
export function normalizeColumnEvent(eventInput: unknown, currentInput: unknown): NormalizedColumnEvent {
  const event = parseColumnEvent(eventInput);
  const eventTransfer = parseAchTransfer(event.data);
  const current = parseAchTransfer(currentInput);
  if (!sameImmutableTransfer(eventTransfer, current)) {
    throw new Error("Column event and current ACH transfer disagree on immutable terms");
  }
  if (eventTransfer.currency_code !== "USD" || eventTransfer.type !== "CREDIT") {
    throw new Error("only USD ACH credits are supported by the Column treasury adapter");
  }
  // Persist the immutable authenticated event snapshot. The separately fetched
  // live object validates its economic terms but is intentionally excluded:
  // it may advance between a successful command and a crash/retry.
  const canonicalPayload = { event };
  const payloadHash = createHash("sha256").update(canonicalJson(canonicalPayload)).digest();
  const common = {
    provider: "column" as const,
    providerEventId: event.id,
    eventType: event.type,
    providerTransferId: eventTransfer.id,
    asset: "USD" as const,
    amountMicros: BigInt(eventTransfer.amount) * MICROS_PER_CENT,
    occurredAt: new Date(event.created_at),
    payloadHash,
    canonicalPayload,
  };

  if (eventTransfer.is_incoming) {
    if (event.type === "ach.incoming_transfer.settled" && eventTransfer.status === "SETTLED") {
      return { ...common, kind: "funding_settled", providerRouteRef: eventTransfer.account_number_id };
    }
    if (event.type === "ach.incoming_transfer.returned" && eventTransfer.status === "RETURNED") {
      const details = Array.isArray(eventTransfer.return_details) ? eventTransfer.return_details : [];
      const latest = details.at(-1);
      const returnCode = latest && typeof latest === "object" && typeof (latest as Record<string, unknown>).return_code === "string"
        ? ` (${(latest as Record<string, unknown>).return_code})` : "";
      return {
        ...common, kind: "funding_returned", providerRouteRef: eventTransfer.account_number_id,
        reason: `Column ACH funding returned${returnCode}`,
      };
    }
    return { ...common, kind: "ignored", reason: "incoming ACH event is not a settled credit or return" };
  }

  if (!event.type.startsWith("ach.outgoing_transfer.")) {
    return { ...common, kind: "ignored", reason: "event is not an outgoing ACH transition" };
  }
  const state = columnPayoutState(eventTransfer.status);
  if (!state) return { ...common, kind: "ignored", reason: `unsupported Column ACH state ${eventTransfer.status}` };
  return { ...common, kind: "payout_transition", providerState: state };
}

export function verifyColumnWebhook(input: {
  rawBody: Uint8Array;
  signature?: string;
  endpointId?: string;
  expectedEndpointId: string;
  secret: string;
}): boolean {
  if (!input.signature || !/^[0-9a-f]{64}$/i.test(input.signature)) return false;
  if (!input.endpointId || input.endpointId !== input.expectedEndpointId) return false;
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest();
  const presented = Buffer.from(input.signature, "hex");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export class ColumnClient {
  readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly authorization: string;
  private readonly timeoutMs: number;

  constructor(options: ColumnClientOptions) {
    if (!options.apiKey || options.apiKey.length > 512
      || options.apiKey.trim() !== options.apiKey || /[\r\n]/.test(options.apiKey)) {
      throw new Error("Column API key is required");
    }
    this.baseUrl = new URL(options.baseUrl ?? COLUMN_API);
    const loopback = isLoopbackHostname(this.baseUrl);
    if (this.baseUrl.protocol !== "https:" && !(options.allowInsecureLocalhost && loopback)) {
      throw new Error("Column API must use HTTPS");
    }
    if (this.baseUrl.username || this.baseUrl.password || this.baseUrl.pathname !== "/"
      || this.baseUrl.search || this.baseUrl.hash) {
      throw new Error("Column API URL must be a bare origin without credentials");
    }
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.authorization = `Basic ${Buffer.from(`:${options.apiKey}`).toString("base64")}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error("Column timeout must be an integer from 100 to 60000 milliseconds");
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        signal,
        redirect: "error",
        headers: { authorization: this.authorization, accept: "application/json", ...init.headers },
      });
    } catch (error) {
      throw new ColumnApiError(`Column request failed: ${error instanceof Error ? error.message : "network error"}`, 0, true);
    }
    let body: string;
    try {
      body = await readBoundedResponseText(
        response,
        MAX_COLUMN_BODY_BYTES,
        "Column API response is too large",
      );
    } catch (error) {
      throw new ColumnApiError(
        error instanceof Error ? error.message : "Column API response could not be read",
        response.status,
        true,
      );
    }
    if (!response.ok) {
      throw new ColumnApiError(
        `Column API returned HTTP ${response.status}`,
        response.status,
        response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
        body.slice(0, 2_000)
      );
    }
    try {
      return body ? JSON.parse(body) as unknown : {};
    } catch {
      throw new ColumnApiError("Column API returned invalid JSON", response.status, false, body.slice(0, 2_000));
    }
  }

  async getEvent(eventId: string): Promise<ColumnEvent> {
    const expectedId = text(eventId, "eventId");
    const event = parseColumnEvent(await this.request(`/events/${encodeURIComponent(expectedId)}`));
    if (event.id !== expectedId) throw new Error("Column returned a different event id");
    return event;
  }

  async listWebhookEvents(input: { createdGte: Date; createdLt?: Date; limit?: number; startingAfter?: string }) {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Column event limit must be 1-100");
    const query = new URLSearchParams({ "created.gte": input.createdGte.toISOString(), limit: String(limit) });
    if (input.createdLt) query.set("created.lt", input.createdLt.toISOString());
    if (input.startingAfter) query.set("starting_after", input.startingAfter);
    const envelope = object(await this.request(`/events/webhook?${query}`), "Column events response");
    if (!Array.isArray(envelope.events)) throw new Error("Column events response is missing events");
    return envelope.events.map(parseColumnEvent);
  }

  async getAchTransfer(transferId: string): Promise<ColumnAchTransfer> {
    const expectedId = text(transferId, "transferId");
    const transfer = parseAchTransfer(await this.request(`/transfers/ach/${encodeURIComponent(expectedId)}`));
    if (transfer.id !== expectedId) throw new Error("Column returned a different ACH transfer id");
    return transfer;
  }

  async getBankAccount(bankAccountId: string): Promise<ColumnBankAccount> {
    const expectedId = text(bankAccountId, "bankAccountId");
    const row = object(await this.request(`/bank-accounts/${encodeURIComponent(expectedId)}`), "Column bank account");
    const balances = object(row.balances, "bankAccount.balances");
    const result: ColumnBankAccount = {
      ...row,
      id: text(row.id, "bankAccount.id"),
      currency_code: text(row.currency_code, "bankAccount.currency_code", 3),
      balances: {
        available_amount: integer(balances.available_amount, "balances.available_amount"),
        holding_amount: integer(balances.holding_amount, "balances.holding_amount"),
        locked_amount: integer(balances.locked_amount, "balances.locked_amount"),
        pending_amount: integer(balances.pending_amount, "balances.pending_amount"),
      },
    };
    if (row.updated_at !== undefined) result.updated_at = isoDate(row.updated_at, "bankAccount.updated_at");
    if (result.id !== expectedId) throw new Error("Column returned a different bank account id");
    return result;
  }

  async createAchPayout(input: {
    payoutId: string;
    sourceBankAccountId?: string;
    sourceAccountNumberId?: string;
    counterpartyId: string;
    amountMicros: bigint;
    sameDay?: boolean;
  }): Promise<ColumnAchTransfer> {
    if ((!input.sourceBankAccountId && !input.sourceAccountNumberId)
      || (input.sourceBankAccountId && input.sourceAccountNumberId)) {
      throw new Error("exactly one Column source bank account or account number is required");
    }
    if (input.amountMicros <= 0n || input.amountMicros % MICROS_PER_CENT !== 0n) {
      throw new Error("Column ACH payout must be positive whole cents");
    }
    const cents = input.amountMicros / MICROS_PER_CENT;
    if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Column ACH payout exceeds safe cent range");
    const body = new URLSearchParams({
      amount: cents.toString(),
      counterparty_id: text(input.counterpartyId, "counterpartyId"),
      currency_code: "USD",
      description: `money payout ${text(input.payoutId, "payoutId", 100)}`,
      company_entry_description: "AGENT PAY",
      same_day: String(input.sameDay ?? false),
      type: "CREDIT",
      ...(input.sourceBankAccountId ? { bank_account_id: text(input.sourceBankAccountId, "sourceBankAccountId") } : {}),
      ...(input.sourceAccountNumberId ? { account_number_id: text(input.sourceAccountNumberId, "sourceAccountNumberId") } : {}),
    });
    const transfer = parseAchTransfer(await this.request("/transfers/ach", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": `money-payout-${input.payoutId}`,
      },
      body,
    }));
    const sourceMatches = input.sourceBankAccountId
      ? transfer.bank_account_id === input.sourceBankAccountId
      : transfer.account_number_id === input.sourceAccountNumberId;
    if (!sourceMatches || transfer.counterparty_id !== input.counterpartyId
      || transfer.amount !== Number(cents) || transfer.currency_code !== "USD"
      || transfer.type !== "CREDIT" || transfer.is_incoming) {
      throw new Error("Column payout response does not match reserved payout terms");
    }
    return transfer;
  }
}

export function columnBankSnapshot(account: ColumnBankAccount, observedAt = new Date()) {
  if (account.currency_code !== "USD") throw new Error("Column bank snapshot must be USD");
  const availableMicros = BigInt(account.balances.available_amount) * MICROS_PER_CENT;
  const holdingMicros = BigInt(account.balances.holding_amount) * MICROS_PER_CENT;
  const lockedMicros = BigInt(account.balances.locked_amount) * MICROS_PER_CENT;
  const pendingMicros = BigInt(account.balances.pending_amount) * MICROS_PER_CENT;
  return {
    provider: "column" as const,
    providerAccountRef: account.id,
    asset: "USD" as const,
    bookMicros: availableMicros + holdingMicros + lockedMicros,
    availableMicros,
    holdingMicros,
    lockedMicros,
    pendingMicros,
    providerObservationId: `${account.id}:${observedAt.toISOString()}`,
    observedAt,
  };
}

export { MICROS_PER_CENT };
