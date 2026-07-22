// Hand-written declarations for dist/index.js (built from src/seller/index.ts
// by scripts/build-packages.mjs). test/packages-build.test.ts pins the export
// surface of this file against the source module — update both together.
//
// hono is an optional peer used only by moneyPaid, so these declarations must
// not import from it: a type-only import still has to resolve, and a consumer
// using only createMoneySellerClient (no hono installed, skipLibCheck off)
// would fail with TS2307. The middleware is typed against minimal structural
// interfaces instead; Hono's real Context/Next satisfy them, so moneyPaid
// remains directly usable as Hono middleware.

/** Structural subset of hono's Context that the paywall middleware uses. */
export interface MoneyPaidContext {
  req: { header(name: string): string | undefined };
  json(body: unknown, status?: number): Response;
}

export type MoneyPaidNext = () => Promise<void>;

export interface MoneySellerClientOptions {
  /** Hosted money-network API origin, e.g. https://api.money.example. */
  networkUrl: string;
  providerId: string;
  /** Base64 PKCS#8 Ed25519 key registered on the provider account. */
  providerKey: string;
  /** Request deadline in milliseconds for calls to the payment network (100-60000). */
  timeoutMs?: number;
  /** Injectable for tests and non-standard runtimes. */
  fetch?: typeof globalThis.fetch;
}

export interface MoneySellerOptions extends MoneySellerClientOptions {
  serviceId: string;
}

export type NetworkJson = Record<string, unknown>;

export interface SellerNetworkResponse {
  status: number;
  body: NetworkJson;
}

export interface MoneySellerClient {
  challenge(serviceId: string): Promise<SellerNetworkResponse>;
  redeem(serviceId: string, challengeId: string, receiptId: string): Promise<SellerNetworkResponse>;
  refund(input: {
    receiptId: string;
    amountMicros: number;
    memo?: string;
    idempotencyKey: string;
  }): Promise<SellerNetworkResponse>;
}

/** One authenticated client for challenges, redemptions, and refunds; keeps
 * request signing out of route handlers. */
export function createMoneySellerClient(options: MoneySellerClientOptions): MoneySellerClient;

/** Hono middleware for a paid endpoint. The network issues the challenge from
 * the registered service terms and redeems the agent's receipt before the
 * resource is served — the seller never invents a price. */
export function moneyPaid(options: MoneySellerOptions): (c: MoneyPaidContext, next: MoneyPaidNext) => Promise<Response | void>;

/** Resolve a secret from NAME or NAME_FILE (first non-empty line of the file),
 * e.g. MONEY_PROVIDER_KEY / MONEY_PROVIDER_KEY_FILE. */
export function secretFromEnv(
  name: string,
  env?: Readonly<Record<string, string | undefined>>,
): string | undefined;
