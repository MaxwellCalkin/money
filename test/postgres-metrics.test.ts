import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresCards } from "../src/db/cards.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresExternal } from "../src/db/external.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { PostgresMarketplace } from "../src/db/marketplace.ts";
import { PostgresMetrics } from "../src/db/metrics.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { PostgresPolicy } from "../src/db/policy.ts";
import { PostgresTreasury } from "../src/db/treasury.ts";
import {
  approveComplianceFixture,
  clearCounterpartyFixture,
  linkTreasuryDestinationFixture,
} from "./helpers/compliance-fixture.ts";

class EmbeddedPostgres implements TransactionalDatabase {
  constructor(readonly pg: PGliteInterface) {}
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryRows<T>> {
    const result = await this.pg.query<T>(text, [...values]);
    return { rows: result.rows, affectedRows: result.affectedRows };
  }
  async executeScript(text: string) { await this.pg.exec(text); }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (transaction: Transaction) => work({
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = []
      ) => {
        const result = await transaction.query<R>(text, [...values]);
        return { rows: result.rows, affectedRows: result.affectedRows };
      },
      executeScript: async (text: string) => { await transaction.exec(text); },
    }));
  }
  async close() { await this.pg.close(); }
}

const PAY_TO = "0x209693bc6afc0c5328ba36faf03c514ef312287c";
const HOST = "metrics-data.example.com";
const X402_PAYEE = `x402:${HOST}:${PAY_TO}`;
const MERCHANT_HINT = "metrics-shop.example";
const MEMO = "metrics research memo must never publish";

/** Recompute a chained cumulative root exactly as documented: starting from
 * the empty byte string, fold each receipt's evidence-hash bytes in
 * transfer_seq order via root = sha256(root || hash). */
function recomputeRoot(hashes: Array<Uint8Array>): string {
  let root = Buffer.alloc(0);
  for (const hash of hashes) {
    root = createHash("sha256").update(root).update(hash).digest();
  }
  return root.toString("hex");
}

/** ISO week label (IYYY-"W"IW) for an instant, computed strictly in UTC —
 * the independent reference the database bucketing must match regardless of
 * its session time zone. */
function utcIsoWeekLabel(at: Date): string {
  const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + 3); // this week's Thursday
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

