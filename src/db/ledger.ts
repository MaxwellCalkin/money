import { randomBytes } from "node:crypto";
import type { SqlExecutor, TransactionalDatabase } from "./database.ts";

export type DatabaseAccountKind = "user" | "agent" | "provider";
export type TransferOperation = "fund" | "allocate" | "pay";

export interface DatabaseAccount {
  id: string;
  kind: DatabaseAccountKind | "external";
  ownerId?: string;
  name: string;
  handle?: string;
  publicKey?: string;
  status: "active" | "frozen" | "closed";
  createdAt: Date;
}

export interface PostedTransfer {
  status: "posted";
  replayed: boolean;
  transferId: string;
  receiptId: string;
  fromBalanceMicros: bigint;
  toBalanceMicros: bigint;
}

export interface DeniedTransfer {
  status: "denied";
  replayed: boolean;
  code: string;
  reason: string;
  fromBalanceMicros?: bigint;
  toBalanceMicros?: bigint;
}

export type DatabaseTransferResult = PostedTransfer | DeniedTransfer;

interface TransferRow extends Record<string, unknown> {
  status: "posted" | "denied";
  replayed: boolean;
  transfer_id: string | null;
  receipt_id: string | null;
  denial_code: string | null;
  reason: string | null;
  from_balance_micros: string | number | bigint | null;
  to_balance_micros: string | number | bigint | null;
}

function asBigInt(value: string | number | bigint | null): bigint | undefined {
  return value === null ? undefined : BigInt(value);
}

function accountPrefix(kind: DatabaseAccountKind): string {
  return kind === "user" ? "usr" : kind === "agent" ? "agt" : "prv";
}

export class PostgresLedger {
  constructor(readonly db: TransactionalDatabase) {}

  async registerAccount(input: {
    id?: string;
    kind: DatabaseAccountKind;
    name: string;
    ownerId?: string;
    handle?: string;
    publicKey?: string;
  }): Promise<DatabaseAccount> {
    const id = input.id ?? `${accountPrefix(input.kind)}_${randomBytes(16).toString("base64url")}`;
    const result = await this.db.query<Record<string, unknown>>(
      "select * from money_private.register_account($1, $2, $3, $4, $5, $6)",
      [id, input.kind, input.name, input.ownerId ?? null, input.handle ?? null, input.publicKey ?? null]
    );
    const row = result.rows[0];
    if (!row) throw new Error("account registration returned no row");
    return {
      id: String(row.id),
      kind: row.kind as DatabaseAccount["kind"],
      ...(row.owner_id ? { ownerId: String(row.owner_id) } : {}),
      name: String(row.name),
      ...(row.handle ? { handle: String(row.handle) } : {}),
      ...(row.public_key ? { publicKey: String(row.public_key) } : {}),
      status: row.status as DatabaseAccount["status"],
      createdAt: new Date(String(row.created_at)),
    };
  }

  async postTransfer(input: {
    actorId: string;
    operation: TransferOperation;
    idempotencyKey: string;
    from: string;
    to: string;
    amountMicros: bigint | number | string;
    asset?: string;
    memo?: string;
    metadata?: Record<string, unknown>;
  }): Promise<DatabaseTransferResult> {
    const amount = BigInt(input.amountMicros);
    const call = input.operation === "pay"
      ? {
          sql: "select * from money_private.post_agent_payment($1, $2, $3, $4, $5::bigint, $6, $7::jsonb)",
          values: [input.actorId, input.idempotencyKey, input.to, input.asset ?? "USD", amount.toString(), input.memo ?? "", JSON.stringify(input.metadata ?? {})],
        }
      : input.operation === "allocate"
        ? {
            sql: "select * from money_private.post_owner_allocation($1, $2, $3, $4, $5::bigint, $6, $7::jsonb)",
            values: [input.actorId, input.idempotencyKey, input.to, input.asset ?? "USD", amount.toString(), input.memo ?? "", JSON.stringify(input.metadata ?? {})],
          }
        : {
            sql: "select * from money_private.post_confirmed_funding($1, $2, $3, $4::bigint, $5::jsonb)",
            values: [input.actorId, input.idempotencyKey, input.asset ?? "USD", amount.toString(), JSON.stringify(input.metadata ?? {})],
          };
    if (
      (input.operation === "pay" && input.from !== input.actorId) ||
      (input.operation === "allocate" && input.from !== input.actorId) ||
      (input.operation === "fund" && (input.from !== "external:funding" || input.to !== input.actorId))
    ) {
      throw new Error(`invalid ${input.operation} endpoints for actor`);
    }
    const result = await this.db.query<TransferRow>(
      call.sql,
      call.values
    );
    const row = result.rows[0];
    if (!row) throw new Error("posting function returned no result");
    if (row.status === "denied") {
      return {
        status: "denied",
        replayed: row.replayed,
        code: row.denial_code ?? "denied",
        reason: row.reason ?? "transfer denied",
        ...(asBigInt(row.from_balance_micros) !== undefined ? { fromBalanceMicros: asBigInt(row.from_balance_micros)! } : {}),
        ...(asBigInt(row.to_balance_micros) !== undefined ? { toBalanceMicros: asBigInt(row.to_balance_micros)! } : {}),
      };
    }
    if (!row.transfer_id || !row.receipt_id) throw new Error("posted transfer is missing durable identifiers");
    return {
      status: "posted",
      replayed: row.replayed,
      transferId: row.transfer_id,
      receiptId: row.receipt_id,
      fromBalanceMicros: asBigInt(row.from_balance_micros)!,
      toBalanceMicros: asBigInt(row.to_balance_micros)!,
    };
  }

