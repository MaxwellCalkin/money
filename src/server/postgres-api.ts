import { serve } from "@hono/node-server";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Hono, type Context, type Next } from "hono";
import { CardIssuerApiError, type CardIssuer } from "../cards/issuer.ts";
import { createCardIssuerFromEnv, readCardAuthTtlSeconds, readCardRevealMode } from "../cards/runtime.ts";
import { enforceProductionPreflight } from "../deploy/preflight.ts";
import {
  decryptPaymentHeaderWithKeyring,
  encryptPaymentHeaderWithKeyring,
  parseExternalHeaderKey,
  parseExternalHeaderKeyring,
  singleExternalHeaderKeyring,
  type ExternalAuthorizationBinding,
  type ExternalHeaderKeyring,
} from "../bridge/cipher.ts";
import {
  buildXPayment,
  canonicalHostOf,
  decodeSettlement,
  decodeXPayment,
  requirementToMicros,
  type PaymentRequirements,
  type SettlementResponse,
  type XPaymentPayload,
} from "../bridge/x402.ts";
import {
  X402V2EvmPaymentSigner,
  decodedV2Payment,
  normalizeExternalRequirement,
  stablePaymentIdentifier,
  type DecodedX402Payment,
  type NormalizedExternalRequirement,
  type SignedX402Payment,
  type X402PaymentSigner,
  type X402V2Requirement,
} from "../bridge/x402-v2.ts";
import { HttpEvmSigner, LocalEvmSigner } from "../bridge/evm-wallet.ts";
import { EvmRpcSettlementVerifier, parseEvmRpcNetworks } from "../bridge/evm-settlement.ts";
import { MockWallet, type ExternalWallet } from "../bridge/wallet.ts";
import { isValidPublicKey, verifyRequest } from "../core/identity.ts";
import {
  decryptHostedVerificationUrl,
  parseComplianceSessionKeyring,
  type ComplianceSessionKeyring,
} from "../compliance/session-cipher.ts";
import { isValidHandle, isValidServiceSlug, normalizeServiceSlug } from "../core/network.ts";
import {
  PostgresCards,
  type CardCommandResult,
  type DatabaseCard,
  type DatabaseCardAuthorization,
} from "../db/cards.ts";
import type { DatabaseAccount } from "../db/ledger.ts";
import { PostgresLedger, type DatabaseTransferResult } from "../db/ledger.ts";
import { PostgresControlPlane, type AccountBalance, type DatabaseService, type PaymentEvidence } from "../db/control-plane.ts";
import { PostgresCompliance, type ComplianceSubject } from "../db/compliance.ts";
import type { TransactionalDatabase } from "../db/database.ts";
import {
  PostgresExternal,
  type DatabaseExternalPayment,
  type DatabaseExternalPaymentSecret,
  type ExternalCommandResult,
} from "../db/external.ts";
import { PostgresMarketplace, type DatabaseChallenge } from "../db/marketplace.ts";
import { runMigrations } from "../db/migrate.ts";
import { PostgresPolicy, type DatabaseApproval, type DatabaseMandate, type PolicyPaymentResult } from "../db/policy.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import {
  PostgresTreasury,
  type TreasuryControls,
  type TreasuryDestination,
  type TreasuryExposure,
  type TreasuryFunding,
  type TreasuryPayout,
  type TreasuryRoute,
} from "../db/treasury.ts";
import { ownerAppHtml } from "./owner-app.ts";
import { listenHost } from "./listen.ts";

const AUTH_WINDOW_MS = 2 * 60_000;
const CLOCK_SKEW_MS = 30_000;
const MAX_SIGNED_BODY_BYTES = 256 * 1024;

type ApiEnv = { Variables: { agentId: string; userId: string; providerId: string } };
type IdentityKind = "user" | "agent" | "provider";

export interface PostgresApiOptions {
  /** Local demos only. Real top-ups arrive through the separate treasury role. */
  allowDevelopmentFunding?: boolean;
  /** SANDBOX ONLY. Lets an owner session (bearer token) call /fund, /allocate,
   * /mandates, and /mandates/:id/revoke so the local owner app is one-tap.
   * Production preflight refuses this flag unconditionally: in production those
   * routes accept only owner-signed (Ed25519) requests, so a stolen session can
   * never move funds or widen authority. */
  allowSessionOwnerWrites?: boolean;
  /** When non-empty, POST /users requires a matching inviteCode. The hosted
   * beta hands invites to recruited pilots instead of exposing an open,
   * rate-limitable signup surface to the internet. */
  signupInvites?: string[];
  /** All three external options are required; otherwise x402 routes fail closed. */
  externalWallet?: ExternalWallet;
  externalHeaderKey?: Uint8Array;
  externalHeaderKeyring?: ExternalHeaderKeyring;
  /** Production x402 v2 signer, normally backed by a remote HSM service. */
  externalPaymentSigner?: X402PaymentSigner;
  verifyExternalSettlement?: ExternalSettlementVerifier;
  /** Product-side decryption only; provider credentials remain in the worker. */
  complianceSessionKeyring?: ComplianceSessionKeyring;
  complianceProviderName?: string;
  /** Card rail: the issuer adapter held by the API process (the create/close/
   * reveal credential). Card issuance fails closed with 503 without it. */
  cardIssuer?: CardIssuer;
  /** PAN custody. `none` (default) exposes no reveal surface at all; `token`
   * enables the single-use checkout-token reveal for host-side fill. */
  cardRevealMode?: "none" | "token";
  /** Required in `token` mode: keys the at-rest hash of checkout tokens. */
  cardRevealTokenKey?: Uint8Array;
  cardAuthTtlSeconds?: number;
  now?: () => number;
}

/** Hash both sides so the comparison is constant-time regardless of code
 * length; invite codes are hand-issued opaque strings, not derived secrets. */
function inviteCodeMatches(invites: readonly string[], supplied: string): boolean {
  const suppliedHash = createHash("sha256").update(supplied, "utf8").digest();
  let matched = false;
  for (const invite of invites) {
    if (timingSafeEqual(createHash("sha256").update(invite, "utf8").digest(), suppliedHash)) {
      matched = true;
    }
  }
  return matched;
}

/** MONEY_SIGNUP_INVITES is a JSON array of 8-128 char opaque codes. */
export function parseSignupInvites(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MONEY_SIGNUP_INVITES must be a JSON array of invite codes");
  }
  if (!Array.isArray(parsed) || parsed.length > 256
    || !parsed.every((code) => typeof code === "string" && code.length >= 8 && code.length <= 128)) {
    throw new Error("MONEY_SIGNUP_INVITES must be a JSON array of 8-128 character invite codes (max 256)");
  }
  return parsed as string[];
}

export interface ExternalSettlementVerificationInput {
  payment: DatabaseExternalPaymentSecret;
  paymentHeader: string;
  authorization: DecodedX402Payment;
  settlement: SettlementResponse;
}

export type ExternalSettlementVerifier = (
  input: ExternalSettlementVerificationInput
) => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };

function databaseCode(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === "object"; depth += 1) {
    const candidate = cursor as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    cursor = candidate.cause;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "request failed";
}

function jsonInteger(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

function formatMicros(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const dollars = absolute / 1_000_000n;
  const rawFraction = (absolute % 1_000_000n).toString().padStart(6, "0");
  const fraction = rawFraction.replace(/0+$/, "").padEnd(2, "0");
  return `${sign}$${dollars}.${fraction}`;
}

function positiveMicros(value: unknown): bigint | undefined {
  try {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) return undefined;
    if (typeof value === "string" && !/^[1-9][0-9]*$/.test(value)) return undefined;
    if (typeof value !== "number" && typeof value !== "string") return undefined;
    const amount = BigInt(value);
    return amount > 0n ? amount : undefined;
  } catch {
    return undefined;
  }
}

function nonnegativeMicros(value: unknown): bigint | undefined {
  try {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return undefined;
    if (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
    if (typeof value !== "number" && typeof value !== "string") return undefined;
    const amount = BigInt(value);
    return amount >= 0n ? amount : undefined;
  } catch {
    return undefined;
  }
}

function validClientKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && !value.startsWith("chl_") && !value.startsWith("rev_");
}

function validUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function accountView(account: DatabaseAccount | AccountBalance) {
  return {
    id: account.id,
    kind: account.kind,
    ...(account.ownerId ? { ownerId: account.ownerId } : {}),
    name: account.name,
    ...(account.handle ? { handle: account.handle } : {}),
    status: account.status,
    createdAt: account.createdAt.getTime(),
    ...(Object.hasOwn(account, "balanceMicros")
      ? { balanceMicros: jsonInteger((account as AccountBalance).balanceMicros) }
      : {}),
  };
}

function mandateView(mandate: DatabaseMandate) {
  return {
    id: mandate.id,
    userId: mandate.userId,
    agentId: mandate.agentId,
    budget: jsonInteger(mandate.budgetMicros),
    perTxCap: jsonInteger(mandate.perTxCapMicros),
    dailyCap: jsonInteger(mandate.dailyCapMicros),
    escalateAbove: jsonInteger(mandate.escalateAboveMicros),
    newPayeeCap: jsonInteger(mandate.newPayeeCapMicros),
    ...(mandate.payeeAllowlist ? { payeeAllowlist: mandate.payeeAllowlist } : {}),
    spent: jsonInteger(mandate.spentMicros),
    spentToday: jsonInteger(mandate.spentTodayMicros),
    today: mandate.spendDay,
    expiresAt: mandate.expiresAt.getTime(),
    revoked: Boolean(mandate.revokedAt),
    idempotencyKey: mandate.idempotencyKey,
    createdAt: mandate.createdAt.getTime(),
  };
}

function challengeView(challenge: DatabaseChallenge) {
  return {
    id: challenge.id,
    providerId: challenge.providerId,
    ...(challenge.serviceId ? { serviceId: challenge.serviceId } : {}),
    asset: challenge.asset,
    amountMicros: jsonInteger(challenge.amountMicros),
    amountDisplay: formatMicros(challenge.amountMicros),
    resource: challenge.resource,
    ...(challenge.claimedBy ? { claimedBy: challenge.claimedBy } : {}),
    ...(challenge.paidBy ? { paidBy: challenge.paidBy } : {}),
    ...(challenge.receiptId ? { receiptId: challenge.receiptId } : {}),
    expiresAt: challenge.expiresAt.getTime(),
    redeemed: Boolean(challenge.redeemedAt),
    ...(challenge.redeemedAt ? { redeemedAt: challenge.redeemedAt.getTime() } : {}),
    createdAt: challenge.createdAt.getTime(),
  };
}

function externalView(payment: DatabaseExternalPayment) {
  return {
    id: payment.id,
    agentId: payment.agentId,
    state: payment.state,
    host: payment.host,
    payTo: payment.payTo,
    settlementAsset: payment.settlementAsset,
    settlementNetwork: payment.settlementNetwork,
    resource: payment.resource,
    policyPayee: payment.policyPayee,
    amountMicros: jsonInteger(payment.amountMicros),
    amountDisplay: formatMicros(payment.amountMicros),
    ...(payment.transferId ? { transferId: payment.transferId } : {}),
    ...(payment.receiptId ? { receiptId: payment.receiptId } : {}),
    ...(payment.approvalId ? { approvalId: payment.approvalId } : {}),
    ...(payment.authorizationExpiresAt ? { authorizationExpiresAt: payment.authorizationExpiresAt.getTime() } : {}),
    ...(payment.reverseAfter ? { reverseAfter: payment.reverseAfter.getTime() } : {}),
    ...(payment.settledTx ? { settledTx: payment.settledTx } : {}),
    ...(payment.reversalTransferId ? { reversalTransferId: payment.reversalTransferId } : {}),
    createdAt: payment.createdAt.getTime(),
    updatedAt: payment.updatedAt.getTime(),
  };
}

const CARD_MERCHANT_HINT_PATTERN = /^[a-z0-9][a-z0-9.-]{0,99}$/;
const MAX_CARD_CAP_MICROS = 10_000_000_000n;
const DEFAULT_CARD_LIFETIME_SECONDS = 3_600;
const MAX_CARD_LIFETIME_SECONDS = 30 * 86_400;
const CHECKOUT_TOKEN_TTL_SECONDS = 600;

/** Owner- and agent-facing card view. Deliberately excludes the issuer's
 * provider card reference and transfer seqs; the PAN itself never reaches this
 * process outside the single-use reveal path. */
function cardView(card: DatabaseCard) {
  return {
    id: card.id,
    agentId: card.agentId,
    mandateId: card.mandateId,
    state: card.state,
    capMicros: jsonInteger(card.capMicros),
    capDisplay: formatMicros(card.capMicros),
    heldMicros: jsonInteger(card.heldMicros),
    settledMicros: jsonInteger(card.settledMicros),
    singleUse: card.singleUse,
    merchantHint: card.merchantHint,
    policyPayee: card.policyPayee,
    ...(card.lockedPayee ? { lockedPayee: card.lockedPayee } : {}),
    ...(card.mccAllowlist ? { mccAllowlist: card.mccAllowlist } : {}),
    ...(card.last4 ? { last4: card.last4 } : {}),
    ...(card.expMonth !== undefined ? { expMonth: card.expMonth } : {}),
    ...(card.expYear !== undefined ? { expYear: card.expYear } : {}),
    expiresAt: card.expiresAt.getTime(),
    ...(card.approvalId ? { approvalId: card.approvalId } : {}),
    ...(card.receiptId ? { receiptId: card.receiptId } : {}),
    revealCount: card.revealCount,
    ...(card.closeRequestedAt ? { closeRequestedAt: card.closeRequestedAt.getTime() } : {}),
    ...(card.closeReason ? { closeReason: card.closeReason } : {}),
    createdAt: card.createdAt.getTime(),
    updatedAt: card.updatedAt.getTime(),
  };
}

function cardAuthorizationView(item: DatabaseCardAuthorization) {
  return {
    id: item.id,
    cardId: item.cardId,
    state: item.state,
    policyPayee: item.policyPayee,
    merchantDescriptor: item.merchantDescriptor,
    merchantMcc: item.merchantMcc,
    ...(item.merchantNetworkId ? { merchantNetworkId: item.merchantNetworkId } : {}),
    ...(item.merchantCountry ? { merchantCountry: item.merchantCountry } : {}),
    amountMicros: jsonInteger(item.amountMicros),
    amountDisplay: formatMicros(item.amountMicros),
    isVerification: item.isVerification,
    ...(item.settledMicros !== undefined ? { settledMicros: jsonInteger(item.settledMicros) } : {}),
    ...(item.declineCode ? { declineCode: item.declineCode } : {}),
    createdAt: item.createdAt.getTime(),
    updatedAt: item.updatedAt.getTime(),
  };
}

