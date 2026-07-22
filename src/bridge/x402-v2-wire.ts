import type { ResourceInfo } from "@x402/core/types";

/**
 * Dependency-free x402 v2 wire helpers: header names, hostile-input decode,
 * and the wire-shape types. Split from x402-v2.ts so the published agent
 * wallet (which only ever DECODES seller challenges — all signing happens
 * server-side in the bridge) does not drag @x402/core, @x402/evm,
 * @x402/extensions, and viem into its dependency tree. The only import here
 * is a type, erased at build.
 */

export const X402_V2_PAYMENT_HEADER = "payment-signature";
export const X402_V2_REQUIRED_HEADER = "payment-required";
export const X402_V2_RESPONSE_HEADER = "payment-response";

export interface X402V2Requirement {
  scheme: string;
  network: `${string}:${string}`;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface X402V2PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: X402V2Requirement[];
  extensions?: Record<string, unknown>;
}

export function encodeX402V2Header(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeX402V2Header<T = unknown>(value: string): T | null {
  try {
    if (!value || value.length > 128 * 1024) return null;
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function decodePaymentRequiredV2(value: string): X402V2PaymentRequired | null {
  const parsed = decodeX402V2Header<X402V2PaymentRequired>(value);
  if (!parsed || parsed.x402Version !== 2 || !parsed.resource
    || !Array.isArray(parsed.accepts) || parsed.accepts.length === 0) return null;
  return parsed;
}
