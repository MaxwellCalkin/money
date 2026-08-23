import type { SqlExecutor } from "./database.ts";

export type CardState = "prepared" | "approval_required" | "cancelled" | "pending" | "confirmed" | "reversed";
export type CardCommandStatus = "prepared" | "posted" | "approval_required" | "denied";
export type CardAuthorizationState = "declined" | "pending" | "confirmed" | "reversed";
export type CardDecision = "approved" | "declined";
export type CardDeclineCode =
  | "card_not_active" | "card_expired" | "treasury_breaker" | "mandate_revoked" | "mandate_expired"
  | "duplicate_authorization" | "mcc_not_allowed" | "payee_not_allowed" | "merchant_lock"
  | "single_use" | "new_payee_cap" | "card_cap";

type Micros = bigint | number | string;
type Timestamp = Date | string;

interface CardCommandRow extends Record<string, unknown> {
  status: CardCommandStatus;
  replayed: boolean;
  card_id: string | null;
  card_state: CardState | null;
  transfer_id: string | null;
  receipt_id: string | null;
  approval_id: string | null;
  denial_code: string | null;
  reason: string | null;
  from_balance_micros: Micros | null;
  to_balance_micros: Micros | null;
}

interface CardRow extends Record<string, unknown> {
  id: string;
  agent_id: string;
  mandate_id: string;
  idempotency_key: string;
  state: CardState;
  cap_micros: Micros;
  held_micros: Micros;
  settled_micros: Micros;
  single_use: boolean;
  merchant_hint: string;
  policy_payee: string;
  locked_payee: string | null;
  mcc_allowlist: string[] | null;
  expires_at: Timestamp;
  reverse_after: Timestamp | null;
  approval_id: string | null;
  transfer_seq: Micros | null;
  receipt_id: string | null;
  release_transfer_seq: Micros | null;
  provider: string | null;
  provider_card_ref: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  reveal_count: number;
  close_requested_at: Timestamp | null;
  close_reason: string | null;
  issuer_closed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface CardAuthorizationRow extends Record<string, unknown> {
  id: string;
  card_id: string;
  agent_id: string;
  provider: string;
  provider_event_id: string;
  provider_authorization_ref: string;
  policy_payee: string;
  merchant_descriptor: string;
  merchant_mcc: string;
  merchant_network_id: string | null;
  merchant_country: string | null;
  amount_micros: Micros;
  is_verification: boolean;
  settled_micros: Micros | null;
  state: CardAuthorizationState;
  decline_code: string | null;
  reverse_after: Timestamp | null;
  settled_event_id: string | null;
  voided_event_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface CardSettlementRow extends Record<string, unknown> {
  result_status: string;
  replayed: boolean;
  authorization_id: string;
  card_id: string;
  card_state: CardState;
  held_micros: Micros;
  settled_micros: Micros;
}

export interface CardCommandResult {
  status: CardCommandStatus;
  replayed: boolean;
  cardId?: string;
  cardState?: CardState;
  transferId?: string;
  receiptId?: string;
  approvalId?: string;
  code?: string;
  reason?: string;
  fromBalanceMicros?: bigint;
  toBalanceMicros?: bigint;
}

/** A card row as the database stores it. `providerCardRef` is the issuer's
 * opaque card identifier, never a card number; API surfaces must not return it
 * to agents or owners. */
export interface DatabaseCard {
  id: string;
  agentId: string;
  mandateId: string;
  idempotencyKey: string;
  state: CardState;
  capMicros: bigint;
  heldMicros: bigint;
  settledMicros: bigint;
  singleUse: boolean;
  merchantHint: string;
  policyPayee: string;
  lockedPayee?: string;
  mccAllowlist?: string[];
  expiresAt: Date;
  reverseAfter?: Date;
  approvalId?: string;
  transferSeq?: bigint;
  receiptId?: string;
  releaseTransferSeq?: bigint;
  provider?: string;
  providerCardRef?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
  revealCount: number;
  closeRequestedAt?: Date;
  closeReason?: string;
  issuerClosedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface DatabaseCardAuthorization {
  id: string;
  cardId: string;
  agentId: string;
  provider: string;
  providerEventId: string;
  providerAuthorizationRef: string;
  policyPayee: string;
  merchantDescriptor: string;
  merchantMcc: string;
  merchantNetworkId?: string;
  merchantCountry?: string;
  amountMicros: bigint;
  isVerification: boolean;
  settledMicros?: bigint;
  state: CardAuthorizationState;
  declineCode?: string;
  reverseAfter?: Date;
  settledEventId?: string;
  voidedEventId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CardAuthorizationDecision {
  decision: CardDecision;
  declineCode?: CardDeclineCode | string;
  authorizationId?: string;
  cardId?: string;
  replayed: boolean;
}

export interface CardSettlementResult {
  status: string;
  replayed: boolean;
  authorizationId: string;
  cardId: string;
  cardState: CardState;
  heldMicros: bigint;
  settledMicros: bigint;
}

export interface CardRefundResult {
  status: string;
  replayed: boolean;
  refundId: string;
  authorizationId: string;
  cardId: string;
  transferId: string;
  receiptId: string;
  agentBalanceMicros: bigint;
}

export interface CardCloseResult {
  cardId: string;
  state: CardState;
  closeRequestedAt?: Date;
  releaseTransferId?: string;
  replayed: boolean;
}

export interface CardAwaitingIssuerClose {
  cardId: string;
  agentId: string;
  provider: string;
  providerCardRef: string;
  state: CardState;
  closeRequestedAt?: Date;
}

/** Worker-side view of an authorization, keyed by the issuer's reference. */
export interface CardAuthorizationByRef {
  authorizationId: string;
  cardId: string;
  agentId: string;
  state: CardAuthorizationState;
  declineCode?: string;
  policyPayee: string;
  amountMicros: bigint;
  settledMicros?: bigint;
  isVerification: boolean;
  reverseAfter?: Date;
  createdAt: Date;
}

/** Worker-side view of a card, keyed by the issuer's card reference. */
export interface CardByProviderRef {
  cardId: string;
  agentId: string;
  state: CardState;
  heldMicros: bigint;
  settledMicros: bigint;
  capMicros: bigint;
  closeRequestedAt?: Date;
  issuerClosedAt?: Date;
}

export interface CardRevealToken {
  cardId: string;
  expiresAt: Date;
  revealCount: number;
}

export interface CardRevealGrant {
  cardId: string;
  agentId: string;
  provider: string;
  providerCardRef: string;
}

function date(value: Timestamp): Date {
  return value instanceof Date ? value : new Date(value);
}

function optionalDate(value: Timestamp | null): Date | undefined {
  return value === null ? undefined : date(value);
}

function optionalBigInt(value: Micros | null | undefined): bigint | undefined {
  return value === null || value === undefined ? undefined : BigInt(value);
}

function commandFromRow(row?: CardCommandRow): CardCommandResult {
  if (!row) throw new Error("card command returned no result");
  return {
    status: row.status,
    replayed: row.replayed,
    ...(row.card_id ? { cardId: row.card_id } : {}),
    ...(row.card_state ? { cardState: row.card_state } : {}),
    ...(row.transfer_id ? { transferId: row.transfer_id } : {}),
    ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    ...(row.denial_code ? { code: row.denial_code } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(optionalBigInt(row.from_balance_micros) !== undefined
      ? { fromBalanceMicros: optionalBigInt(row.from_balance_micros)! } : {}),
    ...(optionalBigInt(row.to_balance_micros) !== undefined
      ? { toBalanceMicros: optionalBigInt(row.to_balance_micros)! } : {}),
  };
}

function publicFromRow(row: CardRow): DatabaseCard {
  return {
    id: row.id,
    agentId: row.agent_id,
    mandateId: row.mandate_id,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    capMicros: BigInt(row.cap_micros),
    heldMicros: BigInt(row.held_micros),
    settledMicros: BigInt(row.settled_micros),
    singleUse: row.single_use,
    merchantHint: row.merchant_hint,
    policyPayee: row.policy_payee,
    ...(row.locked_payee ? { lockedPayee: row.locked_payee } : {}),
    ...(row.mcc_allowlist ? { mccAllowlist: [...row.mcc_allowlist] } : {}),
    expiresAt: date(row.expires_at),
    ...(optionalDate(row.reverse_after) ? { reverseAfter: optionalDate(row.reverse_after)! } : {}),
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    ...(optionalBigInt(row.transfer_seq) !== undefined ? { transferSeq: optionalBigInt(row.transfer_seq)! } : {}),
    ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
    ...(optionalBigInt(row.release_transfer_seq) !== undefined
      ? { releaseTransferSeq: optionalBigInt(row.release_transfer_seq)! } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.provider_card_ref ? { providerCardRef: row.provider_card_ref } : {}),
    ...(row.last4 ? { last4: row.last4 } : {}),
    ...(row.exp_month !== null ? { expMonth: Number(row.exp_month) } : {}),
    ...(row.exp_year !== null ? { expYear: Number(row.exp_year) } : {}),
    revealCount: Number(row.reveal_count),
    ...(optionalDate(row.close_requested_at) ? { closeRequestedAt: optionalDate(row.close_requested_at)! } : {}),
    ...(row.close_reason ? { closeReason: row.close_reason } : {}),
    ...(optionalDate(row.issuer_closed_at) ? { issuerClosedAt: optionalDate(row.issuer_closed_at)! } : {}),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

function authorizationFromRow(row: CardAuthorizationRow): DatabaseCardAuthorization {
  return {
    id: row.id,
    cardId: row.card_id,
    agentId: row.agent_id,
    provider: row.provider,
    providerEventId: row.provider_event_id,
    providerAuthorizationRef: row.provider_authorization_ref,
    policyPayee: row.policy_payee,
    merchantDescriptor: row.merchant_descriptor,
    merchantMcc: row.merchant_mcc,
    ...(row.merchant_network_id ? { merchantNetworkId: row.merchant_network_id } : {}),
    ...(row.merchant_country ? { merchantCountry: row.merchant_country } : {}),
    amountMicros: BigInt(row.amount_micros),
    isVerification: row.is_verification,
    ...(optionalBigInt(row.settled_micros) !== undefined ? { settledMicros: optionalBigInt(row.settled_micros)! } : {}),
    state: row.state,
    ...(row.decline_code ? { declineCode: row.decline_code } : {}),
    ...(optionalDate(row.reverse_after) ? { reverseAfter: optionalDate(row.reverse_after)! } : {}),
    ...(row.settled_event_id ? { settledEventId: row.settled_event_id } : {}),
    ...(row.voided_event_id ? { voidedEventId: row.voided_event_id } : {}),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

function settlementFromRow(row?: CardSettlementRow): CardSettlementResult {
  if (!row) throw new Error("card settlement command returned no result");
  return {
    status: row.result_status,
    replayed: row.replayed,
    authorizationId: row.authorization_id,
    cardId: row.card_id,
    cardState: row.card_state,
    heldMicros: BigInt(row.held_micros),
    settledMicros: BigInt(row.settled_micros),
  };
}

export interface CardIssuerMaterial {
  provider: string;
  providerCardRef: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

/** Typed boundary over the card rail's SECURITY DEFINER commands. Each process
 * constructs this with its own database role (product, authorization ingress,
 * event worker, sweep worker); the class never broadens what that role may do. */
export class PostgresCards {
  constructor(readonly db: SqlExecutor) {}

  async prepare(input: {
    cardId: string;
    agentId: string;
    idempotencyKey: string;
    capMicros: Micros;
    singleUse?: boolean;
    merchantHint: string;
    mccAllowlist?: readonly string[] | null;
    expiresAt: Timestamp;
  }): Promise<CardCommandResult> {
    const result = await this.db.query<CardCommandRow>(
      `select * from money_private.prepare_card(
        $1::uuid, $2, $3, $4::bigint, $5, $6, $7::text[], $8::timestamptz
      )`,
      [
        input.cardId, input.agentId, input.idempotencyKey, BigInt(input.capMicros).toString(),
        input.singleUse ?? true, input.merchantHint,
        input.mccAllowlist === undefined || input.mccAllowlist === null ? null : [...input.mccAllowlist],
        date(input.expiresAt).toISOString(),
      ]
    );
    return commandFromRow(result.rows[0]);
  }

  async activate(input: {
    agentId: string;
    cardId: string;
    authTtlSeconds?: number;
  } & CardIssuerMaterial): Promise<CardCommandResult> {
    const result = await this.db.query<CardCommandRow>(
      `select * from money_private.activate_card(
        $1, $2::uuid, $3, $4, $5, $6::smallint, $7::smallint, $8
      )`,
      [
        input.agentId, input.cardId, input.provider, input.providerCardRef, input.last4,
        input.expMonth, input.expYear, input.authTtlSeconds ?? 604_800,
      ]
    );
    return commandFromRow(result.rows[0]);
  }

  async resolveApproval(
    userId: string,
    approvalId: string,
    action: "approve" | "reject",
    reason?: string,
    issuer?: CardIssuerMaterial & { authTtlSeconds?: number },
  ): Promise<CardCommandResult> {
    const result = await this.db.query<CardCommandRow>(
      `select * from money_private.resolve_card_approval(
        $1, $2::uuid, $3, $4, $5, $6, $7, $8::smallint, $9::smallint, $10
      )`,
      [
        userId, approvalId, action, reason ?? null,
        issuer?.provider ?? null, issuer?.providerCardRef ?? null, issuer?.last4 ?? null,
        issuer?.expMonth ?? null, issuer?.expYear ?? null, issuer?.authTtlSeconds ?? 604_800,
      ]
    );
    return commandFromRow(result.rows[0]);
  }

  async decideAuthorization(input: {
    provider: string;
    providerEventId: string;
    providerAuthorizationRef: string;
    providerCardRef: string;
    amountMicros: Micros;
    merchantDescriptor: string;
    merchantMcc: string;
    merchantNetworkId?: string;
    merchantCountry?: string;
    authTtlSeconds?: number;
  }): Promise<CardAuthorizationDecision> {
    const result = await this.db.query<{
      decision: CardDecision; decline_code: string | null;
      authorization_id: string | null; card_id: string | null; replayed: boolean;
    }>(
      `select * from money_private.decide_card_authorization(
        $1, $2, $3, $4, $5::bigint, $6, $7, $8, $9, $10
      )`,
      [
        input.provider, input.providerEventId, input.providerAuthorizationRef, input.providerCardRef,
        BigInt(input.amountMicros).toString(), input.merchantDescriptor, input.merchantMcc,
        input.merchantNetworkId ?? null, input.merchantCountry ?? null, input.authTtlSeconds ?? 604_800,
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("card authorization decision returned no result");
    return {
      decision: row.decision,
      ...(row.decline_code ? { declineCode: row.decline_code } : {}),
      ...(row.authorization_id ? { authorizationId: row.authorization_id } : {}),
      ...(row.card_id ? { cardId: row.card_id } : {}),
      replayed: row.replayed,
    };
  }

  async settleAuthorization(input: {
    provider: string; providerEventId: string; providerAuthorizationRef: string;
    settledMicros: Micros; occurredAt: Timestamp;
    payloadHash: Uint8Array; canonicalPayload: Record<string, unknown>;
    overcaptureBps?: number;
  }): Promise<CardSettlementResult> {
    const result = await this.db.query<CardSettlementRow>(
      `select * from money_private.settle_card_authorization(
        $1, $2, $3, $4::bigint, $5::timestamptz, $6::bytea, $7::jsonb, $8
      )`,
      [
        input.provider, input.providerEventId, input.providerAuthorizationRef,
        BigInt(input.settledMicros).toString(), date(input.occurredAt).toISOString(),
        Buffer.from(input.payloadHash), JSON.stringify(input.canonicalPayload), input.overcaptureBps ?? 0,
      ]
    );
    return settlementFromRow(result.rows[0]);
  }

  async voidAuthorization(input: {
    provider: string; providerEventId: string; providerAuthorizationRef: string;
    occurredAt: Timestamp; payloadHash: Uint8Array; canonicalPayload: Record<string, unknown>;
  }): Promise<CardSettlementResult> {
    const result = await this.db.query<CardSettlementRow>(
      `select * from money_private.void_card_authorization(
        $1, $2, $3, $4::timestamptz, $5::bytea, $6::jsonb
      )`,
      [
        input.provider, input.providerEventId, input.providerAuthorizationRef,
        date(input.occurredAt).toISOString(), Buffer.from(input.payloadHash), JSON.stringify(input.canonicalPayload),
      ]
    );
    return settlementFromRow(result.rows[0]);
  }

  async refundAuthorization(input: {
    provider: string; providerEventId: string; providerRefundRef: string; providerAuthorizationRef: string;
    amountMicros: Micros; occurredAt: Timestamp;
    payloadHash: Uint8Array; canonicalPayload: Record<string, unknown>;
  }): Promise<CardRefundResult> {
    const result = await this.db.query<{
      result_status: string; replayed: boolean; refund_id: string; authorization_id: string;
      card_id: string; transfer_id: string; receipt_id: string; agent_balance_micros: Micros;
    }>(
      `select * from money_private.refund_card_authorization(
        $1, $2, $3, $4, $5::bigint, $6::timestamptz, $7::bytea, $8::jsonb
      )`,
      [
        input.provider, input.providerEventId, input.providerRefundRef, input.providerAuthorizationRef,
        BigInt(input.amountMicros).toString(), date(input.occurredAt).toISOString(),
        Buffer.from(input.payloadHash), JSON.stringify(input.canonicalPayload),
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("card refund command returned no result");
    return {
      status: row.result_status, replayed: row.replayed, refundId: row.refund_id,
      authorizationId: row.authorization_id, cardId: row.card_id,
      transferId: row.transfer_id, receiptId: row.receipt_id,
      agentBalanceMicros: BigInt(row.agent_balance_micros),
    };
  }

  async closeCard(requesterId: string, cardId: string, reason?: string): Promise<CardCloseResult> {
    const result = await this.db.query<{
      card_id: string; card_state: CardState; close_requested_at: Timestamp | null;
      release_transfer_id: string | null; replayed: boolean;
    }>("select * from money_private.close_card($1, $2::uuid, $3)", [requesterId, cardId, reason ?? null]);
    const row = result.rows[0];
    if (!row) throw new Error("card close returned no result");
    return {
      cardId: row.card_id, state: row.card_state,
      ...(optionalDate(row.close_requested_at) ? { closeRequestedAt: optionalDate(row.close_requested_at)! } : {}),
      ...(row.release_transfer_id ? { releaseTransferId: row.release_transfer_id } : {}),
      replayed: row.replayed,
    };
  }

  async sweepAuthorizations(limit = 100): Promise<Array<{ authorizationId: string; cardId: string }>> {
    const result = await this.db.query<{ authorization_id: string; card_id: string }>(
      "select * from money_private.sweep_card_authorizations($1)", [limit]
    );
    return result.rows.map((row) => ({ authorizationId: row.authorization_id, cardId: row.card_id }));
  }

  async sweepCards(limit = 100): Promise<Array<{ cardId: string; state: CardState; releaseTransferId?: string }>> {
    const result = await this.db.query<{ card_id: string; card_state: CardState; release_transfer_id: string | null }>(
      "select * from money_private.sweep_cards($1)", [limit]
    );
    return result.rows.map((row) => ({
      cardId: row.card_id, state: row.card_state,
      ...(row.release_transfer_id ? { releaseTransferId: row.release_transfer_id } : {}),
    }));
  }

  async list(requesterId: string, limit = 50): Promise<DatabaseCard[]> {
    const result = await this.db.query<CardRow>(
      "select * from money_private.list_cards_for_requester($1, $2)", [requesterId, limit]
    );
    return result.rows.map(publicFromRow);
  }

  async get(requesterId: string, cardId: string): Promise<DatabaseCard | undefined> {
    const result = await this.db.query<CardRow>(
      "select * from money_private.get_card_for_requester($1, $2::uuid)", [requesterId, cardId]
    );
    return result.rows[0] ? publicFromRow(result.rows[0]) : undefined;
  }

  async byKey(agentId: string, idempotencyKey: string): Promise<DatabaseCard | undefined> {
    const result = await this.db.query<CardRow>(
      "select * from money_private.get_card_for_agent_by_key($1, $2)", [agentId, idempotencyKey]
    );
    return result.rows[0] ? publicFromRow(result.rows[0]) : undefined;
  }

  async byApproval(userId: string, approvalId: string): Promise<DatabaseCard | undefined> {
    const result = await this.db.query<CardRow>(
      "select * from money_private.get_card_by_approval_for_owner($1, $2::uuid)", [userId, approvalId]
    );
    return result.rows[0] ? publicFromRow(result.rows[0]) : undefined;
  }

  async isCardApproval(userId: string, approvalId: string): Promise<boolean> {
    const result = await this.db.query<{ is_card: boolean }>(
      "select money_private.is_card_approval($1, $2::uuid) as is_card", [userId, approvalId]
    );
    return result.rows[0]?.is_card ?? false;
  }

  async listAuthorizations(requesterId: string, cardId: string, limit = 20): Promise<DatabaseCardAuthorization[]> {
    const result = await this.db.query<CardAuthorizationRow>(
      "select * from money_private.list_card_authorizations_for_requester($1, $2::uuid, $3)",
      [requesterId, cardId, limit]
    );
    return result.rows.map(authorizationFromRow);
  }

  async issueRevealToken(input: {
    agentId: string; cardId: string; tokenHash: Uint8Array; ttlSeconds: number;
  }): Promise<CardRevealToken> {
    const result = await this.db.query<{ card_id: string; expires_at: Timestamp; reveal_count: number }>(
      "select * from money_private.issue_card_reveal_token($1, $2::uuid, $3::bytea, $4)",
      [input.agentId, input.cardId, Buffer.from(input.tokenHash), input.ttlSeconds]
    );
    const row = result.rows[0];
    if (!row) throw new Error("card reveal token returned no result");
    return { cardId: row.card_id, expiresAt: date(row.expires_at), revealCount: Number(row.reveal_count) };
  }

  /** Consumes a reveal token for the signer. The signer must be the agent the
   * token was issued to and the named card must be the one the token was
   * issued for; the kernel fails closed on either mismatch BEFORE consuming,
   * so a mistaken card id never burns one of the three bounded reveals. */
  async consumeRevealToken(tokenHash: Uint8Array, agentId: string, cardId: string): Promise<CardRevealGrant> {
    const result = await this.db.query<{
      card_id: string; agent_id: string; provider: string; provider_card_ref: string;
    }>("select * from money_private.consume_card_reveal_token($1::bytea, $2, $3::uuid)", [Buffer.from(tokenHash), agentId, cardId]);
    const row = result.rows[0];
    if (!row) throw new Error("card reveal token consumption returned no result");
    return { cardId: row.card_id, agentId: row.agent_id, provider: row.provider, providerCardRef: row.provider_card_ref };
  }

  async recordEvent(input: {
    provider: string; providerEventId: string; eventType: string; providerObjectId: string;
    payloadHash: Uint8Array; canonicalPayload: Record<string, unknown>;
  }): Promise<boolean> {
    const result = await this.db.query<{ replayed: boolean }>(
      "select money_private.record_card_provider_event($1,$2,$3,$4,$5::bytea,$6::jsonb) as replayed",
      [input.provider, input.providerEventId, input.eventType, input.providerObjectId,
        Buffer.from(input.payloadHash), JSON.stringify(input.canonicalPayload)]
    );
    return result.rows[0]?.replayed ?? false;
  }

  async enqueueEvent(input: { provider: string; providerEventId: string; endpointId: string; deliveryHash: Uint8Array }) {
    const result = await this.db.query<{ inbox_id: Micros; replayed: boolean; state: string }>(
      "select * from money_private.enqueue_card_provider_event($1,$2,$3,$4::bytea)",
      [input.provider, input.providerEventId, input.endpointId, Buffer.from(input.deliveryHash)]
    );
    const row = result.rows[0];
    if (!row) throw new Error("card event enqueue returned no result");
    return { inboxId: BigInt(row.inbox_id), replayed: row.replayed, state: row.state };
  }

  async claimEvents(workerId: string, limit: number) {
    const result = await this.db.query<{
      inbox_id: Micros; provider: string; provider_event_id: string; attempts: number;
    }>("select * from money_private.claim_card_provider_events($1,$2)", [workerId, limit]);
    return result.rows.map((row) => ({
      inboxId: BigInt(row.inbox_id), provider: row.provider,
      providerEventId: row.provider_event_id, attempts: row.attempts,
    }));
  }

  async completeEvent(workerId: string, inboxId: bigint, outcome: "completed" | "ignored") {
    await this.db.query("select money_private.complete_card_provider_event($1,$2::bigint,$3)", [workerId, inboxId.toString(), outcome]);
  }

  async failEvent(workerId: string, inboxId: bigint, error: string, retryAfterSeconds: number, dead = false) {
    await this.db.query(
      "select money_private.fail_card_provider_event($1,$2::bigint,$3,$4,$5)",
      [workerId, inboxId.toString(), error, retryAfterSeconds, dead]
    );
  }

  async awaitingIssuerClose(limit = 100): Promise<CardAwaitingIssuerClose[]> {
    const result = await this.db.query<{
      card_id: string; agent_id: string; provider: string; provider_card_ref: string;
      card_state: CardState; close_requested_at: Timestamp | null;
    }>("select * from money_private.list_cards_awaiting_issuer_close($1)", [limit]);
    return result.rows.map((row) => ({
      cardId: row.card_id, agentId: row.agent_id, provider: row.provider, providerCardRef: row.provider_card_ref,
      state: row.card_state,
      ...(optionalDate(row.close_requested_at) ? { closeRequestedAt: optionalDate(row.close_requested_at)! } : {}),
    }));
  }

  async authorizationByRef(provider: string, providerAuthorizationRef: string): Promise<CardAuthorizationByRef | undefined> {
    const result = await this.db.query<{
      authorization_id: string; card_id: string; agent_id: string; state: CardAuthorizationState;
      decline_code: string | null; policy_payee: string; amount_micros: Micros; settled_micros: Micros | null;
      is_verification: boolean; reverse_after: Timestamp | null; created_at: Timestamp;
    }>("select * from money_private.get_card_authorization_by_ref($1, $2)", [provider, providerAuthorizationRef]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      authorizationId: row.authorization_id, cardId: row.card_id, agentId: row.agent_id, state: row.state,
      ...(row.decline_code ? { declineCode: row.decline_code } : {}),
      policyPayee: row.policy_payee, amountMicros: BigInt(row.amount_micros),
      ...(optionalBigInt(row.settled_micros) !== undefined ? { settledMicros: optionalBigInt(row.settled_micros)! } : {}),
      isVerification: row.is_verification,
      ...(optionalDate(row.reverse_after) ? { reverseAfter: optionalDate(row.reverse_after)! } : {}),
      createdAt: date(row.created_at),
    };
  }

  async byProviderRef(provider: string, providerCardRef: string): Promise<CardByProviderRef | undefined> {
    const result = await this.db.query<{
      card_id: string; agent_id: string; card_state: CardState; held_micros: Micros; settled_micros: Micros;
      cap_micros: Micros; close_requested_at: Timestamp | null; issuer_closed_at: Timestamp | null;
    }>("select * from money_private.get_card_by_provider_ref($1, $2)", [provider, providerCardRef]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      cardId: row.card_id, agentId: row.agent_id, state: row.card_state,
      heldMicros: BigInt(row.held_micros), settledMicros: BigInt(row.settled_micros), capMicros: BigInt(row.cap_micros),
      ...(optionalDate(row.close_requested_at) ? { closeRequestedAt: optionalDate(row.close_requested_at)! } : {}),
      ...(optionalDate(row.issuer_closed_at) ? { issuerClosedAt: optionalDate(row.issuer_closed_at)! } : {}),
    };
  }

  /** Fail-closed containment for the event worker (role money_card_worker):
   * called when the issuer reports an approval that has no matching
   * agentmoney decision. Tripping is one-way here; only the operator's
   * restore path can reopen anything. */
  async tripBreaker(reason: string): Promise<void> {
    await this.db.query("select money_private.trip_treasury_breaker($1)", [reason]);
  }

  async markIssuerClosed(cardId: string, providerCardRef: string): Promise<boolean> {
    const result = await this.db.query<{ closed: boolean }>(
      "select money_private.mark_card_issuer_closed($1::uuid, $2) as closed", [cardId, providerCardRef]
    );
    return result.rows[0]?.closed ?? false;
  }
}
