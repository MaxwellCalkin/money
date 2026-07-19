import { createHash } from "node:crypto";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresControlPlane } from "../src/db/control-plane.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { PostgresPolicy } from "../src/db/policy.ts";

class EmbeddedPostgres implements TransactionalDatabase {
  constructor(readonly pg: PGliteInterface) {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryRows<T>> {
    const result = await this.pg.query<T>(text, [...values]);
    return { rows: result.rows, affectedRows: result.affectedRows };
  }

  async executeScript(text: string): Promise<void> {
    await this.pg.exec(text);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (transaction: Transaction) => work({
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = []
      ): Promise<QueryRows<R>> => {
        const result = await transaction.query<R>(text, [...values]);
        return { rows: result.rows, affectedRows: result.affectedRows };
      },
      executeScript: async (text: string) => {
        await transaction.exec(text);
      },
    }));
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

const key = (name: string) => `public-key-${name}-${"x".repeat(40)}`;
const hash = (value: string) => createHash("sha256").update(value).digest();

describe("Postgres durable control plane", () => {
  let db: EmbeddedPostgres;
  let ledger: PostgresLedger;
  let policy: PostgresPolicy;
  let control: PostgresControlPlane;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    ledger = new PostgresLedger(db);
    policy = new PostgresPolicy(db);
    control = new PostgresControlPlane(db);
  }, 30_000);

  afterEach(async () => {
    await db.close();
  });

  async function identityWorld() {
    const owner = await control.registerIdentity({
      id: "usr_control01", kind: "user", name: "Owner", handle: "owner", publicKey: key("owner"),
    });
    const agent = await control.registerIdentity({
      actorId: owner.id, id: "agt_control01", kind: "agent", ownerId: owner.id,
      name: "Scout", handle: "scout", publicKey: key("agent"),
    });
    return { owner, agent };
  }

  it("registers public-key identities idempotently and binds children to their owner", async () => {
    const { owner, agent } = await identityWorld();
    const replay = await control.registerIdentity({
      kind: "user", name: "Owner", handle: "owner", publicKey: key("owner"),
    });
    expect(replay).toEqual({ ...owner, replayed: true });
    await expect(control.registerIdentity({
      kind: "user", name: "Changed owner", handle: "owner", publicKey: key("owner"),
    })).rejects.toThrow(/different identity terms/);
    await expect(control.registerIdentity({
      actorId: "usr_someone_else", kind: "agent", ownerId: owner.id,
      name: "Mole", publicKey: key("mole"),
    })).rejects.toThrow(/created by its owner/);
    expect(agent.ownerId).toBe(owner.id);
    expect((await control.resolvePublicAccount("@scout"))?.id).toBe(agent.id);
    expect((await control.resolvePublicAccount(agent.id))?.publicKey).toBeUndefined();
  });

  it("accepts each signed nonce once per actor and rejects stale or mismatched envelopes", async () => {
    const { owner, agent } = await identityWorld();
    const now = Date.now();
    const requestHash = hash("POST\n/pay\nbody");
    const request = {
      accountId: agent.id,
      kind: "agent" as const,
      expectedPublicKey: key("agent"),
      nonce: "nonce-control-0001",
      signedAtMs: now,
      requestHash,
    };
    await control.consumeSignedRequest(request);
    await expect(control.consumeSignedRequest(request)).rejects.toThrow(/nonce already used/);
    await control.consumeSignedRequest({ ...request, accountId: owner.id, kind: "user", expectedPublicKey: key("owner") });
    await expect(control.consumeSignedRequest({ ...request, nonce: "nonce-control-0002", expectedPublicKey: key("wrong") })).rejects.toThrow(/key changed/);
    await expect(control.consumeSignedRequest({ ...request, nonce: "nonce-control-0003", signedAtMs: now - 10 * 60_000 })).rejects.toThrow(/timestamp/);
    expect((await db.query("select * from money.signed_request_nonces")).rows).toHaveLength(2);
  });

  it("stores hashed owner sessions durably, caps them at ten, and revokes them on owner key rotation", async () => {
    const { owner, agent } = await identityWorld();
    const tokens = Array.from({ length: 11 }, (_, index) => hash(`session-${index}`));
    for (const token of tokens) await control.createOwnerSession(owner.id, token);
    expect(await control.resolveOwnerSession(tokens[0]!)).toBeUndefined();
    expect(await control.resolveOwnerSession(tokens[10]!)).toBe(owner.id);
    const active = await db.query<{ count: string }>(`
      select count(*)::text as count from money.owner_sessions
      where user_id = $1 and revoked_at is null and expires_at > clock_timestamp()
    `, [owner.id]);
    expect(active.rows[0]?.count).toBe("10");

    await control.rotatePublicKey(owner.id, agent.id, key("agent-new"));
    expect(await control.resolveOwnerSession(tokens[10]!)).toBe(owner.id);
    await control.rotatePublicKey(owner.id, owner.id, key("owner-new"));
    expect(await control.resolveOwnerSession(tokens[10]!)).toBeUndefined();
    expect(await control.accountForAuth(owner.id)).toEqual(expect.objectContaining({ publicKey: key("owner-new") }));
  });

