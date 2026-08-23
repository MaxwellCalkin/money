import type { CardIssuer } from "./issuer.ts";
import { MockIssuer } from "./mock-issuer.ts";
import { StripeIssuingClient } from "./stripe-issuing.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export type CardRevealMode = "none" | "token";
export type CardIssuerRole = "api" | "worker";

function optionalInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

/** MONEY_CARD_WEBHOOK_SECRETS is a JSON array of one to four secrets so a
 * rotation can overlap, exactly like MONEY_COMPLIANCE_WEBHOOK_SECRETS. */
export function parseCardWebhookSecrets(encoded: string | undefined): string[] {
  if (!encoded?.trim()) throw new Error("MONEY_CARD_WEBHOOK_SECRETS is required");
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error("MONEY_CARD_WEBHOOK_SECRETS must be a JSON array");
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 4
    || value.some((secret) => typeof secret !== "string" || secret.length < 24
      || secret.length > 512 || secret.trim() !== secret || /[\r\n]/.test(secret))) {
    throw new Error("MONEY_CARD_WEBHOOK_SECRETS must contain one to four secrets of 24-512 characters");
  }
  return [...new Set(value as string[])];
}

/** PAN custody default. `none` means no reveal surface exists at all; `token`
 * enables the single-use checkout-token reveal for runtimes with host-side
 * fill. There is deliberately no `pan` mode. */
export function readCardRevealMode(env: Environment = process.env): CardRevealMode {
  const value = env.MONEY_CARD_REVEAL_MODE?.trim();
  if (value === undefined || value === "" || value === "none") return "none";
  if (value === "token") return "token";
  throw new Error("MONEY_CARD_REVEAL_MODE must be none or token");
}

export function readCardAuthTtlSeconds(env: Environment = process.env): number {
  return optionalInteger(env.MONEY_CARD_AUTH_TTL_SECONDS, 604_800, 60, 2_592_000, "MONEY_CARD_AUTH_TTL_SECONDS");
}

export function readCardWebhookToleranceSeconds(env: Environment = process.env): number {
  return optionalInteger(
    env.MONEY_CARD_WEBHOOK_TOLERANCE_SECONDS, 300, 30, 600, "MONEY_CARD_WEBHOOK_TOLERANCE_SECONDS",
  );
}

export function readCardOvercaptureBps(env: Environment = process.env): number {
  return optionalInteger(env.MONEY_CARD_OVERCAPTURE_BPS, 0, 0, 2_500, "MONEY_CARD_OVERCAPTURE_BPS");
}

/** Issuer credentials follow the Column three-way split: the API process holds
 * the create/close/reveal key, the event worker holds a read-only event key,
 * and the authorization ingress holds no issuer credential at all — which is
 * why there is no "ingress" role here. The mock issuer is in-process state for
 * the sandbox demo and tests; production preflight refuses it. */
export function createCardIssuerFromEnv(
  env: Environment = process.env,
  options: { role: CardIssuerRole },
): CardIssuer {
  const provider = env.MONEY_CARD_PROVIDER?.trim();
  if (!provider) throw new Error("MONEY_CARD_PROVIDER is required");
  if (options.role !== "api" && options.role !== "worker") {
    throw new Error("card issuer role must be api or worker");
  }
  if (provider === "mock") {
    if (env.NODE_ENV === "production") {
      throw new Error("the mock card issuer is forbidden in production");
    }
    return new MockIssuer();
  }
  if (provider === "stripe-issuing") {
    const baseUrl = env.MONEY_CARD_ISSUER_BASE_URL?.trim();
    if (options.role === "api") {
      const apiKey = env.MONEY_CARD_ISSUER_API_KEY;
      if (!apiKey) {
        throw new Error("MONEY_CARD_ISSUER_API_KEY is required for the stripe-issuing api role");
      }
      const cardholderId = env.MONEY_CARD_STRIPE_CARDHOLDER_ID?.trim();
      if (!cardholderId) {
        throw new Error("MONEY_CARD_STRIPE_CARDHOLDER_ID is required for the stripe-issuing api role");
      }
      return new StripeIssuingClient({
        apiKey,
        role: "api",
        cardholderId,
        ...(baseUrl ? { baseUrl } : {}),
      });
    }
    const apiKey = env.MONEY_CARD_EVENT_API_KEY;
    if (!apiKey) {
      throw new Error("MONEY_CARD_EVENT_API_KEY is required for the stripe-issuing worker role");
    }
    return new StripeIssuingClient({
      apiKey,
      role: "worker",
      ...(baseUrl ? { baseUrl } : {}),
    });
  }
  throw new Error(`unsupported card issuer provider ${provider}`);
}