function treasuryPayoutView(item: TreasuryPayout) {
  return {
    id: item.id,
    destinationId: item.destinationId,
    provider: item.provider,
    asset: item.asset,
    amountMicros: jsonInteger(item.amountMicros),
    amountDisplay: formatMicros(item.amountMicros),
    state: item.state,
    attempts: item.attempts,
    ...(item.providerTransferId ? { providerTransferId: item.providerTransferId } : {}),
    ...(item.lastError ? { lastError: item.lastError } : {}),
    requestedAt: item.requestedAt.getTime(),
    ...(item.submittedAt ? { submittedAt: item.submittedAt.getTime() } : {}),
    ...(item.settledAt ? { settledAt: item.settledAt.getTime() } : {}),
    ...(item.terminalAt ? { terminalAt: item.terminalAt.getTime() } : {}),
  };
}

function treasuryFundingView(item: TreasuryFunding) {
  return {
    id: item.id, provider: item.provider, asset: item.asset,
    amountMicros: jsonInteger(item.amountMicros), amountDisplay: formatMicros(item.amountMicros),
    state: item.state, settledAt: item.settledAt.getTime(),
    ...(item.returnedAt ? { returnedAt: item.returnedAt.getTime() } : {}),
    createdAt: item.createdAt.getTime(),
  };
}

function treasuryExposureView(item: TreasuryExposure) {
  return {
    id: item.id, fundingId: item.fundingId,
    amountMicros: jsonInteger(item.amountMicros), recoveredMicros: jsonInteger(item.recoveredMicros),
    state: item.state, reason: item.reason, createdAt: item.createdAt.getTime(),
    ...(item.resolvedAt ? { resolvedAt: item.resolvedAt.getTime() } : {}),
  };
}

function treasuryRouteView(item: TreasuryRoute) {
  return { id: item.id, provider: item.provider, label: item.label, status: item.status, createdAt: item.createdAt.getTime() };
}

function treasuryDestinationView(item: TreasuryDestination) {
  return {
    id: item.id, provider: item.provider, label: item.label, status: item.status,
    verifiedAt: item.verifiedAt.getTime(), createdAt: item.createdAt.getTime(),
  };
}

function treasuryControlView(item: TreasuryControls) {
  return {
    fundingEnabled: item.fundingEnabled, payoutsEnabled: item.payoutsEnabled,
    externalSpendEnabled: item.externalSpendEnabled,
    maxPayoutMicros: jsonInteger(item.maxPayoutMicros),
    maxPendingPayoutMicros: jsonInteger(item.maxPendingPayoutMicros),
    ...(item.breakerReason ? { breakerReason: "External money movement is paused for treasury review." } : {}),
    updatedAt: item.updatedAt.getTime(),
  };
}

function complianceView(item: ComplianceSubject) {
  return {
    accountId: item.accountId,
    subjectType: item.subjectType,
    state: item.state,
    riskTier: item.riskTier,
    ...(item.countryCode ? { countryCode: item.countryCode } : {}),
    screeningState: item.screeningState,
    ...(item.identityExpiresAt ? { identityExpiresAt: item.identityExpiresAt.getTime() } : {}),
    ...(item.screeningExpiresAt ? { screeningExpiresAt: item.screeningExpiresAt.getTime() } : {}),
    ...(item.nextReviewAt ? { nextReviewAt: item.nextReviewAt.getTime() } : {}),
    updatedAt: item.updatedAt.getTime(),
  };
}

function externalBinding(payment: DatabaseExternalPaymentSecret): ExternalAuthorizationBinding {
  if (!payment.authorizationExpiresAt || !payment.reverseAfter) {
    throw new Error("unsigned external intent has no authorization binding");
  }
  return {
    externalId: payment.id,
    agentId: payment.agentId,
    idempotencyKey: payment.idempotencyKey,
    host: payment.host,
    payTo: payment.payTo,
    settlementAsset: payment.settlementAsset,
    settlementNetwork: payment.settlementNetwork,
    resource: payment.resource,
    policyPayee: payment.policyPayee,
    amountMicros: payment.amountMicros,
    authorizationExpiresAt: payment.authorizationExpiresAt,
    reverseAfter: payment.reverseAfter,
  };
}

function approvalView(approval: DatabaseApproval, challenge?: DatabaseChallenge) {
  return {
    id: approval.id,
    userId: approval.userId,
    mandateId: approval.mandateId,
    agentId: approval.agentId,
    to: approval.to,
    amount: jsonInteger(approval.amountMicros),
    memo: approval.memo,
    idempotencyKey: approval.idempotencyKey,
    createdAt: approval.createdAt.getTime(),
    expiresAt: approval.expiresAt.getTime(),
    status: approval.status,
    ...(approval.resolvedAt ? { resolvedAt: approval.resolvedAt.getTime() } : {}),
    ...(approval.receiptId ? { receiptId: approval.receiptId } : {}),
    ...(approval.reason ? { reason: approval.reason } : {}),
    ...(challenge ? { challenge: challengeView(challenge) } : {}),
  };
}

function evidenceView(evidence: PaymentEvidence, profiles = new Map<string, DatabaseAccount>()) {
  const amount = jsonInteger(evidence.amountMicros);
  return {
    seq: jsonInteger(evidence.receiptSeq),
    id: evidence.receiptId,
    ts: evidence.createdAt.getTime(),
    transferId: evidence.transferId,
    from: evidence.from,
    to: evidence.to,
    amount,
    memo: evidence.memo,
    ...(evidence.mandateId ? { mandateId: evidence.mandateId } : {}),
    hash: evidence.evidenceHash,
    ...(profiles.get(evidence.from) ? { fromAccount: accountView(profiles.get(evidence.from)!) } : {}),
    ...(profiles.get(evidence.to) ? { toAccount: accountView(profiles.get(evidence.to)!) } : {}),
  };
}

