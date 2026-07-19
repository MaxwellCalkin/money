import type { TransactionalDatabase } from "./database.ts";

export interface DatabaseMandate {
  id: string;
  userId: string;
  agentId: string;
  asset: string;
  budgetMicros: bigint;
  perTxCapMicros: bigint;
  dailyCapMicros: bigint;
  escalateAboveMicros: bigint;
  newPayeeCapMicros: bigint;
  payeeAllowlist?: string[];
  spentMicros: bigint;
  spentTodayMicros: bigint;
  spendDay: string;
  expiresAt: Date;
  revokedAt?: Date;
  idempotencyKey: string;
  createdAt: Date;
}

export type DatabaseApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "failed";

export interface DatabaseApproval {
  id: string;
  userId: string;
  mandateId: string;
  agentId: string;
  to: string;
  asset: string;
  amountMicros: bigint;
  memo: string;
  idempotencyKey: string;
  status: DatabaseApprovalStatus;
  expiresAt: Date;
  resolvedAt?: Date;
  receiptId?: string;
  reason?: string;
  createdAt: Date;
}

export interface PostedPolicyPayment {
  status: "posted";
  replayed: boolean;
  transferId: string;
  receiptId: string;
  approvalId?: string;
  fromBalanceMicros: bigint;
  toBalanceMicros: bigint;
}

export interface PendingPolicyApproval {
  status: "approval_required";
  replayed: boolean;
  approvalId: string;
}

export interface DeniedPolicyPayment {
  status: "denied";
  replayed: boolean;
  approvalId?: string;
  code: string;
  reason: string;
  fromBalanceMicros?: bigint;
  toBalanceMicros?: bigint;
}

export type PolicyPaymentResult = PostedPolicyPayment | PendingPolicyApproval | DeniedPolicyPayment;

interface PaymentRow extends Record<string, unknown> {
  status: "posted" | "approval_required" | "denied";
  replayed: boolean;
  transfer_id: string | null;
  receipt_id: string | null;
  approval_id: string | null;
  denial_code: string | null;
  reason: string | null;
  from_balance_micros: string | number | bigint | null;
  to_balance_micros: string | number | bigint | null;
}

interface MandateRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  agent_id: string;
  asset_code: string;
  budget_micros: string | number | bigint;
  per_tx_cap_micros: string | number | bigint;
  daily_cap_micros: string | number | bigint;
  escalate_above_micros: string | number | bigint;
  new_payee_cap_micros: string | number | bigint;
  payee_allowlist: string[] | null;
  spent_micros: string | number | bigint;
  spent_today_micros: string | number | bigint;
  spend_day: string | Date;
  expires_at: string | Date;
  revoked_at: string | Date | null;
  idempotency_key: string;
  created_at: string | Date;
}

interface ApprovalRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  mandate_id: string;
  agent_id: string;
  to_account_id: string;
  asset_code: string;
  amount_micros: string | number | bigint;
  memo: string;
  idempotency_key: string;
  status: DatabaseApprovalStatus;
  expires_at: string | Date;
  resolved_at: string | Date | null;
  receipt_id: string | null;
  reason: string | null;
  created_at: string | Date;
}

function optionalBigInt(value: string | number | bigint | null): bigint | undefined {
  return value === null ? undefined : BigInt(value);
}

function parsePayment(row?: PaymentRow): PolicyPaymentResult {
  if (!row) throw new Error("policy function returned no result");
  if (row.status === "approval_required") {
    if (!row.approval_id) throw new Error("approval result is missing its durable id");
    return { status: "approval_required", replayed: row.replayed, approvalId: row.approval_id };
  }
  if (row.status === "denied") {
    return {
      status: "denied",
      replayed: row.replayed,
      ...(row.approval_id ? { approvalId: row.approval_id } : {}),
      code: row.denial_code ?? "denied",
      reason: row.reason ?? "payment denied",
      ...(optionalBigInt(row.from_balance_micros) !== undefined
        ? { fromBalanceMicros: optionalBigInt(row.from_balance_micros)! }
        : {}),
      ...(optionalBigInt(row.to_balance_micros) !== undefined
        ? { toBalanceMicros: optionalBigInt(row.to_balance_micros)! }
        : {}),
    };
  }
  if (!row.transfer_id || !row.receipt_id) throw new Error("posted policy payment is missing durable identifiers");
  const fromBalanceMicros = optionalBigInt(row.from_balance_micros);
  const toBalanceMicros = optionalBigInt(row.to_balance_micros);
  if (fromBalanceMicros === undefined || toBalanceMicros === undefined) {
    throw new Error("posted policy payment is missing balances");
  }
  return {
    status: "posted",
    replayed: row.replayed,
    transferId: row.transfer_id,
    receiptId: row.receipt_id,
    ...(row.approval_id ? { approvalId: row.approval_id } : {}),
    fromBalanceMicros,
    toBalanceMicros,
  };
}

function parseMandate(row: MandateRow): DatabaseMandate {
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    asset: row.asset_code,
    budgetMicros: BigInt(row.budget_micros),
    perTxCapMicros: BigInt(row.per_tx_cap_micros),
    dailyCapMicros: BigInt(row.daily_cap_micros),
    escalateAboveMicros: BigInt(row.escalate_above_micros),
    newPayeeCapMicros: BigInt(row.new_payee_cap_micros),
    ...(row.payee_allowlist !== null ? { payeeAllowlist: row.payee_allowlist } : {}),
    spentMicros: BigInt(row.spent_micros),
    spentTodayMicros: BigInt(row.spent_today_micros),
    spendDay: row.spend_day instanceof Date ? row.spend_day.toISOString().slice(0, 10) : String(row.spend_day),
    expiresAt: new Date(row.expires_at),
    ...(row.revoked_at !== null ? { revokedAt: new Date(row.revoked_at) } : {}),
    idempotencyKey: row.idempotency_key,
    createdAt: new Date(row.created_at),
  };
}

