import { createHash, webcrypto } from "node:crypto";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements as OfficialPaymentRequirements,
  ResourceInfo,
} from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  PAYMENT_IDENTIFIER,
  appendPaymentIdentifierToExtensions,
  isPaymentIdentifierExtension,
} from "@x402/extensions/payment-identifier";
import type { Eip3009Authorization } from "./x402.ts";
import {
  EXTERNAL_TX_CAP,
  findAllowedAsset,
  requirementToMicros,
  type PaymentRequirements as X402V1Requirement,
  type XPaymentPayload,
} from "./x402.ts";
import { getAddress } from "viem";

export const X402_V2_PAYMENT_HEADER = "payment-signature";
export const X402_V2_REQUIRED_HEADER = "payment-required";
export const X402_V2_RESPONSE_HEADER = "payment-response";

export interface EvmTypedDataSigner {
  readonly address: `0x${string}`;
  signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

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

export interface NormalizedExternalRequirement {
  protocolVersion: 1 | 2;
  requirement: X402V1Requirement | X402V2Requirement;
  amountMicros: bigint;
  network: string;
  asset: string;
  payTo: string;
  resource: ResourceInfo;
  extensions?: Record<string, unknown>;
}

export interface DecodedX402Payment {
  protocolVersion: 1 | 2;
  authorization: Eip3009Authorization;
  signature: string;
  network: string;
  asset?: string;
  accepted?: X402V2Requirement;
  payload: XPaymentPayload | PaymentPayload;
}

export interface SignedX402Payment {
  protocolVersion: 1 | 2;
  paymentHeaderName: "x-payment" | "payment-signature";
  settlementHeaderName: "x-payment-response" | "payment-response";
  header: string;
  authorization: Eip3009Authorization;
  payload: XPaymentPayload | PaymentPayload;
}

export interface X402PaymentSigner {
  readonly address: string;
  createPayment(input: {
    requirement: X402V2Requirement;
    resource: ResourceInfo;
    extensions?: Record<string, unknown>;
    paymentIdentifier: string;
  }): Promise<SignedX402Payment>;
}

function safeText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function resourceInfo(url: string, raw: unknown): ResourceInfo {
  const candidate = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    url,
    ...(safeText(candidate.description, 2_000) ? { description: String(candidate.description) } : {}),
    ...(safeText(candidate.mimeType, 200) ? { mimeType: String(candidate.mimeType) } : {}),
  };
}

