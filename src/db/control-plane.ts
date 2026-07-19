import { randomBytes } from "node:crypto";
import type { SqlExecutor } from "./database.ts";
import type { DatabaseAccount, DatabaseAccountKind } from "./ledger.ts";

export interface RegisteredIdentity extends DatabaseAccount {
  replayed: boolean;
}

export interface AccountBalance extends Omit<DatabaseAccount, "publicKey"> {
  balanceMicros: bigint;
}

export interface PaymentEvidence {
  receiptId: string;
  receiptSeq: bigint;
  transferId: string;
  from: string;
  to: string;
  asset: string;
  amountMicros: bigint;
  memo: string;
  mandateId?: string;
  operation: string;
  idempotencyKey: string;
  createdAt: Date;
  evidenceHash: string;
}

export interface DatabaseService {
  id: string;
  providerId: string;
  slug: string;
  name: string;
  description: string;
  endpointUrl: string;
  asset: string;
  priceMicros: bigint;
  active: boolean;
  createdAt: Date;
}

interface AccountRow extends Record<string, unknown> {
  id: string;
  kind: DatabaseAccount["kind"];
  owner_id: string | null;
  name: string;
  handle: string | null;
  public_key?: string | null;
  status: DatabaseAccount["status"];
  created_at: string | Date;
  replayed?: boolean;
}

interface AccountBalanceRow extends AccountRow {
  balance_micros: string | number | bigint;
}

interface EvidenceRow extends Record<string, unknown> {
  receipt_id: string;
  receipt_seq: string | number | bigint;
  transfer_id: string;
  from_account_id: string;
  to_account_id: string;
  asset_code: string;
  amount_micros: string | number | bigint;
  memo: string;
  mandate_id: string | null;
  operation: string;
  idempotency_key: string;
  created_at: string | Date;
  evidence_hash: Uint8Array | Buffer | string;
}

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
}

function accountFromRow(row: AccountRow): DatabaseAccount {
  return {
    id: row.id,
    kind: row.kind,
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    name: row.name,
    ...(row.handle ? { handle: row.handle } : {}),
    ...(row.public_key ? { publicKey: row.public_key } : {}),
    status: row.status,
    createdAt: new Date(row.created_at),
  };
}

function evidenceHash(value: EvidenceRow["evidence_hash"]): string {
  if (typeof value === "string") return value.startsWith("\\x") ? value.slice(2) : value;
  return Buffer.from(value).toString("hex");
}

function evidenceFromRow(row: EvidenceRow): PaymentEvidence {
  return {
    receiptId: row.receipt_id,
    receiptSeq: BigInt(row.receipt_seq),
    transferId: row.transfer_id,
    from: row.from_account_id,
    to: row.to_account_id,
    asset: row.asset_code,
    amountMicros: BigInt(row.amount_micros),
    memo: row.memo,
    ...(row.mandate_id ? { mandateId: row.mandate_id } : {}),
    operation: row.operation,
    idempotencyKey: row.idempotency_key,
    createdAt: new Date(row.created_at),
    evidenceHash: evidenceHash(row.evidence_hash),
  };
}

function accountPrefix(kind: DatabaseAccountKind): string {
  return kind === "user" ? "usr" : kind === "agent" ? "agt" : "prv";
}

/** Typed gateway for identity, signed-envelope replay defense, owner sessions,
 * and tenant-scoped reads. All sensitive reads and writes go through reviewed
 * SECURITY DEFINER functions granted to the narrow application role. */
export class PostgresControlPlane {
  constructor(readonly db: SqlExecutor) {}

  async accountForAuth(id: string): Promise<DatabaseAccount | undefined> {
    const result = await this.db.query<AccountRow>(
      `select id, kind, owner_id, name, handle, public_key, status, created_at
       from money.accounts where id = $1`,
      [id]
    );
    return result.rows[0] ? accountFromRow(result.rows[0]) : undefined;
  }

  async registerIdentity(input: {
    actorId?: string;
    id?: string;
    kind: DatabaseAccountKind;
    name: string;
    ownerId?: string;
    handle?: string;
    publicKey: string;
  }): Promise<RegisteredIdentity> {
    const id = input.id ?? `${accountPrefix(input.kind)}_${randomBytes(16).toString("base64url")}`;
    const result = await this.db.query<AccountRow>(
      "select * from money_private.register_public_identity($1, $2, $3, $4, $5, $6, $7)",
      [input.actorId ?? null, id, input.kind, input.name, input.ownerId ?? null, input.handle ?? null, input.publicKey]
    );
    const row = result.rows[0];
    if (!row) throw new Error("identity registration returned no row");
    return { ...accountFromRow(row), replayed: Boolean(row.replayed) };
  }