function serviceView(service: DatabaseService, provider?: DatabaseAccount) {
  return {
    id: service.id,
    providerId: service.providerId,
    slug: service.slug,
    name: service.name,
    description: service.description,
    endpointUrl: service.endpointUrl,
    asset: service.asset,
    priceMicros: jsonInteger(service.priceMicros),
    priceDisplay: formatMicros(service.priceMicros),
    active: service.active,
    ...(provider?.handle ? { providerHandle: provider.handle, address: `@${provider.handle}/${service.slug}` } : {}),
    createdAt: service.createdAt.getTime(),
  };
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

/** Only non-economic protocol details live here. Economic fields remain
 * first-class constrained columns and are never trusted from this context. */
function signingContextFor(normalized: NormalizedExternalRequirement): Record<string, unknown> {
  if (normalized.protocolVersion === 1) return {};
  const requirement = normalized.requirement as X402V2Requirement;
  const resource = {
    ...(normalized.resource.description ? { description: normalized.resource.description } : {}),
    ...(normalized.resource.mimeType ? { mimeType: normalized.resource.mimeType } : {}),
  };
  return {
    maxTimeoutSeconds: requirement.maxTimeoutSeconds,
    resource,
    ...(normalized.extensions ? { extensions: normalized.extensions } : {}),
  };
}

/** Core production API backed by the atomic Postgres money kernel. Identity,
 * policy, marketplace, refunds, and the external settlement state machine are
 * durable here. Real rail adapters are injected and the API fails closed when
 * wallet, encryption, or independent settlement verification is absent. */
export function createPostgresApi(db: TransactionalDatabase, options: PostgresApiOptions = {}) {
  const control = new PostgresControlPlane(db);
  const ledger = new PostgresLedger(db);
  const policy = new PostgresPolicy(db);
  const marketplace = new PostgresMarketplace(db);
  const external = new PostgresExternal(db);
  const treasury = new PostgresTreasury(db);
  const compliance = new PostgresCompliance(db);
  const cards = new PostgresCards(db);
  const clock = options.now ?? Date.now;
  const cardIssuer = options.cardIssuer;
  const cardBridgeReady = Boolean(cardIssuer);
  const cardRevealMode = options.cardRevealMode ?? "none";
  const cardRevealTokenKey = options.cardRevealTokenKey ? Buffer.from(options.cardRevealTokenKey) : undefined;
  if (cardRevealTokenKey && cardRevealTokenKey.length < 32) {
    throw new Error("cardRevealTokenKey must contain at least 32 bytes");
  }
  if (cardRevealMode === "token" && !cardRevealTokenKey) {
    throw new Error("cardRevealTokenKey is required when cardRevealMode is token");
  }
  const cardAuthTtlSeconds = options.cardAuthTtlSeconds ?? 604_800;
  if (!Number.isSafeInteger(cardAuthTtlSeconds) || cardAuthTtlSeconds < 60 || cardAuthTtlSeconds > 2_592_000) {
    throw new Error("cardAuthTtlSeconds must be an integer between 60 and 2592000");
  }
  const externalHeaderKey = options.externalHeaderKey ? Buffer.from(options.externalHeaderKey) : undefined;
  if (externalHeaderKey && externalHeaderKey.length !== 32) {
    throw new Error("externalHeaderKey must contain exactly 32 bytes");
  }
  const externalHeaderKeyring = options.externalHeaderKeyring
    ?? (externalHeaderKey ? singleExternalHeaderKeyring(externalHeaderKey) : undefined);
  const externalBridgeReady = Boolean(
    (options.externalWallet || options.externalPaymentSigner)
      && externalHeaderKeyring && options.verifyExternalSettlement
  );
  const complianceOnboardingReady = Boolean(
    options.complianceSessionKeyring && options.complianceProviderName
  );
  const app = new Hono<ApiEnv>();

  app.onError((error, c) => {
    console.error("Postgres money API error", error);
    return c.json({ error: "internal_error", reason: "The request could not be completed." }, 500);
  });

  const noStore = async (c: Context<ApiEnv>, next: Next) => {
    await next();
    c.header("cache-control", "no-store");
  };
  app.use("/owner/*", noStore);
  app.use("/agent/*", noStore);
  app.use("/provider/*", noStore);
  app.use("/pay-external", noStore);
  app.use("/pay-external/*", noStore);
  app.use("/cards", noStore);
  app.use("/cards/*", noStore);
  app.use("/dashboard/state", noStore);

  const readBody = async <T>(c: Context): Promise<T | null> => c.req.json<T>().catch(() => null);

  const databaseFailure = (c: Context, error: unknown, fallback: string) => {
    const code = databaseCode(error);
    const reason = errorMessage(error);
    if (code === "23505") return c.json({ error: "conflict", reason }, 409);
    if (code === "42501") return c.json({ error: "forbidden", reason }, 403);
    if (code === "P0002") return c.json({ error: "not_found", reason }, 404);
    if (code === "22023" || code === "23503") return c.json({ error: "invalid_request", reason }, 400);
    if (code === "55000") return c.json({ error: "treasury_unavailable", reason }, 503);
    console.error(fallback, error);
    return c.json({ error: fallback, reason: "The request could not be completed." }, 500);
  };

  const requireSignedAccount = (kind: IdentityKind) => {
    const idHeader = kind === "agent" ? "x-agent-id" : kind === "user" ? "x-user-id" : "x-provider-id";
    const contextKey = kind === "agent" ? "agentId" : kind === "user" ? "userId" : "providerId";
    return async (c: Context<ApiEnv>, next: Next) => {
      const accountId = c.req.header(idHeader);
      const nonce = c.req.header("x-signature-nonce");
      const signature = c.req.header("x-signature");
      const signedAt = Number(c.req.header("x-signature-ts"));
      const reject = (reason: string) => c.json({ error: "unauthenticated", reason }, 401);
      if (!accountId || !nonce || nonce.length < 8 || !signature || !Number.isSafeInteger(signedAt)) {
        return reject(`signed request required: ${idHeader}, x-signature-ts, x-signature-nonce, x-signature`);
      }
      const now = Date.now();
      if (now - signedAt > AUTH_WINDOW_MS || signedAt - now > CLOCK_SKEW_MS) {
        return reject("signature timestamp outside the accepted window");
      }
      const declaredLength = Number(c.req.header("content-length") ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_SIGNED_BODY_BYTES) return reject("request body too large");
      const body = await c.req.text();
      if (Buffer.byteLength(body, "utf8") > MAX_SIGNED_BODY_BYTES) return reject("request body too large");
      const account = await control.accountForAuth(accountId).catch(() => undefined);
      if (!account || account.kind !== kind || account.status !== "active" || !account.publicKey) {
        return reject(`unknown or inactive ${kind}`);
      }
      const url = new URL(c.req.url);
      const path = url.pathname + url.search;
      if (!verifyRequest(account.publicKey, signature, { method: c.req.method, path, body, ts: signedAt, nonce })) {
        return reject("signature verification failed");
      }
      const requestHash = createHash("sha256")
        .update([c.req.method.toUpperCase(), path, body, String(signedAt), nonce].join("\n"), "utf8")
        .digest();
      try {
        await control.consumeSignedRequest({
          accountId,
          kind,
          expectedPublicKey: account.publicKey,
          nonce,
          signedAtMs: signedAt,
          requestHash,
        });
      } catch (error) {
        return reject(databaseCode(error) === "28000" ? errorMessage(error) : "signed request could not be accepted");
      }
      c.set(contextKey, accountId);
      await next();
    };
  };

  const requireAgentSig = requireSignedAccount("agent");
  const requireOwnerSig = requireSignedAccount("user");
  const requireProviderSig = requireSignedAccount("provider");
  const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest();

  const bearer = (c: Context<ApiEnv>): string | undefined => {
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(c.req.header("authorization") ?? "");
    return match?.[1];
  };

  const requireOwnerAccess = async (c: Context<ApiEnv>, next: Next) => {
    if (!c.req.header("authorization")) return requireOwnerSig(c, next);
    const token = bearer(c);
    if (!token) return c.json({ error: "unauthorized", reason: "owner session is invalid" }, 401);
    const userId = await control.resolveOwnerSession(tokenHash(token));
    if (!userId) return c.json({ error: "unauthorized", reason: "owner session is missing, revoked, or expired" }, 401);
    c.set("userId", userId);
    await next();
  };

  // The four owner-money write routes (/fund, /allocate, /mandates,
  // /mandates/:id/revoke) are owner-SIGNED in production. The sandbox-only
  // allowSessionOwnerWrites option relaxes exactly those four to session auth
  // so the local owner app is one-tap; requireOwnerAccess still falls back to
  // the signature path when no Authorization header is present, so signed
  // CLI/onboard traffic behaves byte-identically under either flag state.
  // Identity-root authority (/accounts/:id/rotate-key, /agents, /providers)
  // is NOT relaxed even in sandbox.
  const ownerWriteAuth = options.allowSessionOwnerWrites ? requireOwnerAccess : requireOwnerSig;

  const profilesFor = async (evidence: readonly PaymentEvidence[]) => {
    const accounts = await control.publicAccounts(evidence.flatMap((item) => [item.from, item.to]));
    return new Map(accounts.map((account) => [account.id, account]));
  };

  const challengeIdForApproval = (approval: DatabaseApproval): string | undefined => {
    const match = /^chl_([0-9a-fA-F-]{36})$/.exec(approval.idempotencyKey);
    return match?.[1];
  };

  const approvalViews = async (requesterId: string, approvals: readonly DatabaseApproval[]) => {
    const ids = approvals.flatMap((approval) => {
      const id = challengeIdForApproval(approval);
      return id ? [id] : [];
    });
    const challenges = new Map(
      (await marketplace.challenges(requesterId, ids)).map((challenge) => [challenge.id, challenge])
    );
    return approvals.map((approval) => approvalView(
      approval,
      challengeIdForApproval(approval) ? challenges.get(challengeIdForApproval(approval)!) : undefined
    ));
  };

  const paymentView = async (requesterId: string, result: PolicyPaymentResult) => {
    if (result.status === "denied") {
      return { status: "denied" as const, code: result.code, reason: result.reason, replayed: result.replayed };
    }
    if (result.status === "approval_required") {
      const approval = await policy.approval(requesterId, result.approvalId);
      if (!approval) throw new Error("approval result is not visible to its requester");
      const [view] = await approvalViews(requesterId, [approval]);
      return { status: "approval_required" as const, approval: view!, replayed: result.replayed };
    }
    const evidence = await control.receipt(requesterId, result.receiptId);
    if (!evidence) throw new Error("posted payment receipt is not visible to its requester");
    const amount = jsonInteger(evidence.amountMicros);
    return {
      status: "paid" as const,
      transfer: {
        id: evidence.transferId,
        ts: evidence.createdAt.getTime(),
        from: evidence.from,
        to: evidence.to,
        amount,
        memo: evidence.memo,
        idempotencyKey: evidence.idempotencyKey,
        ...(evidence.mandateId ? { mandateId: evidence.mandateId } : {}),
      },
      receipt: evidenceView(evidence),
      replayed: result.replayed,
    };
  };

  const transferView = async (requesterId: string, result: DatabaseTransferResult) => {
    if (result.status === "denied") {
      return {
        status: "denied" as const,
        code: result.code,
        reason: result.reason,
        replayed: result.replayed,
        ...(result.fromBalanceMicros !== undefined ? { fromBalanceMicros: jsonInteger(result.fromBalanceMicros) } : {}),
        ...(result.toBalanceMicros !== undefined ? { toBalanceMicros: jsonInteger(result.toBalanceMicros) } : {}),
      };
    }
    const evidence = await control.receipt(requesterId, result.receiptId);
    return {
      status: "posted" as const,
      transferId: result.transferId,
      receiptId: result.receiptId,
      replayed: result.replayed,
      fromBalanceMicros: jsonInteger(result.fromBalanceMicros),
      toBalanceMicros: jsonInteger(result.toBalanceMicros),
      ...(evidence ? { receipt: evidenceView(evidence) } : {}),
    };
  };

  const decryptExternalHeader = (payment: DatabaseExternalPaymentSecret): {
    header: string;
    authorization: DecodedX402Payment;
  } => {
    if (!externalHeaderKeyring || !payment.paymentHeaderCiphertext || !payment.authorizationHash
      || !payment.authorizationExpiresAt || !payment.reverseAfter || !payment.authorizationKeyId) {
      throw new Error("external payment has no decryptable authorization");
    }
    const header = decryptPaymentHeaderWithKeyring(
      payment.paymentHeaderCiphertext, externalHeaderKeyring,
      externalBinding(payment), payment.authorizationKeyId
    ).plaintext;
    const digest = createHash("sha256").update(header, "utf8").digest();
    if (!digest.equals(payment.authorizationHash)) throw new Error("external authorization hash mismatch");
    const legacy = payment.protocolVersion === 1 ? decodeXPayment(header) : null;
    const authorization: DecodedX402Payment | null = legacy ? {
      protocolVersion: 1,
      authorization: legacy.payload.authorization,
      signature: legacy.payload.signature,
      network: legacy.network,
      payload: legacy,
    } : decodedV2Payment(header);
    const auth = authorization?.authorization;
    if (!authorization || authorization.protocolVersion !== payment.protocolVersion || !auth
      || authorization.network !== payment.settlementNetwork
      || auth.to.toLowerCase() !== payment.payTo.toLowerCase()
      || auth.value !== payment.amountMicros.toString()
      || Number(auth.validBefore) * 1_000 !== payment.authorizationExpiresAt.getTime()) {
      throw new Error("stored external authorization does not match durable payment terms");
    }
    if (authorization.protocolVersion === 2
      && (authorization.asset?.toLowerCase() !== payment.settlementAsset.toLowerCase()
        || authorization.accepted?.amount !== payment.amountMicros.toString())) {
      throw new Error("stored x402 v2 accepted requirement does not match durable payment terms");
    }
    return { header, authorization };
  };

  const sameExternalTerms = (
    payment: DatabaseExternalPaymentSecret,
    input: {
      host: string;
      payTo: string;
      settlementAsset: string;
      settlementNetwork: string;
      resource: string;
      policyPayee: string;
      amountMicros: bigint;
      protocolVersion: 1 | 2;
      signingContext: Record<string, unknown>;
    }
  ) => payment.host === input.host
    && payment.payTo.toLowerCase() === input.payTo.toLowerCase()
    && payment.settlementAsset.toLowerCase() === input.settlementAsset.toLowerCase()
    && payment.settlementNetwork === input.settlementNetwork
    && payment.resource === input.resource
    && payment.policyPayee === input.policyPayee
    && payment.amountMicros === input.amountMicros
    && payment.protocolVersion === input.protocolVersion
    && canonicalJson(payment.signingContext) === canonicalJson(input.signingContext);

  const requestExistingExternal = (payment: DatabaseExternalPaymentSecret) => external.prepare({
    externalId: payment.id,
    agentId: payment.agentId,
    idempotencyKey: payment.idempotencyKey,
    host: payment.host,
    payTo: payment.payTo,
    settlementAsset: payment.settlementAsset,
    settlementNetwork: payment.settlementNetwork,
    resource: payment.resource,
    policyPayee: payment.policyPayee,
    amountMicros: payment.amountMicros,
    protocolVersion: payment.protocolVersion,
    signingContext: payment.signingContext,
  });

  const normalizedFromIntent = (payment: DatabaseExternalPaymentSecret): NormalizedExternalRequirement => {
    const context = payment.signingContext;
    const resourceMetadata = context.resource && typeof context.resource === "object" && !Array.isArray(context.resource)
      ? context.resource as Record<string, unknown>
      : {};
    const requirement = payment.protocolVersion === 2 ? {
      scheme: "exact",
      network: payment.settlementNetwork,
      amount: payment.amountMicros.toString(),
      asset: payment.settlementAsset,
      payTo: payment.payTo,
      maxTimeoutSeconds: context.maxTimeoutSeconds,
      extra: {},
    } : {
      scheme: "exact",
      network: payment.settlementNetwork,
      maxAmountRequired: payment.amountMicros.toString(),
      asset: payment.settlementAsset,
      payTo: payment.payTo,
      resource: payment.resource,
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    };
    const normalized = normalizeExternalRequirement({
      url: payment.resource,
      requirement,
      x402Version: payment.protocolVersion,
      resource: { url: payment.resource, ...resourceMetadata },
      extensions: context.extensions,
    });
    if (!normalized.ok) throw new Error(`durable external intent is no longer supported: ${normalized.reason}`);
    return normalized.value;
  };

  const signExternalIntent = async (payment: DatabaseExternalPaymentSecret): Promise<{
    signed: SignedX402Payment;
    ciphertext: Buffer;
    keyId: string;
    authorizationHash: Buffer;
    authorizationExpiresAt: Date;
    reverseAfter: Date;
  }> => {
    if (!externalHeaderKeyring) throw new Error("external authorization keyring is unavailable");
    const normalized = normalizedFromIntent(payment);
    let signed: SignedX402Payment;
    if (normalized.protocolVersion === 1) {
      if (!options.externalWallet) throw new Error("x402 v1 signer is unavailable");
      const built = buildXPayment(options.externalWallet, normalized.requirement as PaymentRequirements, clock());
      const payload = decodeXPayment(built.header);
      if (!payload) throw new Error("x402 v1 signer produced an invalid payload");
      signed = {
        protocolVersion: 1,
        paymentHeaderName: "x-payment",
        settlementHeaderName: "x-payment-response",
        header: built.header,
        authorization: built.authorization,
        payload,
      };
    } else {
      if (!options.externalPaymentSigner) throw new Error("x402 v2 EVM signer is unavailable");
      signed = await options.externalPaymentSigner.createPayment({
        requirement: normalized.requirement as X402V2Requirement,
        resource: normalized.resource,
        extensions: normalized.extensions,
        paymentIdentifier: stablePaymentIdentifier(payment.agentId, payment.idempotencyKey),
      });
    }
    if (signed.protocolVersion !== payment.protocolVersion
      || signed.authorization.to.toLowerCase() !== payment.payTo.toLowerCase()
      || signed.authorization.value !== payment.amountMicros.toString()) {
      throw new Error("external signer returned authorization for different payment terms");
    }
    const validBeforeSeconds = Number(signed.authorization.validBefore);
    const issuedAt = clock();
    if (!Number.isSafeInteger(validBeforeSeconds) || validBeforeSeconds * 1_000 <= issuedAt
      || validBeforeSeconds * 1_000 > issuedAt + 10 * 60_000) {
      throw new Error("payment authorization has no usable bounded validity window");
    }
    const authorizationExpiresAt = new Date(validBeforeSeconds * 1_000);
    const reverseAfter = new Date(authorizationExpiresAt.getTime() + 5 * 60_000);
    const binding: ExternalAuthorizationBinding = {
      externalId: payment.id,
      agentId: payment.agentId,
      idempotencyKey: payment.idempotencyKey,
      host: payment.host,
      payTo: payment.payTo,
      settlementAsset: payment.settlementAsset,
      settlementNetwork: payment.settlementNetwork,
      resource: payment.resource,
      policyPayee: payment.policyPayee,
      amountMicros: payment.amountMicros,
      authorizationExpiresAt,
      reverseAfter,
    };
    const encrypted = encryptPaymentHeaderWithKeyring(signed.header, externalHeaderKeyring, binding);
    return {
      signed,
      ciphertext: encrypted.ciphertext,
      keyId: encrypted.keyId,
      authorizationHash: createHash("sha256").update(signed.header, "utf8").digest(),
      authorizationExpiresAt,
      reverseAfter,
    };
  };

  const activatePreparedExternal = async (agentId: string, externalId: string): Promise<ExternalCommandResult> => {
    const payment = await external.secret(agentId, externalId);
    if (!payment) throw new Error("prepared external payment is not visible to its agent");
    if (payment.state !== "prepared") return requestExistingExternal(payment);
    if (!(await treasury.controlState()).externalSpendEnabled) {
      const error = new Error("treasury external-spend circuit breaker is open") as Error & { code: string };
      error.code = "55000";
      throw error;
    }
    const authorization = await signExternalIntent(payment);
    return external.activate({
      agentId,
      externalId,
      paymentHeaderCiphertext: authorization.ciphertext,
      authorizationHash: authorization.authorizationHash,
      authorizationKeyId: authorization.keyId,
      authorizationExpiresAt: authorization.authorizationExpiresAt,
      reverseAfter: authorization.reverseAfter,
    });
  };

  const externalCommandView = async (
    requesterId: string,
    result: ExternalCommandResult,
    exposeHeader: boolean,
    payingAgentId = requesterId
  ) => {
    if (result.status === "denied") {
      return {
        status: "denied" as const,
        replayed: result.replayed,
        ...(result.externalId ? { externalId: result.externalId } : {}),
        ...(result.externalState ? { state: result.externalState } : {}),
        code: result.code ?? "denied",
        reason: result.reason ?? "external payment denied",
      };
    }
    if (!result.externalId || !result.externalState) {
      throw new Error("external command is missing durable identity");
    }
    if (result.status === "approval_required") {
      if (!result.approvalId) throw new Error("external approval result is missing approval id");
      const approval = await policy.approval(requesterId, result.approvalId);
      if (!approval) throw new Error("external approval is not visible to its requester");
      return {
        status: "approval_required" as const,
        externalId: result.externalId,
        state: result.externalState,
        approval: approvalView(approval),
        replayed: result.replayed,
      };
    }
    if (result.status === "prepared") {
      return {
        status: "prepared" as const,
        externalId: result.externalId,
        state: result.externalState,
        replayed: result.replayed,
      };
    }
    if (!result.receiptId || !result.transferId) {
      throw new Error("posted external payment is missing journal evidence");
    }
    const payment = await external.secret(payingAgentId, result.externalId);
    if (!payment) throw new Error("posted external payment is not visible to its agent");
    const evidence = await control.receipt(requesterId, result.receiptId);
    if (!evidence) throw new Error("posted external receipt is not visible to its agent");
    const decrypted = exposeHeader ? decryptExternalHeader(payment) : undefined;
    return {
      status: "paid" as const,
      externalId: payment.id,
      state: payment.state,
      policyPayee: payment.policyPayee,
      amountMicros: jsonInteger(payment.amountMicros),
      settlementNetwork: payment.settlementNetwork,
      settlementAsset: payment.settlementAsset,
      protocolVersion: payment.protocolVersion,
      resource: payment.resource,
      ...(decrypted ? {
        paymentHeader: decrypted.header,
        paymentHeaderName: payment.protocolVersion === 2 ? "payment-signature" : "x-payment",
        settlementHeaderName: payment.protocolVersion === 2 ? "payment-response" : "x-payment-response",
      } : {}),
      transfer: {
        id: result.transferId,
        from: evidence.from,
        to: evidence.to,
        amount: jsonInteger(evidence.amountMicros),
        memo: evidence.memo,
      },
      receipt: evidenceView(evidence),
      replayed: result.replayed,
    };
  };

  const stateFeed = async (requesterId: string, limit: number) => {
    const feed = await control.paymentFeed(requesterId, limit);
    const profiles = await profilesFor(feed);
    return feed.map((evidence) => evidenceView(evidence, profiles));
  };

  const servicesView = async (requesterId: string) => {
    const services = await control.services(requesterId);
    const providers = new Map((await control.publicAccounts(services.map((service) => service.providerId))).map((account) => [account.id, account]));
    return services.map((service) => serviceView(service, providers.get(service.providerId)));
  };

  const treasurySnapshot = async (requesterId: string, includeFunding: boolean) => {
    const [destinations, routes, payouts, fundings, exposures, controls] = await Promise.all([
      treasury.destinations(requesterId),
      includeFunding ? treasury.routes(requesterId) : Promise.resolve([]),
      treasury.payouts(requesterId, 100),
      includeFunding ? treasury.fundings(requesterId, 100) : Promise.resolve([]),
      includeFunding ? treasury.exposures(requesterId, 100) : Promise.resolve([]),
      treasury.controlState(),
    ]);
    return {
      controls: treasuryControlView(controls),
      depositRoutes: routes.map(treasuryRouteView),
      destinations: destinations.map(treasuryDestinationView),
      payouts: payouts.map(treasuryPayoutView),
      fundings: fundings.map(treasuryFundingView),
      exposures: exposures.map(treasuryExposureView),
    };
  };

  // The ops role records real verdicts (per-transfer zero-sum, receipt
  // evidence-hash recheck) on a schedule; the product role serves only the
  // latest stored row — a cheap single-row read the role matrix allows. An
  // unavailable or never-recorded verdict degrades to null: this indicator
  // must never take the owner surface down or manufacture assurance.
  const ledgerIntegrityView = async () => {
    try {
      const report = await control.latestLedgerHealth();
      return report
        ? {
            integrity: {
              zeroSum: report.zeroSum,
              receiptsOk: report.receiptsOk,
              verifiedAt: report.verifiedAt.getTime(),
            },
          }
        : { integrity: null };
    } catch (error) {
      console.error("ledger integrity read failed", error);
      return { integrity: null };
    }
  };

  const ownerSnapshot = async (userId: string) => {
    const [accounts, mandates, approvals, feed, services, externalPayments, cardList, treasuryState, complianceState, integrityView] = await Promise.all([
      control.accountState(userId),
      policy.listMandates(userId, 100),
      policy.listApprovals(userId, undefined, 100),
      stateFeed(userId, 25),
      servicesView(userId),
      external.list(userId, 100),
      cards.list(userId, 20),
      treasurySnapshot(userId, true),
      compliance.state(userId),
      ledgerIntegrityView(),
    ]);
    const renderedApprovals = await approvalViews(userId, approvals.reverse());
    return {
      now: Date.now(),
      ...integrityView,
      accounts: accounts.map(accountView),
      services,
      mandates: mandates.map(mandateView),
      approvals: renderedApprovals,
      feed,
      external: externalPayments.map(externalView),
      cards: cardList.map(cardView),
      treasury: treasuryState,
      ...(complianceState ? { compliance: complianceView(complianceState) } : {}),
    };
  };

  const childSnapshot = async (accountId: string, limit = 25) => {
    const [accounts, mandates, approvals, feed, services, externalPayments, cardList, treasuryState, complianceState] = await Promise.all([
      control.accountState(accountId),
      policy.listMandates(accountId, 100),
      policy.listApprovals(accountId, undefined, 100),
      stateFeed(accountId, limit),
      servicesView(accountId),
      external.list(accountId, Math.min(limit, 100)),
      cards.list(accountId, Math.min(limit, 20)),
      treasurySnapshot(accountId, false),
      compliance.state(accountId),
    ]);
    const activeMandate = mandates.find((mandate) => !mandate.revokedAt && mandate.expiresAt.getTime() > Date.now());
    const renderedApprovals = await approvalViews(accountId, approvals.reverse());
    return {
      now: Date.now(),
      account: accounts[0] ? accountView(accounts[0]) : undefined,
      ...(activeMandate ? { mandate: mandateView(activeMandate) } : {}),
      approvals: renderedApprovals,
      feed,
      services,
      external: externalPayments.map(externalView),
      cards: cardList.map(cardView),
      treasury: treasuryState,
      ...(complianceState ? { compliance: complianceView(complianceState) } : {}),
    };
  };

  app.get("/health/live", (c) => c.json({ ok: true }));
  app.get("/health/ready", async (c) => {
    try {
      const result = await db.query<{ version: string | null; ready: boolean }>(`
        select (select max(version) from money.schema_migrations) as version,
          to_regprocedure('money_private.consume_signed_request(text,text,text,text,bigint,bytea)') is not null
          and to_regprocedure('money_private.request_agent_payment(text,text,text,text,bigint,text)') is not null
          and to_regprocedure('money_private.request_challenge_payment(text,uuid)') is not null
          and to_regprocedure('money_private.prepare_external_payment(uuid,text,text,text,text,text,text,text,text,bigint,smallint,jsonb)') is not null
          and to_regprocedure('money_private.activate_external_payment(text,uuid,bytea,bytea,text,timestamptz,timestamptz)') is not null
          and to_regprocedure('money_private.resolve_external_approval_v2(text,uuid,text,text,bytea,bytea,text,timestamptz,timestamptz)') is not null
          and to_regprocedure('money_private.get_unresolved_external_payment_by_resource(text,text)') is not null
          and to_regprocedure('money_private.latest_ledger_health()') is not null
          and to_regprocedure('money_private.confirm_external_payment(text,uuid,text)') is not null
          and to_regprocedure('money_private.request_treasury_payout(text,text,uuid,text,bigint)') is not null
          and to_regprocedure('money_private.treasury_control_state()') is not null
          and to_regprocedure('money_private.compliance_subject_state(text)') is not null
          and to_regprocedure('money_private.request_compliance_verification_session(text,text,text)') is not null
          and to_regprocedure('money_private.evaluate_transfer_risk(text,text,text,bytea,text,text,text,bigint,jsonb)') is not null as ready
      `);
      return result.rows[0]?.ready
        ? c.json({ ok: true, schemaVersion: result.rows[0].version })
        : c.json({ ok: false, error: "schema_not_ready" }, 503);
    } catch {
      return c.json({ ok: false, error: "database_unavailable" }, 503);
    }
  });

  app.post("/users", async (c) => {
    const body = await readBody<{ name: string; publicKey: string; handle?: string; inviteCode?: string }>(c);
    if (!body || typeof body.name !== "string" || body.name.length < 1 || body.name.length > 200
      || !isValidPublicKey(body.publicKey) || (body.handle !== undefined && !isValidHandle(body.handle))) {
      return c.json({ error: "invalid_request", reason: "need name, a valid Ed25519 publicKey, and optional valid handle" }, 400);
    }
    if (options.signupInvites?.length
      && !inviteCodeMatches(options.signupInvites, typeof body.inviteCode === "string" ? body.inviteCode : "")) {
      return c.json({ error: "invite_required", reason: "signup on this network requires a valid invite code" }, 403);
    }
    try {
      const account = await control.registerIdentity({ kind: "user", name: body.name, publicKey: body.publicKey, handle: body.handle });
      return c.json({ ...accountView(account), replayed: account.replayed });
    } catch (error) {
      return databaseFailure(c, error, "signup_failed");
    }
  });

  app.post("/agents", requireOwnerSig, async (c) => {
    const ownerId = c.get("userId");
    const body = await readBody<{ name: string; ownerId: string; publicKey: string; handle?: string }>(c);
    if (!body || body.ownerId !== ownerId || typeof body.name !== "string" || body.name.length < 1 || body.name.length > 200
      || !isValidPublicKey(body.publicKey) || (body.handle !== undefined && !isValidHandle(body.handle))) {
      return c.json({ error: "invalid_request", reason: "need signing ownerId, name, valid agent publicKey, and optional valid handle" }, 400);
    }
    try {
      const account = await control.registerIdentity({
        actorId: ownerId, kind: "agent", ownerId, name: body.name, publicKey: body.publicKey, handle: body.handle,
      });
      return c.json({ ...accountView(account), replayed: account.replayed });
    } catch (error) {
      return databaseFailure(c, error, "agent_registration_failed");
    }
  });

  app.post("/providers", requireOwnerSig, async (c) => {
    const ownerId = c.get("userId");
    const body = await readBody<{ name: string; ownerId: string; publicKey: string; handle: string }>(c);
    if (!body || body.ownerId !== ownerId || typeof body.name !== "string" || body.name.length < 1 || body.name.length > 200
      || !isValidPublicKey(body.publicKey) || !isValidHandle(body.handle)) {
      return c.json({ error: "invalid_request", reason: "need signing ownerId, name, unique handle, and valid provider publicKey" }, 400);
    }
    try {
      const account = await control.registerIdentity({
        actorId: ownerId, kind: "provider", ownerId, name: body.name, publicKey: body.publicKey, handle: body.handle,
      });
      return c.json({ ...accountView(account), replayed: account.replayed });
    } catch (error) {
      return databaseFailure(c, error, "provider_registration_failed");
    }
  });

  app.get("/handles/:handle", async (c) => {
    const account = await control.resolvePublicAccount(`@${c.req.param("handle") ?? ""}`);
    return account ? c.json(accountView(account)) : c.json({ error: "handle_not_found" }, 404);
  });

  app.post("/services", requireProviderSig, async (c) => {
    const providerId = c.get("providerId");
    const body = await readBody<{
      slug: string;
      name: string;
      description?: string;
      endpointUrl: string;
      priceMicros: number | string;
      idempotencyKey: string;
    }>(c);
    const price = body ? positiveMicros(body.priceMicros) : undefined;
    const slug = typeof body?.slug === "string" ? normalizeServiceSlug(body.slug) : "";
    let endpoint: URL | undefined;
    try {
      endpoint = body?.endpointUrl ? new URL(body.endpointUrl) : undefined;
    } catch {
      endpoint = undefined;
    }
    if (!body || !isValidServiceSlug(slug) || typeof body.name !== "string" || body.name.length < 1 || body.name.length > 200
      || (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 2_000))
      || !endpoint || !["http:", "https:"].includes(endpoint.protocol) || price === undefined
      || !validClientKey(body.idempotencyKey)) {
      return c.json({
        error: "invalid_request",
        reason: "need slug, name, absolute HTTP(S) endpointUrl, positive priceMicros, and idempotencyKey",
      }, 400);
    }
    try {
      const service = await marketplace.registerService({
        providerId,
        slug,
        name: body.name,
        description: body.description ?? "",
        endpointUrl: endpoint.toString(),
        priceMicros: price,
        idempotencyKey: body.idempotencyKey,
      });
      const provider = (await control.publicAccounts([providerId]))[0];
      return c.json({ ...serviceView(service, provider), replayed: service.replayed });
    } catch (error) {
      return databaseFailure(c, error, "service_registration_failed");
    }
  });

  app.post("/services/:id/status", requireProviderSig, async (c) => {
    const body = await readBody<{ active: boolean }>(c);
    if (!body || typeof body.active !== "boolean" || !validUuid(c.req.param("id"))) {
      return c.json({ error: "invalid_request", reason: "need boolean active" }, 400);
    }
    try {
      return c.json(await marketplace.setServiceActive(
        c.get("providerId"),
        c.req.param("id") ?? "",
        body.active
      ));
    } catch (error) {
      return databaseFailure(c, error, "service_status_failed");
    }
  });

  app.get("/services", async (c) => {
    const requested = Number(c.req.query("limit") ?? 50);
    const beforeCreatedRaw = c.req.query("beforeCreated");
    const beforeId = c.req.query("beforeId");
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > 100 || Boolean(beforeCreatedRaw) !== Boolean(beforeId)) {
      return c.json({ error: "invalid_request", reason: "limit must be 1-100; cursor requires beforeCreated and beforeId" }, 400);
    }
    const beforeCreated = beforeCreatedRaw ? new Date(beforeCreatedRaw) : undefined;
    if (beforeCreated && !Number.isFinite(beforeCreated.getTime())) {
      return c.json({ error: "invalid_request", reason: "beforeCreated must be a valid timestamp" }, 400);
    }
    try {
      const services = await marketplace.publicServices({ limit: requested, beforeCreated, beforeId });
      const providers = new Map(
        (await control.publicAccounts(services.map((service) => service.providerId)))
          .map((provider) => [provider.id, provider])
      );
      return c.json(services.map((service) => serviceView(service, providers.get(service.providerId))));
    } catch (error) {
      return databaseFailure(c, error, "service_catalog_failed");
    }
  });

  app.get("/services/:id", async (c) => {
    const service = await marketplace.publicService(c.req.param("id") ?? "");
    if (!service) return c.json({ error: "service_not_found" }, 404);
    const provider = (await control.publicAccounts([service.providerId]))[0];
    return c.json(serviceView(service, provider));
  });

  app.get("/catalog/:handle/:slug", async (c) => {
    const service = await marketplace.publicService(`@${c.req.param("handle")}/${c.req.param("slug")}`);
    if (!service) return c.json({ error: "service_not_found" }, 404);
    const provider = (await control.publicAccounts([service.providerId]))[0];
    return c.json(serviceView(service, provider));
  });

  app.post("/merchant/challenges", requireProviderSig, async (c) => {
    const body = await readBody<{ serviceId: string }>(c);
    if (!body || !validUuid(body.serviceId)) {
      return c.json({ error: "invalid_request", reason: "need serviceId" }, 400);
    }
    try {
      const challenge = await marketplace.createChallenge(c.get("providerId"), body.serviceId);
      return c.json({
        scheme: "money",
        serviceId: challenge.serviceId,
        resource: challenge.resource,
        amountMicros: jsonInteger(challenge.amountMicros),
        amountDisplay: formatMicros(challenge.amountMicros),
        asset: challenge.asset,
        payTo: challenge.providerId,
        challengeId: challenge.id,
        expiresAt: challenge.expiresAt.getTime(),
        instruction: "POST /pay-challenge as the agent, then retry with x-payment-challenge and x-payment-receipt",
      }, 402);
    } catch (error) {
      return databaseFailure(c, error, "challenge_failed");
    }
  });

  app.post("/merchant/redeem", requireProviderSig, async (c) => {
    const body = await readBody<{ serviceId: string; challengeId: string; receiptId: string }>(c);
    if (!body || !validUuid(body.serviceId) || !validUuid(body.challengeId) || !validUuid(body.receiptId)) {
      return c.json({ error: "invalid_request", reason: "need serviceId, challengeId, and receiptId" }, 400);
    }
    try {
      const result = await marketplace.redeem({ providerId: c.get("providerId"), ...body });
      return result.ok
        ? c.json({ ok: true, challengeId: result.challengeId, redeemedAt: result.redeemedAt?.getTime() })
        : c.json({ error: "payment_rejected", reason: result.reason }, 402);
    } catch (error) {
      return databaseFailure(c, error, "redemption_failed");
    }
  });

  app.post("/refunds", requireProviderSig, async (c) => {
    const body = await readBody<{
      receiptId: string;
      amountMicros: number | string;
      memo?: string;
      idempotencyKey: string;
    }>(c);
    const amount = body ? positiveMicros(body.amountMicros) : undefined;
    if (!body || !validUuid(body.receiptId) || amount === undefined
      || (body.memo !== undefined && (typeof body.memo !== "string" || body.memo.length > 500))
      || !validClientKey(body.idempotencyKey)) {
      return c.json({ error: "invalid_request", reason: "need receiptId, positive amountMicros, optional memo, and idempotencyKey" }, 400);
    }
    try {
      const result = await marketplace.refund({
        providerId: c.get("providerId"),
        receiptId: body.receiptId,
        amountMicros: amount,
        memo: body.memo,
        idempotencyKey: body.idempotencyKey,
      });
      if (result.status === "denied") {
        const status = result.code === "idempotency_conflict" ? 409 : result.code === "insufficient_funds" ? 402 : 400;
        return c.json({
          status: "denied",
          code: result.code,
          reason: result.reason,
          replayed: result.replayed,
          ...(result.remainingMicros !== undefined ? { remaining: jsonInteger(result.remainingMicros) } : {}),
        }, status);
      }
      const evidence = await control.receipt(c.get("providerId"), result.receiptId);
      if (!evidence) throw new Error("refund receipt is not visible to its provider");
      return c.json({
        status: "refunded",
        replayed: result.replayed,
        remaining: jsonInteger(result.remainingMicros),
        transfer: {
          id: result.transferId,
          from: evidence.from,
          to: evidence.to,
          amount: jsonInteger(evidence.amountMicros),
          memo: evidence.memo,
          idempotencyKey: evidence.idempotencyKey,
          refundOf: result.refundOf,
        },
        receipt: { ...evidenceView(evidence), refundOf: result.refundOf },
      });
    } catch (error) {
      return databaseFailure(c, error, "refund_failed");
    }
  });

  app.post("/owner/sessions", requireOwnerSig, async (c) => {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = await control.createOwnerSession(c.get("userId"), tokenHash(token));
    return c.json({ token, expiresAt: expiresAt.getTime(), dashboardPath: `/dashboard#token=${encodeURIComponent(token)}` });
  });

  app.delete("/owner/sessions/current", requireOwnerAccess, async (c) => {
    const token = bearer(c);
    if (token) await control.revokeOwnerSession(c.get("userId"), tokenHash(token));
    return c.json({ ok: true });
  });

  app.post("/fund", ownerWriteAuth, async (c) => {
    if (!options.allowDevelopmentFunding) {
      return c.json({ error: "treasury_required", reason: "production top-ups are accepted only from the treasury integration" }, 403);
    }
    const userId = c.get("userId");
    const body = await readBody<{ userId: string; amountMicros: number | string; idempotencyKey: string }>(c);
    const amount = body ? positiveMicros(body.amountMicros) : undefined;
    if (!body || body.userId !== userId || amount === undefined || !validClientKey(body.idempotencyKey)) {
      return c.json({ error: "invalid_request", reason: "need signing userId, positive amountMicros, and idempotencyKey" }, 400);
    }
    const result = await ledger.postTransfer({
      actorId: userId, operation: "fund", idempotencyKey: body.idempotencyKey,
      from: "external:funding", to: userId, amountMicros: amount,
    });
    return c.json(await transferView(userId, result), result.status === "posted" ? 200 : 402);
  });

  app.post("/allocate", ownerWriteAuth, async (c) => {
    const userId = c.get("userId");
    const body = await readBody<{ userId: string; agentId: string; amountMicros: number | string; idempotencyKey: string }>(c);
    const amount = body ? positiveMicros(body.amountMicros) : undefined;
    if (!body || body.userId !== userId || typeof body.agentId !== "string" || amount === undefined || !validClientKey(body.idempotencyKey)) {
      return c.json({ error: "invalid_request", reason: "need signing userId, agentId, positive amountMicros, and idempotencyKey" }, 400);
    }
    try {
      const result = await ledger.postTransfer({
        actorId: userId, operation: "allocate", idempotencyKey: body.idempotencyKey,
        from: userId, to: body.agentId, amountMicros: amount,
      });
      return c.json(await transferView(userId, result), result.status === "posted" ? 200 : 402);
    } catch (error) {
      return databaseFailure(c, error, "allocation_failed");
    }
  });

  app.post("/mandates", ownerWriteAuth, async (c) => {
    const userId = c.get("userId");
    const body = await readBody<{
      userId: string; agentId: string; budgetMicros: number | string; perTxCapMicros: number | string;
      dailyCapMicros: number | string; escalateAboveMicros: number | string; newPayeeCapMicros: number | string;
      payeeAllowlist?: string[]; expiresAt?: number | string; idempotencyKey: string;
    }>(c);
    const caps = body ? [body.budgetMicros, body.perTxCapMicros, body.dailyCapMicros, body.escalateAboveMicros, body.newPayeeCapMicros].map(nonnegativeMicros) : [];
    const expiresAt = body?.expiresAt === undefined ? new Date(Date.now() + 30 * 86_400_000) : new Date(body.expiresAt);
    if (!body || body.userId !== userId || typeof body.agentId !== "string" || caps.length !== 5 || caps.some((cap) => cap === undefined)
      || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() || !validClientKey(body.idempotencyKey)
      || (body.payeeAllowlist !== undefined && (!Array.isArray(body.payeeAllowlist) || body.payeeAllowlist.length > 1_000 || body.payeeAllowlist.some((id) => typeof id !== "string" || !id)))) {
      return c.json({ error: "invalid_request", reason: "need signing userId, agentId, non-negative *Micros caps, future expiry, and idempotencyKey" }, 400);
    }
    try {
      const result = await policy.grantMandate({
        userId, agentId: body.agentId, budgetMicros: caps[0]!, perTxCapMicros: caps[1]!,
        dailyCapMicros: caps[2]!, escalateAboveMicros: caps[3]!, newPayeeCapMicros: caps[4]!,
        payeeAllowlist: body.payeeAllowlist, expiresAt, idempotencyKey: body.idempotencyKey,
      });
      const mandate = await policy.mandate(userId, result.mandateId);
      if (!mandate) throw new Error("granted mandate could not be read back");
      return c.json({ ...mandateView(mandate), replayed: result.replayed });
    } catch (error) {
      return databaseFailure(c, error, "mandate_grant_failed");
    }
  });

  app.post("/mandates/:id/revoke", ownerWriteAuth, async (c) => {
    const userId = c.get("userId");
    try {
      const changed = await policy.revokeMandate(userId, c.req.param("id") ?? "");
      return c.json({ ok: true, mandateId: c.req.param("id"), changed });
    } catch (error) {
      return databaseFailure(c, error, "mandate_revocation_failed");
    }
  });

  app.post("/accounts/:id/rotate-key", requireOwnerSig, async (c) => {
    const body = await readBody<{ publicKey: string }>(c);
    if (!body || !isValidPublicKey(body.publicKey)) {
      return c.json({ error: "invalid_request", reason: "need a valid Ed25519 publicKey" }, 400);
    }
    try {
      const result = await control.rotatePublicKey(c.get("userId"), c.req.param("id") ?? "", body.publicKey);
      return c.json({ ok: true, accountId: result.accountId, changed: result.changed });
    } catch (error) {
      return databaseFailure(c, error, "key_rotation_failed");
    }
  });

  app.post("/pay", requireAgentSig, async (c) => {
    const agentId = c.get("agentId");
    const body = await readBody<{ to: string; amountMicros: number | string; memo?: string; idempotencyKey: string }>(c);
    const amount = body ? positiveMicros(body.amountMicros) : undefined;
    if (!body || typeof body.to !== "string" || body.to.length < 1 || body.to.length > 128 || amount === undefined
      || (body.memo !== undefined && (typeof body.memo !== "string" || body.memo.length > 500)) || !validClientKey(body.idempotencyKey)) {
      return c.json({ error: "invalid_request", reason: "need to, positive amountMicros, memo up to 500 characters, and idempotencyKey" }, 400);
    }
    const payee = await control.resolvePublicAccount(body.to);
    if (!payee) return c.json({ error: "payee_not_found", reason: `unknown account or handle ${body.to}` }, 404);
    try {
      const result = await policy.requestPayment({
        agentId, idempotencyKey: body.idempotencyKey, to: payee.id,
        amountMicros: amount, memo: body.memo ?? "",
      });
      const view = await paymentView(agentId, result);
      const status = view.status === "paid" ? 200 : view.status === "approval_required" ? 202 : view.code === "idempotency_conflict" ? 409 : 402;
      return c.json(view, status);
    } catch (error) {
      return databaseFailure(c, error, "payment_failed");
    }
  });

  // The agent forwards one allowlisted x402 requirement from the URL it
  // actually fetched. The authorization is encrypted before it reaches the
  // database and is released only after an atomic debit (or owner approval).
  app.post("/pay-external", requireAgentSig, async (c) => {
    if (!externalBridgeReady || !externalHeaderKeyring) {
      return c.json({
        error: "external_bridge_unavailable",
        reason: "payment signer, authorization keyring, and settlement verification must all be configured",
      }, 503);
    }
    const agentId = c.get("agentId");
    const body = await readBody<{
      url: string;
      requirement: unknown;
      idempotencyKey: string;
      x402Version?: number;
      resource?: unknown;
      extensions?: unknown;
    }>(c);
    if (!body || typeof body.url !== "string" || body.url.length < 1 || body.url.length > 2_048
      || !body.requirement || typeof body.requirement !== "object" || !validClientKey(body.idempotencyKey)) {
      return c.json({ error: "invalid_request", reason: "need url, requirement, and idempotencyKey" }, 400);
    }
    const host = canonicalHostOf(body.url);
    if (!host.ok) return c.json({ error: "invalid_request", reason: host.reason }, 400);
    const normalized = normalizeExternalRequirement({
      url: body.url,
      requirement: body.requirement,
      x402Version: body.x402Version,
      resource: body.resource,
      extensions: body.extensions,
    });
    if (!normalized.ok) return c.json({ error: "invalid_request", reason: normalized.reason }, 400);
    if (normalized.value.protocolVersion === 1 && !options.externalWallet) {
      return c.json({ error: "external_protocol_unavailable", reason: "x402 v1 signer is not configured" }, 503);
    }
    if (normalized.value.protocolVersion === 2 && !options.externalPaymentSigner) {
      return c.json({ error: "external_protocol_unavailable", reason: "x402 v2 signer is not configured" }, 503);
    }
    const amountMicros = normalized.value.amountMicros;
    const terms = {
      host: host.host,
      payTo: normalized.value.payTo,
      settlementAsset: normalized.value.asset,
      settlementNetwork: normalized.value.network,
      resource: body.url,
      policyPayee: `x402:${host.host}:${normalized.value.payTo.toLowerCase()}`,
      amountMicros,
      protocolVersion: normalized.value.protocolVersion,
      signingContext: signingContextFor(normalized.value),
    };

    try {
      // This read avoids an unnecessary HSM signature on ordinary retries.
      // The database command below remains the concurrency authority.
      const prior = await external.secretByKey(agentId, body.idempotencyKey);
      if (prior) {
        if (!sameExternalTerms(prior, terms)) {
          return c.json({
            status: "denied",
            code: "idempotency_conflict",
            reason: "idempotency key was reused with different external terms",
            replayed: true,
          }, 409);
        }
        let result = await requestExistingExternal(prior);
        if (result.status === "prepared" && result.externalId) {
          result = await activatePreparedExternal(agentId, result.externalId);
        }
        const view = await externalCommandView(agentId, result, true);
        if (view.status === "paid") return c.json(view, 200);
        if (view.status === "approval_required") return c.json(view, 202);
        if (view.status === "prepared") return c.json({ error: "external_activation_incomplete" }, 503);
        return c.json(view, view.code === "idempotency_conflict" || view.state === "reversed" ? 409 : 402);
      }

      if (!(await treasury.controlState()).externalSpendEnabled) {
        return c.json({
          error: "treasury_unavailable",
          reason: "treasury external-spend circuit breaker is open",
        }, 503);
      }

      const externalId = randomUUID();
      let result = await external.prepare({
        externalId,
        agentId,
        idempotencyKey: body.idempotencyKey,
        ...terms,
      });
      if (result.status === "prepared" && result.externalId) {
        result = await activatePreparedExternal(agentId, result.externalId);
      }
      const view = await externalCommandView(agentId, result, true);
      if (view.status === "paid") return c.json(view, 200);
      if (view.status === "approval_required") return c.json(view, 202);
      if (view.status === "prepared") return c.json({ error: "external_activation_incomplete" }, 503);
      return c.json(view, view.code === "idempotency_conflict" ? 409 : 402);
    } catch (error) {
      return databaseFailure(c, error, "external_payment_failed");
    }
  });

  // Narrow restart lookup: unlike the general state feed, this remains exact
  // even when a high-volume agent has more than 100 unresolved resources.
  app.get("/pay-external/unresolved", requireAgentSig, async (c) => {
    const resource = c.req.query("resource");
    if (!resource || resource.length > 2_048) {
      return c.json({ error: "invalid_request", reason: "need a resource URL" }, 400);
    }
    try {
      const payment = await external.unresolvedByResource(c.get("agentId"), resource);
      return payment
        ? c.json({ externalId: payment.externalId, state: payment.state, resource })
        : c.json({ error: "external_payment_not_found" }, 404);
    } catch (error) {
      return databaseFailure(c, error, "external_lookup_failed");
    }
  });

  // Crash/restart recovery for agent runtimes. The durable external id is
  // discoverable in /agent/state; this endpoint releases the original header
  // only to the paying agent and never creates a second authorization.
  app.post("/pay-external/:id/resume", requireAgentSig, async (c) => {
    if (!externalBridgeReady) {
      return c.json({ error: "external_bridge_unavailable" }, 503);
    }
    const agentId = c.get("agentId");
    const externalId = c.req.param("id") ?? "";
    if (!validUuid(externalId)) return c.json({ error: "external_payment_not_found" }, 404);
    try {
      const payment = await external.secret(agentId, externalId);
      if (!payment) return c.json({ error: "external_payment_not_found" }, 404);
      const result = payment.state === "prepared"
        ? await activatePreparedExternal(agentId, externalId)
        : await requestExistingExternal(payment);
      const view = await externalCommandView(agentId, result, true);
      if (view.status === "paid") return c.json(view, 200);
      if (view.status === "approval_required") return c.json(view, 202);
      if (view.status === "prepared") return c.json({ error: "external_activation_incomplete" }, 503);
      return c.json(view, view.code === "idempotency_conflict" || view.state === "reversed" ? 409 : 402);
    } catch (error) {
      return databaseFailure(c, error, "external_resume_failed");
    }
  });

  // Settlement verification deliberately happens before the short database
  // transaction. The final command then serializes confirmation against the
  // reversal worker; exactly one state transition can win.
  app.post("/pay-external/:id/confirm", requireAgentSig, async (c) => {
    if (!externalBridgeReady || !options.verifyExternalSettlement) {
      return c.json({ error: "external_bridge_unavailable" }, 503);
    }
    const agentId = c.get("agentId");
    const externalId = c.req.param("id") ?? "";
    const body = await readBody<{ settlement: string }>(c);
    if (!validUuid(externalId) || !body || typeof body.settlement !== "string"
      || body.settlement.length < 1 || body.settlement.length > 65_536) {
      return c.json({ error: "invalid_request", reason: "need external payment id and settlement header" }, 400);
    }
    try {
      const payment = await external.secret(agentId, externalId);
      if (!payment) return c.json({ error: "external_payment_not_found" }, 404);
      if (payment.state === "reversed") {
        return c.json({ error: "confirm_failed", reason: "payment was already reversed", state: payment.state }, 409);
      }
      if (payment.state === "approval_required") {
        return c.json({ error: "confirm_failed", reason: "payment has not been approved and debited", state: payment.state }, 409);
      }
      if (payment.state === "cancelled") {
        return c.json({ error: "confirm_failed", reason: "payment authorization was cancelled", state: payment.state }, 409);
      }
      const settlement = decodeSettlement(body.settlement);
      const decrypted = decryptExternalHeader(payment);
      const auth = decrypted.authorization.authorization;
      if (!settlement || settlement.success !== true
        || typeof settlement.transaction !== "string" || settlement.transaction.length < 1 || settlement.transaction.length > 256
        || settlement.network !== payment.settlementNetwork
        || typeof settlement.payer !== "string"
        || settlement.payer.toLowerCase() !== auth.from.toLowerCase()) {
        return c.json({ error: "settlement_unverified", reason: "settlement claim does not match the payment authorization" }, 409);
      }
      if (payment.state === "confirmed") {
        if (payment.settledTx !== settlement.transaction) {
          return c.json({ error: "confirm_failed", reason: "payment was confirmed with a different transaction", state: payment.state }, 409);
        }
        return c.json({ ok: true, state: payment.state, settledTx: payment.settledTx, replayed: true });
      }

      let verified: { ok: boolean; reason?: string };
      try {
        verified = await options.verifyExternalSettlement({
          payment,
          paymentHeader: decrypted.header,
          authorization: decrypted.authorization,
          settlement,
        });
      } catch (error) {
        console.error("external settlement verifier failed", error);
        return c.json({ error: "settlement_verifier_unavailable" }, 503);
      }
      if (!verified.ok) {
        return c.json({
          error: "settlement_unverified",
          reason: verified.reason ?? "independent settlement verification failed",
        }, 409);
      }
      const result = await external.confirm(agentId, externalId, settlement.transaction);
      return result.ok
        ? c.json({ ok: true, state: result.state, settledTx: result.settledTx, replayed: result.replayed })
        : c.json({ error: "confirm_failed", reason: result.reason, state: result.state, replayed: result.replayed }, 409);
    } catch (error) {
      return databaseFailure(c, error, "external_confirmation_failed");
    }
  });

  app.post("/pay-challenge", requireAgentSig, async (c) => {
    const agentId = c.get("agentId");
    const body = await readBody<{ challengeId: string }>(c);
    if (!body || !validUuid(body.challengeId)) {
      return c.json({ error: "invalid_request", reason: "need challengeId" }, 400);
    }
    try {
      const result = await marketplace.payChallenge(agentId, body.challengeId);
      const payment = await paymentView(agentId, result);
      const challenge = (await marketplace.challenges(agentId, [body.challengeId]))[0];
      const status = payment.status === "paid" ? 200
        : payment.status === "approval_required" ? 202
          : payment.code === "idempotency_conflict" ? 409 : 402;
      return c.json({ ...payment, ...(challenge ? { challenge: challengeView(challenge) } : {}) }, status);
    } catch (error) {
      return databaseFailure(c, error, "challenge_payment_failed");
    }
  });

  // ---------------------------------------------------------------------------
  // Card rail. A card is a reserved, capped, merchant-lockable permit under one
  // mandate: issuing it reserves the full cap from the agent's funds. The
  // issuer create happens OUTSIDE the database transaction with
  // Idempotency-Key = card id, so a same-key retry can never mint a second
  // issuer card, and a database denial afterwards closes the issuer card
  // best-effort (the worker's awaiting-close drain is the durable path).
  // ---------------------------------------------------------------------------

  const checkoutTokenHash = (token: string): Buffer =>
    createHmac("sha256", cardRevealTokenKey!).update(token, "utf8").digest();

  const issueCheckoutToken = async (agentId: string, cardId: string) => {
    const token = randomBytes(32).toString("base64url");
    const issued = await cards.issueRevealToken({
      agentId, cardId, tokenHash: checkoutTokenHash(token), ttlSeconds: CHECKOUT_TOKEN_TTL_SECONDS,
    });
    return { checkoutToken: token, checkoutTokenExpiresAt: issued.expiresAt.getTime() };
  };

  const cardApprovalNote = async (card: DatabaseCard): Promise<string> => {
    const agentName = (await control.publicAccounts([card.agentId]))[0]?.name ?? card.agentId;
    const minutes = Math.max(1, Math.round((card.expiresAt.getTime() - clock()) / 60_000));
    return `${agentName} wants a card for up to ${formatMicros(card.capMicros)} at ${card.merchantHint}, expires in ${minutes} min`;
  };

  /**
   * A `55000` card-spend pause raised during activation is retryable: the same
   * idempotency key must be able to resume this card once the operator
   * re-enables spend, and the issuer replays this card's create call
   * (Idempotency-Key = card id), so closing the issuer card here would hand
   * every later retry canceled card material that activates against a dead
   * card. A prepared card can never be approved by decide_card_authorization,
   * so the open issuer card is spend-inert until activation succeeds.
   */
  const isRetryableCardSpendPause = (error: unknown): boolean => {
    if (databaseCode(error) !== "55000") return false;
    let cursor: unknown = error;
    for (let depth = 0; depth < 4 && cursor instanceof Error; depth += 1) {
      if (cursor.message.includes("card-spend circuit breaker is open")) return true;
      cursor = cursor.cause;
    }
    return false;
  };

  const cardFailure = (c: Context, error: unknown, fallback: string) => {
    if (error instanceof CardIssuerApiError) {
      // Never echo an issuer response body: reveal-adjacent errors must not
      // carry card material into any agent- or owner-facing response.
      console.error("card issuer request failed", error.status, error.retryable);
      return c.json({ error: "card_issuer_unavailable", reason: "The card issuer request could not be completed." }, 502);
    }
    return databaseFailure(c, error, fallback);
  };

  /** Issuer create then atomic activation for a card in state `prepared`. */
  const activatePreparedCard = async (agentId: string, card: DatabaseCard): Promise<CardCommandResult> => {
    if (!cardIssuer) throw new Error("card issuer is not configured");
    const material = await cardIssuer.createCard({
      cardId: card.id,
      capMicros: card.capMicros,
      expiresAt: card.expiresAt,
      merchantHint: card.merchantHint,
      singleUse: card.singleUse,
      agentId,
      ownerId: (await control.publicAccounts([agentId]))[0]?.ownerId ?? "",
    });
    let result: CardCommandResult;
    try {
      result = await cards.activate({
        agentId,
        cardId: card.id,
        provider: cardIssuer.provider,
        providerCardRef: material.providerCardRef,
        last4: material.last4,
        expMonth: material.expMonth,
        expYear: material.expYear,
        authTtlSeconds: cardAuthTtlSeconds,
      });
    } catch (error) {
      // Best-effort close only on terminal denials and unexpected errors; a
      // retryable card-spend pause keeps the issuer card open so the same-key
      // retry replays live material (see isRetryableCardSpendPause).
      if (!isRetryableCardSpendPause(error)) {
        await cardIssuer.closeCard(material.providerCardRef).catch(() => undefined);
      }
      throw error;
    }
    if (result.status === "denied") {
      await cardIssuer.closeCard(material.providerCardRef).catch(() => undefined);
    }
    return result;
  };

  const cardCommandResponse = async (c: Context<ApiEnv>, agentId: string, result: CardCommandResult) => {
    if (result.status === "denied") {
      return c.json({
        status: "denied" as const,
        code: result.code ?? "denied",
        reason: result.reason ?? "card request denied",
        replayed: result.replayed,
        ...(result.cardId ? { cardId: result.cardId } : {}),
      }, result.code === "idempotency_conflict" ? 409 : 402);
    }
    if (!result.cardId) throw new Error("card command is missing durable identity");
    const card = await cards.get(agentId, result.cardId);
    if (!card) throw new Error("card command result is not visible to its agent");
    if (result.status === "approval_required") {
      if (!result.approvalId) throw new Error("card approval result is missing its approval id");
      const approval = await policy.approval(agentId, result.approvalId);
      if (!approval) throw new Error("card approval is not visible to its requester");
      return c.json({
        status: "approval_required" as const,
        cardId: result.cardId,
        approval: approvalView(approval),
        note: await cardApprovalNote(card),
        replayed: result.replayed,
      }, 202);
    }
    if (result.status === "posted") {
      // Fresh activations in token mode carry one checkout token; replays do
      // not burn the bounded reveal budget — POST /cards/:id/resume is the
      // sanctioned path to a fresh token.
      const token = cardRevealMode === "token" && !result.replayed
        ? await issueCheckoutToken(agentId, card.id)
        : undefined;
      return c.json({
        status: "active" as const,
        card: cardView(card),
        ...(result.receiptId ? { receiptId: result.receiptId } : {}),
        ...(token ?? {}),
        replayed: result.replayed,
      }, 200);
    }
    return c.json({ error: "card_activation_incomplete" }, 503);
  };

  app.post("/cards", requireAgentSig, async (c) => {
    if (!cardBridgeReady) {
      return c.json({
        error: "card_bridge_unavailable",
        reason: "a card issuer adapter must be configured",
      }, 503);
    }
    const agentId = c.get("agentId");
    const body = await readBody<{
      idempotencyKey: string;
      capMicros?: number | string;
      capUsd?: number;
      merchantHint: string;
      singleUse?: boolean;
      expiresInSeconds?: number;
      mccAllowlist?: string[];
    }>(c);
    const capFromUsd = body && typeof body.capUsd === "number" && Number.isFinite(body.capUsd) && body.capUsd > 0
      ? BigInt(Math.round(body.capUsd * 1_000_000))
      : undefined;
    const cap = body?.capMicros !== undefined ? positiveMicros(body.capMicros) : capFromUsd;
    const expiresInSeconds = body?.expiresInSeconds === undefined ? DEFAULT_CARD_LIFETIME_SECONDS : body.expiresInSeconds;
    if (!body || (body.capMicros !== undefined && body.capUsd !== undefined)
      || cap === undefined || cap <= 0n || cap > MAX_CARD_CAP_MICROS
      || typeof body.merchantHint !== "string" || !CARD_MERCHANT_HINT_PATTERN.test(body.merchantHint)
      || (body.singleUse !== undefined && typeof body.singleUse !== "boolean")
      || !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > MAX_CARD_LIFETIME_SECONDS
      || (body.mccAllowlist !== undefined && (!Array.isArray(body.mccAllowlist)
        || body.mccAllowlist.length < 1 || body.mccAllowlist.length > 32
        || body.mccAllowlist.some((mcc) => typeof mcc !== "string" || !/^[0-9]{4}$/.test(mcc))))
      || !validClientKey(body.idempotencyKey)) {
      return c.json({
        error: "invalid_request",
        reason: "need idempotencyKey, capUsd or capMicros (up to $10,000), a lowercase merchantHint host, optional singleUse, expiresInSeconds (60s to 30d), and an optional mccAllowlist of 4-digit codes",
      }, 400);
    }
    try {
      const prior = await cards.byKey(agentId, body.idempotencyKey);
      if (!prior && !(await treasury.controlState()).cardSpendEnabled) {
        return c.json({ error: "treasury_unavailable", reason: "card spending is paused by the operator" }, 503);
      }
      let result = await cards.prepare({
        cardId: randomUUID(),
        agentId,
        idempotencyKey: body.idempotencyKey,
        capMicros: cap,
        singleUse: body.singleUse ?? true,
        merchantHint: body.merchantHint,
        ...(body.mccAllowlist ? { mccAllowlist: body.mccAllowlist } : {}),
        expiresAt: new Date(clock() + expiresInSeconds * 1_000),
      });
      if (result.status === "prepared" && result.cardId) {
        const prepared = await cards.get(agentId, result.cardId);
        if (!prepared) throw new Error("prepared card is not visible to its agent");
        result = await activatePreparedCard(agentId, prepared);
      }
      return await cardCommandResponse(c, agentId, result);
    } catch (error) {
      return cardFailure(c, error, "card_request_failed");
    }
  });

  app.post("/cards/:id/resume", requireAgentSig, async (c) => {
    const agentId = c.get("agentId");
    const cardId = c.req.param("id") ?? "";
    if (!validUuid(cardId)) return c.json({ error: "card_not_found" }, 404);
    try {
      const card = await cards.get(agentId, cardId);
      if (!card || card.agentId !== agentId) return c.json({ error: "card_not_found" }, 404);
      if (card.state === "prepared") {
        if (!cardBridgeReady) return c.json({ error: "card_bridge_unavailable" }, 503);
        if (!(await treasury.controlState()).cardSpendEnabled) {
          return c.json({ error: "treasury_unavailable", reason: "card spending is paused by the operator" }, 503);
        }
        return await cardCommandResponse(c, agentId, await activatePreparedCard(agentId, card));
      }
      if (card.state === "approval_required" && card.approvalId) {
        const approval = await policy.approval(agentId, card.approvalId);
        return c.json({
          status: "approval_required",
          cardId: card.id,
          ...(approval ? { approval: approvalView(approval) } : {}),
          note: await cardApprovalNote(card),
          replayed: true,
        }, 202);
      }
      if (card.state === "pending") {
        let token: { checkoutToken: string; checkoutTokenExpiresAt: number } | undefined;
        if (cardRevealMode === "token") {
          try {
            token = await issueCheckoutToken(agentId, card.id);
          } catch (error) {
            if (databaseCode(error) === "55000") {
              return c.json({ error: "reveal_limit", reason: errorMessage(error) }, 409);
            }
            throw error;
          }
        }
        return c.json({ status: "active", card: cardView(card), ...(token ?? {}), replayed: true });
      }
      return c.json({ status: card.state, card: cardView(card), replayed: true });
    } catch (error) {
      return cardFailure(c, error, "card_resume_failed");
    }
  });

  app.get("/cards/:id", requireAgentSig, async (c) => {
    const agentId = c.get("agentId");
    const cardId = c.req.param("id") ?? "";
    if (!validUuid(cardId)) return c.json({ error: "card_not_found" }, 404);
    try {
      const card = await cards.get(agentId, cardId);
      if (!card) return c.json({ error: "card_not_found" }, 404);
      const authorizations = await cards.listAuthorizations(agentId, cardId, 20);
      return c.json({ card: cardView(card), authorizations: authorizations.map(cardAuthorizationView) });
    } catch (error) {
      return databaseFailure(c, error, "card_lookup_failed");
    }
  });

  const closeCardRoute = async (c: Context<ApiEnv>, requesterId: string) => {
    const cardId = c.req.param("id") ?? "";
    if (!validUuid(cardId)) return c.json({ error: "card_not_found" }, 404);
    const body = await readBody<{ reason?: string }>(c);
    if (body?.reason !== undefined && typeof body.reason !== "string") {
      return c.json({ error: "invalid_request", reason: "reason must be a string" }, 400);
    }
    try {
      const result = await cards.closeCard(requesterId, cardId, body?.reason?.slice(0, 500));
      return c.json({
        cardId: result.cardId,
        state: result.state,
        replayed: result.replayed,
        ...(result.closeRequestedAt ? { closeRequestedAt: result.closeRequestedAt.getTime() } : {}),
        ...(result.releaseTransferId ? { releaseTransferId: result.releaseTransferId } : {}),
      });
    } catch (error) {
      return databaseFailure(c, error, "card_close_failed");
    }
  };

  app.post("/cards/:id/close", requireAgentSig, (c) => closeCardRoute(c, c.get("agentId")));

  // The single reveal surface, and only in `token` mode. The checkout token is
  // single-use, hashed at rest, bound by the kernel to the signing agent and a
  // card that is still pending; the PAN is returned exactly once with no-store
  // and is never logged or persisted.
  app.post("/cards/:id/reveal", requireAgentSig, async (c) => {
    if (cardRevealMode !== "token") return c.json({ error: "card_reveal_unavailable" }, 404);
    if (!cardIssuer) return c.json({ error: "card_bridge_unavailable" }, 503);
    const agentId = c.get("agentId");
    const cardId = c.req.param("id") ?? "";
    const body = await readBody<{ checkoutToken: string }>(c);
    if (!validUuid(cardId) || !body || typeof body.checkoutToken !== "string"
      || body.checkoutToken.length < 16 || body.checkoutToken.length > 512) {
      return c.json({ error: "invalid_request", reason: "need the card id and its single-use checkoutToken" }, 400);
    }
    try {
      // The kernel binds the consume to both the signer and the card id from
      // the URL, and refuses BEFORE marking the token consumed on a mismatch,
      // so posting a token to the wrong card never burns a bounded reveal.
      const grant = await cards.consumeRevealToken(checkoutTokenHash(body.checkoutToken), agentId, cardId);
      if (grant.cardId !== cardId || grant.agentId !== agentId) {
        // Defense in depth only: the kernel has already enforced both bindings.
        return c.json({ error: "conflict", reason: "checkout token does not belong to this card" }, 409);
      }
      let secrets;
      try {
        secrets = await cardIssuer.revealCard(grant.providerCardRef);
      } catch {
        // Deliberately detail-free: a failed issuer reveal must never leak a
        // response body that could carry card material.
        return c.json({ error: "card_reveal_failed", reason: "The issuer reveal request could not be completed." }, 502);
      }
      c.header("cache-control", "no-store");
      return c.json({
        cardId,
        pan: secrets.pan,
        cvc: secrets.cvc,
        expMonth: secrets.expMonth,
        expYear: secrets.expYear,
      });
    } catch (error) {
      const code = databaseCode(error);
      if (code === "55000") return c.json({ error: "conflict", reason: errorMessage(error) }, 409);
      if (code === "P0002") return c.json({ error: "checkout_token_not_found" }, 404);
      return databaseFailure(c, error, "card_reveal_failed");
    }
  });

  app.get("/owner/cards", requireOwnerAccess, async (c) => {
    try {
      return c.json((await cards.list(c.get("userId"), 100)).map(cardView));
    } catch (error) {
      return databaseFailure(c, error, "card_list_failed");
    }
  });
  app.post("/owner/cards/:id/close", requireOwnerAccess, (c) => closeCardRoute(c, c.get("userId")));

  app.get("/agent/state", requireAgentSig, async (c) => {
    const requested = Number(c.req.query("limit") ?? 25);
    const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(100, requested)) : 25;
    return c.json(await childSnapshot(c.get("agentId"), limit));
  });

  app.get("/agent/approvals/:id", requireAgentSig, async (c) => {
    const approval = await policy.approval(c.get("agentId"), c.req.param("id") ?? "");
    return approval ? c.json(approvalView(approval)) : c.json({ error: "approval_not_found" }, 404);
  });

  const requestTreasuryPayout = async (c: Context<ApiEnv>, sourceAccountId: string) => {
    const body = await readBody<{
      destinationId: string;
      amountMicros: number | string;
      idempotencyKey: string;
    }>(c);
    const amount = body ? positiveMicros(body.amountMicros) : undefined;
    if (!body || !validUuid(body.destinationId) || amount === undefined || amount % 10_000n !== 0n
      || !validClientKey(body.idempotencyKey)) {
      return c.json({
        error: "invalid_request",
        reason: "need a verified destinationId, positive whole-cent amountMicros, and idempotencyKey",
      }, 400);
    }
    try {
      const result = await treasury.requestPayout({
        sourceAccountId, idempotencyKey: body.idempotencyKey,
        destinationId: body.destinationId, asset: "USD", amountMicros: amount,
      });
      if (result.status === "denied") {
        return c.json({ status: "denied", code: result.code, reason: result.reason, replayed: result.replayed },
          result.code === "idempotency_conflict" ? 409 : result.code === "insufficient_funds" ? 402 : 422);
      }
      const item = result.payoutId ? await treasury.payout(sourceAccountId, result.payoutId) : undefined;
      if (!item) throw new Error("treasury payout lifecycle row could not be read back");
      return c.json({ payout: treasuryPayoutView(item), replayed: result.replayed }, 202);
    } catch (error) {
      return databaseFailure(c, error, "payout_request_failed");
    }
  };

  const cancelTreasuryPayout = async (c: Context<ApiEnv>, sourceAccountId: string) => {
    const payoutId = c.req.param("id") ?? "";
    if (!validUuid(payoutId)) return c.json({ error: "payout_not_found" }, 404);
    try {
      const result = await treasury.cancelPayout(sourceAccountId, payoutId);
      if (result.status === "denied") {
        return c.json({ status: "denied", code: result.code, reason: result.reason, replayed: result.replayed }, 409);
      }
      const item = await treasury.payout(sourceAccountId, payoutId);
      if (!item) throw new Error("cancelled payout lifecycle row could not be read back");
      return c.json({ payout: treasuryPayoutView(item), replayed: result.replayed });
    } catch (error) {
      return databaseFailure(c, error, "payout_cancellation_failed");
    }
  };

  app.get("/owner/treasury", requireOwnerAccess, async (c) => {
    try {
      return c.json(await treasurySnapshot(c.get("userId"), true));
    } catch (error) {
      return databaseFailure(c, error, "treasury_state_failed");
    }
  });
  app.post("/owner/payouts", requireOwnerAccess, (c) => requestTreasuryPayout(c, c.get("userId")));
  app.post("/owner/payouts/:id/cancel", requireOwnerAccess, (c) => cancelTreasuryPayout(c, c.get("userId")));

  app.get("/owner/compliance", requireOwnerAccess, async (c) => {
    try {
      const state = await compliance.state(c.get("userId"));
      return state ? c.json(complianceView(state)) : c.json({ error: "compliance_not_found" }, 404);
    } catch (error) {
      return databaseFailure(c, error, "compliance_state_failed");
    }
  });

  app.post("/owner/compliance", requireOwnerAccess, async (c) => {
    const body = await readBody<{
      subjectType: "individual" | "business";
      countryCode: string;
      expectedSingleMicros: string | number;
      expectedMonthlyMicros: string | number;
    }>(c);
    const expectedSingleMicros = nonnegativeMicros(body?.expectedSingleMicros);
    const expectedMonthlyMicros = nonnegativeMicros(body?.expectedMonthlyMicros);
    if (!body || !["individual", "business"].includes(body.subjectType)
      || !/^[A-Z]{2}$/.test(body.countryCode ?? "")
      || expectedSingleMicros === undefined || expectedMonthlyMicros === undefined
      || expectedMonthlyMicros < expectedSingleMicros) {
      return c.json({
        error: "invalid_request",
        reason: "need subjectType, two-letter countryCode, and non-negative expected activity",
      }, 400);
    }
    try {
      const state = await compliance.beginVerification({
        userId: c.get("userId"), subjectType: body.subjectType,
        countryCode: body.countryCode, expectedSingleMicros, expectedMonthlyMicros,
      });
      return c.json({
        ...complianceView(state),
        next: "Complete the identity-verification inquiry supplied by the configured compliance provider.",
      }, 202);
    } catch (error) {
      return databaseFailure(c, error, "compliance_onboarding_failed");
    }
  });

  const verificationSessionView = async (userId: string, sessionId: string) => {
    const session = await compliance.verificationSession(userId, sessionId);
    if (!session) return undefined;
    const base = {
      id: session.id,
      state: session.state,
      expiresAt: session.expiresAt.getTime(),
      updatedAt: session.updatedAt.getTime(),
    };
    if (session.state !== "ready") return base;
    if (!options.complianceSessionKeyring || !session.hostedUrlCiphertext
      || !session.hostedUrlHash || !session.encryptionKeyId) {
      throw new Error("ready verification session is missing encrypted URL evidence");
    }
    const decrypted = decryptHostedVerificationUrl(
      session.hostedUrlCiphertext,
      options.complianceSessionKeyring,
      {
        sessionId: session.id,
        subjectAccountId: session.subjectAccountId,
        provider: session.provider,
        expiresAt: session.expiresAt,
      },
      session.encryptionKeyId,
    ).plaintext;
    const hash = createHash("sha256").update(decrypted, "utf8").digest();
    if (!hash.equals(session.hostedUrlHash)) {
      throw new Error("hosted verification URL hash does not match durable evidence");
    }
    return { ...base, hostedUrl: decrypted };
  };

  app.post("/owner/compliance/inquiries", requireOwnerAccess, async (c) => {
    if (!complianceOnboardingReady) {
      return c.json({
        error: "compliance_provider_unavailable",
        reason: "Hosted identity verification is not configured.",
      }, 503);
    }
    const body = await readBody<{ idempotencyKey: string }>(c);
    if (!body || !/^[A-Za-z0-9._:-]{8,200}$/.test(body.idempotencyKey ?? "")) {
      return c.json({ error: "invalid_request", reason: "a safe idempotencyKey is required" }, 400);
    }
    try {
      const requested = await compliance.requestVerificationSession({
        userId: c.get("userId"),
        provider: options.complianceProviderName!,
        idempotencyKey: body.idempotencyKey,
      });
      const view = await verificationSessionView(c.get("userId"), requested.id);
      if (!view) throw new Error("requested verification session could not be read back");
      return c.json({ ...view, replayed: requested.replayed ?? false }, view.state === "ready" ? 200 : 202);
    } catch (error) {
      return databaseFailure(c, error, "compliance_inquiry_failed");
    }
  });

  app.get("/owner/compliance/inquiries/:id", requireOwnerAccess, async (c) => {
    if (!complianceOnboardingReady) {
      return c.json({ error: "compliance_provider_unavailable" }, 503);
    }
    const sessionId = c.req.param("id") ?? "";
    if (!validUuid(sessionId)) return c.json({ error: "verification_session_not_found" }, 404);
    try {
      const view = await verificationSessionView(c.get("userId"), sessionId);
      return view ? c.json(view) : c.json({ error: "verification_session_not_found" }, 404);
    } catch (error) {
      return databaseFailure(c, error, "compliance_inquiry_state_failed");
    }
  });

  app.get("/provider/treasury", requireProviderSig, async (c) => {
    try {
      return c.json(await treasurySnapshot(c.get("providerId"), false));
    } catch (error) {
      return databaseFailure(c, error, "treasury_state_failed");
    }
  });
  app.post("/provider/payouts", requireProviderSig, (c) => requestTreasuryPayout(c, c.get("providerId")));
  app.post("/provider/payouts/:id/cancel", requireProviderSig, (c) => cancelTreasuryPayout(c, c.get("providerId")));

  app.get("/provider/state", requireProviderSig, async (c) => c.json(await childSnapshot(c.get("providerId"))));
  app.get("/owner/state", requireOwnerAccess, async (c) => c.json(await ownerSnapshot(c.get("userId"))));

  app.post("/owner/approvals/:id/approve", requireOwnerAccess, async (c) => {
    const userId = c.get("userId");
    const approvalId = c.req.param("id") ?? "";
    if (!validUuid(approvalId)) return c.json({ error: "approval_not_found" }, 404);
    const approval = await policy.approval(userId, approvalId);
    if (!approval) return c.json({ error: "approval_not_found" }, 404);
    try {
      if (await cards.isCardApproval(userId, approvalId)) {
        const intent = await cards.byApproval(userId, approvalId);
        if (!intent) throw new Error("card approval intent could not be read");
        let result: CardCommandResult;
        if (approval.status === "pending") {
          if (!cardIssuer) {
            return c.json({
              error: "card_bridge_unavailable",
              reason: "a card issuer adapter must be configured",
            }, 503);
          }
          const material = await cardIssuer.createCard({
            cardId: intent.id,
            capMicros: intent.capMicros,
            expiresAt: intent.expiresAt,
            merchantHint: intent.merchantHint,
            singleUse: intent.singleUse,
            agentId: intent.agentId,
            ownerId: userId,
          });
          try {
            result = await cards.resolveApproval(userId, approvalId, "approve", undefined, {
              provider: cardIssuer.provider,
              providerCardRef: material.providerCardRef,
              last4: material.last4,
              expMonth: material.expMonth,
              expYear: material.expYear,
              authTtlSeconds: cardAuthTtlSeconds,
            });
          } catch (error) {
            // Same retry contract as activatePreparedCard: a card-spend pause
            // keeps the issuer card open so a later owner approve replays
            // live material instead of a canceled card.
            if (!isRetryableCardSpendPause(error)) {
              await cardIssuer.closeCard(material.providerCardRef).catch(() => undefined);
            }
            throw error;
          }
          if (result.status === "denied") {
            await cardIssuer.closeCard(material.providerCardRef).catch(() => undefined);
          }
        } else {
          result = await cards.resolveApproval(userId, approvalId, "approve");
        }
        const updated = await policy.approval(userId, approvalId);
        if (!updated) throw new Error("resolved card approval could not be read back");
        const after = await cards.get(userId, intent.id);
        return c.json({
          approval: approvalView(updated),
          status: result.status === "posted" ? "active" : "denied",
          ...(result.code ? { code: result.code } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.receiptId ? { receiptId: result.receiptId } : {}),
          ...(after ? { card: cardView(after) } : {}),
          replayed: result.replayed,
        }, result.status === "posted" ? 200 : 409);
      }
      if (await external.isExternalApproval(userId, approvalId)) {
        const intent = await external.secretByApproval(userId, approvalId);
        if (!intent) throw new Error("external approval intent could not be read");
        const result = approval.status === "pending" ? await (async () => {
          const authorization = await signExternalIntent(intent);
          return external.resolveApproval(userId, approvalId, "approve", undefined, {
            paymentHeaderCiphertext: authorization.ciphertext,
            authorizationHash: authorization.authorizationHash,
            authorizationKeyId: authorization.keyId,
            authorizationExpiresAt: authorization.authorizationExpiresAt,
            reverseAfter: authorization.reverseAfter,
          });
        })() : await requestExistingExternal(intent);
        const updated = await policy.approval(userId, approvalId);
        if (!updated) throw new Error("resolved external approval could not be read back");
        const payment = await externalCommandView(userId, result, false, approval.agentId);
        const status = payment.status === "paid" ? 200 : payment.status === "approval_required" ? 202 : 409;
        return c.json({ approval: approvalView(updated), external: payment, replayed: result.replayed }, status);
      }
      const result = await policy.resolveApproval(userId, approvalId, "approve");
      const updated = await policy.approval(userId, approvalId);
      if (!updated) throw new Error("resolved approval could not be read back");
      const payment = await paymentView(userId, result);
      return c.json({ approval: approvalView(updated), payment, replayed: result.replayed }, payment.status === "paid" ? 200 : 409);
    } catch (error) {
      return cardFailure(c, error, "approval_failed");
    }
  });

  app.post("/owner/approvals/:id/reject", requireOwnerAccess, async (c) => {
    const userId = c.get("userId");
    const approvalId = c.req.param("id") ?? "";
    if (!validUuid(approvalId)) return c.json({ error: "approval_not_found" }, 404);
    const approval = await policy.approval(userId, approvalId);
    if (!approval) return c.json({ error: "approval_not_found" }, 404);
    const body = await readBody<{ reason?: string }>(c);
    const reason = typeof body?.reason === "string" ? body.reason.slice(0, 500) : "rejected by owner";
    try {
      if (await cards.isCardApproval(userId, approvalId)) {
        const result = await cards.resolveApproval(userId, approvalId, "reject", reason);
        const updated = await policy.approval(userId, approvalId);
        if (!updated) throw new Error("rejected card approval could not be read back");
        const intent = await cards.byApproval(userId, approvalId);
        return c.json({
          approval: approvalView(updated),
          status: "rejected",
          ...(result.code ? { code: result.code } : {}),
          ...(intent ? { card: cardView(intent) } : {}),
          replayed: result.replayed,
        });
      }
      if (await external.isExternalApproval(userId, approvalId)) {
        const result = await external.resolveApproval(userId, approvalId, "reject", reason);
        const updated = await policy.approval(userId, approvalId);
        if (!updated) throw new Error("rejected external approval could not be read back");
        return c.json({
          approval: approvalView(updated),
          external: await externalCommandView(userId, result, false, approval.agentId),
          replayed: result.replayed,
        });
      }
      const result = await policy.resolveApproval(userId, approvalId, "reject", reason);
      const updated = await policy.approval(userId, approvalId);
      if (!updated) throw new Error("rejected approval could not be read back");
      return c.json({ approval: approvalView(updated), payment: await paymentView(userId, result), replayed: result.replayed });
    } catch (error) {
      return databaseFailure(c, error, "approval_rejection_failed");
    }
  });

  let ownerAppPage: string | undefined;
  app.get("/dashboard", (c) => {
    c.header("content-security-policy", "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    c.header("referrer-policy", "no-referrer");
    c.header("x-content-type-options", "nosniff");
    ownerAppPage ??= ownerAppHtml({
      sessionOwnerWrites: Boolean(options.allowSessionOwnerWrites),
      developmentFunding: Boolean(options.allowDevelopmentFunding),
    });
    return c.html(ownerAppPage);
  });
  app.get("/dashboard/state", requireOwnerAccess, async (c) => c.json(await ownerSnapshot(c.get("userId"))));

  return { app, control, ledger, policy, marketplace, external, treasury, compliance, cards };
}