function parseApproval(row: ApprovalRow): DatabaseApproval {
  return {
    id: row.id,
    userId: row.user_id,
    mandateId: row.mandate_id,
    agentId: row.agent_id,
    to: row.to_account_id,
    asset: row.asset_code,
    amountMicros: BigInt(row.amount_micros),
    memo: row.memo,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    expiresAt: new Date(row.expires_at),
    ...(row.resolved_at !== null ? { resolvedAt: new Date(row.resolved_at) } : {}),
    ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    createdAt: new Date(row.created_at),
  };
}

/** Application-facing policy gateway. Every mutating call delegates to one
 * SECURITY DEFINER database function whose transaction covers the decision,
 * counters, approval evidence, journal entries, receipt, and outbox event. */
export class PostgresPolicy {
  constructor(readonly db: TransactionalDatabase) {}

  async grantMandate(input: {
    userId: string;
    agentId: string;
    budgetMicros: bigint | number | string;
    perTxCapMicros: bigint | number | string;
    dailyCapMicros: bigint | number | string;
    escalateAboveMicros: bigint | number | string;
    newPayeeCapMicros: bigint | number | string;
    payeeAllowlist?: readonly string[] | null;
    expiresAt: Date | string;
    idempotencyKey: string;
    asset?: string;
  }): Promise<{ mandateId: string; replayed: boolean }> {
    const expiresAt = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) throw new Error("invalid mandate expiry");
    const result = await this.db.query<{ mandate_id: string; replayed: boolean }>(
      `select * from money_private.grant_mandate(
        $1, $2, $3, $4::bigint, $5::bigint, $6::bigint, $7::bigint,
        $8::bigint, $9::text[], $10::timestamptz, $11
      )`,
      [
        input.userId,
        input.agentId,
        input.asset ?? "USD",
        BigInt(input.budgetMicros).toString(),
        BigInt(input.perTxCapMicros).toString(),
        BigInt(input.dailyCapMicros).toString(),
        BigInt(input.escalateAboveMicros).toString(),
        BigInt(input.newPayeeCapMicros).toString(),
        input.payeeAllowlist === undefined || input.payeeAllowlist === null ? null : [...input.payeeAllowlist],
        expiresAt.toISOString(),
        input.idempotencyKey,
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("mandate grant returned no result");
    return { mandateId: row.mandate_id, replayed: row.replayed };
  }

  async revokeMandate(userId: string, mandateId: string): Promise<boolean> {
    const result = await this.db.query<{ revoked: boolean }>(
      "select money_private.revoke_mandate($1, $2::uuid) as revoked",
      [userId, mandateId]
    );
    if (!result.rows[0]) throw new Error("mandate revocation returned no result");
    return result.rows[0].revoked;
  }

  async requestPayment(input: {
    agentId: string;
    idempotencyKey: string;
    to: string;
    amountMicros: bigint | number | string;
    asset?: string;
    memo?: string;
  }): Promise<PolicyPaymentResult> {
    const result = await this.db.query<PaymentRow>(
      "select * from money_private.request_agent_payment($1, $2, $3, $4, $5::bigint, $6)",
      [input.agentId, input.idempotencyKey, input.to, input.asset ?? "USD", BigInt(input.amountMicros).toString(), input.memo ?? ""]
    );
    return parsePayment(result.rows[0]);
  }

  async resolveApproval(
    userId: string,
    approvalId: string,
    action: "approve" | "reject",
    reason?: string
  ): Promise<PolicyPaymentResult> {
    const result = await this.db.query<PaymentRow>(
      "select * from money_private.resolve_approval($1, $2::uuid, $3, $4)",
      [userId, approvalId, action, reason ?? null]
    );
    return parsePayment(result.rows[0]);
  }

  async mandate(requesterId: string, id: string): Promise<DatabaseMandate | undefined> {
    const result = await this.db.query<MandateRow>(
      "select * from money_private.get_mandate($1, $2::uuid)",
      [requesterId, id]
    );
    return result.rows[0] ? parseMandate(result.rows[0]) : undefined;
  }

  async approval(requesterId: string, id: string): Promise<DatabaseApproval | undefined> {
    const result = await this.db.query<ApprovalRow>(
      "select * from money_private.get_approval($1, $2::uuid)",
      [requesterId, id]
    );
    return result.rows[0] ? parseApproval(result.rows[0]) : undefined;
  }

  async listApprovals(requesterId: string, status?: DatabaseApprovalStatus, limit = 100): Promise<DatabaseApproval[]> {
    const result = await this.db.query<ApprovalRow>(
      "select * from money_private.list_approvals($1, $2, $3)",
      [requesterId, status ?? null, limit]
    );
    return result.rows.map(parseApproval);
  }

  async listMandates(requesterId: string, limit = 100): Promise<DatabaseMandate[]> {
    const result = await this.db.query<MandateRow>(
      "select * from money_private.list_mandates($1, $2)",
      [requesterId, limit]
    );
    return result.rows.map(parseMandate);
  }
}
