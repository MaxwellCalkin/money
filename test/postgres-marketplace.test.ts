import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresControlPlane } from "../src/db/control-plane.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { PostgresMarketplace } from "../src/db/marketplace.ts";
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

const key = (name: string) => `public-key-market-${name}-${"x".repeat(32)}`;

describe("Postgres marketplace transactions", () => {
  let db: EmbeddedPostgres;
  let control: PostgresControlPlane;
  let ledger: PostgresLedger;
  let policy: PostgresPolicy;
  let marketplace: PostgresMarketplace;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    control = new PostgresControlPlane(db);
    ledger = new PostgresLedger(db);
    policy = new PostgresPolicy(db);
    marketplace = new PostgresMarketplace(db);
  }, 30_000);

  afterEach(async () => {
    await db.close();
  });

  async function world(input: { price?: bigint; escalateAbove?: bigint } = {}) {
    const owner = await control.registerIdentity({
      id: "usr_market01", kind: "user", name: "Owner", handle: "owner", publicKey: key("owner"),
    });
    const agent = await control.registerIdentity({
      actorId: owner.id, id: "agt_market01", kind: "agent", ownerId: owner.id,
      name: "Scout", handle: "scout", publicKey: key("agent"),
    });
    const secondAgent = await control.registerIdentity({
      actorId: owner.id, id: "agt_market02", kind: "agent", ownerId: owner.id,
      name: "Writer", handle: "writer", publicKey: key("writer"),
    });
    const provider = await control.registerIdentity({
      actorId: owner.id, id: "prv_market01", kind: "provider", ownerId: owner.id,
      name: "Research Cloud", handle: "research-cloud", publicKey: key("provider"),
    });
    await ledger.postTransfer({
      actorId: owner.id, operation: "fund", idempotencyKey: "market-fund",
      from: "external:funding", to: owner.id, amountMicros: 20_000_000n,
    });
    await ledger.postTransfer({
      actorId: owner.id, operation: "allocate", idempotencyKey: "market-allocate-1",
      from: owner.id, to: agent.id, amountMicros: 10_000_000n,
    });
    await ledger.postTransfer({
      actorId: owner.id, operation: "allocate", idempotencyKey: "market-allocate-2",
      from: owner.id, to: secondAgent.id, amountMicros: 5_000_000n,
    });
    for (const [index, id] of [agent.id, secondAgent.id].entries()) {
      await policy.grantMandate({
        userId: owner.id,
        agentId: id,
        budgetMicros: index === 0 ? 10_000_000n : 5_000_000n,
        perTxCapMicros: 10_000_000n,
        dailyCapMicros: 10_000_000n,
        escalateAboveMicros: input.escalateAbove ?? 10_000_000n,
        newPayeeCapMicros: 10_000_000n,
        expiresAt: new Date(Date.now() + 86_400_000),
        idempotencyKey: `market-mandate-${index}`,
      });
    }
    const service = await marketplace.registerService({
      providerId: provider.id,
      slug: "market-report",
      name: "Market report",
      description: "Fresh machine-economy data",
      endpointUrl: "https://seller.example/report",
      priceMicros: input.price ?? 50_000n,
      idempotencyKey: "market-service",
    });
    return { owner, agent, secondAgent, provider, service };
  }

  it("publishes canonical service terms idempotently and supports safe shutdown", async () => {
    const { provider, service } = await world();
    expect(service.replayed).toBe(false);
    expect(service.priceMicros).toBe(50_000n);
    const replay = await marketplace.registerService({
      providerId: provider.id,
      slug: "MARKET-REPORT",
      name: "Market report",
      description: "Fresh machine-economy data",
      endpointUrl: "https://seller.example/report",
      priceMicros: 50_000n,
      idempotencyKey: "market-service",
    });
    expect(replay).toEqual(expect.objectContaining({ id: service.id, replayed: true }));
    await expect(marketplace.registerService({
      providerId: provider.id,
      slug: "market-report",
      name: "Changed terms",
      endpointUrl: "https://seller.example/report",
      priceMicros: 50_000n,
      idempotencyKey: "market-service",
    })).rejects.toThrow(/different terms/);
    expect(await marketplace.publicService("@research-cloud/market-report")).toEqual(
      expect.objectContaining({ id: service.id, active: true })
    );
    expect(await marketplace.publicServices()).toEqual([
      expect.objectContaining({ id: service.id }),
    ]);
    expect(await marketplace.setServiceActive(provider.id, service.id, false)).toEqual({
      serviceId: service.id, active: false, changed: true,
    });
    expect(await marketplace.publicService(service.id)).toBeUndefined();
    await expect(marketplace.createChallenge(provider.id, service.id)).rejects.toThrow(/inactive/);
    expect(await marketplace.setServiceActive(provider.id, service.id, true)).toEqual({
      serviceId: service.id, active: true, changed: true,
    });
  });

  it("charges a challenge once, binds it to one agent, and redeems it once", async () => {
    const { agent, secondAgent, provider, service } = await world();
    const challenge = await marketplace.createChallenge(provider.id, service.id);
    const paid = await marketplace.payChallenge(agent.id, challenge.id);
    expect(paid).toEqual(expect.objectContaining({ status: "posted", replayed: false }));
    if (paid.status !== "posted") throw new Error("expected challenge payment");
    expect(await ledger.balance(agent.id)).toBe(9_950_000n);
    expect(await ledger.balance(provider.id)).toBe(50_000n);

    const replay = await marketplace.payChallenge(agent.id, challenge.id);
    expect(replay).toEqual(expect.objectContaining({
      status: "posted", replayed: true, receiptId: paid.receiptId,
    }));
    const stolen = await marketplace.payChallenge(secondAgent.id, challenge.id);
    expect(stolen).toEqual(expect.objectContaining({
      status: "denied", code: "challenge_invalid",
    }));
    expect(await ledger.balance(provider.id)).toBe(50_000n);

    const redeemed = await marketplace.redeem({
      providerId: provider.id,
      serviceId: service.id,
      challengeId: challenge.id,
      receiptId: paid.receiptId,
    });
    expect(redeemed).toEqual(expect.objectContaining({ ok: true, challengeId: challenge.id }));
    expect(await marketplace.redeem({
      providerId: provider.id,
      serviceId: service.id,
      challengeId: challenge.id,
      receiptId: paid.receiptId,
    })).toEqual(expect.objectContaining({ ok: false, reason: expect.stringContaining("single-use") }));

    await db.query("update money.challenges set expires_at = clock_timestamp() - interval '1 minute' where id = $1", [challenge.id]);
    expect(await marketplace.payChallenge(agent.id, challenge.id)).toEqual(expect.objectContaining({
      status: "posted", replayed: true, receiptId: paid.receiptId,
    }));
  });

  it("claims approval-gated challenges, expires approval with the offer, and binds settlement atomically", async () => {
    const { owner, agent, secondAgent, provider, service } = await world({
      price: 3_000_000n,
      escalateAbove: 2_000_000n,
    });
    const challenge = await marketplace.createChallenge(provider.id, service.id);
    const requested = await marketplace.payChallenge(agent.id, challenge.id);
    expect(requested).toEqual(expect.objectContaining({ status: "approval_required" }));
    if (requested.status !== "approval_required") throw new Error("expected approval");
    const [claimed] = await marketplace.challenges(agent.id, [challenge.id]);
    expect(claimed).toEqual(expect.objectContaining({ claimedBy: agent.id }));
    expect(claimed).not.toHaveProperty("receiptId");
    expect(await marketplace.payChallenge(secondAgent.id, challenge.id)).toEqual(expect.objectContaining({
      status: "denied", code: "challenge_invalid",
    }));
    const approval = await policy.approval(owner.id, requested.approvalId);
    expect(approval?.expiresAt.getTime()).toBeLessThanOrEqual(challenge.expiresAt.getTime());

    const approved = await policy.resolveApproval(owner.id, requested.approvalId, "approve");
    expect(approved).toEqual(expect.objectContaining({ status: "posted" }));
    if (approved.status !== "posted") throw new Error("expected approved payment");
    const [bound] = await marketplace.challenges(agent.id, [challenge.id]);
    expect(bound).toEqual(expect.objectContaining({
      paidBy: agent.id,
      receiptId: approved.receiptId,
    }));
    await db.query("update money.challenges set expires_at = clock_timestamp() - interval '1 minute' where id = $1", [challenge.id]);
    expect(await marketplace.payChallenge(agent.id, challenge.id)).toEqual(expect.objectContaining({
      status: "posted", replayed: true, receiptId: approved.receiptId,
    }));
  });

  it("issues cumulative-capped partial refunds exactly once without recycling mandate authority", async () => {
    const { owner, agent, provider } = await world();
    const paid = await policy.requestPayment({
      agentId: agent.id,
      to: provider.id,
      amountMicros: 5_000_000n,
      memo: "large report",
      idempotencyKey: "refund-purchase",
    });
    if (paid.status !== "posted") throw new Error("expected purchase");
    const mandateBefore = await policy.listMandates(owner.id);
    expect(mandateBefore.find((mandate) => mandate.agentId === agent.id)?.spentMicros).toBe(5_000_000n);

    const first = await marketplace.refund({
      providerId: provider.id,
      receiptId: paid.receiptId,
      amountMicros: 2_000_000n,
      memo: "partial refund",
      idempotencyKey: "refund-1",
    });
    expect(first).toEqual(expect.objectContaining({
      status: "refunded", replayed: false, remainingMicros: 3_000_000n,
    }));
    expect(await marketplace.refund({
      providerId: provider.id,
      receiptId: paid.receiptId,
      amountMicros: 2_000_000n,
      memo: "partial refund",
      idempotencyKey: "refund-1",
    })).toEqual(expect.objectContaining({
      status: "refunded", replayed: true, remainingMicros: 3_000_000n,
    }));
    expect(await marketplace.refund({
      providerId: provider.id,
      receiptId: paid.receiptId,
      amountMicros: 1_000_000n,
      memo: "partial refund",
      idempotencyKey: "refund-1",
    })).toEqual(expect.objectContaining({ status: "denied", code: "idempotency_conflict" }));
    expect(await marketplace.refund({
      providerId: provider.id,
      receiptId: paid.receiptId,
      amountMicros: 4_000_000n,
      idempotencyKey: "refund-too-much",
    })).toEqual(expect.objectContaining({ status: "denied", code: "refund_invalid" }));

    const remainder = await marketplace.refund({
      providerId: provider.id,
      receiptId: paid.receiptId,
      amountMicros: 3_000_000n,
      idempotencyKey: "refund-2",
    });
    expect(remainder).toEqual(expect.objectContaining({ status: "refunded", remainingMicros: 0n }));
    expect(await ledger.balance(agent.id)).toBe(10_000_000n);
    expect(await ledger.balance(provider.id)).toBe(0n);
    expect((await policy.listMandates(owner.id)).find((mandate) => mandate.agentId === agent.id)?.spentMicros).toBe(5_000_000n);
    const refunds = await db.query<{ count: string; total: string }>(`
      select count(*)::text as count, sum(amount_micros)::text as total
      from money.transfers where refund_of = $1
    `, [paid.receiptId]);
    expect(refunds.rows[0]).toEqual({ count: "2", total: "5000000" });
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
  });

  it("serializes competing refunds so their total can never exceed the purchase", async () => {
    const { agent, provider } = await world();
    const paid = await policy.requestPayment({
      agentId: agent.id,
      to: provider.id,
      amountMicros: 100_000n,
      idempotencyKey: "race-purchase",
    });
    if (paid.status !== "posted") throw new Error("expected purchase");
    const results = await Promise.all([
      marketplace.refund({
        providerId: provider.id, receiptId: paid.receiptId,
        amountMicros: 60_000n, idempotencyKey: "race-refund-a",
      }),
      marketplace.refund({
        providerId: provider.id, receiptId: paid.receiptId,
        amountMicros: 60_000n, idempotencyKey: "race-refund-b",
      }),
    ]);
    expect(results.filter((result) => result.status === "refunded")).toHaveLength(1);
    expect(results.filter((result) => result.status === "denied")).toEqual([
      expect.objectContaining({ code: "refund_invalid" }),
    ]);
    const total = await db.query<{ total: string }>(
      "select coalesce(sum(amount_micros), 0)::text as total from money.transfers where refund_of = $1",
      [paid.receiptId]
    );
    expect(total.rows[0]?.total).toBe("60000");
  });

  it("keeps challenge state tenant-scoped", async () => {
    const { agent, provider, service } = await world();
    const stranger = await control.registerIdentity({
      id: "usr_market99", kind: "user", name: "Stranger", handle: "stranger", publicKey: key("stranger"),
    });
    const challenge = await marketplace.createChallenge(provider.id, service.id);
    expect(await marketplace.challenges(stranger.id, [challenge.id])).toEqual([]);
    await marketplace.payChallenge(agent.id, challenge.id);
    expect(await marketplace.challenges(agent.id, [challenge.id])).toEqual([
      expect.objectContaining({ id: challenge.id, claimedBy: agent.id }),
    ]);
    expect(await marketplace.challenges(provider.id, [challenge.id])).toHaveLength(1);
    expect(await marketplace.challenges(stranger.id, [challenge.id])).toEqual([]);
  });

  it("preserves pre-v0.7 retries and receipt verification across the live migration", async () => {
    const legacyDb = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
    try {
      for (const name of ["0001_ledger.sql", "0002_policy.sql", "0003_control_plane.sql"]) {
        await legacyDb.executeScript(readFileSync(join(migrations, name), "utf8"));
      }
      const legacyLedger = new PostgresLedger(legacyDb);
      const owner = await legacyLedger.registerAccount({
        id: "usr_upgrade01", kind: "user", name: "Upgrade owner", publicKey: key("upgrade-owner"),
      });
      const agent = await legacyLedger.registerAccount({
        id: "agt_upgrade01", kind: "agent", ownerId: owner.id, name: "Upgrade agent", publicKey: key("upgrade-agent"),
      });
      const provider = await legacyLedger.registerAccount({
        id: "prv_upgrade01", kind: "provider", ownerId: owner.id, name: "Upgrade provider",
        handle: "upgrade-provider", publicKey: key("upgrade-provider"),
      });
      const funded = await legacyLedger.postTransfer({
        actorId: owner.id, operation: "fund", idempotencyKey: "before-upgrade-fund",
        from: "external:funding", to: owner.id, amountMicros: 1_000_000n,
      });
      await legacyLedger.postTransfer({
        actorId: owner.id, operation: "allocate", idempotencyKey: "before-upgrade-allocate",
        from: owner.id, to: agent.id, amountMicros: 1_000_000n,
      });
      const purchase = await legacyLedger.postTransfer({
        actorId: agent.id, operation: "pay", idempotencyKey: "before-upgrade-pay",
        from: agent.id, to: provider.id, amountMicros: 100_000n,
      });
      if (funded.status !== "posted" || purchase.status !== "posted") throw new Error("expected legacy postings");
      expect(await new PostgresControlPlane(legacyDb).ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });

      await legacyDb.executeScript(readFileSync(join(migrations, "0004_marketplace.sql"), "utf8"));
      const replay = await legacyLedger.postTransfer({
        actorId: owner.id, operation: "fund", idempotencyKey: "before-upgrade-fund",
        from: "external:funding", to: owner.id, amountMicros: 1_000_000n,
      });
      expect(replay).toEqual(expect.objectContaining({
        status: "posted", replayed: true, receiptId: funded.receiptId,
      }));
      const upgradedMarketplace = new PostgresMarketplace(legacyDb);
      expect(await upgradedMarketplace.refund({
        providerId: provider.id,
        receiptId: purchase.receiptId,
        amountMicros: 40_000n,
        idempotencyKey: "after-upgrade-refund",
      })).toEqual(expect.objectContaining({ status: "refunded", remainingMicros: 60_000n }));
      expect(await new PostgresControlPlane(legacyDb).ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
    } finally {
      await legacyDb.close();
    }
  });
});
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