export async function startPostgresApi(port = Number(process.env.PORT ?? 4021)) {
  enforceProductionPreflight("api");
  const db = new PostgresDatabase({ applicationName: "money-product-api" });
  if (process.env.MONEY_AUTO_MIGRATE === "true") await runMigrations(db);
  const mockExternal = process.env.MONEY_EXTERNAL_MOCK === "true";
  if (mockExternal && process.env.NODE_ENV === "production") {
    throw new Error("MONEY_EXTERNAL_MOCK cannot be enabled in production");
  }
  if (process.env.NODE_ENV === "production" && process.env.MONEY_EXTERNAL_HEADER_KEY
    && !process.env.MONEY_EXTERNAL_HEADER_KEYS) {
    throw new Error("MONEY_EXTERNAL_HEADER_KEY is a legacy local fallback; production requires a versioned MONEY_EXTERNAL_HEADER_KEYS keyring");
  }
  const configuredKeyring = process.env.MONEY_EXTERNAL_HEADER_KEYS
    ? parseExternalHeaderKeyring(
      process.env.MONEY_EXTERNAL_HEADER_KEYS,
      process.env.MONEY_EXTERNAL_HEADER_ACTIVE_KEY_ID ?? ""
    )
    : process.env.MONEY_EXTERNAL_HEADER_KEY
      ? singleExternalHeaderKeyring(parseExternalHeaderKey(process.env.MONEY_EXTERNAL_HEADER_KEY))
      : undefined;
  if (Boolean(process.env.MONEY_COMPLIANCE_SESSION_KEYS)
    !== Boolean(process.env.MONEY_COMPLIANCE_SESSION_ACTIVE_KEY_ID)) {
    throw new Error("both MONEY_COMPLIANCE_SESSION_KEYS and MONEY_COMPLIANCE_SESSION_ACTIVE_KEY_ID are required together");
  }
  const complianceSessionKeyring = process.env.MONEY_COMPLIANCE_SESSION_KEYS
    ? parseComplianceSessionKeyring(
      process.env.MONEY_COMPLIANCE_SESSION_KEYS,
      process.env.MONEY_COMPLIANCE_SESSION_ACTIVE_KEY_ID!,
    )
    : undefined;
  if (mockExternal && !configuredKeyring) throw new Error("an external header keyring is required when MONEY_EXTERNAL_MOCK=true");
  const mockWallet = mockExternal ? new MockWallet() : undefined;
  if (mockExternal && (process.env.MONEY_EVM_SIGNER_URL || process.env.MONEY_EVM_PRIVATE_KEY)) {
    throw new Error("mock and real external signer modes are mutually exclusive");
  }
  if (process.env.MONEY_EVM_PRIVATE_KEY && process.env.NODE_ENV === "production") {
    throw new Error("MONEY_EVM_PRIVATE_KEY is refused in production; use the remote HSM signer adapter");
  }
  let evmSigner: HttpEvmSigner | LocalEvmSigner | undefined;
  if (process.env.MONEY_EVM_SIGNER_URL) {
    if (!process.env.MONEY_EVM_SIGNER_ADDRESS) throw new Error("MONEY_EVM_SIGNER_ADDRESS is required with MONEY_EVM_SIGNER_URL");
    if (process.env.NODE_ENV === "production"
      && (!process.env.MONEY_EVM_SIGNER_TOKEN
        || process.env.MONEY_EVM_SIGNER_TOKEN.length < 32)) {
      throw new Error("production remote EVM signing requires MONEY_EVM_SIGNER_TOKEN with at least 32 characters");
    }
    evmSigner = new HttpEvmSigner({
      url: process.env.MONEY_EVM_SIGNER_URL,
      address: process.env.MONEY_EVM_SIGNER_ADDRESS,
      ...(process.env.MONEY_EVM_SIGNER_TOKEN ? { bearerToken: process.env.MONEY_EVM_SIGNER_TOKEN } : {}),
      allowInsecureLocalhost: process.env.NODE_ENV !== "production",
    });
  } else if (process.env.MONEY_EVM_PRIVATE_KEY) {
    evmSigner = new LocalEvmSigner(process.env.MONEY_EVM_PRIVATE_KEY);
  }
  const v2PaymentSigner = evmSigner ? new X402V2EvmPaymentSigner(evmSigner) : undefined;
  const rpcVerifier = process.env.MONEY_EVM_RPC_URLS
    ? new EvmRpcSettlementVerifier(parseEvmRpcNetworks(process.env.MONEY_EVM_RPC_URLS))
    : undefined;
  if (v2PaymentSigner && !rpcVerifier) throw new Error("MONEY_EVM_RPC_URLS is required for independent settlement verification");
  const signupInvites = parseSignupInvites(process.env.MONEY_SIGNUP_INVITES);
  // Card rail: this process holds the create/close/reveal issuer credential
  // and never the webhook secrets; preflight enforces the same split.
  const cardIssuer = process.env.MONEY_CARD_PROVIDER?.trim()
    ? createCardIssuerFromEnv(process.env, { role: "api" })
    : undefined;
  const cardRevealMode = readCardRevealMode(process.env);
  const cardRevealTokenKey = process.env.MONEY_CARD_REVEAL_TOKEN_KEY;
  if (cardRevealMode === "token" && (cardRevealTokenKey ?? "").length < 32) {
    throw new Error("MONEY_CARD_REVEAL_TOKEN_KEY with at least 32 characters is required when MONEY_CARD_REVEAL_MODE=token");
  }
  const { app } = createPostgresApi(db, {
    allowDevelopmentFunding: process.env.MONEY_ALLOW_DEV_FUNDING === "true",
    allowSessionOwnerWrites: process.env.MONEY_ALLOW_SESSION_OWNER_WRITES === "true",
    ...(signupInvites.length ? { signupInvites } : {}),
    ...(configuredKeyring ? { externalHeaderKeyring: configuredKeyring } : {}),
    ...(complianceSessionKeyring && process.env.MONEY_COMPLIANCE_PROVIDER
      ? {
        complianceSessionKeyring,
        complianceProviderName: process.env.MONEY_COMPLIANCE_PROVIDER,
      }
      : {}),
    ...(cardIssuer ? { cardIssuer } : {}),
    cardRevealMode,
    ...(cardRevealTokenKey ? { cardRevealTokenKey: Buffer.from(cardRevealTokenKey, "utf8") } : {}),
    cardAuthTtlSeconds: readCardAuthTtlSeconds(process.env),
    ...(v2PaymentSigner ? { externalPaymentSigner: v2PaymentSigner } : {}),
    ...(rpcVerifier ? {
      verifyExternalSettlement: ({ authorization, settlement }: ExternalSettlementVerificationInput) => {
        if (authorization.protocolVersion !== 2 || !authorization.accepted) {
          return { ok: false, reason: "independent EVM verifier accepts x402 v2 EIP-3009 only" };
        }
        return rpcVerifier.verify({
          requirement: authorization.accepted,
          authorization: authorization.authorization,
          signature: authorization.signature,
          settlement,
        });
      },
    } : {}),
    ...(mockWallet ? {
      externalWallet: mockWallet,
      // Explicit local-only fake rail. Production injects a facilitator or
      // chain verifier and must never rely on seller-controlled claim fields.
      verifyExternalSettlement: ({ settlement }: ExternalSettlementVerificationInput) => ({
        ok: /^0xmock[0-9a-z_-]{1,240}$/i.test(settlement.transaction),
        ...(!/^0xmock[0-9a-z_-]{1,240}$/i.test(settlement.transaction)
          ? { reason: "mock settlement transaction must start with 0xmock" } : {}),
      }),
    } : {}),
  });
  const hostname = listenHost("127.0.0.1");
  const server = serve({ fetch: app.fetch, hostname, port });
  console.log(`Postgres money API listening on http://${hostname}:${port}`);
  console.log(`private owner dashboard at http://${hostname}:${port}/dashboard`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  };
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  return { app, server, db, close, port };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startPostgresApi().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
