import type { SqlExecutor } from "./database.ts";

export type ExternalPaymentState = "approval_required" | "cancelled" | "pending" | "confirmed" | "reversed";
export type ExternalCommandStatus = "posted" | "approval_required" | "denied";

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
  authorization_expires_at: string | Date;
  reverse_after: string | Date;
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
  payment_header_ciphertext: Uint8Array;
  state: ExternalPaymentState;
  reverse_after: string | Date;
  settled_tx: string | null;
  reversal_transfer_seq: string | number | bigint | null;
  created_at: string | Date;
  updated_at: string | Date;
  idempotency_key: string;
  policy_payee: string;
  amount_micros: string | number | bigint;
  authorization_hash: Uint8Array;
  authorization_expires_at: string | Date;
  approval_id: string | null;
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
  authorizationExpiresAt: Date;
  reverseAfter: Date;
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
  paymentHeaderCiphertext: Buffer;
  state: ExternalPaymentState;
  reverseAfter: Date;
  settledTx?: string;
  reversalTransferSeq?: bigint;
  createdAt: Date;
  updatedAt: Date;
  idempotencyKey: string;
  policyPayee: string;
  amountMicros: bigint;
  authorizationHash: Buffer;
  authorizationExpiresAt: Date;
  approvalId?: string;
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
    authorizationExpiresAt: new Date(row.authorization_expires_at),
    reverseAfter: new Date(row.reverse_after),
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
    paymentHeaderCiphertext: Buffer.from(row.payment_header_ciphertext),
    state: row.state,
    reverseAfter: new Date(row.reverse_after),
    ...(row.settled_tx ? { settledTx: row.settled_tx } : {}),
    ...(optionalBigInt(row.reversal_transfer_seq) !== undefined
      ? { reversalTransferSeq: optionalBigInt(row.reversal_transfer_seq)! } : {}),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    idempotencyKey: row.idempotency_key,
    policyPayee: row.policy_payee,
    amountMicros: BigInt(row.amount_micros),
    authorizationHash: Buffer.from(row.authorization_hash),
    authorizationExpiresAt: new Date(row.authorization_expires_at),
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
  };
}

/** Typed boundary over durable, SECURITY DEFINER external-settlement commands. */
export class PostgresExternal {
  constructor(readonly db: SqlExecutor) {}

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
  }): Promise<ExternalCommandResult> {
    const result = await this.db.query<ExternalCommandRow>(
      `select * from money_private.request_external_payment(
        $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint,
        $11::bytea, $12::bytea, $13::timestamptz, $14::timestamptz
      )`,
      [
        input.externalId, input.agentId, input.idempotencyKey, input.host,
        input.payTo, input.settlementAsset, input.settlementNetwork, input.resource,
        input.policyPayee, BigInt(input.amountMicros).toString(),
        Buffer.from(input.paymentHeaderCiphertext), Buffer.from(input.authorizationHash),
        new Date(input.authorizationExpiresAt).toISOString(), new Date(input.reverseAfter).toISOString(),
      ]
    );
    return commandFromRow(result.rows[0]);
  }

  async resolveApproval(
    userId: string,
    approvalId: string,
    action: "approve" | "reject",
    reason?: string
  ): Promise<ExternalCommandResult> {
    const result = await this.db.query<ExternalCommandRow>(
      "select * from money_private.resolve_external_approval($1, $2::uuid, $3, $4)",
      [userId, approvalId, action, reason ?? null]
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

  async isExternalApproval(userId: string, approvalId: string): Promise<boolean> {
    const result = await this.db.query<{ is_external: boolean }>(
      "select money_private.is_external_approval($1, $2::uuid) as is_external",
      [userId, approvalId]
    );
    return result.rows[0]?.is_external ?? false;
  }
}
