import { decodePaymentRequiredV2, type X402V2PaymentRequired } from "../bridge/x402-v2-wire.ts";

export interface ExternalPaymentDemand {
  protocolVersion: 1 | 2;
  requirement: Record<string, unknown>;
  resource?: unknown;
  extensions?: unknown;
}

export type ExternalPaymentDemandResult =
  | { ok: true; demand: ExternalPaymentDemand }
  | { ok: false; reason: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exact(accepts: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(accepts)) return undefined;
  return accepts.map(record).find((candidate) => candidate?.scheme === "exact");
}

/** Parse an untrusted seller challenge. A present v2 header is authoritative:
 * malformed v2 data is never silently downgraded to a v1 JSON body. */
export function parseExternalPaymentDemand(
  paymentRequiredHeader: string | null | undefined,
  body: unknown,
): ExternalPaymentDemandResult {
  if (paymentRequiredHeader !== null && paymentRequiredHeader !== undefined) {
    const required = decodePaymentRequiredV2(paymentRequiredHeader);
    if (!required) return { ok: false, reason: "seller sent a malformed PAYMENT-REQUIRED header" };
    const requirement = exact(required.accepts);
    if (!requirement) return { ok: false, reason: "external x402 v2 challenge offers no supported exact payment" };
    return {
      ok: true,
      demand: {
        protocolVersion: 2,
        requirement,
        resource: required.resource,
        ...(required.extensions ? { extensions: required.extensions } : {}),
      },
    };
  }

  const candidate = record(body);
  const requirement = exact(candidate?.accepts);
  if (!requirement) return { ok: false, reason: "server demanded payment but sent no supported x402 exact challenge" };
  if (candidate?.x402Version === 2) {
    const required = candidate as unknown as X402V2PaymentRequired;
    if (!required.resource) return { ok: false, reason: "x402 v2 challenge is missing resource metadata" };
    return {
      ok: true,
      demand: {
        protocolVersion: 2,
        requirement,
        resource: required.resource,
        ...(required.extensions ? { extensions: required.extensions } : {}),
      },
    };
  }
  if (candidate?.x402Version !== undefined && candidate.x402Version !== 1) {
    return { ok: false, reason: "seller requested an unsupported x402 version" };
  }
  return { ok: true, demand: { protocolVersion: 1, requirement } };
}
