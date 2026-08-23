import { readBoundedResponse } from "../core/bounded-response.ts";
import { isLoopbackHostname } from "../core/url-security.ts";
import {
  CardIssuerApiError,
  ISSUER_API_VERSION,
  MAX_ISSUER_AMOUNT_CENTS,
  microsToCents,
  parseIssuerAuthorization,
  parseIssuerCard,
  parseIssuerEvent,
  parseIssuerTransaction,
  type CardIssuer,
  type IssuerAuthorization,
  type IssuerCard,
  type IssuerCardMaterial,
  type IssuerCardSecrets,
  type IssuerCreateCardInput,
  type IssuerEvent,
  type IssuerTransaction,
} from "./issuer.ts";

/** Real Stripe Issuing adapter, modeled on the Column treasury client: bounded
 * responses, typed retryable API errors, no redirects, a hard timeout, and no
 * code path that can place a secret (API key or PAN) into a log line or an
 * error message. Request/response shapes are recorded from Stripe's public
 * documentation into test/fixtures/stripe-issuing/ and must be re-verified
 * against live test mode before go-live (see the fixtures README). */

const STRIPE_API = "https://api.stripe.com";
const MAX_STRIPE_BODY_BYTES = 1024 * 1024;

export type StripeIssuingRole = "api" | "worker";

export interface StripeIssuingClientOptions {
  /** api role: the create/close/reveal secret key. worker role: the restricted
   * read key for events, authorizations, transactions, and the close drain. */
  apiKey: string;
  role: StripeIssuingRole;
  /** Required for the api role: the pre-created Issuing cardholder every
   * agent card is issued under. Forbidden for the worker role. */
  cardholderId?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Tests may use a loopback HTTP fixture; production refuses plaintext. */
  allowInsecureLocalhost?: boolean;
  timeoutMs?: number;
}