  async balance(accountId: string, asset = "USD"): Promise<bigint> {
    const result = await this.db.query<{ available_micros: string | number | bigint }>(
      "select available_micros from money.balances where account_id = $1 and asset_code = $2",
      [accountId, asset]
    );
    if (!result.rows[0]) throw new Error(`unknown account or asset balance: ${accountId}/${asset}`);
    return BigInt(result.rows[0].available_micros);
  }

  /** Recompute every cached balance from the immutable journal. A production
   * monitor runs this continuously and pages on any mismatch. */
  async reconcile(): Promise<Array<{
    accountId: string;
    asset: string;
    cachedMicros: bigint;
    journalMicros: bigint;
    matches: boolean;
  }>> {
    const result = await this.db.query<{
      account_id: string;
      asset_code: string;
      cached_micros: string | number | bigint;
      journal_micros: string | number | bigint;
    }>(`
      select b.account_id, b.asset_code,
        b.available_micros as cached_micros,
        coalesce(sum(e.amount_micros), 0)::bigint as journal_micros
      from money.balances b
      left join money.ledger_entries e
        on e.account_id = b.account_id and e.asset_code = b.asset_code
      group by b.account_id, b.asset_code, b.available_micros
      order by b.account_id, b.asset_code
    `);
    return result.rows.map((row) => {
      const cachedMicros = BigInt(row.cached_micros);
      const journalMicros = BigInt(row.journal_micros);
      return {
        accountId: row.account_id,
        asset: row.asset_code,
        cachedMicros,
        journalMicros,
        matches: cachedMicros === journalMicros,
      };
    });
  }

  async claimOutbox(workerId: string, limit = 100): Promise<Array<{ id: bigint; topic: string; aggregateId: string; payload: unknown }>> {
    if (!workerId || limit < 1 || limit > 1_000) throw new Error("invalid outbox worker or batch size");
    return this.db.transaction(async (tx: SqlExecutor) => {
      const result = await tx.query<{
        id: string | number | bigint;
        topic: string;
        aggregate_id: string;
        payload: unknown;
      }>(`
        with claims as (
          select id from money.outbox_events
          where published_at is null
            and available_at <= clock_timestamp()
            and (locked_at is null or locked_at < clock_timestamp() - interval '2 minutes')
          order by available_at, id
          limit $2
          for update skip locked
        )
        update money.outbox_events e set
          locked_at = clock_timestamp(),
          locked_by = $1,
          attempts = attempts + 1
        from claims
        where e.id = claims.id
        returning e.id, e.topic, e.aggregate_id, e.payload
      `, [workerId, limit]);
      return result.rows.map((row) => ({
        id: BigInt(row.id),
        topic: row.topic,
        aggregateId: row.aggregate_id,
        payload: row.payload,
      }));
    });
  }

  async markOutboxPublished(workerId: string, ids: readonly bigint[]): Promise<void> {
    if (ids.length === 0) return;
    const result = await this.db.query(
      `update money.outbox_events set
         published_at = clock_timestamp(), locked_at = null, locked_by = null, last_error = null
       where locked_by = $1 and id = any($2::bigint[]) and published_at is null`,
      [workerId, ids.map(String)]
    );
    const changed = result.rowCount ?? result.affectedRows ?? 0;
    if (changed !== ids.length) throw new Error("outbox acknowledgement did not own every requested event");
  }

  async markOutboxFailed(workerId: string, id: bigint, reason: string): Promise<void> {
    const result = await this.db.query(
      `update money.outbox_events set
         available_at = clock_timestamp() + least(interval '5 minutes', interval '1 second' * power(2, least(attempts, 8))),
         locked_at = null, locked_by = null, last_error = left($3, 1000)
       where id = $2 and locked_by = $1 and published_at is null`,
      [workerId, id.toString(), reason]
    );
    const changed = result.rowCount ?? result.affectedRows ?? 0;
    if (changed !== 1) throw new Error("outbox failure did not own the requested event");
  }
}
