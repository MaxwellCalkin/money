import type { DatabaseService } from "./control-plane.ts";
import type { SqlExecutor } from "./database.ts";
import {
  parsePolicyPayment,
  type PaymentFunctionRow,
  type PolicyPaymentResult,
} from "./policy.ts";

interface ServiceRow extends Record<string, unknown> {
  id: string;
  provider_id: string;
  slug: string;
  name: string;
  description: string;
  endpoint_url: string;
  asset_code: string;
  price_micros: string | number | bigint;
  active: boolean;
  created_at: string | Date;
  updated_at: string | Date;
  replayed?: boolean;
}

interface ChallengeRow extends Record<string, unknown> {
  id: string;
  provider_id: string;
  service_id: string | null;
  asset_code: string;
  amount_micros: string | number | bigint;
  resource: string;
  claimed_by: string | null;
  claimed_at: string | Date | null;
  paid_by: string | null;
  receipt_id: string | null;
  expires_at: string | Date;
  redeemed_at: string | Date | null;
  created_at: string | Date;
}

interface RefundRow extends Record<string, unknown> {
  status: "refunded" | "denied";
  replayed: boolean;
  transfer_id: string | null;
  receipt_id: string | null;
  denial_code: string | null;
  reason: string | null;
  remaining_micros: string | number | bigint | null;
  from_balance_micros: string | number | bigint | null;
  to_balance_micros: string | number | bigint | null;
  refund_of: string;
}

export interface DatabaseChallenge {
  id: string;
  providerId: string;
  serviceId?: string;
  asset: string;
  amountMicros: bigint;
  resource: string;
  claimedBy?: string;
  claimedAt?: Date;
  paidBy?: string;
  receiptId?: string;
  expiresAt: Date;
  redeemedAt?: Date;
  createdAt: Date;
}

export interface RegisteredService extends DatabaseService {
  updatedAt: Date;
  replayed: boolean;
}

export type MarketplaceRefundResult =
  | {
      status: "refunded";
      replayed: boolean;
      transferId: string;
      receiptId: string;
      remainingMicros: bigint;
      fromBalanceMicros: bigint;
      toBalanceMicros: bigint;
      refundOf: string;
    }
  | {
      status: "denied";
      replayed: boolean;
      code: string;
      reason: string;
      remainingMicros?: bigint;
      fromBalanceMicros?: bigint;
      toBalanceMicros?: bigint;
      refundOf: string;
    };

function serviceFromRow(row: ServiceRow): DatabaseService {
  return {
    id: row.id,
    providerId: row.provider_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    endpointUrl: row.endpoint_url,
    asset: row.asset_code,
    priceMicros: BigInt(row.price_micros),
    active: row.active,
    createdAt: new Date(row.created_at),
  };
}

function challengeFromRow(row: ChallengeRow): DatabaseChallenge {
  return {
    id: row.id,
    providerId: row.provider_id,
    ...(row.service_id ? { serviceId: row.service_id } : {}),
    asset: row.asset_code,
    amountMicros: BigInt(row.amount_micros),
    resource: row.resource,
    ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
    ...(row.claimed_at ? { claimedAt: new Date(row.claimed_at) } : {}),
    ...(row.paid_by ? { paidBy: row.paid_by } : {}),
    ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
    expiresAt: new Date(row.expires_at),
    ...(row.redeemed_at ? { redeemedAt: new Date(row.redeemed_at) } : {}),
    createdAt: new Date(row.created_at),
  };
}

function optionalBigInt(value: string | number | bigint | null): bigint | undefined {
  return value === null ? undefined : BigInt(value);
}

/** Marketplace gateway. Every mutation is one SECURITY DEFINER command whose
 * transaction owns the service terms, challenge state, money movement, or
 * cumulative refund decision it changes. */
export class PostgresMarketplace {
  constructor(readonly db: SqlExecutor) {}

