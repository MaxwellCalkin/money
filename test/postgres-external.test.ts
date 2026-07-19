import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresControlPlane } from "../src/db/control-plane.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresExternal } from "../src/db/external.ts";
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

const PAY_TO = "0x209693bc6afc0c5328ba36faf03c514ef312287c";
const ASSET = "0x00000000000000000000000000000000000c0ffe";
const HOST = "data.example.com";
const POLICY_PAYEE = `x402:${HOST}:${PAY_TO}`;
const key = (name: string) => `public-key-external-${name}-${"x".repeat(32)}`;

describe("Postgres external settlement state machine", () => {
  let db: EmbeddedPostgres;
  let control: PostgresControlPlane;
  let ledger: PostgresLedger;
  let policy: PostgresPolicy;
  let external: PostgresExternal;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    control = new PostgresControlPlane(db);
    ledger = new PostgresLedger(db);
    policy = new PostgresPolicy(db);
    external = new PostgresExternal(db);
  }, 30_000);

  afterEach(async () => {
    await db.close();
  });

  async function world(escalateAboveMicros = 1_000_000n) {
    const owner = await control.registerIdentity({
      id: "usr_external1", kind: "user", name: "Owner", handle: "owner-ext", publicKey: key("owner"),
    });
    const agent = await control.registerIdentity({
      actorId: owner.id, id: "agt_external1", kind: "agent", ownerId: owner.id,
      name: "Scout", handle: "scout-ext", publicKey: key("agent"),
    });
    const otherOwner = await control.registerIdentity({
      id: "usr_external2", kind: "user", name: "Other", handle: "other-ext", publicKey: key("other"),
    });
    const otherAgent = await control.registerIdentity({
      actorId: otherOwner.id, id: "agt_external2", kind: "agent", ownerId: otherOwner.id,
      name: "Other agent", handle: "other-agent-ext", publicKey: key("other-agent"),
    });
    await ledger.postTransfer({
      actorId: owner.id, operation: "fund", idempotencyKey: "external-fund",
      from: "external:funding", to: owner.id, amountMicros: 2_000_000n,
    });
    await ledger.postTransfer({
      actorId: owner.id, operation: "allocate", idempotencyKey: "external-allocate",
      from: owner.id, to: agent.id, amountMicros: 1_000_000n,
    });
    const granted = await policy.grantMandate({
      userId: owner.id,
      agentId: agent.id,
      budgetMicros: 1_000_000n,
      perTxCapMicros: 1_000_000n,
      dailyCapMicros: 1_000_000n,
      escalateAboveMicros,
      newPayeeCapMicros: 100_000n,
      expiresAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: `external-mandate-${escalateAboveMicros}`,
    });
    return { owner, agent, otherOwner, otherAgent, mandateId: granted.mandateId };
  }

  function requestInput(agentId: string, idempotencyKey: string, input: {
    amountMicros?: bigint;
    authorizationExpiresAt?: Date;
    reverseAfter?: Date;
    payTo?: string;
    host?: string;
  } = {}) {
    const host = input.host ?? HOST;
    const payTo = input.payTo ?? PAY_TO;
    const amountMicros = input.amountMicros ?? 50_000n;
    const authorizationExpiresAt = input.authorizationExpiresAt ?? new Date(Date.now() + 60_000);
    const reverseAfter = input.reverseAfter ?? new Date(authorizationExpiresAt.getTime() + 60_000);
    const plaintext = `authorization:${agentId}:${idempotencyKey}`;
    return {
      externalId: randomUUID(),
      agentId,
      idempotencyKey,
      host,
      payTo,
      settlementAsset: ASSET,
      settlementNetwork: "mock-local",
      resource: `https://${host}/report`,
      policyPayee: `x402:${host}:${payTo.toLowerCase()}`,
      amountMicros,
      paymentHeaderCiphertext: Buffer.concat([Buffer.alloc(32, 7), Buffer.from(plaintext)]),
      authorizationHash: createHash("sha256").update(plaintext).digest(),
      authorizationExpiresAt,
      reverseAfter,
    };
  }

  it("atomically debits, replays one authorization, scopes reads, and confirms once", async () => {
    const { owner, agent, otherOwner, otherAgent, mandateId } = await world();
    const first = await external.request(requestInput(agent.id, "external-one"));
    expect(first).toEqual(expect.objectContaining({
      status: "posted", replayed: false, externalState: "pending",
      transferId: expect.any(String), receiptId: expect.any(String),
    }));
    expect(await ledger.balance(agent.id)).toBe(950_000n);
    expect(await ledger.balance("external:x402")).toBe(50_000n);

    const replay = await external.request(requestInput(agent.id, "external-one"));
    expect(replay).toEqual(expect.objectContaining({
      status: "posted", replayed: true, externalId: first.externalId,
      transferId: first.transferId, receiptId: first.receiptId,
    }));
    expect(await ledger.balance(agent.id)).toBe(950_000n);
    const conflict = await external.request(requestInput(agent.id, "external-one", { amountMicros: 49_999n }));
    expect(conflict).toEqual(expect.objectContaining({ status: "denied", code: "idempotency_conflict", replayed: true }));

    expect((await external.list(agent.id))[0]).toEqual(expect.objectContaining({ id: first.externalId, policyPayee: POLICY_PAYEE }));
    expect((await external.list(owner.id))[0]).toEqual(expect.objectContaining({ id: first.externalId }));
    expect(await external.list(otherOwner.id)).toEqual([]);
    expect(await external.list(otherAgent.id)).toEqual([]);
    expect(await external.secret(otherAgent.id, first.externalId!)).toBeUndefined();
    expect((await external.secretByKey(agent.id, "external-one"))?.id).toBe(first.externalId);

    const mandate = await policy.mandate(owner.id, mandateId);
    expect(mandate).toEqual(expect.objectContaining({ spentMicros: 50_000n, spentTodayMicros: 50_000n }));
    const confirmed = await external.confirm(agent.id, first.externalId!, "0xmocktx1");
    expect(confirmed).toEqual({ ok: true, replayed: false, state: "confirmed", settledTx: "0xmocktx1" });
    expect(await external.confirm(agent.id, first.externalId!, "0xmocktx1")).toEqual({
      ok: true, replayed: true, state: "confirmed", settledTx: "0xmocktx1",
    });
    expect(await external.confirm(agent.id, first.externalId!, "0xother")).toEqual(expect.objectContaining({
      ok: false, replayed: true, state: "confirmed", settledTx: "0xmocktx1",
    }));
    const second = await external.request(requestInput(agent.id, "external-two", { amountMicros: 40_000n }));
    await expect(external.confirm(agent.id, second.externalId!, "0xmocktx1")).rejects.toMatchObject({ code: "23505" });
    expect((await external.secret(agent.id, second.externalId!))?.state).toBe("pending");
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
  });

  it("persists exact owner approval terms and only debits after approval", async () => {
    const { owner, agent, otherOwner } = await world(10_000n);
    const requested = await external.request(requestInput(agent.id, "external-approval"));
    expect(requested).toEqual(expect.objectContaining({
      status: "approval_required", replayed: false, externalState: "approval_required",
      approvalId: expect.any(String),
    }));
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);
    expect(await external.isExternalApproval(owner.id, requested.approvalId!)).toBe(true);
    expect(await external.isExternalApproval(otherOwner.id, requested.approvalId!)).toBe(false);

    const approved = await external.resolveApproval(owner.id, requested.approvalId!, "approve");
    expect(approved).toEqual(expect.objectContaining({
      status: "posted", externalId: requested.externalId, externalState: "pending",
      transferId: expect.any(String), receiptId: expect.any(String), approvalId: requested.approvalId,
    }));
    expect(await ledger.balance(agent.id)).toBe(950_000n);
    expect((await policy.approval(owner.id, requested.approvalId!))?.status).toBe("approved");
    const replay = await external.resolveApproval(owner.id, requested.approvalId!, "approve");
    expect(replay).toEqual(expect.objectContaining({ status: "posted", replayed: true, transferId: approved.transferId }));
    await expect(external.resolveApproval(otherOwner.id, requested.approvalId!, "approve")).rejects.toMatchObject({ code: "42501" });
  });

  it("makes rejection and expiry durable without leaking or moving funds", async () => {
    const { owner, agent } = await world(10_000n);
    const rejected = await external.request(requestInput(agent.id, "external-reject"));
    const rejection = await external.resolveApproval(owner.id, rejected.approvalId!, "reject", "not this vendor");
    expect(rejection).toEqual(expect.objectContaining({
      status: "denied", code: "approval_rejected", externalState: "cancelled",
    }));
    expect(rejection.paymentHeaderCiphertext).toBeUndefined();
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);
    expect((await external.request(requestInput(agent.id, "external-reject"))).status).toBe("denied");

    const expiresAt = new Date(Date.now() + 120);
    const expiring = await external.request(requestInput(agent.id, "external-expire", {
      amountMicros: 40_000n,
      authorizationExpiresAt: expiresAt,
      reverseAfter: new Date(expiresAt.getTime() + 50),
    }));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const expired = await external.resolveApproval(owner.id, expiring.approvalId!, "approve");
    expect(expired).toEqual(expect.objectContaining({
      status: "denied", code: "approval_expired", externalState: "cancelled",
    }));
    expect((await policy.approval(owner.id, expiring.approvalId!))?.status).toBe("expired");
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);
  });

  it("cancels external approval state immediately when its mandate is revoked", async () => {
    const { owner, agent, mandateId } = await world(10_000n);
    const requested = await external.request(requestInput(agent.id, "external-revoked-approval"));
    expect(requested.status).toBe("approval_required");
    expect(await policy.revokeMandate(owner.id, mandateId)).toBe(true);
    expect((await policy.approval(owner.id, requested.approvalId!))?.status).toBe("failed");
    expect((await external.secret(agent.id, requested.externalId!))?.state).toBe("cancelled");
    expect(await external.request(requestInput(agent.id, "external-revoked-approval"))).toEqual(expect.objectContaining({
      status: "denied", code: "approval_failed", externalState: "cancelled", replayed: true,
    }));
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);
  });

  it("reverses expired pending debits once and never restores mandate authority", async () => {
    const { owner, agent, mandateId } = await world();
    const expiresAt = new Date(Date.now() + 80);
    const payment = await external.request(requestInput(agent.id, "external-reverse", {
      authorizationExpiresAt: expiresAt,
      reverseAfter: new Date(expiresAt.getTime() + 60),
    }));
    expect(await ledger.balance(agent.id)).toBe(950_000n);
    const spent = (await policy.mandate(owner.id, mandateId))!.spentMicros;
    await new Promise((resolve) => setTimeout(resolve, 190));
    const [firstSweep, secondSweep] = await Promise.all([external.sweep(10), external.sweep(10)]);
    expect([...firstSweep, ...secondSweep]).toHaveLength(1);
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);
    expect(await ledger.balance("external:x402")).toBe(0n);
    expect((await policy.mandate(owner.id, mandateId))!.spentMicros).toBe(spent);
    expect((await external.secret(agent.id, payment.externalId!))?.state).toBe("reversed");
    expect(await external.confirm(agent.id, payment.externalId!, "0xlate")).toEqual(expect.objectContaining({
      ok: false, state: "reversed",
    }));
    expect(await external.request(requestInput(agent.id, "external-reverse"))).toEqual(expect.objectContaining({
      status: "denied", code: "permit_invalid", externalState: "reversed", replayed: true,
    }));
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
  });

  it("rejects raw boundary transfers and immutable-term or lifecycle tampering", async () => {
    const { agent } = await world();
    await expect(ledger.postTransfer({
      actorId: agent.id,
      operation: "pay",
      idempotencyKey: "raw-boundary",
      from: agent.id,
      to: "external:x402",
      amountMicros: 50_000n,
    })).rejects.toMatchObject({ code: "42501" });
    const payment = await external.request(requestInput(agent.id, "immutable-external"));
    await expect(db.query(
      "update money.external_payments set amount_micros = amount_micros + 1 where id = $1::uuid",
      [payment.externalId]
    )).rejects.toThrow(/economic terms are immutable/);
    await expect(db.query(
      "update money.external_payments set state = 'reversed' where id = $1::uuid",
      [payment.externalId]
    )).rejects.toThrow(/lifecycle|transition/i);
    await expect(db.query(
      "delete from money.external_payments where id = $1::uuid",
      [payment.externalId]
    )).rejects.toThrow(/append-only/);
  });

  it("preserves v0.7 retries and receipt hashes across the live v0.8 migration", async () => {
    const legacyDb = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
    try {
      for (const name of ["0001_ledger.sql", "0002_policy.sql", "0003_control_plane.sql", "0004_marketplace.sql"]) {
        await legacyDb.executeScript(readFileSync(join(migrations, name), "utf8"));
      }
      const legacyLedger = new PostgresLedger(legacyDb);
      const legacyPolicy = new PostgresPolicy(legacyDb);
      const owner = await legacyLedger.registerAccount({
        id: "usr_extupgrade", kind: "user", name: "Upgrade owner", publicKey: key("upgrade-owner"),
      });
      const agent = await legacyLedger.registerAccount({
        id: "agt_extupgrade", kind: "agent", ownerId: owner.id, name: "Upgrade agent", publicKey: key("upgrade-agent"),
      });
      const peer = await legacyLedger.registerAccount({
        id: "agt_extpeer01", kind: "agent", ownerId: owner.id, name: "Upgrade peer", publicKey: key("upgrade-peer"),
      });
      const funded = await legacyLedger.postTransfer({
        actorId: owner.id, operation: "fund", idempotencyKey: "v07-fund",
        from: "external:funding", to: owner.id, amountMicros: 1_000_000n,
      });
      await legacyLedger.postTransfer({
        actorId: owner.id, operation: "allocate", idempotencyKey: "v07-allocate",
        from: owner.id, to: agent.id, amountMicros: 1_000_000n,
      });
      const paid = await legacyLedger.postTransfer({
        actorId: agent.id, operation: "pay", idempotencyKey: "v07-pay",
        from: agent.id, to: peer.id, amountMicros: 25_000n,
      });
      if (funded.status !== "posted" || paid.status !== "posted") throw new Error("expected v0.7 postings");
      await legacyPolicy.grantMandate({
        userId: owner.id, agentId: agent.id,
        budgetMicros: 500_000n, perTxCapMicros: 500_000n, dailyCapMicros: 500_000n,
        escalateAboveMicros: 500_000n, newPayeeCapMicros: 100_000n,
        expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: "v07-mandate",
      });
      expect(await new PostgresControlPlane(legacyDb).ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });

      await legacyDb.executeScript(readFileSync(join(migrations, "0005_external_settlement.sql"), "utf8"));
      expect(await legacyLedger.postTransfer({
        actorId: owner.id, operation: "fund", idempotencyKey: "v07-fund",
        from: "external:funding", to: owner.id, amountMicros: 1_000_000n,
      })).toEqual(expect.objectContaining({ status: "posted", replayed: true, receiptId: funded.receiptId }));
      expect(await legacyLedger.postTransfer({
        actorId: agent.id, operation: "pay", idempotencyKey: "v07-pay",
        from: agent.id, to: peer.id, amountMicros: 25_000n,
      })).toEqual(expect.objectContaining({ status: "posted", replayed: true, receiptId: paid.receiptId }));
      const upgradedExternal = new PostgresExternal(legacyDb);
      expect(await upgradedExternal.request(requestInput(agent.id, "v08-first-external"))).toEqual(expect.objectContaining({
        status: "posted", externalState: "pending",
      }));
      expect(await new PostgresControlPlane(legacyDb).ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
    } finally {
      await legacyDb.close();
    }
  });
});
