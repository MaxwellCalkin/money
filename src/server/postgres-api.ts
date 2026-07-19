import { serve } from "@hono/node-server";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Hono, type Context, type Next } from "hono";
import { decryptPaymentHeader, encryptPaymentHeader, parseExternalHeaderKey, type ExternalAuthorizationBinding } from "../bridge/cipher.ts";
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
import { MockWallet, type ExternalWallet } from "../bridge/wallet.ts";
import { isValidPublicKey, verifyRequest } from "../core/identity.ts";
import { isValidHandle, isValidServiceSlug, normalizeServiceSlug } from "../core/network.ts";
import type { DatabaseAccount } from "../db/ledger.ts";
import { PostgresLedger, type DatabaseTransferResult } from "../db/ledger.ts";
import { PostgresControlPlane, type AccountBalance, type DatabaseService, type PaymentEvidence } from "../db/control-plane.ts";
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
import { dashboardHtml } from "./dashboard.ts";

const AUTH_WINDOW_MS = 2 * 60_000;
const CLOCK_SKEW_MS = 30_000;
const MAX_SIGNED_BODY_BYTES = 256 * 1024;

type ApiEnv = { Variables: { agentId: string; userId: string; providerId: string } };
type IdentityKind = "user" | "agent" | "provider";

export interface PostgresApiOptions {
  /** Local demos only. Real top-ups arrive through the separate treasury role. */
  allowDevelopmentFunding?: boolean;
  /** All three external options are required; otherwise x402 routes fail closed. */
  externalWallet?: ExternalWallet;
  externalHeaderKey?: Uint8Array;
  verifyExternalSettlement?: ExternalSettlementVerifier;
  now?: () => number;
}

export interface ExternalSettlementVerificationInput {
  payment: DatabaseExternalPaymentSecret;
  paymentHeader: string;
  authorization: XPaymentPayload;
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
    authorizationExpiresAt: payment.authorizationExpiresAt.getTime(),
    reverseAfter: payment.reverseAfter.getTime(),
    ...(payment.settledTx ? { settledTx: payment.settledTx } : {}),
    ...(payment.reversalTransferId ? { reversalTransferId: payment.reversalTransferId } : {}),
    createdAt: payment.createdAt.getTime(),
    updatedAt: payment.updatedAt.getTime(),
  };
}

