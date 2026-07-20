import type { SqlExecutor } from "./database.ts";

export type ExternalPaymentState = "prepared" | "approval_required" | "cancelled" | "pending" | "confirmed" | "reversed";
export type ExternalCommandStatus = "prepared" | "posted" | "approval_required" | "denied";

interface ExternalCommandRow extends Record<string, unknown> {
  status: ExternalCommandStatus;
  replayed: boolean;
  external_id: string | null;
  external_state: ExternalPaymentState | null;
  transfer_id: string | null;
  receipt_id: string | null;
  approval_id: string | null;
  denial_code: string | null;
  reason: string | null;
  from_balance_micros: string | number | bigint | null;
  to_balance_micros: string | number | bigint | null;
  payment_header_ciphertext: Uint8Array | null;
  authorization_hash: Uint8Array | null;
}

interface ExternalPublicRow extends Record<string, unknown> {
  external_id: string;
  agent_id: string;
  state: ExternalPaymentState;
  host: string;
  pay_to: string;
  settlement_asset: string;
  settlement_network: string;
  resource: string;
  policy_payee: string;
  amount_micros: string | number | bigint;
  transfer_id: string | null;
  receipt_id: string | null;
  approval_id: string | null;
  authorization_expires_at: string | Date | null;
  reverse_after: string | Date | null;
  settled_tx: string | null;
  reversal_transfer_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ExternalSecretRow extends Record<string, unknown> {
  id: string;
  agent_id: string;
  transfer_seq: string | number | bigint | null;
  receipt_id: string | null;
  host: string;
  pay_to: string;
  settlement_asset: string;
  settlement_network: string;
  resource: string;
  payment_header_ciphertext: Uint8Array | null;
  state: ExternalPaymentState;
  reverse_after: string | Date | null;
  settled_tx: string | null;
  reversal_transfer_seq: string | number | bigint | null;
  created_at: string | Date;
  updated_at: string | Date;
  idempotency_key: string;
  policy_payee: string;
  amount_micros: string | number | bigint;
  authorization_hash: Uint8Array | null;
  authorization_expires_at: string | Date | null;
  approval_id: string | null;
  protocol_version: 1 | 2;
  signing_context: Record<string, unknown>;
  authorization_key_id: string | null;
  mandate_id: string | null;
}

interface ExternalRotationRow extends Record<string, unknown> {
  external_id: string;
  agent_id: string;
  idempotency_key: string;
  host: string;
  pay_to: string;
  settlement_asset: string;
  settlement_network: string;
  resource: string;
  policy_payee: string;
  amount_micros: string | number | bigint;
  payment_header_ciphertext: Uint8Array;
  authorization_hash: Uint8Array;
  authorization_key_id: string;
  authorization_expires_at: string | Date;
  reverse_after: string | Date;
}

export interface DatabaseExternalPayment {
  id: string;
  agentId: string;
  state: ExternalPaymentState;
  host: string;
  payTo: string;
  settlementAsset: string;
  settlementNetwork: string;
  resource: string;
  policyPayee: string;
  amountMicros: bigint;
  transferId?: string;
  receiptId?: string;
  approvalId?: string;
  authorizationExpiresAt?: Date;
  reverseAfter?: Date;
  settledTx?: string;
  reversalTransferId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DatabaseExternalPaymentSecret {
  id: string;
  agentId: string;
  transferSeq?: bigint;
  receiptId?: string;
  host: string;
  payTo: string;
  settlementAsset: string;
  settlementNetwork: string;
  resource: string;
  paymentHeaderCiphertext?: Buffer;
  state: ExternalPaymentState;
  reverseAfter?: Date;
  settledTx?: string;
  reversalTransferSeq?: bigint;
  createdAt: Date;
  updatedAt: Date;
  idempotencyKey: string;
  policyPayee: string;
  amountMicros: bigint;
  authorizationHash?: Buffer;
  authorizationExpiresAt?: Date;
  approvalId?: string;
  protocolVersion: 1 | 2;
  signingContext: Record<string, unknown>;
  authorizationKeyId?: string;
  mandateId?: string;
}

export interface ExternalAuthorizationRotationCandidate {
  externalId: string;
  agentId: string;
  idempotencyKey: string;
  host: string;
  payTo: string;
  settlementAsset: string;
  settlementNetwork: string;
  resource: string;
  policyPayee: string;
  amountMicros: bigint;
  paymentHeaderCiphertext: Buffer;
  authorizationHash: Buffer;
  authorizationKeyId: string;
  authorizationExpiresAt: Date;
  reverseAfter: Date;
}

export interface ExternalCommandResult {
  status: ExternalCommandStatus;
  replayed: boolean;
  externalId?: string;
  externalState?: ExternalPaymentState;
  transferId?: string;
  receiptId?: string;
  approvalId?: string;
  code?: string;
  reason?: string;
  fromBalanceMicros?: bigint;
  toBalanceMicros?: bigint;
  paymentHeaderCiphertext?: Buffer;
  authorizationHash?: Buffer;
}

export interface ExternalConfirmationResult {
  ok: boolean;
  replayed: boolean;
  state: ExternalPaymentState;
  settledTx?: string;
  reason?: string;
}

function optionalBigInt(value: string | number | bigint | null): bigint | undefined {
  return value === null ? undefined : BigInt(value);
}

function commandFromRow(row?: ExternalCommandRow): ExternalCommandResult {
  if (!row) throw new Error("external payment command returned no result");
  return {
    status: row.status,
    replayed: row.replayed,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    ...(row.external_state ? { externalState: row.external_state } : {}),
    ...(row.transfer_id ? { transferId: row.transfer_id } : {}),
    ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    ...(row.denial_code ? { code: row.denial_code } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(optionalBigInt(row.from_balance_micros) !== undefined
      ? { fromBalanceMicros: optionalBigInt(row.from_balance_micros)! } : {}),
    ...(optionalBigInt(row.to_balance_micros) !== undefined
      ? { toBalanceMicros: optionalBigInt(row.to_balance_micros)! } : {}),
    ...(row.payment_header_ciphertext
      ? { paymentHeaderCiphertext: Buffer.from(row.payment_header_ciphertext) } : {}),
    ...(row.authorization_hash ? { authorizationHash: Buffer.from(row.authorization_hash) } : {}),
  };
}

function publicFromRow(row: ExternalPublicRow): DatabaseExternalPayment {
  return {
    id: row.external_id,
    agentId: row.agent_id,
    state: row.state,
    host: row.host,
    payTo: row.pay_to,
    settlementAsset: row.settlement_asset,
    settlementNetwork: row.settlement_network,
    resource: row.resource,
    policyPayee: row.policy_payee,
    amountMicros: BigInt(row.amount_micros),
    ...(row.transfer_id ? { transferId: row.transfer_id } : {}),
    ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    ...(row.authorization_expires_at ? { authorizationExpiresAt: new Date(row.authorization_expires_at) } : {}),
    ...(row.reverse_after ? { reverseAfter: new Date(row.reverse_after) } : {}),
    ...(row.settled_tx ? { settledTx: row.settled_tx } : {}),
    ...(row.reversal_transfer_id ? { reversalTransferId: row.reversal_transfer_id } : {}),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function secretFromRow(row: ExternalSecretRow): DatabaseExternalPaymentSecret {
  return {
    id: row.id,
    agentId: row.agent_id,
    ...(optionalBigInt(row.transfer_seq) !== undefined ? { transferSeq: optionalBigInt(row.transfer_seq)! } : {}),
    ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
    host: row.host,
    payTo: row.pay_to,
    settlementAsset: row.settlement_asset,
    settlementNetwork: row.settlement_network,
    resource: row.resource,
    ...(row.payment_header_ciphertext ? { paymentHeaderCiphertext: Buffer.from(row.payment_header_ciphertext) } : {}),
    state: row.state,
    ...(row.reverse_after ? { reverseAfter: new Date(row.reverse_after) } : {}),
    ...(row.settled_tx ? { settledTx: row.settled_tx } : {}),
    ...(optionalBigInt(row.reversal_transfer_seq) !== undefined
      ? { reversalTransferSeq: optionalBigInt(row.reversal_transfer_seq)! } : {}),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    idempotencyKey: row.idempotency_key,
    policyPayee: row.policy_payee,
    amountMicros: BigInt(row.amount_micros),
    ...(row.authorization_hash ? { authorizationHash: Buffer.from(row.authorization_hash) } : {}),
    ...(row.authorization_expires_at ? { authorizationExpiresAt: new Date(row.authorization_expires_at) } : {}),
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    protocolVersion: row.protocol_version,
    signingContext: row.signing_context,
    ...(row.authorization_key_id ? { authorizationKeyId: row.authorization_key_id } : {}),
    ...(row.mandate_id ? { mandateId: row.mandate_id } : {}),
  };
}

/** Typed boundary over durable, SECURITY DEFINER external-settlement commands. */
export class PostgresExternal {
  constructor(readonly db: SqlExecutor) {}

  async prepare(input: {
    externalId: string;
    agentId: string;
    idempotencyKey: string;
    host: string;
    payTo: string;
    settlementAsset: string;
    settlementNetwork: string;
    resource: string;
    policyPayee: string;
    amountMicros: bigint | number | string;
    protocolVersion?: 1 | 2;
    signingContext?: Record<string, unknown>;
  }): Promise<ExternalCommandResult> {
    const protocolVersion = input.protocolVersion ?? 1;
    const signingContext = input.signingContext ?? (protocolVersion === 2
      ? { maxTimeoutSeconds: 60, resource: {} }
      : {});
    const result = await this.db.query<ExternalCommandRow>(
      `select * from money_private.prepare_external_payment(
        $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint, $11::smallint, $12::jsonb
      )`,
      [
        input.externalId, input.agentId, input.idempotencyKey, input.host,
        input.payTo, input.settlementAsset, input.settlementNetwork, input.resource,
        input.policyPayee, BigInt(input.amountMicros).toString(),
        protocolVersion, JSON.stringify(signingContext),
      ]
    );
    return commandFromRow(result.rows[0]);
  }

  async activate(input: {
    agentId: string;
    externalId: string;
    paymentHeaderCiphertext: Uint8Array;
    authorizationHash: Uint8Array;
    authorizationKeyId: string;
    authorizationExpiresAt: Date | string;
    reverseAfter: Date | string;
  }): Promise<ExternalCommandResult> {
    const result = await this.db.query<ExternalCommandRow>(
      `select * from money_private.activate_external_payment(
        $1, $2::uuid, $3::bytea, $4::bytea, $5, $6::timestamptz, $7::timestamptz
      )`,
      [
        input.agentId, input.externalId, Buffer.from(input.paymentHeaderCiphertext),
        Buffer.from(input.authorizationHash), input.authorizationKeyId,
        new Date(input.authorizationExpiresAt).toISOString(), new Date(input.reverseAfter).toISOString(),
      ]
    );
    return commandFromRow(result.rows[0]);
  }

  /** Compatibility helper for tests and non-HTTP callers: prepare, then
   * activate autonomous intents. Approval intents intentionally remain unsigned. */
  async request(input: {
    externalId: string;
    agentId: string;
    idempotencyKey: string;
    host: string;
    payTo: string;
    settlementAsset: string;
    settlementNetwork: string;
    resource: string;
    policyPayee: string;
    amountMicros: bigint | number | string;
    paymentHeaderCiphertext: Uint8Array;
    authorizationHash: Uint8Array;
    authorizationExpiresAt: Date | string;
    reverseAfter: Date | string;
    authorizationKeyId?: string;
    protocolVersion?: 1 | 2;
    signingContext?: Record<string, unknown>;
  }): Promise<ExternalCommandResult> {
    const prepared = await this.prepare(input);
    if (prepared.status !== "prepared" || !prepared.externalId) return prepared;
    return this.activate({
      agentId: input.agentId,
      externalId: prepared.externalId,
      paymentHeaderCiphertext: input.paymentHeaderCiphertext,
      authorizationHash: input.authorizationHash,
      authorizationKeyId: input.authorizationKeyId ?? "legacy",
      authorizationExpiresAt: input.authorizationExpiresAt,
      reverseAfter: input.reverseAfter,
    });
  }

  async resolveApproval(
    userId: string,
    approvalId: string,
    action: "approve" | "reject",
    reason?: string,
    authorization?: {
      paymentHeaderCiphertext: Uint8Array;
      authorizationHash: Uint8Array;
      authorizationKeyId: string;
      authorizationExpiresAt: Date | string;
      reverseAfter: Date | string;
    },
  ): Promise<ExternalCommandResult> {
    const result = await this.db.query<ExternalCommandRow>(
      `select * from money_private.resolve_external_approval_v2(
        $1, $2::uuid, $3, $4, $5::bytea, $6::bytea, $7, $8::timestamptz, $9::timestamptz
      )`,
      [
        userId, approvalId, action, reason ?? null,
        authorization ? Buffer.from(authorization.paymentHeaderCiphertext) : null,
        authorization ? Buffer.from(authorization.authorizationHash) : null,
        authorization?.authorizationKeyId ?? null,
        authorization ? new Date(authorization.authorizationExpiresAt).toISOString() : null,
        authorization ? new Date(authorization.reverseAfter).toISOString() : null,
      ]
    );
    return commandFromRow(result.rows[0]);
  }

  async confirm(agentId: string, externalId: string, settledTx: string): Promise<ExternalConfirmationResult> {
    const result = await this.db.query<{
      ok: boolean;
      replayed: boolean;
      external_state: ExternalPaymentState;
      settled_tx: string | null;
      reason: string | null;
    }>(
      "select * from money_private.confirm_external_payment($1, $2::uuid, $3)",
      [agentId, externalId, settledTx]
    );
    const row = result.rows[0];
    if (!row) throw new Error("external confirmation returned no result");
    return {
      ok: row.ok,
      replayed: row.replayed,
      state: row.external_state,
      ...(row.settled_tx ? { settledTx: row.settled_tx } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
    };
  }

  async sweep(limit = 100): Promise<Array<{ externalId: string; reversalTransferId: string }>> {
    const result = await this.db.query<{ external_id: string; reversal_transfer_id: string }>(
      "select * from money_private.sweep_external_payments($1)",
      [limit]
    );
    return result.rows.map((row) => ({ externalId: row.external_id, reversalTransferId: row.reversal_transfer_id }));
  }

  async list(requesterId: string, limit = 50): Promise<DatabaseExternalPayment[]> {
    const result = await this.db.query<ExternalPublicRow>(
      "select * from money_private.list_external_payments_for_requester($1, $2)",
      [requesterId, limit]
    );
    return result.rows.map(publicFromRow);
  }

  async secret(agentId: string, externalId: string): Promise<DatabaseExternalPaymentSecret | undefined> {
    const result = await this.db.query<ExternalSecretRow>(
      "select * from money_private.get_external_payment_secret($1, $2::uuid)",
      [agentId, externalId]
    );
    return result.rows[0] ? secretFromRow(result.rows[0]) : undefined;
  }

  async secretByKey(agentId: string, idempotencyKey: string): Promise<DatabaseExternalPaymentSecret | undefined> {
    const result = await this.db.query<ExternalSecretRow>(
      "select * from money_private.get_external_payment_secret_by_key($1, $2)",
      [agentId, idempotencyKey]
    );
    return result.rows[0] ? secretFromRow(result.rows[0]) : undefined;
  }

  async secretByApproval(userId: string, approvalId: string): Promise<DatabaseExternalPaymentSecret | undefined> {
    const result = await this.db.query<ExternalSecretRow>(
      "select * from money_private.get_external_payment_by_approval_for_owner($1, $2::uuid)",
      [userId, approvalId]
    );
    return result.rows[0] ? secretFromRow(result.rows[0]) : undefined;
  }

  async unresolvedByResource(
    agentId: string,
    resource: string,
  ): Promise<{ externalId: string; state: ExternalPaymentState } | undefined> {
    const result = await this.db.query<{ external_id: string; external_state: ExternalPaymentState }>(
      "select * from money_private.get_unresolved_external_payment_by_resource($1, $2)",
      [agentId, resource]
    );
    const row = result.rows[0];
    return row ? { externalId: row.external_id, state: row.external_state } : undefined;
  }

  async rotateAuthorization(input: {
    externalId: string;
    expectedAuthorizationHash: Uint8Array;
    paymentHeaderCiphertext: Uint8Array;
    authorizationKeyId: string;
  }): Promise<boolean> {
    const result = await this.db.query<{ rotated: boolean }>(
      `select money_private.replace_external_authorization_ciphertext(
        $1::uuid, $2::bytea, $3::bytea, $4
      ) as rotated`,
      [input.externalId, Buffer.from(input.expectedAuthorizationHash), Buffer.from(input.paymentHeaderCiphertext), input.authorizationKeyId]
    );
    return result.rows[0]?.rotated ?? false;
  }

  async rotationCandidates(
    activeKeyId: string,
    limit = 100,
  ): Promise<ExternalAuthorizationRotationCandidate[]> {
    const result = await this.db.query<ExternalRotationRow>(
      "select * from money_private.list_external_authorizations_for_rotation($1, $2)",
      [activeKeyId, limit]
    );
    return result.rows.map((row) => ({
      externalId: row.external_id,
      agentId: row.agent_id,
      idempotencyKey: row.idempotency_key,
      host: row.host,
      payTo: row.pay_to,
      settlementAsset: row.settlement_asset,
      settlementNetwork: row.settlement_network,
      resource: row.resource,
      policyPayee: row.policy_payee,
      amountMicros: BigInt(row.amount_micros),
      paymentHeaderCiphertext: Buffer.from(row.payment_header_ciphertext),
      authorizationHash: Buffer.from(row.authorization_hash),
      authorizationKeyId: row.authorization_key_id,
      authorizationExpiresAt: new Date(row.authorization_expires_at),
      reverseAfter: new Date(row.reverse_after),
    }));
  }

  async isExternalApproval(userId: string, approvalId: string): Promise<boolean> {
    const result = await this.db.query<{ is_external: boolean }>(
      "select money_private.is_external_approval($1, $2::uuid) as is_external",
      [userId, approvalId]
    );
    return result.rows[0]?.is_external ?? false;
  }
}
