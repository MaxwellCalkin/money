import { createHash } from "node:crypto";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresCompliance } from "../src/db/compliance.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { runMigrations } from "../src/db/migrate.ts";

class EmbeddedPostgres implements TransactionalDatabase {
  constructor(readonly pg: PGliteInterface) {}
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string, values: readonly unknown[] = []
  ): Promise<QueryRows<T>> {
    const result = await this.pg.query<T>(text, [...values]);
    return { rows: result.rows, affectedRows: result.affectedRows };
  }
  async executeScript(text: string) { await this.pg.exec(text); }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (transaction: Transaction) => work({
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(
        text: string, values: readonly unknown[] = []
      ) => {
        const result = await transaction.query<R>(text, [...values]);
        return { rows: result.rows, affectedRows: result.affectedRows };
      },
      executeScript: async (text: string) => { await transaction.exec(text); },
    }));
  }
  async close() { await this.pg.close(); }
}

const hash = (value: string) => createHash("sha256").update(value).digest();

describe("Postgres compliance and risk perimeter", () => {
  let db: EmbeddedPostgres;
  let ledger: PostgresLedger;
  let compliance: PostgresCompliance;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    ledger = new PostgresLedger(db);
    compliance = new PostgresCompliance(db);
  }, 30_000);

  afterEach(async () => { await db.close(); });

  async function approve(userId: string, riskTier: "low" | "standard" | "high" = "standard") {
    const observedAt = new Date(Date.now() - 1_000);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    await compliance.beginVerification({
      userId, subjectType: "individual", countryCode: "US",
      expectedSingleMicros: 5_000_000_000n,
      expectedMonthlyMicros: 50_000_000_000n,
    });
    await compliance.recordEvidence({
      subjectAccountId: userId, kind: "identity", provider: "fixture",
      providerResultRef: `identity-${userId}`, decision: "clear",
      evidenceHash: hash(`identity:${userId}`), listVersion: "identity-v1",
      observedAt, expiresAt, normalized: { identityVerified: true },
    });
    await compliance.recordEvidence({
      subjectAccountId: userId, kind: "sanctions", provider: "fixture",
      providerResultRef: `sanctions-${userId}`, decision: "clear",
      evidenceHash: hash(`sanctions:${userId}`), listVersion: "screening-v1",
      observedAt, expiresAt, normalized: { matches: 0 },
    });
    return compliance.approveSubject({
      subjectAccountId: userId, riskTier,
      nextReviewAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      reviewReference: `CASE-${userId}`, reason: "fixture evidence reviewed",
    });
  }

  async function family(prefix: string) {
    const owner = await ledger.registerAccount({
      id: `usr_${prefix}owner`, kind: "user", name: `${prefix} owner`,
    });
    const agent = await ledger.registerAccount({
      id: `agt_${prefix}agent`, kind: "agent", ownerId: owner.id, name: `${prefix} agent`,
    });
    return { owner, agent };
  }

  it("fails closed until both customer subjects have current reviewed evidence", async () => {
    const source = await family("source01");
    const destination = await family("dest0001");

    const blockedFunding = await ledger.postTransfer({
      actorId: source.owner.id, operation: "fund", idempotencyKey: "fund-before-kyc",
      from: "external:funding", to: source.owner.id, amountMicros: 2_000_000n,
    });
    expect(blockedFunding).toEqual(expect.objectContaining({
      status: "denied", code: "compliance_required", replayed: false,
    }));
    await approve(source.owner.id);
    expect(await ledger.postTransfer({
      actorId: source.owner.id, operation: "fund", idempotencyKey: "fund-before-kyc",
      from: "external:funding", to: source.owner.id, amountMicros: 2_000_000n,
    })).toEqual(expect.objectContaining({ status: "denied", replayed: true }));
    expect(await ledger.postTransfer({
      actorId: source.owner.id, operation: "fund", idempotencyKey: "fund-after-kyc",
      from: "external:funding", to: source.owner.id, amountMicros: 2_000_000n,
    })).toEqual(expect.objectContaining({ status: "posted" }));
    expect(await ledger.postTransfer({
      actorId: source.owner.id, operation: "allocate", idempotencyKey: "allocate",
      from: source.owner.id, to: source.agent.id, amountMicros: 2_000_000n,
    })).toEqual(expect.objectContaining({ status: "posted" }));

    const blockedPayment = await ledger.postTransfer({
      actorId: source.agent.id, operation: "pay", idempotencyKey: "pay-before-destination-kyc",
      from: source.agent.id, to: destination.agent.id, amountMicros: 100_000n,
    });
    expect(blockedPayment).toEqual(expect.objectContaining({
      status: "denied", code: "compliance_required",
    }));
    await approve(destination.owner.id);
    expect(await ledger.postTransfer({
      actorId: source.agent.id, operation: "pay", idempotencyKey: "pay-after-destination-kyc",
      from: source.agent.id, to: destination.agent.id, amountMicros: 100_000n,
    })).toEqual(expect.objectContaining({ status: "posted" }));

    const evidence = await db.query<{ decisions: number; links: number }>(`
      select
        (select count(*)::integer from money.risk_decisions) as decisions,
        (select count(*)::integer from money.risk_transfer_links) as links
    `);
    expect(evidence.rows[0]).toEqual({ decisions: 4, links: 2 });
  });

  it("requires a current clear counterparty decision for external spend", async () => {
    const source = await family("extern01");
    await approve(source.owner.id);
    await ledger.postTransfer({
      actorId: source.owner.id, operation: "fund", idempotencyKey: "fund",
      from: "external:funding", to: source.owner.id, amountMicros: 2_000_000n,
    });
    await ledger.postTransfer({
      actorId: source.owner.id, operation: "allocate", idempotencyKey: "allocate",
      from: source.owner.id, to: source.agent.id, amountMicros: 2_000_000n,
    });
    const externalPayee = "https://api.vendor.test|eip155:8453|0x0000000000000000000000000000000000000001";
    const call = (key: string) => db.query<{
      status: string; denial_code: string | null; transfer_id: string | null;
    }>(`
      select * from money_private.post_transfer_kernel(
        $1,'external_debit',$2,$1,'external:x402','USD',$3,'external test',$4::jsonb,null
      )
    `, [source.agent.id, key, "100000", JSON.stringify({ externalPayee })]);

    expect((await call("external-unscreened")).rows[0]).toEqual(expect.objectContaining({
      status: "denied", denial_code: "compliance_required",
    }));
    const counterparty = await compliance.registerCounterparty({
      kind: "wallet", canonicalRef: externalPayee, label: "Vendor wallet",
      provider: "fixture", providerRef: "wallet-vendor-1",
    });
    await compliance.recordCounterpartyScreening({
      counterpartyId: counterparty.id, state: "clear", evidenceHash: hash("wallet-clear"),
      listVersion: "ofac-fixture-v1", screenedAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    });
    expect((await call("external-screened")).rows[0]).toEqual(expect.objectContaining({
      status: "posted", transfer_id: expect.any(String),
    }));

    const expired = await compliance.registerCounterparty({
      kind: "wallet", canonicalRef: `${externalPayee}-expired`, label: "Expired wallet",
    });
    await compliance.recordCounterpartyScreening({
      counterpartyId: expired.id, state: "clear", evidenceHash: hash("wallet-expired"),
      screenedAt: new Date(Date.now() - 2 * 24 * 60 * 60_000),
      expiresAt: new Date(Date.now() - 24 * 60 * 60_000),
    });
    const expiredCall = await db.query<{ status: string; denial_code: string | null }>(`
      select * from money_private.post_transfer_kernel(
        $1,'external_debit','external-expired',$1,'external:x402','USD',100000,'external test',$2::jsonb,null
      )
    `, [source.agent.id, JSON.stringify({ externalPayee: `${externalPayee}-expired` })]);
    expect(expiredCall.rows[0]).toEqual(expect.objectContaining({
      status: "denied", denial_code: "compliance_required",
    }));
  });

  it("serializes aggregate velocity so concurrent agents cannot exceed the customer limit", async () => {
    const source = await family("velocity");
    const destination = await family("veldest1");
    await approve(source.owner.id, "high");
    await approve(destination.owner.id);
    await ledger.postTransfer({
      actorId: source.owner.id, operation: "fund", idempotencyKey: "fund",
      from: "external:funding", to: source.owner.id, amountMicros: 3_000_000_000n,
    });
    await ledger.postTransfer({
      actorId: source.owner.id, operation: "allocate", idempotencyKey: "allocate",
      from: source.owner.id, to: source.agent.id, amountMicros: 3_000_000_000n,
    });
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => ledger.postTransfer({
      actorId: source.agent.id, operation: "pay", idempotencyKey: `velocity-${index}`,
      from: source.agent.id, to: destination.agent.id, amountMicros: 600_000_000n,
    })));
    expect(results.filter((result) => result.status === "posted")).toHaveLength(4);
    const denied = results.find((result) => result.status === "denied");
    expect(denied).toEqual(expect.objectContaining({ code: "risk_limit" }));
    expect(await ledger.balance(destination.agent.id)).toBe(2_400_000_000n);
    const counter = await db.query<{ amount_micros: string | number | bigint; transfer_count: string | number | bigint }>(`
      select amount_micros, transfer_count from money.risk_velocity_buckets
      where subject_account_id = $1 and bucket_day = current_date and category = 'all_outflow'
    `, [source.owner.id]);
    expect(BigInt(counter.rows[0]!.amount_micros)).toBe(2_400_000_000n);
    expect(BigInt(counter.rows[0]!.transfer_count)).toBe(4n);
  });

  it("freezes a whole account family and preserves append-only review evidence", async () => {
    const source = await family("restrict");
    await approve(source.owner.id);
    await ledger.postTransfer({
      actorId: source.owner.id, operation: "fund", idempotencyKey: "fund",
      from: "external:funding", to: source.owner.id, amountMicros: 1_000_000n,
    });
    await ledger.postTransfer({
      actorId: source.owner.id, operation: "allocate", idempotencyKey: "allocate",
      from: source.owner.id, to: source.agent.id, amountMicros: 1_000_000n,
    });
    const externalPayee = "https://restricted.vendor.test|eip155:8453|0x0000000000000000000000000000000000000002";
    const counterparty = await compliance.registerCounterparty({
      kind: "wallet", canonicalRef: externalPayee, label: "Restricted-flow vendor",
    });
    await compliance.recordCounterpartyScreening({
      counterpartyId: counterparty.id, state: "clear", evidenceHash: hash("restricted-vendor-clear"),
      screenedAt: new Date(Date.now() - 1_000), expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    });
    expect((await db.query<{ status: string }>(`
      select * from money_private.post_transfer_kernel(
        $1,'external_debit','external-before-hold',$1,'external:x402','USD',100000,'external test',$2::jsonb,null
      )
    `, [source.agent.id, JSON.stringify({ externalPayee })])).rows[0]?.status).toBe("posted");
    const complianceCase = await compliance.openCase({
      subjectAccountId: source.owner.id, kind: "transaction_monitoring", severity: "high",
      alertCode: "velocity_anomaly", summary: "Fixture transaction pattern requires review",
      dueAt: new Date(Date.now() + 24 * 60 * 60_000), reviewReference: "ALERT-001",
      reason: "automated monitoring referral",
    });
    await compliance.restrictSubject({
      subjectAccountId: source.owner.id, caseId: complianceCase.id,
      reasonCode: "monitoring_review", reason: "hold while case is reviewed",
    });
    const statuses = await db.query<{ id: string; status: string }>(
      "select id, status from money.accounts where id = $1 or owner_id = $1 order by id",
      [source.owner.id]
    );
    expect(statuses.rows.every((row) => row.status === "frozen")).toBe(true);
    const reversal = await db.query<{ status: string }>(`
      select * from money_private.post_transfer_kernel(
        'external:x402','external_reversal','external-reversal-after-hold',
        'external:x402',$1,'USD',100000,'restricted unwind',$2::jsonb,null
      )
    `, [source.agent.id, JSON.stringify({ externalPayee })]);
    expect(reversal.rows[0]?.status).toBe("posted");
    expect((await db.query<{ status: string }>(
      "select status from money.accounts where id = $1", [source.agent.id]
    )).rows[0]?.status).toBe("frozen");
    await expect(db.query(
      "update money.compliance_case_actions set reason = 'tampered' where case_id = $1",
      [complianceCase.id]
    )).rejects.toThrow(/append-only/i);
    await compliance.resolveCase({
      caseId: complianceCase.id, status: "closed_no_action",
      reviewReference: "CASE-REVIEW-001", reason: "review found expected behavior",
    });
    const released = await compliance.releaseRestriction({
      subjectAccountId: source.owner.id, reviewReference: "RELEASE-001",
      reason: "case closed with no action and evidence remains current",
    });
    expect(released.state).toBe("approved");
    const active = await db.query<{ status: string }>(
      "select status from money.accounts where id = $1 or owner_id = $1", [source.owner.id]
    );
    expect(active.rows.every((row) => row.status === "active")).toBe(true);
  });

  it("turns a blocked provider result into a restricted subject and critical case", async () => {
    const source = await family("blocked1");
    await compliance.beginVerification({
      userId: source.owner.id, subjectType: "individual", countryCode: "US",
      expectedSingleMicros: 1_000_000n, expectedMonthlyMicros: 10_000_000n,
    });
    const result = await compliance.recordEvidence({
      subjectAccountId: source.owner.id, kind: "sanctions", provider: "fixture",
      providerResultRef: "blocked-screening-1", decision: "blocked",
      evidenceHash: hash("blocked-screening"), listVersion: "screening-v1",
      observedAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      normalized: { matchDisposition: "blocked" },
    });
    expect(result.subjectState).toBe("restricted");
    expect((await compliance.state(source.owner.id))?.screeningState).toBe("review");
    const cases = await compliance.listCases();
    expect(cases).toEqual([expect.objectContaining({
      subjectAccountId: source.owner.id, severity: "critical", status: "open",
    })]);
    expect((await db.query<{ status: string }>(
      "select status from money.accounts where id = $1", [source.owner.id]
    )).rows[0]?.status).toBe("frozen");
  });

  it("sweeps expired reviews and counterparty decisions into fail-closed state", async () => {
    const source = await family("expiry01");
    await approve(source.owner.id);
    const counterparty = await compliance.registerCounterparty({
      kind: "wallet", canonicalRef: "wallet:expiry-fixture", label: "Expiring wallet",
    });
    await compliance.recordCounterpartyScreening({
      counterpartyId: counterparty.id,
      state: "clear",
      evidenceHash: hash("expiring-wallet-clear"),
      screenedAt: new Date(Date.now() - 2 * 24 * 60 * 60_000),
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    });
    await db.query(
      "update money.compliance_subjects set next_review_at = clock_timestamp() - interval '1 second' where account_id = $1",
      [source.owner.id]
    );
    await db.query(
      "update money.compliance_counterparties set expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [counterparty.id]
    );

    expect(await compliance.sweepExpired()).toEqual({
      restrictedSubjects: 1,
      expiredCounterparties: 1,
    });
    expect((await compliance.state(source.owner.id))?.state).toBe("restricted");
    expect((await db.query<{ state: string }>(
      "select state from money.compliance_counterparties where id = $1", [counterparty.id]
    )).rows[0]?.state).toBe("expired");
    expect((await db.query<{ status: string }>(
      "select status from money.accounts where id = $1", [source.agent.id]
    )).rows[0]?.status).toBe("frozen");
    expect(await compliance.listCases()).toEqual([
      expect.objectContaining({
        subjectAccountId: source.owner.id,
        alertCode: "evidence_expired",
        severity: "high",
        status: "open",
      }),
    ]);
    expect(await compliance.sweepExpired()).toEqual({
      restrictedSubjects: 0,
      expiredCounterparties: 0,
    });
  });
});
