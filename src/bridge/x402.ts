import { randomBytes } from "node:crypto";
import { usd, type Micros } from "../core/types.ts";
import type { ExternalWallet } from "./wallet.ts";

/**
 * x402 protocol v1 wire format (per the coinbase/x402 spec: 402 JSON body +
 * base64 X-PAYMENT header carrying an EIP-3009 authorization). v2 (Dec 2025)
 * moves the 402 payload into a PAYMENT-REQUIRED header, renames the header
 * to PAYMENT-SIGNATURE, and switches networks to CAIP-2 ids — the bridge
 * targets v1 (the widely deployed format) and treats v2 as a follow-up.
 *
 * Everything in a 402 response is attacker-controlled. The bridge trusts
 * NONE of it economically: (network, asset) must match the server-side
 * allowlist below (which pins decimals), the amount is parsed and capped
 * here, and the owner's mandate is the final authority on every spend.
 */

export interface PaymentRequirements {
  scheme: string;
  /** v1 network slug, e.g. "base-sepolia"; "mock-local" is our test rail. */
  network: string;
  /** Atomic token units as a decimal string (uint256-as-string). */
  maxAmountRequired: string;
  /** ERC-20 contract address of the payment token. */
  asset: string;
  payTo: string;
  resource: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  /** For exact/EVM: the token contract's EIP-712 domain name + version. */
  extra?: { name?: string; version?: string };
}

export interface PaymentRequired402 {
  x402Version: number;
  error?: string;
  accepts: PaymentRequirements[];
}

/** EIP-3009 TransferWithAuthorization message — all values are strings. */
export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface XPaymentPayload {
  x402Version: 1;
  scheme: string;
  network: string;
  payload: { signature: string; authorization: Eip3009Authorization };
}

/** X-PAYMENT-RESPONSE settlement result (base64 JSON on the 200). */
export interface SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer: string;
  errorReason?: string;
}

// ── Server-side economic pinning ────────────────────────────────────────────

export interface AllowedAsset {
  network: string;
  asset: string;
  symbol: string;
  /** Must be 6 for the 1:1 atomic-units→micro-dollars peg to hold. */
  decimals: number;
}

/**
 * The ONLY (network, asset) pairs the bridge will pay. Decimals are pinned
 * here, never read from the 402 body — a 2-decimal token would make "$1"
 * parse as $0.0001. USDC has 6 decimals everywhere, so atomic units ARE
 * micro-dollars. Base Sepolia address is from the x402 spec examples.
 */
export const ASSET_ALLOWLIST: AllowedAsset[] = [
  { network: "mock-local", asset: "0x00000000000000000000000000000000000c0ffe", symbol: "USDC", decimals: 6 },
  { network: "base-sepolia", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6 },
];

/** No single external purchase above this, whatever the mandate says. */
export const EXTERNAL_TX_CAP: Micros = usd(10);

const MAX_TIMEOUT_SECONDS_CAP = 600;

export function findAllowedAsset(network: string, asset: string): AllowedAsset | undefined {
  return ASSET_ALLOWLIST.find(
    (a) => a.network === network && a.asset.toLowerCase() === String(asset).toLowerCase()
  );
}

/**
 * Validate a requirement and derive the internal charge from it. Returns a
 * reason string on rejection — never a partial parse.
 */
export function requirementToMicros(req: PaymentRequirements): { ok: true; micros: Micros } | { ok: false; reason: string } {
  if (!req || typeof req !== "object") return { ok: false, reason: "missing payment requirement" };
  if (req.scheme !== "exact") return { ok: false, reason: `unsupported scheme "${req.scheme}" (only "exact")` };
  if (typeof req.payTo !== "string" || !req.payTo) return { ok: false, reason: "missing payTo" };
  const allowed = findAllowedAsset(req.network, req.asset);
  if (!allowed) return { ok: false, reason: `asset/network not allowlisted: ${req.network} ${req.asset}` };
  if (allowed.decimals !== 6) return { ok: false, reason: "only 6-decimal assets map to micro-dollars" };
  if (typeof req.maxAmountRequired !== "string" || !/^\d{1,15}$/.test(req.maxAmountRequired)) {
    return { ok: false, reason: "maxAmountRequired must be a decimal string of atomic units" };
  }
  const micros = Number(req.maxAmountRequired);
  if (micros <= 0) return { ok: false, reason: "amount must be positive" };
  if (micros > EXTERNAL_TX_CAP) {
    return { ok: false, reason: `amount exceeds the external per-transaction hard cap (${EXTERNAL_TX_CAP} micros)` };
  }
  return { ok: true, micros };
}

/** Canonical vendor host for policy purposes — lowercased, no port, no
 *  trailing dot, so case/port/dot variants can't each get a fresh
 *  new-payee allowance. (Subdomain rotation remains; noted in docs.) */
export function canonicalHostOf(url: string): { ok: true; host: string } | { ok: false; reason: string } {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "url must be http(s)" };
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    if (!host) return { ok: false, reason: "url has no host" };
    return { ok: true, host };
  } catch {
    return { ok: false, reason: "invalid url" };
  }
}

// ── Wire encoding ───────────────────────────────────────────────────────────

export function buildXPayment(
  wallet: ExternalWallet,
  req: PaymentRequirements,
  nowMs: number
): { header: string; authorization: Eip3009Authorization } {
  const nowSec = Math.floor(nowMs / 1000);
  const timeout = Math.min(Math.max(Number(req.maxTimeoutSeconds) || 60, 10), MAX_TIMEOUT_SECONDS_CAP);
  const authorization: Eip3009Authorization = {
    from: wallet.address,
    to: req.payTo,
    value: req.maxAmountRequired,
    validAfter: String(nowSec - 600),
    validBefore: String(nowSec + timeout),
    nonce: "0x" + randomBytes(32).toString("hex"),
  };
  const signature = wallet.signAuthorization(authorization, {
    name: req.extra?.name ?? "USDC",
    version: req.extra?.version ?? "2",
    network: req.network,
    asset: req.asset,
  });
  const payload: XPaymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: req.network,
    payload: { signature, authorization },
  };
  return { header: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"), authorization };
}

export function decodeXPayment(header: string): XPaymentPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as XPaymentPayload;
    if (parsed?.x402Version !== 1 || !parsed.payload?.authorization || !parsed.payload.signature) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function encodeSettlement(res: SettlementResponse): string {
  return Buffer.from(JSON.stringify(res), "utf8").toString("base64");
}

export function decodeSettlement(header: string): SettlementResponse | null {
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as SettlementResponse;
    if (typeof parsed?.success !== "boolean") return null;
    return parsed;
  } catch {
    return null;
  }
}