describe("Postgres public metrics", () => {
  let db: EmbeddedPostgres;
  let ledger: PostgresLedger;
  let policy: PostgresPolicy;
  let treasury: PostgresTreasury;
  let external: PostgresExternal;
  let cards: PostgresCards;
  let metrics: PostgresMetrics;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    ledger = new PostgresLedger(db);
    policy = new PostgresPolicy(db);
    treasury = new PostgresTreasury(db);
    external = new PostgresExternal(db);
    cards = new PostgresCards(db);
    metrics = new PostgresMetrics(db);
    await treasury.configureControls({
      fundingEnabled: true, payoutsEnabled: true, externalSpendEnabled: true,
      maxPayoutMicros: 100_000_000_000n, maxPendingPayoutMicros: 1_000_000_000_000n,
      maxOpenExposureMicros: 100_000_000_000n, maxReconciliationVarianceMicros: 1_000_000n,
      reason: "metrics test fixture enables treasury controls",
    });
    await treasury.setCardSpendEnabled(true, "metrics test fixture");
  }, 30_000);

  afterEach(async () => {
    await db.close();
  });

  /** A small world touching every operation class:
   * - ownerDev is dev/sandbox funded ('fund') and their agent A1 spends on
   *   all three rails (pay, external_debit, card_reserve);
   * - ownerMixed is funded by BOTH the dev path and provider-verified
   *   treasury settlement, so proportional lineage attribution is exercised
   *   including the conservative floor toward the dev bucket. */
  async function world() {
    const ownerDev = await ledger.registerAccount({
      id: "usr_metrics01", kind: "user", name: "Metrics Dev Owner", handle: "metrics-owner",
    });
    const agentA1 = await ledger.registerAccount({
      id: "agt_metrics01", kind: "agent", name: "Metrics Scout", ownerId: ownerDev.id, handle: "metrics-scout",
    });
    const agentA2 = await ledger.registerAccount({
      id: "agt_metrics02", kind: "agent", name: "Metrics Writer", ownerId: ownerDev.id, handle: "metrics-writer",
    });
    const provider = await ledger.registerAccount({
      id: "prv_metrics01", kind: "provider", name: "Metrics Seller", ownerId: ownerDev.id, handle: "metrics-seller",
    });
    const ownerMixed = await ledger.registerAccount({
      id: "usr_metrics02", kind: "user", name: "Metrics Mixed Owner", handle: "metrics-mixed",
    });
    const agentB1 = await ledger.registerAccount({
      id: "agt_metrics03", kind: "agent", name: "Metrics Runner", ownerId: ownerMixed.id, handle: "metrics-runner",
    });
    await approveComplianceFixture(db, ownerDev.id);
    await approveComplianceFixture(db, ownerMixed.id);
    await clearCounterpartyFixture(db, X402_PAYEE);
    await clearCounterpartyFixture(db, `card:hint:${MERCHANT_HINT}`, "merchant");

    // funding: dev/sandbox path for both owners (10_000_000 + 500_000).
    await ledger.postTransfer({
      actorId: ownerDev.id, operation: "fund", idempotencyKey: "metrics-fund-dev",
      from: "external:funding", to: ownerDev.id, amountMicros: 10_000_000n,
    });
    await ledger.postTransfer({
      actorId: ownerMixed.id, operation: "fund", idempotencyKey: "metrics-fund-mixed",
      from: "external:funding", to: ownerMixed.id, amountMicros: 500_000n,
    });
    // treasury: provider-verified settlement for ownerMixed (1_000_000).
    await treasury.registerDepositRoute({
      userId: ownerMixed.id, provider: "column", providerRouteRef: "acno_metrics_mixed", label: "Metrics route",
    });
    await treasury.settleFunding({
      provider: "column", providerEventId: "evnt_metrics_settle", eventType: "ach.incoming_transfer.settled",
      providerTransferId: "acht_metrics_settle", providerRouteRef: "acno_metrics_mixed",
      asset: "USD", amountMicros: 1_000_000n, occurredAt: new Date(Date.now() - 1_000),
      payloadHash: createHash("sha256").update("metrics-settle").digest(),
      canonicalPayload: { id: "metrics-settle" },
    });

    // internal allocations.
    await ledger.postTransfer({
      actorId: ownerDev.id, operation: "allocate", idempotencyKey: "metrics-allocate-a1",
      from: ownerDev.id, to: agentA1.id, amountMicros: 5_000_000n,
    });
    await ledger.postTransfer({
      actorId: ownerDev.id, operation: "allocate", idempotencyKey: "metrics-allocate-a2",
      from: ownerDev.id, to: agentA2.id, amountMicros: 1_000_000n,
    });
    await ledger.postTransfer({
      actorId: ownerMixed.id, operation: "allocate", idempotencyKey: "metrics-allocate-b1",
      from: ownerMixed.id, to: agentB1.id, amountMicros: 800_000n,
    });

    await policy.grantMandate({
      userId: ownerDev.id, agentId: agentA1.id,
      budgetMicros: 1_000_000n, perTxCapMicros: 1_000_000n, dailyCapMicros: 1_000_000n,
      escalateAboveMicros: 1_000_000n, newPayeeCapMicros: 1_000_000n,
      expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: "metrics-mandate-a1",
    });

    // internal pay (memo must never surface publicly).
    const paid = await ledger.postTransfer({
      actorId: agentA1.id, operation: "pay", idempotencyKey: "metrics-pay-a1",
      from: agentA1.id, to: provider.id, amountMicros: 125_000n, memo: MEMO,
    });
    // external x402 debit.
    const plaintext = `authorization:${agentA1.id}:metrics-external`;
    const externalPayment = await external.request({
      externalId: randomUUID(), agentId: agentA1.id, idempotencyKey: "metrics-external",
      host: HOST, payTo: PAY_TO, settlementAsset: "0x00000000000000000000000000000000000c0ffe",
      settlementNetwork: "mock-local", resource: `https://${HOST}/report`, policyPayee: X402_PAYEE,
      amountMicros: 50_000n,
      paymentHeaderCiphertext: Buffer.concat([Buffer.alloc(32, 7), Buffer.from(plaintext)]),
      authorizationHash: createHash("sha256").update(plaintext).digest(),
      authorizationExpiresAt: new Date(Date.now() + 60_000),
      reverseAfter: new Date(Date.now() + 120_000),
    });
    expect(externalPayment.status).toBe("posted");
    // card reserve.
    const prepared = await cards.prepare({
      cardId: randomUUID(), agentId: agentA1.id, idempotencyKey: "metrics-card",
      capMicros: 200_000n, singleUse: false, merchantHint: MERCHANT_HINT,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(prepared.status).toBe("prepared");
    expect((await cards.activate({
      agentId: agentA1.id, cardId: prepared.cardId!, provider: "mock",
      providerCardRef: "ic_metrics_1", last4: "4242", expMonth: 12, expYear: 2030,
    })).status).toBe("posted");
    // second owner family spends internally; 100_001 forces lineage rounding.
    const mixedPaid = await ledger.postTransfer({
      actorId: agentB1.id, operation: "pay", idempotencyKey: "metrics-pay-b1",
      from: agentB1.id, to: provider.id, amountMicros: 100_001n, memo: "runner subtask",
    });
    expect(paid.status).toBe("posted");
    expect(mixedPaid.status).toBe("posted");
    return {
      ownerDev, ownerMixed, agentA1, agentA2, agentB1, provider,
      cardId: prepared.cardId!,
      payReceiptId: paid.status === "posted" ? paid.receiptId : "",
    };
  }

  it("publishes honest zeroes before any traffic exists", async () => {
    const document = await metrics.publicMetrics();
    expect(document.distinctFundedAgents).toBe(0);
    expect(document.distinctPaidProviders).toBe(0);
    expect(document.weekly).toEqual([]);
    expect(document.operationClasses).toEqual([
      { operationClass: "internal", transfers: 0, volumeMicros: "0" },
      { operationClass: "external", transfers: 0, volumeMicros: "0" },
      { operationClass: "card", transfers: 0, volumeMicros: "0" },
      { operationClass: "treasury", transfers: 0, volumeMicros: "0" },
      { operationClass: "funding", transfers: 0, volumeMicros: "0" },
    ]);
    expect(document.fundingLineage).toEqual({
      devFundingMicros: "0",
      externalFundingMicros: "0",
      spendMicros: "0",
      devAttributedSpendMicros: "0",
      externalAttributedSpendMicros: "0",
    });
    expect(document.cohorts).toEqual([]);
    expect(typeof document.generatedAt).toBe("string");
  });

  it("aggregates counts, class volumes, and the conservative funding-lineage split", async () => {
    await world();
    const document = await metrics.publicMetrics();
    expect(document.distinctFundedAgents).toBe(3);
    expect(document.distinctPaidProviders).toBe(1);
    expect(document.operationClasses).toEqual([
      { operationClass: "internal", transfers: 5, volumeMicros: "7025001" },
      { operationClass: "external", transfers: 1, volumeMicros: "50000" },
      { operationClass: "card", transfers: 1, volumeMicros: "200000" },
      { operationClass: "treasury", transfers: 1, volumeMicros: "1000000" },
      { operationClass: "funding", transfers: 2, volumeMicros: "10500000" },
    ]);
    // ownerDev spends 375_000 with only dev funding -> all dev.
    // ownerMixed spends 100_001 with 500_000 dev + 1_000_000 settled external:
    // external share floor(100_001 * 1_000_000 / 1_500_000) = 66_667, and the
    // rounding remainder lands in the dev bucket, never the external one.
    expect(document.fundingLineage).toEqual({
      devFundingMicros: "10500000",
      externalFundingMicros: "1000000",
      spendMicros: "475001",
      devAttributedSpendMicros: "408334",
      externalAttributedSpendMicros: "66667",
    });
    // Single active week: all ten transfers, two distinct spending agents.
    expect(document.weekly).toHaveLength(1);
    expect(document.weekly[0]).toEqual(expect.objectContaining({
      transfers: 10,
      volumeMicros: "18775001",
      activeAgents: 2,
      week: expect.stringMatching(/^\d{4}-W\d{2}$/),
      weekStart: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      chainRoot: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    // Both spending agents first became active this week: one cohort.
    expect(document.cohorts).toEqual([{
      cohortWeek: document.weekly[0]?.week,
      weekStart: document.weekly[0]?.weekStart,
      cohortSize: 2,
      activeByWeek: [2],
    }]);
  });

  it("nets payouts out of external funding and released card reserves out of spend", async () => {
    const seeded = await world();
    // Release the whole 200_000 card reservation: it must drop back out of
    // net spend instead of counting as settled volume forever.
    const closed = await cards.closeCard(seeded.agentA1.id, seeded.cardId, "metrics release");
    expect(closed.state).toBe("reversed");

    // Pay out 600_000 of ownerMixed's provider-verified settlement: the
    // outstanding payout must shrink the external funding credit, so a
    // settle -> payout -> re-settle cycle can never double-count.
    const destination = await treasury.registerDestination({
      accountId: seeded.ownerMixed.id, provider: "column",
      providerRef: "ctpy_metrics_mixed", label: "Metrics payout destination",
    });
    await linkTreasuryDestinationFixture(db, destination.id, "column:ctpy_metrics_mixed");
    const payout = await treasury.requestPayout({
      sourceAccountId: seeded.ownerMixed.id, idempotencyKey: "metrics-payout",
      destinationId: destination.id, asset: "USD", amountMicros: 600_000n,
    });
    expect(payout.status).toBe("queued");

    const document = await metrics.publicMetrics();
    // ownerDev: dev-only funding; spend 375_000 - 200_000 released = 175_000.
    // ownerMixed: dev 500_000, external greatest(1_000_000 - 600_000, 0) =
    // 400_000; spend 100_001 -> external floor(100_001 * 400_000 / 900_000)
    // = 44_444, remainder to the dev bucket.
    expect(document.fundingLineage).toEqual({
      devFundingMicros: "10500000",
      externalFundingMicros: "400000",
      spendMicros: "275001",
      devAttributedSpendMicros: "230557",
      externalAttributedSpendMicros: "44444",
    });

    // A returned payout reverses the hold and restores the external credit.
    const [claim] = await treasury.claimPayouts("metrics-worker", 5);
    await treasury.recordPayoutSubmission("metrics-worker", claim!.payoutId, "acht_metrics_out", "submitted");
    const returned = await treasury.transitionPayout({
      provider: "column", providerEventId: "evnt_metrics_payout_returned",
      eventType: "ach.outgoing_transfer.returned", providerTransferId: "acht_metrics_out",
      providerState: "returned", asset: "USD", amountMicros: 600_000n,
      occurredAt: new Date(Date.now() - 500),
      payloadHash: createHash("sha256").update("metrics-payout-returned").digest(),
      canonicalPayload: { id: "metrics-payout-returned" },
    });
    expect(returned.status).toBe("returned");
    const after = await metrics.publicMetrics();
    expect(after.fundingLineage.externalFundingMicros).toBe("1000000");
    expect(after.fundingLineage.externalAttributedSpendMicros).toBe("66667");
    expect(after.fundingLineage.spendMicros).toBe("275001");

    // A marketplace refund (kernel-locked to the original payer, capped at
    // the original receipt) nets back out of spend exactly like a card
    // release: the page copy says spend is net of refunds, so it must be.
    const refunded = await new PostgresMarketplace(db).refund({
      providerId: seeded.provider.id, receiptId: seeded.payReceiptId,
      amountMicros: 25_000n, idempotencyKey: "metrics-refund",
    });
    expect(refunded.status).toBe("refunded");
    const netted = await metrics.publicMetrics();
    expect(netted.fundingLineage).toEqual({
      devFundingMicros: "10500000",
      externalFundingMicros: "1000000",
      spendMicros: "250001",
      devAttributedSpendMicros: "183334",
      externalAttributedSpendMicros: "66667",
    });
  });

  it("labels founder money re-spent through another owner family as dev-funded, not external", async () => {
    // The seller-funded-buyer wash: dev-funded family A routes money to
    // family B's agent via an agent-to-agent pay; B holds a small amount of
    // genuine provider-verified settlement. B's re-spend must NOT be labeled
    // externally settled beyond what B's real settlement can cover — peer
    // income lands in the dev bucket, and external attribution is capped at
    // settlement actually received.
    const ownerA = await ledger.registerAccount({
      id: "usr_metrics11", kind: "user", name: "Metrics Founderish", handle: "metrics-founderish",
    });
    const agentA = await ledger.registerAccount({
      id: "agt_metrics11", kind: "agent", name: "Metrics Router", ownerId: ownerA.id, handle: "metrics-router",
    });
    const ownerB = await ledger.registerAccount({
      id: "usr_metrics12", kind: "user", name: "Metrics Peer Owner", handle: "metrics-peerowner",
    });
    const agentB = await ledger.registerAccount({
      id: "agt_metrics12", kind: "agent", name: "Metrics Peer Agent", ownerId: ownerB.id, handle: "metrics-peeragent",
    });
    const provider = await ledger.registerAccount({
      id: "prv_metrics11", kind: "provider", name: "Metrics Sink", ownerId: ownerA.id, handle: "metrics-sink",
    });
    await approveComplianceFixture(db, ownerA.id);
    await approveComplianceFixture(db, ownerB.id);

    // A is purely dev-funded; B has 30_000 of provider-verified settlement.
    await ledger.postTransfer({
      actorId: ownerA.id, operation: "fund", idempotencyKey: "metrics-xfund-a",
      from: "external:funding", to: ownerA.id, amountMicros: 200_000n,
    });
    await treasury.registerDepositRoute({
      userId: ownerB.id, provider: "column", providerRouteRef: "acno_metrics_peer", label: "Peer route",
    });
    await treasury.settleFunding({
      provider: "column", providerEventId: "evnt_metrics_peer_settle", eventType: "ach.incoming_transfer.settled",
      providerTransferId: "acht_metrics_peer_settle", providerRouteRef: "acno_metrics_peer",
      asset: "USD", amountMicros: 30_000n, occurredAt: new Date(Date.now() - 1_000),
      payloadHash: createHash("sha256").update("metrics-peer-settle").digest(),
      canonicalPayload: { id: "metrics-peer-settle" },
    });
    await ledger.postTransfer({
      actorId: ownerA.id, operation: "allocate", idempotencyKey: "metrics-xalloc-a",
      from: ownerA.id, to: agentA.id, amountMicros: 100_000n,
    });
    await ledger.postTransfer({
      actorId: ownerB.id, operation: "allocate", idempotencyKey: "metrics-xalloc-b",
      from: ownerB.id, to: agentB.id, amountMicros: 20_000n,
    });
    // Cross-family hop: A's agent pays B's agent 90_000, and B's agent
    // re-spends 100_000 on a provider.
    const hop = await ledger.postTransfer({
      actorId: agentA.id, operation: "pay", idempotencyKey: "metrics-xhop",
      from: agentA.id, to: agentB.id, amountMicros: 90_000n,
    });
    expect(hop.status).toBe("posted");
    const respend = await ledger.postTransfer({
      actorId: agentB.id, operation: "pay", idempotencyKey: "metrics-xrespend",
      from: agentB.id, to: provider.id, amountMicros: 100_000n,
    });
    expect(respend.status).toBe("posted");

    const document = await metrics.publicMetrics();
    // Family A: dev 200_000, external 0, spend 90_000 -> all dev.
    // Family B: dev (peer income) 90_000, external 30_000, spend 100_000 ->
    // external floor(100_000 * 30_000 / 120_000) = 25_000, remainder dev.
    // Without the peer-income rule B's mix would be 100% external and the
    // whole 100_000 re-spend of founder money would be labeled "externally
    // settled" off 30_000 of real settlement.
    expect(document.fundingLineage).toEqual({
      devFundingMicros: "290000",
      externalFundingMicros: "30000",
      spendMicros: "190000",
      devAttributedSpendMicros: "165000",
      externalAttributedSpendMicros: "25000",
    });
    expect(BigInt(document.fundingLineage.externalAttributedSpendMicros))
      .toBeLessThanOrEqual(BigInt(document.fundingLineage.externalFundingMicros));
  });

  it("caps a family's externally attributed spend at the external settlement it actually received", async () => {
    // Drive the rollup helper directly (as the migration owner) with a
    // pathological mix the kernel makes hard to reach: zero dev funding,
    // 1_000_000 of settlement, 5_000_000 of spend. Proportional attribution
    // alone would call all 5_000_000 external; the cap holds it at the
    // 1_000_000 that provably settled.
    await db.query(
      "select money_private.metrics_lineage_apply('usr_capcase', 0, 0, 1000000, 0, 0, 0, 5000000, 0)"
    );
    const document = await metrics.publicMetrics();
    expect(document.fundingLineage).toEqual({
      devFundingMicros: "0",
      externalFundingMicros: "1000000",
      spendMicros: "5000000",
      devAttributedSpendMicros: "4000000",
      externalAttributedSpendMicros: "1000000",
    });
  });

  it("builds retention cohorts from each agent's first active week, counts only", async () => {
    await world();
    // Move agent A1's internal pay back exactly one ISO week: A1's cohort
    // becomes last week while its external and card activity keeps it active
    // this week; B1 stays a this-week cohort of one.
    await db.query("alter table money.transfers disable trigger transfers_append_only");
    await db.query(
      "update money.transfers set created_at = created_at - interval '7 days' " +
      "where operation = 'pay' and from_account_id = 'agt_metrics01'"
    );
    await db.query("alter table money.transfers enable trigger transfers_append_only");

    const document = await metrics.publicMetrics();
    expect(document.weekly).toHaveLength(2);
    expect(document.cohorts).toEqual([
      {
        cohortWeek: document.weekly[0]?.week,
        weekStart: document.weekly[0]?.weekStart,
        cohortSize: 1,
        activeByWeek: [1, 1],
      },
      {
        cohortWeek: document.weekly[1]?.week,
        weekStart: document.weekly[1]?.weekStart,
        cohortSize: 1,
        activeByWeek: [1],
      },
    ]);
  });

  it("buckets weeks in UTC regardless of the database session time zone", async () => {
    const { payReceiptId } = await world();
    // UTC+14: the session-local date is usually already tomorrow, so any
    // accidental session-time bucketing would move week boundaries.
    await db.query("set TimeZone = 'Pacific/Kiritimati'");
    try {
      const document = await metrics.publicMetrics();
      const label = utcIsoWeekLabel(new Date());
      expect(document.weekly).toHaveLength(1);
      expect(document.weekly[0]?.week).toBe(label);
      expect((await metrics.verifyReceipt(payReceiptId)).weekBucket).toBe(label);
      expect(document.cohorts).toEqual([
        expect.objectContaining({ cohortWeek: label, cohortSize: 2 }),
      ]);
    } finally {
      await db.query("set TimeZone = 'UTC'");
    }
  });

  it("derives chain roots a third party can recompute from receipts alone", async () => {
    await world();
    const document = await metrics.publicMetrics();
    const receipts = await db.query<{ evidence_hash: Uint8Array }>(
      "select r.evidence_hash from money.receipts r order by r.transfer_seq"
    );
    expect(receipts.rows.length).toBe(10);
    const expectedRoot = recomputeRoot(receipts.rows.map((row) => row.evidence_hash));
    expect(document.weekly.at(-1)?.chainRoot).toBe(expectedRoot);
    // Deterministic: a second read yields the identical root.
    expect((await metrics.publicMetrics()).weekly.at(-1)?.chainRoot).toBe(expectedRoot);
  });

  it("caps the weekly series at 26 ISO weeks while keeping old receipts in every cumulative chained root", async () => {
    await world();
    // Backdate the very first transfer ~28 weeks: it must leave the windowed
    // series but stay inside every cumulative chain root.
    await db.query("alter table money.transfers disable trigger transfers_append_only");
    await db.query(
      "update money.transfers set created_at = clock_timestamp() - interval '196 days' where seq = 1"
    );
    await db.query("alter table money.transfers enable trigger transfers_append_only");

    const document = await metrics.publicMetrics();
    expect(document.weekly).toHaveLength(26);
    expect(document.weekly.reduce((sum, week) => sum + week.transfers, 0)).toBe(9);
    expect(document.weekly.slice(0, 25).every((week) => week.transfers === 0)).toBe(true);
    expect(document.weekly.at(-1)?.transfers).toBe(9);

    const receipts = await db.query<{ evidence_hash: Uint8Array; transfer_seq: string | number }>(
      "select r.evidence_hash, r.transfer_seq from money.receipts r order by r.transfer_seq"
    );
    // The oldest displayed week's root covers exactly the backdated receipt.
    expect(document.weekly[0]?.chainRoot).toBe(recomputeRoot([receipts.rows[0]!.evidence_hash]));
    expect(document.weekly[0]?.chainRoot).not.toBe(document.weekly.at(-1)?.chainRoot);
    // The newest root covers the full journal in transfer_seq order.
    expect(document.weekly.at(-1)?.chainRoot)
      .toBe(recomputeRoot(receipts.rows.map((row) => row.evidence_hash)));
  });

  it("verifies receipts by exact uuid with chain evidence and nothing else", async () => {
    const { payReceiptId } = await world();
    const verification = await metrics.verifyReceipt(payReceiptId);
    const stored = await db.query<{ transfer_seq: string | number; hex: string }>(
      "select transfer_seq, encode(evidence_hash, 'hex') as hex from money.receipts where id = $1",
      [payReceiptId]
    );
    expect(verification).toEqual({
      exists: true,
      transferSeq: String(stored.rows[0]?.transfer_seq),
      evidenceHash: stored.rows[0]?.hex,
      operationClass: "internal",
      weekBucket: (await metrics.publicMetrics()).weekly.at(-1)?.week,
    });
    // Invariant 2: exactly these fields, never parties, amounts, memos, or
    // per-transfer timestamps.
    expect(Object.keys(verification).sort()).toEqual(
      ["evidenceHash", "exists", "operationClass", "transferSeq", "weekBucket"],
    );
    expect(await metrics.verifyReceipt(randomUUID())).toEqual({ exists: false });
  });

  it("never leaks account ids, handles, memos, payees, or merchant hints", async () => {
    const seeded = await world();
    const serialized = JSON.stringify(await metrics.publicMetrics())
      + JSON.stringify(await metrics.verifyReceipt(seeded.payReceiptId));
    for (const forbidden of [
      seeded.ownerDev.id, seeded.ownerMixed.id, seeded.agentA1.id, seeded.agentA2.id,
      seeded.agentB1.id, seeded.provider.id,
      "metrics-owner", "metrics-scout", "metrics-writer", "metrics-seller",
      "metrics-mixed", "metrics-runner",
      MEMO, "runner subtask", X402_PAYEE, PAY_TO, HOST, MERCHANT_HINT,
      "acno_metrics_mixed", "ic_metrics_1",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("grants the metrics role exactly two functions and nothing else", async () => {
    const { payReceiptId } = await world();
    await db.executeScript(readFileSync(resolve("db/roles.sql"), "utf8"));
    const privileges = await db.query<Record<string, boolean>>(`
      select
        has_function_privilege('money_metrics', 'money_private.public_metrics()', 'EXECUTE') as metrics_public,
        has_function_privilege('money_metrics', 'money_private.verify_receipt(uuid)', 'EXECUTE') as metrics_verify,
        has_function_privilege('money_metrics', 'money_private.metrics_weekly_series(integer)', 'EXECUTE') as metrics_series,
        has_function_privilege('money_metrics', 'money_private.metrics_advance_chain(integer)', 'EXECUTE') as metrics_advance,
        has_function_privilege('money_metrics', 'money_private.metrics_operation_class(text)', 'EXECUTE') as metrics_class,
        has_function_privilege('money_metrics', 'money_private.metrics_week_bucket(timestamptz)', 'EXECUTE') as metrics_bucket,
        has_function_privilege('money_metrics', 'money_private.metrics_lineage_derived(numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric)', 'EXECUTE') as metrics_lineage_derived,
        has_function_privilege('money_metrics', 'money_private.metrics_lineage_apply(text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric)', 'EXECUTE') as metrics_lineage_apply,
        has_function_privilege('money_metrics', 'money_private.post_transfer(text,text,text,text,text,text,bigint,text,jsonb)', 'EXECUTE') as metrics_post,
        has_function_privilege('money_metrics', 'money_private.request_agent_payment(text,text,text,text,bigint,text)', 'EXECUTE') as metrics_pay,
        has_function_privilege('money_metrics', 'money_private.get_receipt(text,uuid)', 'EXECUTE') as metrics_get_receipt,
        has_table_privilege('money_metrics', 'money.transfers', 'SELECT') as metrics_transfers,
        has_table_privilege('money_metrics', 'money.receipts', 'SELECT') as metrics_receipts,
        has_table_privilege('money_metrics', 'money.ledger_entries', 'SELECT') as metrics_ledger,
        has_table_privilege('money_metrics', 'money.accounts', 'SELECT') as metrics_accounts,
        has_table_privilege('money_metrics', 'money.balances', 'SELECT') as metrics_balances,
        has_table_privilege('money_metrics', 'money.mandates', 'SELECT') as metrics_mandates,
        has_table_privilege('money_metrics', 'money.metrics_weekly', 'SELECT') as metrics_cache_weekly,
        has_table_privilege('money_metrics', 'money.metrics_week_agents', 'SELECT') as metrics_cache_agents,
        has_table_privilege('money_metrics', 'money.metrics_chain_checkpoint', 'SELECT') as metrics_cache_checkpoint,
        has_table_privilege('money_metrics', 'money.metrics_agent_first_week', 'SELECT') as metrics_cache_first_week,
        has_table_privilege('money_metrics', 'money.metrics_class_totals', 'SELECT') as metrics_cache_class_totals,
        has_table_privilege('money_metrics', 'money.metrics_funded_agents', 'SELECT') as metrics_cache_funded,
        has_table_privilege('money_metrics', 'money.metrics_paid_providers', 'SELECT') as metrics_cache_paid,
        has_table_privilege('money_metrics', 'money.metrics_counts', 'SELECT') as metrics_cache_counts,
        has_table_privilege('money_metrics', 'money.metrics_owner_lineage', 'SELECT') as metrics_cache_owner_lineage,
        has_table_privilege('money_metrics', 'money.metrics_lineage_totals', 'SELECT') as metrics_cache_lineage_totals,
        has_schema_privilege('money_metrics', 'money', 'USAGE') as metrics_money_usage,
        has_schema_privilege('money_metrics', 'money_private', 'USAGE') as metrics_private_usage,
        has_function_privilege('money_app', 'money_private.public_metrics()', 'EXECUTE') as app_public,
        has_function_privilege('money_app', 'money_private.verify_receipt(uuid)', 'EXECUTE') as app_verify,
        has_function_privilege('money_worker', 'money_private.public_metrics()', 'EXECUTE') as worker_public,
        has_function_privilege('money_treasury_ingress', 'money_private.public_metrics()', 'EXECUTE') as treasury_ingress_public,
        has_function_privilege('money_card_ingress', 'money_private.public_metrics()', 'EXECUTE') as card_ingress_public,
        has_function_privilege('money_compliance_ingress', 'money_private.public_metrics()', 'EXECUTE') as compliance_ingress_public,
        has_function_privilege('money_ops', 'money_private.public_metrics()', 'EXECUTE') as ops_public,
        has_function_privilege('money_ops', 'money_private.verify_receipt(uuid)', 'EXECUTE') as ops_verify
    `);
    expect(privileges.rows[0]).toEqual({
      metrics_public: true,
      metrics_verify: true,
      metrics_series: false,
      metrics_advance: false,
      metrics_class: false,
      metrics_bucket: false,
      metrics_lineage_derived: false,
      metrics_lineage_apply: false,
      metrics_post: false,
      metrics_pay: false,
      metrics_get_receipt: false,
      metrics_transfers: false,
      metrics_receipts: false,
      metrics_ledger: false,
      metrics_accounts: false,
      metrics_balances: false,
      metrics_mandates: false,
      metrics_cache_weekly: false,
      metrics_cache_agents: false,
      metrics_cache_checkpoint: false,
      metrics_cache_first_week: false,
      metrics_cache_class_totals: false,
      metrics_cache_funded: false,
      metrics_cache_paid: false,
      metrics_cache_counts: false,
      metrics_cache_owner_lineage: false,
      metrics_cache_lineage_totals: false,
      metrics_money_usage: false,
      metrics_private_usage: true,
      app_public: false,
      app_verify: false,
      worker_public: false,
      treasury_ingress_public: false,
      card_ingress_public: false,
      compliance_ingress_public: false,
      ops_public: true,
      ops_verify: true,
    });

    await db.query("set role money_metrics");
    try {
      const roleMetrics = new PostgresMetrics(db);
      const document = await roleMetrics.publicMetrics();
      expect(document.distinctFundedAgents).toBe(3);
      expect((await roleMetrics.verifyReceipt(payReceiptId)).exists).toBe(true);
      await expect(db.query("select * from money.transfers")).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from money.receipts")).rejects.toThrow(/permission denied/);
      await expect(db.query("select money_private.metrics_weekly_series(26)"))
        .rejects.toThrow(/permission denied/);
      await expect(db.query("select money_private.metrics_advance_chain(10)"))
        .rejects.toThrow(/permission denied/);
      await expect(db.query("select * from money.metrics_weekly"))
        .rejects.toThrow(/permission denied/);
      await expect(db.query("select * from money.metrics_week_agents"))
        .rejects.toThrow(/permission denied/);
      await expect(db.query("select * from money.metrics_owner_lineage"))
        .rejects.toThrow(/permission denied/);
      await expect(db.query("select * from money.metrics_lineage_totals"))
        .rejects.toThrow(/permission denied/);
      await expect(db.query(
        "select money_private.metrics_lineage_apply('usr_metrics01', 0, 0, 0, 0, 0, 0, 0, 0)"
      )).rejects.toThrow(/permission denied/);
      await expect(db.query(
        "select * from money_private.request_agent_payment('agt_metrics01', 'steal', 'agt_metrics02', 'USD', 1, '')"
      )).rejects.toThrow(/permission denied/);
    } finally {
      await db.query("reset role");
    }

    await db.query("set role money_app");
    try {
      await expect(db.query("select money_private.public_metrics()"))
        .rejects.toThrow(/permission denied/);
      await expect(db.query("select * from money_private.verify_receipt($1::uuid)", [payReceiptId]))
        .rejects.toThrow(/permission denied/);
    } finally {
      await db.query("reset role");
    }

    await db.query("set role money_ops");
    try {
      expect((await new PostgresMetrics(db).publicMetrics()).distinctFundedAgents).toBe(3);
    } finally {
      await db.query("reset role");
    }
  });
});