/** Validate hostile seller input and replace all economic metadata with pinned values. */
export function normalizeExternalRequirement(input: {
  url: string;
  requirement: unknown;
  x402Version?: unknown;
  resource?: unknown;
  extensions?: unknown;
}): { ok: true; value: NormalizedExternalRequirement } | { ok: false; reason: string } {
  if (!input.requirement || typeof input.requirement !== "object") {
    return { ok: false, reason: "missing payment requirement" };
  }
  const raw = input.requirement as Record<string, unknown>;
  const inferredVersion = input.x402Version === 2 || (typeof raw.amount === "string" && typeof raw.network === "string" && raw.network.includes(":"))
    ? 2 : 1;
  if (input.x402Version !== undefined && input.x402Version !== 1 && input.x402Version !== 2) {
    return { ok: false, reason: "unsupported x402 version" };
  }
  if (inferredVersion === 1) {
    const requirement = raw as unknown as X402V1Requirement;
    const amount = requirementToMicros(requirement);
    if (!amount.ok) return amount;
    return {
      ok: true,
      value: {
        protocolVersion: 1,
        requirement,
        amountMicros: BigInt(amount.micros),
        network: requirement.network,
        asset: requirement.asset,
        payTo: requirement.payTo,
        resource: resourceInfo(input.url, input.resource),
      },
    };
  }

  if (raw.scheme !== "exact") return { ok: false, reason: "unsupported scheme (only exact EIP-3009 is enabled)" };
  if (typeof raw.network !== "string" || !/^eip155:[1-9][0-9]*$/.test(raw.network)) {
    return { ok: false, reason: "x402 v2 EVM network must use a CAIP-2 eip155 identifier" };
  }
  if (typeof raw.asset !== "string" || typeof raw.payTo !== "string") {
    return { ok: false, reason: "x402 v2 requirement is missing asset or payTo" };
  }
  let asset: string;
  let payTo: string;
  try {
    asset = getAddress(raw.asset);
    payTo = getAddress(raw.payTo);
  } catch {
    return { ok: false, reason: "x402 v2 asset and payTo must be canonical EVM addresses" };
  }
  const allowed = findAllowedAsset(raw.network, asset);
  if (!allowed || !allowed.eip712Name || !allowed.eip712Version || allowed.decimals !== 6) {
    return { ok: false, reason: `asset/network not allowlisted: ${raw.network} ${asset}` };
  }
  if (typeof raw.amount !== "string" || !/^[1-9][0-9]{0,14}$/.test(raw.amount)) {
    return { ok: false, reason: "x402 v2 amount must be a positive decimal string of atomic units" };
  }
  const amountMicros = BigInt(raw.amount);
  if (amountMicros > BigInt(EXTERNAL_TX_CAP)) {
    return { ok: false, reason: `amount exceeds the external per-transaction hard cap (${EXTERNAL_TX_CAP} micros)` };
  }
  const rawExtra = raw.extra && typeof raw.extra === "object" && !Array.isArray(raw.extra)
    ? raw.extra as Record<string, unknown> : {};
  if (rawExtra.assetTransferMethod !== undefined && rawExtra.assetTransferMethod !== "eip3009") {
    return { ok: false, reason: "only the audited EIP-3009 transfer method is enabled" };
  }
  if (rawExtra.name !== undefined && rawExtra.name !== allowed.eip712Name) {
    return { ok: false, reason: "seller EIP-712 token name does not match the allowlist" };
  }
  if (rawExtra.version !== undefined && rawExtra.version !== allowed.eip712Version) {
    return { ok: false, reason: "seller EIP-712 token version does not match the allowlist" };
  }
  const timeout = raw.maxTimeoutSeconds === undefined ? 60 : Number(raw.maxTimeoutSeconds);
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 600) {
    return { ok: false, reason: "maxTimeoutSeconds must be an integer from 10 to 600" };
  }
  const requirement: X402V2Requirement = {
    scheme: "exact",
    network: raw.network as `${string}:${string}`,
    amount: raw.amount,
    asset,
    payTo,
    maxTimeoutSeconds: timeout,
    extra: {
      assetTransferMethod: "eip3009",
      name: allowed.eip712Name,
      version: allowed.eip712Version,
    },
  };
  const extensionRecord = input.extensions && typeof input.extensions === "object" && !Array.isArray(input.extensions)
    ? input.extensions as Record<string, unknown> : undefined;
  const extensions = clonePaymentIdentifierExtension(extensionRecord);
  return {
    ok: true,
    value: {
      protocolVersion: 2,
      requirement,
      amountMicros,
      network: requirement.network,
      asset: requirement.asset,
      payTo: requirement.payTo,
      resource: resourceInfo(input.url, input.resource),
      ...(extensions ? { extensions } : {}),
    },
  };
}

function clonePaymentIdentifierExtension(
  extensions: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const declaration = extensions?.[PAYMENT_IDENTIFIER];
  if (!isPaymentIdentifierExtension(declaration)) return undefined;
  // Never echo arbitrary seller extensions through a privileged treasury
  // signer. The retry identifier is the only v2 extension enabled here.
  return {
    [PAYMENT_IDENTIFIER]: JSON.parse(JSON.stringify(declaration)) as unknown,
  };
}

