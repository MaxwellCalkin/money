import type { Context, Next } from "hono";
import {
  configuredHttpOrigin,
  DEFAULT_CLIENT_TIMEOUT_MS,
} from "../core/api-client.ts";
import { readBoundedResponseText } from "../core/bounded-response.ts";
import { signedHeaders } from "../core/identity.ts";

const MAX_NETWORK_RESPONSE_BYTES = 256 * 1024;

export interface MoneySellerClientOptions {
  /** Hosted money-network API, e.g. https://api.money.example. */
  networkUrl: string;
  providerId: string;
  /** Base64 PKCS#8 Ed25519 key registered on the provider account. */
  providerKey: string;
  /** Request deadline for calls to the payment network. */
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

/** Small provider-side SDK. It keeps signing out of route handlers and gives
 * sellers one authenticated client for challenges, redemptions, and refunds. */
export function createMoneySellerClient(options: MoneySellerClientOptions) {
  const networkUrl = configuredHttpOrigin(options.networkUrl, "seller payment network URL");
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("seller payment network timeout must be 100-60000ms");
  }

  const post = async (
    path: string,
    value: unknown
  ): Promise<SellerNetworkResponse> => {
    const body = JSON.stringify(value);
    try {
      const response = await doFetch(`${networkUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...signedHeaders(
            options.providerId,
            options.providerKey,
            { method: "POST", path, body },
            "x-provider-id"
          ),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      try {
        const responseBody = await readBoundedResponseText(
          response,
          MAX_NETWORK_RESPONSE_BYTES,
          "payment network response is too large",
        );
        const parsed = JSON.parse(responseBody) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("payment network response must be an object");
        }
        return { status: response.status, body: parsed as NetworkJson };
      } catch {
        return { status: 502, body: { error: "invalid_network_response" } };
      }
    } catch (err) {
      return {
        status: 503,
        body: { error: "payment_network_unavailable", reason: (err as Error).message },
      };
    }
  };

  return {
    challenge: (serviceId: string) => post("/merchant/challenges", { serviceId }),
    redeem: (serviceId: string, challengeId: string, receiptId: string) =>
      post("/merchant/redeem", { serviceId, challengeId, receiptId }),
    refund: (input: { receiptId: string; amountMicros: number; memo?: string; idempotencyKey: string }) =>
      post("/refunds", input),
  };
}

/**
 * Hono middleware for an independently operated paid endpoint.
 *
 * The seller never invents a price in its 402 response. It asks the network
 * to issue a challenge from the registered service terms, then asks the
 * network to redeem the agent's receipt before serving the resource.
 */
export function moneyPaid(options: MoneySellerOptions) {
  const client = createMoneySellerClient(options);

  return async (c: Context, next: Next) => {
    const challengeId = c.req.header("x-payment-challenge");
    const receiptId = c.req.header("x-payment-receipt");

    if (challengeId || receiptId) {
      if (!challengeId || !receiptId) {
        return c.json({ error: "payment_rejected", reason: "both payment challenge and receipt are required" }, 402);
      }
      const redeemed = await client.redeem(options.serviceId, challengeId, receiptId);
      if (redeemed.status === 200 && redeemed.body.ok === true) {
        await next();
        return;
      }
      if (redeemed.status !== 402) {
        return c.json({ error: "payment_network_unavailable", detail: redeemed.body }, 503);
      }
      return c.json({ error: "payment_rejected", reason: redeemed.body.reason ?? "receipt was not accepted" }, 402);
    }

    const challenge = await client.challenge(options.serviceId);
    if (challenge.status !== 402) {
      return c.json({ error: "payment_network_unavailable", detail: challenge.body }, 503);
    }
    return c.json(challenge.body, 402);
  };
}
