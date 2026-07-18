/**
 * All amounts are integer micro-dollars: 1_000_000 micros = $1.00.
 * Integers only — floating point never touches money. Micros (not cents)
 * because the network's whole point is high-volume sub-cent transactions.
 */
export type Micros = number;

export const MICROS_PER_DOLLAR = 1_000_000;

export function usd(dollars: number): Micros {
  const micros = Math.round(dollars * MICROS_PER_DOLLAR);
  assertMicros(micros);
  return micros;
}

export function fmt(micros: Micros): string {
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  const dollars = Math.floor(abs / MICROS_PER_DOLLAR);
  const frac = abs % MICROS_PER_DOLLAR;
  if (frac === 0) return `${sign}$${dollars}.00`;
  // Show as many decimals as the amount needs (2 for cents, up to 6 for micros).
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}$${dollars}.${fracStr.length < 2 ? fracStr.padEnd(2, "0") : fracStr}`;
}

export function assertMicros(amount: number): asserts amount is Micros {
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`amount must be an integer number of micros, got ${amount}`);
  }
}

export type AccountKind = "user" | "agent" | "provider" | "external";

export interface Account {
  id: string;
  kind: AccountKind;
  name: string;
  /** Public network address, unique across users, agents, and providers. */
  handle?: string;
  /** Agents and providers may be owned by a user. */
  ownerId?: string;
  /** Account identity: base64 SPKI Ed25519 public key registered at creation.
   *  HTTP requests must be signed by the matching private key. */
  publicKey?: string;
  createdAt: number;
}

/** A paid HTTP service published by a provider on the network. Pricing and
 * endpoint identity live here, outside seller-controlled 402 response text. */
export interface Service {
  id: string;
  providerId: string;
  /** Unique within the provider; public address is @provider/slug. */
  slug: string;
  name: string;
  description: string;
  endpointUrl: string;
  price: Micros;
  active: boolean;
  idempotencyKey: string;
  createdAt: number;
}

export interface Transfer {
  id: string;
  ts: number;
  from: string;
  to: string;
  amount: Micros;
  memo: string;
  idempotencyKey: string;
  mandateId?: string;
  permitId?: string;
  /** For bridge payments the ledger destination is the external:x402
   *  boundary account, but the POLICY payee is the external vendor
   *  ("x402:<host>"). Replay rebuilds mandate counters from this field so
   *  the new-payee throttle state survives restarts exactly. */
  externalPayee?: string;
  /** Present when this transfer returns value from a provider to the payer. */
  refundOf?: string;
}

export interface Mandate {
  id: string;
  /** The human who signed this mandate (in production: passkey ceremony, out-of-band from any agent). */
  userId: string;
  agentId: string;
  budget: Micros;
  perTxCap: Micros;
  dailyCap: Micros;
  /** Amounts above this line require explicit human approval. */
  escalateAbove: Micros;
  /** First-ever payment to an unseen payee is capped here (the injection throttle). */
  newPayeeCap: Micros;
  /** If set, the agent may only pay these account ids. */
  payeeAllowlist?: string[];
  expiresAt: number;
  revoked: boolean;
  /** Client-supplied grant idempotency key: replaying it returns this same
   *  mandate instead of minting a fresh one (a re-granted mandate would reset
   *  the spent counters — a replayed grant must never widen anything). */
  idempotencyKey?: string;
  // Counters — mutated only by PolicyEngine.consume().
  spent: Micros;
  spentToday: Micros;
  /** UTC day (YYYY-MM-DD) the daily counter belongs to. */
  today: string;
  seenPayees: Set<string>;
}

export interface Permit {
  id: string;
  mandateId: string;
  agentId: string;
  payeeId: string;
  amount: Micros;
  issuedAt: number;
  /** Permits are single-use and short-lived: bound to exact payee + amount. */
  expiresAt: number;
  used: boolean;
  /** True when minted by explicit human approval (approval-is-the-mandate). */
  humanApproved: boolean;
}

export type DenialCode =
  | "invalid_amount"
  | "no_mandate"
  | "revoked"
  | "expired"
  | "per_tx_cap"
  | "daily_cap"
  | "budget"
  | "payee_not_allowed"
  | "new_payee_cap"
  | "insufficient_funds"
  | "idempotency_conflict"
  | "permit_invalid"
  | "challenge_invalid"
  | "refund_invalid";

export type Decision =
  | { ok: true; permit: Permit }
  | { ok: false; code: DenialCode; reason: string }
  | { ok: false; code: "escalate"; reason: string; mandateId: string };

export interface Receipt {
  seq: number;
  id: string;
  ts: number;
  transferId: string;
  from: string;
  to: string;
  amount: Micros;
  memo: string;
  mandateId?: string;
  permitId?: string;
  /** External vendor identity ("x402:<host>") — covered by the receipt hash,
   *  so a doctored log cannot repoint who an external payment went to. */
  externalPayee?: string;
  /** Original purchase receipt this refund is economically tied to. */
  refundOf?: string;
  prevHash: string;
  hash: string;
}

/** A pay-per-call charge in the HTTP 402 flow. Single-use: redeemed exactly once. */
export interface Challenge {
  id: string;
  providerId: string;
  /** Present when issued from a registered seller service. */
  serviceId?: string;
  amount: Micros;
  resource: string;
  createdAt: number;
  expiresAt: number;
  paidBy?: string;
  receiptId?: string;
  redeemed: boolean;
}

export type PayResult =
  | { status: "paid"; transfer: Transfer; receipt: Receipt; replayed: boolean }
  | { status: "denied"; code: DenialCode; reason: string }
  | { status: "escalate"; reason: string; mandateId: string };

export type RefundResult =
  | { status: "refunded"; transfer: Transfer; receipt: Receipt; replayed: boolean; remaining: Micros }
  | { status: "denied"; code: DenialCode; reason: string };

/**
 * An external (out-of-loop) x402 purchase. Two-phase: the internal debit
 * happens when the payment header is issued (state "pending"); the payment
 * finalizes when settlement is confirmed, or auto-reverses via the ledger's
 * reversal machinery if no confirmation arrives by reverseAfter. Money that
 * leaves the loop has no in-loop counterparty to claw back from — the
 * pending window is what keeps an unredeemed header from becoming a silent
 * loss.
 */
export interface ExternalPayment {
  id: string;
  agentId: string;
  /** Canonical vendor host; the policy payee is `x402:<host>`. */
  host: string;
  payTo: string;
  asset: string;
  network: string;
  resource: string;
  amount: Micros;
  transferId: string;
  receiptId: string;
  /** Client key that created this payment; replaying it returns this record. */
  idempotencyKey: string;
  /** The exact X-PAYMENT header issued — a replay must return the SAME
   *  credential, never sign a second authorization for the same purchase. */
  paymentHeader: string;
  state: "pending" | "confirmed" | "reversed";
  createdAt: number;
  /** Unconfirmed past this instant → auto-reversed. */
  reverseAfter: number;
  settledTx?: string;
  reversalTransferId?: string;
}

export type ExternalPayResult =
  | { status: "paid"; payment: ExternalPayment; transfer: Transfer; receipt: Receipt; replayed: boolean }
  | { status: "denied"; code: DenialCode; reason: string }
  | { status: "escalate"; reason: string; mandateId: string };