  it("revokes one bearer session without touching the owner's other sessions", async () => {
    const { owner } = await identityWorld();
    const first = hash("first-session");
    const second = hash("second-session");
    await control.createOwnerSession(owner.id, first);
    await control.createOwnerSession(owner.id, second);
    expect(await control.revokeOwnerSession(owner.id, first)).toBe(true);
    expect(await control.revokeOwnerSession(owner.id, first)).toBe(false);
    expect(await control.resolveOwnerSession(first)).toBeUndefined();
    expect(await control.resolveOwnerSession(second)).toBe(owner.id);
  });

  it("scopes account balances to an owner and its children or to the signing child alone", async () => {
    const { owner, agent } = await identityWorld();
    const other = await control.registerIdentity({
      id: "usr_control02", kind: "user", name: "Other", handle: "other", publicKey: key("other"),
    });
    await ledger.postTransfer({ actorId: owner.id, operation: "fund", idempotencyKey: "fund", from: "external:funding", to: owner.id, amountMicros: 20n });
    await ledger.postTransfer({ actorId: owner.id, operation: "allocate", idempotencyKey: "allocate", from: owner.id, to: agent.id, amountMicros: 8n });
    expect(await control.accountState(owner.id)).toEqual([
      expect.objectContaining({ id: owner.id, balanceMicros: 12n }),
      expect.objectContaining({ id: agent.id, balanceMicros: 8n }),
    ]);
    expect(await control.accountState(agent.id)).toEqual([
      expect.objectContaining({ id: agent.id, balanceMicros: 8n }),
    ]);
    expect((await control.accountState(other.id)).map((account) => account.id)).toEqual([other.id]);
  });

  it("shares receipt evidence only with payment participants and their owners", async () => {
    const { owner, agent } = await identityWorld();
    const recipientOwner = await control.registerIdentity({
      id: "usr_control02", kind: "user", name: "Recipient", handle: "recipient", publicKey: key("recipient"),
    });
    const recipient = await control.registerIdentity({
      actorId: recipientOwner.id, id: "agt_control02", kind: "agent", ownerId: recipientOwner.id,
      name: "Writer", handle: "writer", publicKey: key("writer"),
    });
    const stranger = await control.registerIdentity({
      id: "usr_control03", kind: "user", name: "Stranger", handle: "stranger", publicKey: key("stranger"),
    });
    await ledger.postTransfer({ actorId: owner.id, operation: "fund", idempotencyKey: "fund", from: "external:funding", to: owner.id, amountMicros: 10n });
    await ledger.postTransfer({ actorId: owner.id, operation: "allocate", idempotencyKey: "allocate", from: owner.id, to: agent.id, amountMicros: 10n });
    await policy.grantMandate({
      userId: owner.id, agentId: agent.id, budgetMicros: 10n, perTxCapMicros: 10n,
      dailyCapMicros: 10n, escalateAboveMicros: 10n, newPayeeCapMicros: 10n,
      expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: "mandate",
    });
    const paid = await policy.requestPayment({ agentId: agent.id, idempotencyKey: "pay", to: recipient.id, amountMicros: 3n, memo: "work" });
    if (paid.status !== "posted") throw new Error("expected payment");

    expect(await control.paymentFeed(owner.id)).toEqual([
      expect.objectContaining({ receiptId: paid.receiptId, amountMicros: 3n, mandateId: expect.any(String) }),
      expect.objectContaining({ operation: "allocate" }),
      expect.objectContaining({ operation: "fund" }),
    ]);
    expect((await control.paymentFeed(recipientOwner.id))[0]).toEqual(expect.objectContaining({ receiptId: paid.receiptId }));
    expect(await control.paymentFeed(stranger.id)).toEqual([]);
    expect(await control.receipt(owner.id, paid.receiptId)).toEqual(expect.objectContaining({ evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/) }));
    expect(await control.receipt(recipientOwner.id, paid.receiptId)).toBeDefined();
    expect(await control.receipt(stranger.id, paid.receiptId)).toBeUndefined();
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
  });
});