  async consumeSignedRequest(input: {
    accountId: string;
    kind: DatabaseAccountKind;
    expectedPublicKey: string;
    nonce: string;
    signedAtMs: number;
    requestHash: Uint8Array;
  }): Promise<void> {
    await this.db.query(
      "select money_private.consume_signed_request($1, $2, $3, $4, $5::bigint, $6::bytea)",
      [input.accountId, input.kind, input.expectedPublicKey, input.nonce, String(input.signedAtMs), Buffer.from(input.requestHash)]
    );
  }

  async rotatePublicKey(ownerId: string, targetId: string, publicKey: string): Promise<{ accountId: string; changed: boolean }> {
    const result = await this.db.query<{ account_id: string; changed: boolean }>(
      "select * from money_private.rotate_public_key($1, $2, $3)",
      [ownerId, targetId, publicKey]
    );
    const row = result.rows[0];
    if (!row) throw new Error("key rotation returned no row");
    return { accountId: row.account_id, changed: row.changed };
  }

  async createOwnerSession(userId: string, tokenHash: Uint8Array): Promise<Date> {
    const result = await this.db.query<{ expires_at: string | Date }>(
      "select * from money_private.create_owner_session($1, $2::bytea)",
      [userId, Buffer.from(tokenHash)]
    );
    if (!result.rows[0]) throw new Error("owner session creation returned no row");
    return new Date(result.rows[0].expires_at);
  }

  async resolveOwnerSession(tokenHash: Uint8Array): Promise<string | undefined> {
    const result = await this.db.query<{ user_id: string | null }>(
      "select money_private.resolve_owner_session($1::bytea) as user_id",
      [Buffer.from(tokenHash)]
    );
    return result.rows[0]?.user_id ?? undefined;
  }

  async revokeOwnerSession(userId: string, tokenHash: Uint8Array): Promise<boolean> {
    const result = await this.db.query<{ revoked: boolean }>(
      "select money_private.revoke_owner_session($1, $2::bytea) as revoked",
      [userId, Buffer.from(tokenHash)]
    );
    return result.rows[0]?.revoked ?? false;
  }

  async resolvePublicAccount(reference: string): Promise<DatabaseAccount | undefined> {
    const result = await this.db.query<AccountRow>(
      "select * from money_private.resolve_public_account($1)",
      [reference]
    );
    return result.rows[0] ? accountFromRow(result.rows[0]) : undefined;
  }

  async publicAccounts(ids: readonly string[]): Promise<DatabaseAccount[]> {
    if (ids.length === 0) return [];
    const result = await this.db.query<AccountRow>(
      `select id, kind, owner_id, name, handle, status, created_at
       from money.accounts where id = any($1::text[]) order by id`,
      [[...new Set(ids)]]
    );
    return result.rows.map(accountFromRow);
  }

  async accountState(requesterId: string, asset = "USD"): Promise<AccountBalance[]> {
    const result = await this.db.query<AccountBalanceRow>(
      "select * from money_private.account_state($1, $2)",
      [requesterId, asset]
    );
    return result.rows.map((row) => ({ ...accountFromRow(row), balanceMicros: BigInt(row.balance_micros) }));
  }

  async paymentFeed(requesterId: string, limit = 25): Promise<PaymentEvidence[]> {
    const result = await this.db.query<EvidenceRow>(
      "select * from money_private.payment_feed($1, $2)",
      [requesterId, limit]
    );
    return result.rows.map(evidenceFromRow);
  }

  async services(requesterId: string): Promise<DatabaseService[]> {
    const result = await this.db.query<ServiceRow>(
      "select * from money_private.list_services_for_requester($1)",
      [requesterId]
    );
    return result.rows.map((row) => ({
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
    }));
  }

  async receipt(requesterId: string, receiptId: string): Promise<PaymentEvidence | undefined> {
    const result = await this.db.query<EvidenceRow>(
      "select * from money_private.get_receipt($1, $2::uuid)",
      [requesterId, receiptId]
    );
    return result.rows[0] ? evidenceFromRow(result.rows[0]) : undefined;
  }

  async ledgerHealth(): Promise<{ zeroSum: boolean; receiptsOk: boolean }> {
    const result = await this.db.query<{ zero_sum: boolean; receipts_ok: boolean }>(
      "select * from money_private.ledger_health()"
    );
    const row = result.rows[0];
    if (!row) throw new Error("ledger health returned no row");
    return { zeroSum: row.zero_sum, receiptsOk: row.receipts_ok };
  }
}