  async registerService(input: {
    providerId: string;
    slug: string;
    name: string;
    description?: string;
    endpointUrl: string;
    priceMicros: bigint | number | string;
    idempotencyKey: string;
    asset?: string;
  }): Promise<RegisteredService> {
    const result = await this.db.query<ServiceRow>(
      `select * from money_private.register_service(
        $1, $2, $3, $4, $5, $6, $7::bigint, $8
      )`,
      [
        input.providerId,
        input.slug,
        input.name,
        input.description ?? "",
        input.endpointUrl,
        input.asset ?? "USD",
        BigInt(input.priceMicros).toString(),
        input.idempotencyKey,
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("service registration returned no row");
    return {
      ...serviceFromRow(row),
      updatedAt: new Date(row.updated_at),
      replayed: row.replayed ?? false,
    };
  }

  async setServiceActive(
    providerId: string,
    serviceId: string,
    active: boolean
  ): Promise<{ serviceId: string; active: boolean; changed: boolean }> {
    const result = await this.db.query<{ service_id: string; active: boolean; changed: boolean }>(
      "select * from money_private.set_service_active($1, $2::uuid, $3)",
      [providerId, serviceId, active]
    );
    const row = result.rows[0];
    if (!row) throw new Error("service status update returned no row");
    return { serviceId: row.service_id, active: row.active, changed: row.changed };
  }

  async publicServices(input: {
    limit?: number;
    beforeCreated?: Date;
    beforeId?: string;
  } = {}): Promise<DatabaseService[]> {
    const result = await this.db.query<ServiceRow>(
      "select * from money_private.list_public_services($1, $2::timestamptz, $3::uuid)",
      [
        input.limit ?? 50,
        input.beforeCreated?.toISOString() ?? null,
        input.beforeId ?? null,
      ]
    );
    return result.rows.map(serviceFromRow);
  }

  async publicService(reference: string): Promise<DatabaseService | undefined> {
    const result = await this.db.query<ServiceRow>(
      "select * from money_private.get_public_service($1)",
      [reference]
    );
    return result.rows[0] ? serviceFromRow(result.rows[0]) : undefined;
  }

  async createChallenge(providerId: string, serviceId: string): Promise<DatabaseChallenge> {
    const result = await this.db.query<ChallengeRow>(
      "select * from money_private.create_service_challenge($1, $2::uuid)",
      [providerId, serviceId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("challenge creation returned no row");
    return challengeFromRow(row);
  }

  async payChallenge(agentId: string, challengeId: string): Promise<PolicyPaymentResult> {
    const result = await this.db.query<PaymentFunctionRow>(
      "select * from money_private.request_challenge_payment($1, $2::uuid)",
      [agentId, challengeId]
    );
    return parsePolicyPayment(result.rows[0]);
  }

  async challenges(requesterId: string, challengeIds: readonly string[]): Promise<DatabaseChallenge[]> {
    if (challengeIds.length === 0) return [];
    const result = await this.db.query<ChallengeRow>(
      "select * from money_private.get_marketplace_challenges($1, $2::uuid[])",
      [requesterId, [...new Set(challengeIds)]]
    );
    return result.rows.map(challengeFromRow);
  }

  async redeem(input: {
    providerId: string;
    serviceId: string;
    challengeId: string;
    receiptId: string;
  }): Promise<{ ok: boolean; reason?: string; challengeId: string; redeemedAt?: Date }> {
    const result = await this.db.query<{
      ok: boolean;
      reason: string | null;
      challenge_id: string;
      redeemed_at: string | Date | null;
    }>(
      "select * from money_private.redeem_service_challenge($1, $2::uuid, $3::uuid, $4::uuid)",
      [input.providerId, input.serviceId, input.challengeId, input.receiptId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("challenge redemption returned no row");
    return {
      ok: row.ok,
      ...(row.reason ? { reason: row.reason } : {}),
      challengeId: row.challenge_id,
      ...(row.redeemed_at ? { redeemedAt: new Date(row.redeemed_at) } : {}),
    };
  }

  async refund(input: {
    providerId: string;
    receiptId: string;
    amountMicros: bigint | number | string;
    memo?: string;
    idempotencyKey: string;
  }): Promise<MarketplaceRefundResult> {
    const result = await this.db.query<RefundRow>(
      "select * from money_private.issue_refund($1, $2::uuid, $3::bigint, $4, $5)",
      [
        input.providerId,
        input.receiptId,
        BigInt(input.amountMicros).toString(),
        input.memo ?? "",
        input.idempotencyKey,
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("refund command returned no row");
    const remainingMicros = optionalBigInt(row.remaining_micros);
    const fromBalanceMicros = optionalBigInt(row.from_balance_micros);
    const toBalanceMicros = optionalBigInt(row.to_balance_micros);
    if (row.status === "denied") {
      return {
        status: "denied",
        replayed: row.replayed,
        code: row.denial_code ?? "refund_invalid",
        reason: row.reason ?? "refund denied",
        ...(remainingMicros !== undefined ? { remainingMicros } : {}),
        ...(fromBalanceMicros !== undefined ? { fromBalanceMicros } : {}),
        ...(toBalanceMicros !== undefined ? { toBalanceMicros } : {}),
        refundOf: row.refund_of,
      };
    }
    if (!row.transfer_id || !row.receipt_id || remainingMicros === undefined ||
        fromBalanceMicros === undefined || toBalanceMicros === undefined) {
      throw new Error("posted refund is missing durable evidence");
    }
    return {
      status: "refunded",
      replayed: row.replayed,
      transferId: row.transfer_id,
      receiptId: row.receipt_id,
      remainingMicros,
      fromBalanceMicros,
      toBalanceMicros,
      refundOf: row.refund_of,
    };
  }
}