function externalBinding(payment: DatabaseExternalPaymentSecret): ExternalAuthorizationBinding {
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
  const clock = options.now ?? Date.now;
  const externalHeaderKey = options.externalHeaderKey ? Buffer.from(options.externalHeaderKey) : undefined;
  if (externalHeaderKey && externalHeaderKey.length !== 32) {
    throw new Error("externalHeaderKey must contain exactly 32 bytes");
  }
  const externalBridgeReady = Boolean(
    options.externalWallet && externalHeaderKey && options.verifyExternalSettlement
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
  app.use("/dashboard/state", noStore);

  const readBody = async <T>(c: Context): Promise<T | null> => c.req.json<T>().catch(() => null);

  const databaseFailure = (c: Context, error: unknown, fallback: string) => {
    const code = databaseCode(error);
    const reason = errorMessage(error);
    if (code === "23505") return c.json({ error: "conflict", reason }, 409);
    if (code === "42501") return c.json({ error: "forbidden", reason }, 403);
    if (code === "P0002") return c.json({ error: "not_found", reason }, 404);
    if (code === "22023" || code === "23503") return c.json({ error: "invalid_request", reason }, 400);
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
    authorization: XPaymentPayload;
  } => {
    if (!externalHeaderKey || !options.externalWallet) throw new Error("external bridge is unavailable");
    const header = decryptPaymentHeader(
      payment.paymentHeaderCiphertext,
      externalHeaderKey,
      externalBinding(payment)
    );
    const digest = createHash("sha256").update(header, "utf8").digest();
    if (!digest.equals(payment.authorizationHash)) throw new Error("external authorization hash mismatch");
    const authorization = decodeXPayment(header);
    const auth = authorization?.payload.authorization;
    if (!authorization || !auth || authorization.scheme !== "exact"
      || authorization.network !== payment.settlementNetwork
      || auth.from.toLowerCase() !== options.externalWallet.address.toLowerCase()
      || auth.to.toLowerCase() !== payment.payTo.toLowerCase()
      || auth.value !== payment.amountMicros.toString()
      || Number(auth.validBefore) * 1_000 !== payment.authorizationExpiresAt.getTime()) {
      throw new Error("stored external authorization does not match durable payment terms");
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
    }
  ) => payment.host === input.host
    && payment.payTo.toLowerCase() === input.payTo.toLowerCase()
    && payment.settlementAsset.toLowerCase() === input.settlementAsset.toLowerCase()
    && payment.settlementNetwork === input.settlementNetwork
    && payment.resource === input.resource
    && payment.policyPayee === input.policyPayee
    && payment.amountMicros === input.amountMicros;

  const requestExistingExternal = (payment: DatabaseExternalPaymentSecret) => external.request({
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
    paymentHeaderCiphertext: payment.paymentHeaderCiphertext,
    authorizationHash: payment.authorizationHash,
    authorizationExpiresAt: payment.authorizationExpiresAt,
    reverseAfter: payment.reverseAfter,
  });

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
      resource: payment.resource,
      ...(decrypted ? { paymentHeader: decrypted.header } : {}),
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

  const ownerSnapshot = async (userId: string) => {
    const [accounts, mandates, approvals, feed, services, externalPayments] = await Promise.all([
      control.accountState(userId),
      policy.listMandates(userId, 100),
      policy.listApprovals(userId, undefined, 100),
      stateFeed(userId, 25),
      servicesView(userId),
      external.list(userId, 100),
    ]);
    const renderedApprovals = await approvalViews(userId, approvals.reverse());
    return {
      now: Date.now(),
      // Posting constraints enforce zero-sum journals and immutable evidence.
      // Expensive global recomputation belongs to /ops/reconcile, not a UI poll.
      zeroSum: true,
      receiptsOk: true,
      accounts: accounts.map(accountView),
      services,
      mandates: mandates.map(mandateView),
      approvals: renderedApprovals,
      feed,
      external: externalPayments.map(externalView),
    };
  };

  const childSnapshot = async (accountId: string, limit = 25) => {
    const [accounts, mandates, approvals, feed, services, externalPayments] = await Promise.all([
      control.accountState(accountId),
      policy.listMandates(accountId, 100),
      policy.listApprovals(accountId, undefined, 100),
      stateFeed(accountId, limit),
      servicesView(accountId),
      external.list(accountId, Math.min(limit, 100)),
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
          and to_regprocedure('money_private.request_external_payment(uuid,text,text,text,text,text,text,text,text,bigint,bytea,bytea,timestamptz,timestamptz)') is not null
          and to_regprocedure('money_private.confirm_external_payment(text,uuid,text)') is not null as ready
      `);
      return result.rows[0]?.ready
        ? c.json({ ok: true, schemaVersion: result.rows[0].version })
        : c.json({ ok: false, error: "schema_not_ready" }, 503);
    } catch {
      return c.json({ ok: false, error: "database_unavailable" }, 503);
    }
  });

  app.post("/users", async (c) => {
    const body = await readBody<{ name: string; publicKey: string; handle?: string }>(c);
    if (!body || typeof body.name !== "string" || body.name.length < 1 || body.name.length > 200
      || !isValidPublicKey(body.publicKey) || (body.handle !== undefined && !isValidHandle(body.handle))) {
      return c.json({ error: "invalid_request", reason: "need name, a valid Ed25519 publicKey, and optional valid handle" }, 400);
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

  app.post("/fund", requireOwnerSig, async (c) => {
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

  app.post("/allocate", requireOwnerSig, async (c) => {
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

  app.post("/mandates", requireOwnerSig, async (c) => {
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

  app.post("/mandates/:id/revoke", requireOwnerSig, async (c) => {
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
    if (!externalBridgeReady || !options.externalWallet || !externalHeaderKey) {
      return c.json({
        error: "external_bridge_unavailable",
        reason: "wallet, header encryption, and settlement verification must all be configured",
      }, 503);
    }
    const agentId = c.get("agentId");
    const body = await readBody<{
      url: string;
      requirement: PaymentRequirements;
      idempotencyKey: string;
    }>(c);
    if (!body || typeof body.url !== "string" || body.url.length < 1 || body.url.length > 2_048
      || !body.requirement || typeof body.requirement !== "object" || !validClientKey(body.idempotencyKey)) {
      return c.json({ error: "invalid_request", reason: "need url, requirement, and idempotencyKey" }, 400);
    }
    const host = canonicalHostOf(body.url);
    if (!host.ok) return c.json({ error: "invalid_request", reason: host.reason }, 400);
    const amount = requirementToMicros(body.requirement);
    if (!amount.ok) return c.json({ error: "invalid_request", reason: amount.reason }, 400);
    const amountMicros = BigInt(amount.micros);
    const terms = {
      host: host.host,
      payTo: body.requirement.payTo,
      settlementAsset: body.requirement.asset,
      settlementNetwork: body.requirement.network,
      resource: body.url,
      policyPayee: `x402:${host.host}:${body.requirement.payTo.toLowerCase()}`,
      amountMicros,
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
        const result = await requestExistingExternal(prior);
        const view = await externalCommandView(agentId, result, true);
        if (view.status === "paid") return c.json(view, 200);
        if (view.status === "approval_required") return c.json(view, 202);
        return c.json(view, view.code === "idempotency_conflict" || view.state === "reversed" ? 409 : 402);
      }

      const issuedAt = clock();
      const { header, authorization } = buildXPayment(options.externalWallet, body.requirement, issuedAt);
      const validBeforeSeconds = Number(authorization.validBefore);
      if (!Number.isSafeInteger(validBeforeSeconds) || validBeforeSeconds * 1_000 <= issuedAt) {
        return c.json({ error: "invalid_request", reason: "payment authorization has no usable validity window" }, 400);
      }
      const externalId = randomUUID();
      const authorizationExpiresAt = new Date(validBeforeSeconds * 1_000);
      // Keep a bounded confirmation grace window after the authorization can
      // no longer be spent. This absorbs facilitator/chain verification lag
      // without leaving a pending ledger debit indefinitely.
      const reverseAfter = new Date(authorizationExpiresAt.getTime() + 5 * 60_000);
      const binding: ExternalAuthorizationBinding = {
        externalId,
        agentId,
        idempotencyKey: body.idempotencyKey,
        ...terms,
        authorizationExpiresAt,
        reverseAfter,
      };
      const ciphertext = encryptPaymentHeader(header, externalHeaderKey, binding);
      const result = await external.request({
        externalId,
        agentId,
        idempotencyKey: body.idempotencyKey,
        ...terms,
        paymentHeaderCiphertext: ciphertext,
        authorizationHash: createHash("sha256").update(header, "utf8").digest(),
        authorizationExpiresAt,
        reverseAfter,
      });
      const view = await externalCommandView(agentId, result, true);
      if (view.status === "paid") return c.json(view, 200);
      if (view.status === "approval_required") return c.json(view, 202);
      return c.json(view, view.code === "idempotency_conflict" ? 409 : 402);
    } catch (error) {
      return databaseFailure(c, error, "external_payment_failed");
    }
  });

  // Settlement verification deliberately happens before the short database
  // transaction. The final command then serializes confirmation against the
  // reversal worker; exactly one state transition can win.
  app.post("/pay-external/:id/confirm", requireAgentSig, async (c) => {
    if (!externalBridgeReady || !options.externalWallet || !options.verifyExternalSettlement) {
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
      const auth = decrypted.authorization.payload.authorization;
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

  app.get("/agent/state", requireAgentSig, async (c) => {
    const requested = Number(c.req.query("limit") ?? 25);
    const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(100, requested)) : 25;
    return c.json(await childSnapshot(c.get("agentId"), limit));
  });

  app.get("/agent/approvals/:id", requireAgentSig, async (c) => {
    const approval = await policy.approval(c.get("agentId"), c.req.param("id") ?? "");
    return approval ? c.json(approvalView(approval)) : c.json({ error: "approval_not_found" }, 404);
  });

  app.get("/provider/state", requireProviderSig, async (c) => c.json(await childSnapshot(c.get("providerId"))));
  app.get("/owner/state", requireOwnerAccess, async (c) => c.json(await ownerSnapshot(c.get("userId"))));

  app.post("/owner/approvals/:id/approve", requireOwnerAccess, async (c) => {
    const userId = c.get("userId");
    const approvalId = c.req.param("id") ?? "";
    if (!validUuid(approvalId)) return c.json({ error: "approval_not_found" }, 404);
    const approval = await policy.approval(userId, approvalId);
    if (!approval) return c.json({ error: "approval_not_found" }, 404);
    try {
      if (await external.isExternalApproval(userId, approvalId)) {
        const result = await external.resolveApproval(userId, approvalId, "approve");
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
      return databaseFailure(c, error, "approval_failed");
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

  app.get("/dashboard", (c) => {
    c.header("content-security-policy", "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    c.header("referrer-policy", "no-referrer");
    c.header("x-content-type-options", "nosniff");
    return c.html(dashboardHtml);
  });
  app.get("/dashboard/state", requireOwnerAccess, async (c) => c.json(await ownerSnapshot(c.get("userId"))));

  return { app, control, ledger, policy, marketplace, external };
}

export async function startPostgresApi(port = Number(process.env.PORT ?? 4021)) {
  const db = new PostgresDatabase({ applicationName: "money-product-api" });
  if (process.env.MONEY_AUTO_MIGRATE === "true") await runMigrations(db);
  const mockExternal = process.env.MONEY_EXTERNAL_MOCK === "true";
  if (mockExternal && process.env.NODE_ENV === "production") {
    throw new Error("MONEY_EXTERNAL_MOCK cannot be enabled in production");
  }
  const configuredKey = process.env.MONEY_EXTERNAL_HEADER_KEY
    ? parseExternalHeaderKey(process.env.MONEY_EXTERNAL_HEADER_KEY)
    : undefined;
  if (mockExternal && !configuredKey) {
    throw new Error("MONEY_EXTERNAL_HEADER_KEY is required when MONEY_EXTERNAL_MOCK=true");
  }
  const mockWallet = mockExternal ? new MockWallet() : undefined;
  const { app } = createPostgresApi(db, {
    allowDevelopmentFunding: process.env.MONEY_ALLOW_DEV_FUNDING === "true",
    ...(configuredKey ? { externalHeaderKey: configuredKey } : {}),
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
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  console.log(`Postgres money API listening on http://127.0.0.1:${port}`);
  console.log(`private owner dashboard at http://127.0.0.1:${port}/dashboard`);
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