function configText(value: unknown, name: string, max = 255): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max
    || value.trim() !== value || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be a trimmed non-empty string of at most ${max} characters`);
  }
  return value;
}

function pathToken(value: unknown, name: string): string {
  const token = configText(value, name);
  if (!/^[A-Za-z0-9_-]{3,255}$/.test(token)) {
    throw new Error(`${name} must be a provider identifier`);
  }
  return token;
}

export class StripeIssuingClient implements CardIssuer {
  readonly provider = "stripe-issuing";
  readonly baseUrl: URL;
  private readonly role: StripeIssuingRole;
  private readonly cardholderId?: string;
  private readonly fetcher: typeof fetch;
  private readonly authorization: string;
  private readonly timeoutMs: number;

  constructor(options: StripeIssuingClientOptions) {
    configText(options.apiKey, "Stripe Issuing API key", 512);
    if (options.role !== "api" && options.role !== "worker") {
      throw new Error("Stripe Issuing client role must be api or worker");
    }
    this.role = options.role;
    if (options.role === "api") {
      this.cardholderId = pathToken(options.cardholderId, "Stripe Issuing cardholder id");
    } else if (options.cardholderId !== undefined) {
      throw new Error("the worker-role Stripe Issuing credential must not carry a cardholder id");
    }
    this.baseUrl = new URL(options.baseUrl ?? STRIPE_API);
    const loopback = isLoopbackHostname(this.baseUrl);
    if (this.baseUrl.protocol !== "https:" && !(options.allowInsecureLocalhost && loopback)) {
      throw new Error("Stripe Issuing API must use HTTPS");
    }
    if (this.baseUrl.username || this.baseUrl.password || this.baseUrl.pathname !== "/"
      || this.baseUrl.search || this.baseUrl.hash) {
      throw new Error("Stripe Issuing API URL must be a bare origin without credentials");
    }
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.authorization = `Bearer ${options.apiKey}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error("Stripe Issuing timeout must be an integer from 100 to 60000 milliseconds");
    }
  }

  /** One bounded, redirect-refusing request. `sensitive` responses (card
   * reveal) never place any response bytes into a thrown error. */
  private async request(
    path: string,
    init: RequestInit = {},
    options: { sensitive?: boolean; idempotencyKey?: string } = {},
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        signal,
        redirect: "error",
        headers: {
          authorization: this.authorization,
          accept: "application/json",
          "stripe-version": ISSUER_API_VERSION,
          ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new CardIssuerApiError(
        `Stripe Issuing request failed: ${error instanceof Error ? error.message : "network error"}`,
        0,
        true,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new CardIssuerApiError(
        `Stripe Issuing redirect refused (HTTP ${response.status})`,
        response.status,
        false,
      );
    }
    let body: string;
    try {
      body = new TextDecoder().decode(await readBoundedResponse(
        response,
        MAX_STRIPE_BODY_BYTES,
        "Stripe Issuing API response is too large",
      ));
    } catch (error) {
      throw new CardIssuerApiError(
        options.sensitive
          ? "Stripe Issuing API response could not be read"
          : error instanceof Error ? error.message : "Stripe Issuing API response could not be read",
        response.status,
        true,
      );
    }
    if (!response.ok) {
      throw new CardIssuerApiError(
        `Stripe Issuing API returned HTTP ${response.status}`,
        response.status,
        response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
        options.sensitive ? undefined : body.slice(0, 2_000),
      );
    }
    try {
      return body ? JSON.parse(body) as unknown : {};
    } catch {
      throw new CardIssuerApiError(
        "Stripe Issuing API returned invalid JSON",
        response.status,
        false,
        options.sensitive ? undefined : body.slice(0, 2_000),
      );
    }
  }

  private parseCardOrThrow(payload: unknown): IssuerCard {
    try {
      return parseIssuerCard(payload);
    } catch (error) {
      throw new CardIssuerApiError(
        `Stripe Issuing card response is malformed: ${error instanceof Error ? error.message : "parse error"}`,
        200,
        false,
      );
    }
  }

  /** POST /v1/issuing/cards. Single-use is deliberately NOT sent as
   * `lifecycle_controls[cancel_after][payment_count]` (unverified parameter;
   * spec addendum 12): single-use is enforced by our decline ladder plus the
   * per_authorization spending limit sent here. */
  async createCard(input: IssuerCreateCardInput): Promise<IssuerCardMaterial> {
    if (this.role !== "api") {
      throw new CardIssuerApiError("card creation requires the api-role Stripe Issuing credential", 403, false);
    }
    const cardId = configText(input.cardId, "cardId", 128);
    configText(input.agentId, "agentId", 255);
    if (input.capMicros <= 0n) throw new Error("card cap must be positive");
    const capCents = microsToCents(input.capMicros);
    if (capCents < 1 || capCents > MAX_ISSUER_AMOUNT_CENTS) {
      throw new Error("card cap is outside the supported cent range");
    }
    if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime())) {
      throw new Error("card expiresAt must be a valid date");
    }
    const body = new URLSearchParams({
      cardholder: this.cardholderId!,
      currency: "usd",
      type: "virtual",
      status: "active",
      "spending_controls[spending_limits][0][amount]": String(capCents),
      "spending_controls[spending_limits][0][interval]": "per_authorization",
      "metadata[agentmoney_card]": cardId,
      "metadata[agentmoney_agent]": input.agentId,
    });
    const card = this.parseCardOrThrow(await this.request("/v1/issuing/cards", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }, { idempotencyKey: cardId }));
    const metadata = card.metadata as Record<string, unknown> | undefined;
    const limits = (card.spending_controls as Record<string, unknown> | undefined)?.spending_limits;
    const limit = Array.isArray(limits) ? limits[0] as Record<string, unknown> | undefined : undefined;
    const cardholder = typeof card.cardholder === "string"
      ? card.cardholder
      : (card.cardholder as Record<string, unknown> | undefined)?.id;
    if (card.status !== "active"
      || metadata?.agentmoney_card !== cardId
      || cardholder !== this.cardholderId
      || (card.currency !== undefined && card.currency !== "usd")
      || (card.type !== undefined && card.type !== "virtual")
      || limit?.amount !== capCents
      || limit?.interval !== "per_authorization") {
      throw new Error("Stripe Issuing card response does not match the requested card terms");
    }
    return {
      providerCardRef: card.id,
      last4: card.last4,
      expMonth: card.expMonth,
      expYear: card.expYear,
    };
  }

  /** POST /v1/issuing/cards/{id} status=canceled. Allowed for both roles: the
   * API cancels after a post-create denial, the event worker drains
   * close-requested cards (its restricted key needs issuing_cards write). */
  async closeCard(providerCardRef: string): Promise<void> {
    const ref = pathToken(providerCardRef, "providerCardRef");
    const card = this.parseCardOrThrow(await this.request(`/v1/issuing/cards/${encodeURIComponent(ref)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ status: "canceled" }),
    }));
    if (card.id !== ref) throw new Error("Stripe Issuing returned a different card id");
    if (card.status !== "canceled") throw new Error("Stripe Issuing did not cancel the card");
  }

  /** GET /v1/issuing/cards/{id}?expand[]=number&expand[]=cvc — api role only.
   * The result is returned to exactly one caller (the single-use reveal) and
   * is validated by hand so that no thrown error, from this method or from the
   * shared request path, can ever carry the PAN or CVC. */
  async revealCard(providerCardRef: string): Promise<IssuerCardSecrets> {
    if (this.role !== "api") {
      throw new CardIssuerApiError("card reveal requires the api-role Stripe Issuing credential", 403, false);
    }
    const ref = pathToken(providerCardRef, "providerCardRef");
    const query = new URLSearchParams();
    query.append("expand[]", "number");
    query.append("expand[]", "cvc");
    const payload = await this.request(
      `/v1/issuing/cards/${encodeURIComponent(ref)}?${query}`,
      {},
      { sensitive: true },
    );
    const row = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown> : undefined;
    const pan = row?.number;
    const cvc = row?.cvc;
    const expMonth = row?.exp_month;
    const expYear = row?.exp_year;
    if (!row || row.id !== ref || row.status !== "active"
      || typeof pan !== "string" || !/^[0-9]{12,19}$/.test(pan)
      || typeof cvc !== "string" || !/^[0-9]{3,4}$/.test(cvc)
      || typeof expMonth !== "number" || !Number.isSafeInteger(expMonth) || expMonth < 1 || expMonth > 12
      || typeof expYear !== "number" || !Number.isSafeInteger(expYear) || expYear < 2026 || expYear > 2100) {
      throw new CardIssuerApiError("Stripe Issuing reveal response is not an active card", 200, false);
    }
    return { pan, cvc, expMonth, expYear };
  }

  async getEvent(eventId: string): Promise<IssuerEvent> {
    const id = pathToken(eventId, "eventId");
    const event = parseIssuerEvent(await this.request(`/v1/events/${encodeURIComponent(id)}`));
    if (event.id !== id) throw new Error("Stripe Issuing returned a different event id");
    return event;
  }

  async getAuthorization(providerAuthorizationRef: string): Promise<IssuerAuthorization> {
    const ref = pathToken(providerAuthorizationRef, "providerAuthorizationRef");
    const authorization = parseIssuerAuthorization(
      await this.request(`/v1/issuing/authorizations/${encodeURIComponent(ref)}`),
    );
    if (authorization.id !== ref) throw new Error("Stripe Issuing returned a different authorization id");
    return authorization;
  }

  async getTransaction(providerTransactionRef: string): Promise<IssuerTransaction> {
    const ref = pathToken(providerTransactionRef, "providerTransactionRef");
    const transaction = parseIssuerTransaction(
      await this.request(`/v1/issuing/transactions/${encodeURIComponent(ref)}`),
    );
    if (transaction.id !== ref) throw new Error("Stripe Issuing returned a different transaction id");
    return transaction;
  }
}