export function stablePaymentIdentifier(agentId: string, idempotencyKey: string): string {
  return "pay_" + createHash("sha256")
    .update(`${agentId}\0${idempotencyKey}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function authorizationFromPayload(payload: PaymentPayload): Eip3009Authorization {
  const raw = payload.payload as { authorization?: Record<string, unknown> };
  const auth = raw.authorization;
  if (!auth || typeof auth.from !== "string" || typeof auth.to !== "string"
    || typeof auth.value !== "string" || typeof auth.validAfter !== "string"
    || typeof auth.validBefore !== "string" || typeof auth.nonce !== "string") {
    throw new Error("x402 v2 signer returned a non-EIP-3009 payment payload");
  }
  return {
    from: auth.from,
    to: auth.to,
    value: auth.value,
    validAfter: auth.validAfter,
    validBefore: auth.validBefore,
    nonce: auth.nonce,
  };
}

/** Official x402 v2 exact/EVM payload construction over a replaceable signer. */
export class X402V2EvmPaymentSigner implements X402PaymentSigner {
  readonly address: string;
  private readonly client: x402Client;
  private readonly http: x402HTTPClient;

  constructor(signer: EvmTypedDataSigner) {
    this.address = signer.address;
    this.client = new x402Client();
    this.client.register("eip155:*", new ExactEvmScheme(signer));
    this.http = new x402HTTPClient(this.client);
  }

  async createPayment(input: {
    requirement: X402V2Requirement;
    resource: ResourceInfo;
    extensions?: Record<string, unknown>;
    paymentIdentifier: string;
  }): Promise<SignedX402Payment> {
    // @x402/evm uses the browser WebCrypto API for EIP-3009 nonces. Node 20+
    // exposes it globally, while older supported test hosts may require the
    // equivalent node:crypto implementation to be installed explicitly.
    if (!globalThis.crypto) {
      Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
    }
    const extensions = clonePaymentIdentifierExtension(input.extensions);
    if (extensions) appendPaymentIdentifierToExtensions(extensions, input.paymentIdentifier);
    const required: PaymentRequired = {
      x402Version: 2,
      resource: input.resource,
      accepts: [input.requirement as OfficialPaymentRequirements],
      ...(extensions ? { extensions } : {}),
    };
    const payload = await this.client.createPaymentPayload(required);
    const headers = this.http.encodePaymentSignatureHeader(payload);
    const header = headers["PAYMENT-SIGNATURE"] ?? headers["payment-signature"];
    if (!header) throw new Error("x402 v2 client did not produce a PAYMENT-SIGNATURE header");
    return {
      protocolVersion: 2,
      paymentHeaderName: X402_V2_PAYMENT_HEADER,
      settlementHeaderName: X402_V2_RESPONSE_HEADER,
      header,
      authorization: authorizationFromPayload(payload),
      payload,
    };
  }
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

export function decodePaymentPayloadV2(value: string): PaymentPayload | null {
  const parsed = decodeX402V2Header<PaymentPayload>(value);
  if (!parsed || parsed.x402Version !== 2 || !parsed.resource || !parsed.accepted || !parsed.payload) return null;
  return parsed;
}

export function decodedV2Payment(value: string): DecodedX402Payment | null {
  const payload = decodePaymentPayloadV2(value);
  if (!payload) return null;
  const accepted = payload.accepted as X402V2Requirement;
  const body = payload.payload as { signature?: unknown; authorization?: Record<string, unknown> };
  const auth = body.authorization;
  if (accepted.scheme !== "exact" || typeof accepted.network !== "string"
    || typeof accepted.asset !== "string" || typeof accepted.amount !== "string"
    || typeof accepted.payTo !== "string" || typeof body.signature !== "string" || !auth
    || typeof auth.from !== "string" || typeof auth.to !== "string" || typeof auth.value !== "string"
    || typeof auth.validAfter !== "string" || typeof auth.validBefore !== "string" || typeof auth.nonce !== "string") {
    return null;
  }
  return {
    protocolVersion: 2,
    authorization: {
      from: auth.from,
      to: auth.to,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
    },
    signature: body.signature,
    network: accepted.network,
    asset: accepted.asset,
    accepted,
    payload,
  };
}
