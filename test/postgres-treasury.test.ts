import { createHash } from "node:crypto";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresControlPlane } from "../src/db/control-plane.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { PostgresTreasury } from "../src/db/treasury.ts";
import { approveComplianceFixture, linkTreasuryDestinationFixture } from "./helpers/compliance-fixture.ts";

class EmbeddedPostgres implements TransactionalDatabase {
  constructor(readonly pg: PGliteInterface) {}
  async query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<QueryRows<T>> {
    const result = await this.pg.query<T>(text, [...values]);
    return { rows: result.rows, affectedRows: result.affectedRows };
  }
  async executeScript(text: string) { await this.pg.exec(text); }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (transaction: Transaction) => work({
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        const result = await transaction.query<R>(text, [...values]);
        return { rows: result.rows, affectedRows: result.affectedRows };
      },
      executeScript: async (text: string) => { await transaction.exec(text); },
    }));
  }
  async close() { await this.pg.close(); }
}

const publicKey = (name: string) => `public-key-treasury-${name}-${"x".repeat(32)}`;
const occurredAt = () => new Date(Date.now() - 1_000);
const evidence = (id: string) => ({
  payloadHash: createHash("sha256").update(id).digest(),
  canonicalPayload: { id },
});

describe("Postgres treasury", () => {
  let db: EmbeddedPostgres;
  let control: PostgresControlPlane;
  let ledger: PostgresLedger;
  let treasury: PostgresTreasury;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    control = new PostgresControlPlane(db);
    ledger = new PostgresLedger(db);
    treasury = new PostgresTreasury(db);
    await treasury.configureControls({
      fundingEnabled: true, payoutsEnabled: true, externalSpendEnabled: true,
      maxPayoutMicros: 100_000_000_000n, maxPendingPayoutMicros: 1_000_000_000_000n,
      maxOpenExposureMicros: 100_000_000_000n, maxReconciliationVarianceMicros: 1_000_000n,
      reason: "test fixture enables treasury controls",
    });
  }, 30_000);

  afterEach(async () => { await db.close(); });

  async function world() {
    const owner = await control.registerIdentity({
      id: "usr_treasury1", kind: "user", name: "Treasury Owner", handle: "treasury-owner", publicKey: publicKey("owner"),
    });
    const agent = await control.registerIdentity({
      actorId: owner.id, id: "agt_treasury1", kind: "agent", ownerId: owner.id,
      name: "Treasury Agent", handle: "treasury-agent", publicKey: publicKey("agent"),
    });
    const provider = await control.registerIdentity({
      actorId: owner.id, id: "prv_treasury1", kind: "provider", ownerId: owner.id,
      name: "Treasury Provider", handle: "treasury-provider", publicKey: publicKey("provider"),
    });
    await approveComplianceFixture(db, owner.id);
    const route = await treasury.registerDepositRoute({
      userId: owner.id, provider: "column", providerRouteRef: "acno_treasury_owner", label: "Primary USD",
    });
    return { owner, agent, provider, route };
  }

  async function settle(ownerTransfer = "acht_funding_001", amountMicros = 1_000_000n) {
    return treasury.settleFunding({
      provider: "column", providerEventId: `evnt_settle_${ownerTransfer}`,
      eventType: "ach.incoming_transfer.settled", providerTransferId: ownerTransfer,
      providerRouteRef: "acno_treasury_owner", asset: "USD", amountMicros, occurredAt: occurredAt(),
      ...evidence(`settle:${ownerTransfer}`),
    });
  }

  it("settles authenticated funding exactly once and rejects route or evidence drift", async () => {
    const { owner } = await world();
    const first = await settle();
    expect(first).toEqual(expect.objectContaining({ status: "settled", replayed: false, userBalanceMicros: 1_000_000n }));
    expect(await ledger.balance(owner.id)).toBe(1_000_000n);
    expect(await ledger.balance("external:funding")).toBe(-1_000_000n);

    const replay = await settle();
    expect(replay).toEqual(expect.objectContaining({ status: "settled", replayed: true, fundingId: first.fundingId }));
    expect(await ledger.balance(owner.id)).toBe(1_000_000n);

    await expect(treasury.settleFunding({
      provider: "column", providerEventId: "evnt_unknown_route", eventType: "ach.incoming_transfer.settled",
      providerTransferId: "acht_unknown_route", providerRouteRef: "acno_unknown_route",
      asset: "USD", amountMicros: 100_000n, occurredAt: occurredAt(), ...evidence("unknown-route"),
    })).rejects.toThrow(/route is unknown or disabled/i);
    await expect(treasury.settleFunding({
      provider: "column", providerEventId: "evnt_changed_terms", eventType: "ach.incoming_transfer.settled",
      providerTransferId: "acht_funding_001", providerRouteRef: "acno_treasury_owner",
      asset: "USD", amountMicros: 990_000n, occurredAt: occurredAt(), ...evidence("changed-terms"),
    })).rejects.toThrow(/different funding terms/i);
    await treasury.registerDepositRoute({
      userId: owner.id, provider: "column", providerRouteRef: "acno_treasury_other", label: "Other USD",
    });
    await expect(treasury.settleFunding({
      provider: "column", providerEventId: "evnt_changed_route", eventType: "ach.incoming_transfer.settled",
      providerTransferId: "acht_funding_001", providerRouteRef: "acno_treasury_other",
      asset: "USD", amountMicros: 1_000_000n, occurredAt: occurredAt(), ...evidence("changed-route"),
    })).rejects.toThrow(/different funding terms/i);

    await treasury.configureControls({
      fundingEnabled: false, payoutsEnabled: true, externalSpendEnabled: true,
      maxPayoutMicros: 100_000_000_000n, maxPendingPayoutMicros: 1_000_000_000_000n,
      maxOpenExposureMicros: 100_000_000_000n, maxReconciliationVarianceMicros: 1_000_000n,
      reason: "funding maintenance",
    });
    expect(await settle()).toEqual(expect.objectContaining({
      status: "settled", replayed: true, fundingId: first.fundingId,
    }));
    expect((await db.query<{ action: string; reason: string }>(
      "select action, reason from money.treasury_control_events order by id desc limit 1"
    )).rows[0]).toEqual({ action: "configured", reason: "funding maintenance" });
  });

  it("posts exact returns, tracks negative exposure, freezes the family, and requires explicit recovery release", async () => {
    const { owner, agent, provider } = await world();
    await settle();
    await ledger.postTransfer({
      actorId: owner.id, operation: "allocate", idempotencyKey: "treasury-allocation",
      from: owner.id, to: agent.id, amountMicros: 800_000n,
    });
    const returned = await treasury.returnFunding({
      provider: "column", providerEventId: "evnt_return_001", eventType: "ach.incoming_transfer.returned",
      providerTransferId: "acht_funding_001", asset: "USD", amountMicros: 1_000_000n,
      reason: "R10 customer advises unauthorized", occurredAt: occurredAt(), ...evidence("return:001"),
    });
    expect(returned).toEqual(expect.objectContaining({
      status: "returned", userBalanceMicros: -800_000n, openedExposureMicros: 800_000n,
    }));
    expect((await treasury.exposures(owner.id))[0]).toEqual(expect.objectContaining({
      amountMicros: 800_000n, recoveredMicros: 0n, state: "open",
    }));
    for (const accountId of [owner.id, agent.id, provider.id]) {
      expect((await control.accountForAuth(accountId))?.status).toBe("frozen");
    }
    await expect(treasury.releaseFreeze(owner.id, "premature release")).rejects.toThrow(/fully recovered/i);

    const recovery = await settle("acht_recovery_002", 800_000n);
    expect(recovery.recoveredExposureMicros).toBe(800_000n);
    expect((await treasury.exposures(owner.id))[0]).toEqual(expect.objectContaining({ state: "recovered", recoveredMicros: 800_000n }));
    expect((await control.accountForAuth(agent.id))?.status).toBe("frozen");
    expect(await treasury.releaseFreeze(owner.id, "return exposure reviewed and recovered")).toBe(3);
    expect((await control.accountForAuth(agent.id))?.status).toBe("active");
  });

  it("reserves payouts before provider I/O, claims once, and reverses returns exactly once", async () => {
    const { owner } = await world();
    await settle("acht_payout_funding", 2_000_000n);
    const destination = await treasury.registerDestination({
      accountId: owner.id, provider: "column", providerRef: "ctpy_owner_verified", label: "Owner checking",
    });
    await linkTreasuryDestinationFixture(db, destination.id, "column:ctpy_owner_verified");
    const requested = await treasury.requestPayout({
      sourceAccountId: owner.id, idempotencyKey: "payout-one", destinationId: destination.id,
      asset: "USD", amountMicros: 500_000n,
    });
    expect(requested).toEqual(expect.objectContaining({ status: "queued", replayed: false, sourceBalanceMicros: 1_500_000n }));
    expect(await treasury.payout(owner.id, requested.payoutId!)).toEqual(expect.objectContaining({ id: requested.payoutId, state: "queued" }));
    expect(await treasury.payout("usr_not_the_owner", requested.payoutId!)).toBeUndefined();
    expect((await treasury.requestPayout({
      sourceAccountId: owner.id, idempotencyKey: "payout-one", destinationId: destination.id,
      asset: "USD", amountMicros: 500_000n,
    })).replayed).toBe(true);
    expect(await ledger.balance("external:payout")).toBe(500_000n);

    const [claim] = await treasury.claimPayouts("worker-a", 10);
    expect(claim).toEqual(expect.objectContaining({ payoutId: requested.payoutId, providerRef: "ctpy_owner_verified", amountMicros: 500_000n }));
    expect(await treasury.claimPayouts("worker-b", 10)).toEqual([]);
    await treasury.recordPayoutSubmission("worker-a", claim!.payoutId, "acht_outgoing_001", "submitted");
    const returned = await treasury.transitionPayout({
      provider: "column", providerEventId: "evnt_outgoing_returned", eventType: "ach.outgoing_transfer.returned",
      providerTransferId: "acht_outgoing_001", providerState: "returned", asset: "USD",
      amountMicros: 500_000n, occurredAt: occurredAt(), ...evidence("outgoing-returned"),
    });
    expect(returned).toEqual(expect.objectContaining({ status: "returned", replayed: false, payoutId: requested.payoutId }));
    expect(await ledger.balance(owner.id)).toBe(2_000_000n);
    expect(await ledger.balance("external:payout")).toBe(0n);
    expect((await treasury.transitionPayout({
      provider: "column", providerEventId: "evnt_outgoing_returned", eventType: "ach.outgoing_transfer.returned",
      providerTransferId: "acht_outgoing_001", providerState: "returned", asset: "USD",
      amountMicros: 500_000n, occurredAt: occurredAt(), ...evidence("outgoing-returned"),
    })).replayed).toBe(true);
    expect(await ledger.balance(owner.id)).toBe(2_000_000n);
  });

  it("replays payout decisions across breaker changes and never claims stopped or disabled routes", async () => {
    const { owner } = await world();
    await settle("acht_payout_replay_funding", 2_000_000n);
    const destination = await treasury.registerDestination({
      accountId: owner.id, provider: "column", providerRef: "ctpy_payout_replay", label: "Replay checking",
    });
    await linkTreasuryDestinationFixture(db, destination.id, "column:ctpy_payout_replay");
    const request = {
      sourceAccountId: owner.id, idempotencyKey: "payout-breaker-replay",
      destinationId: destination.id, asset: "USD", amountMicros: 200_000n,
    } as const;
    const first = await treasury.requestPayout(request);
    await treasury.configureControls({
      fundingEnabled: true, payoutsEnabled: false, externalSpendEnabled: true,
      maxPayoutMicros: 100_000_000_000n, maxPendingPayoutMicros: 1_000_000_000_000n,
      maxOpenExposureMicros: 100_000_000_000n, maxReconciliationVarianceMicros: 1_000_000n,
      reason: "payout maintenance",
    });
    expect(await treasury.requestPayout(request)).toEqual(expect.objectContaining({
      status: "queued", replayed: true, payoutId: first.payoutId,
    }));
    expect(await treasury.requestPayout({ ...request, amountMicros: 210_000n })).toEqual(expect.objectContaining({
      status: "denied", replayed: true, code: "idempotency_conflict",
    }));
    expect(await treasury.claimPayouts("worker-stopped", 10)).toEqual([]);

    await treasury.configureControls({
      fundingEnabled: true, payoutsEnabled: true, externalSpendEnabled: true,
      maxPayoutMicros: 100_000_000_000n, maxPendingPayoutMicros: 1_000_000_000_000n,
      maxOpenExposureMicros: 100_000_000_000n, maxReconciliationVarianceMicros: 1_000_000n,
      reason: "payout maintenance complete",
    });
    await treasury.setDestinationStatus(owner.id, destination.id, "disabled");
    expect(await treasury.claimPayouts("worker-disabled-route", 10)).toEqual([]);
    expect((await treasury.cancelPayout(owner.id, first.payoutId!)).status).toBe("cancelled");
    expect(await ledger.balance(owner.id)).toBe(2_000_000n);
  });

  it("distinguishes definitive provider rejection from ambiguous manual review", async () => {
    const { owner } = await world();
    await settle("acht_rejection_funding", 2_000_000n);
    const destination = await treasury.registerDestination({
      accountId: owner.id, provider: "column", providerRef: "ctpy_rejection_test", label: "Verified checking",
    });
    await linkTreasuryDestinationFixture(db, destination.id, "column:ctpy_rejection_test");
    const first = await treasury.requestPayout({
      sourceAccountId: owner.id, idempotencyKey: "payout-rejected", destinationId: destination.id, asset: "USD", amountMicros: 200_000n,
    });
    await treasury.claimPayouts("worker-reject", 1);
    await treasury.failPayoutSubmission("worker-reject", first.payoutId!, "Column rejected invalid effective date");
    expect((await treasury.payouts(owner.id)).find((item) => item.id === first.payoutId)?.state).toBe("failed");
    expect(await ledger.balance(owner.id)).toBe(2_000_000n);
    expect((await treasury.controlState()).payoutsEnabled).toBe(true);

    const second = await treasury.requestPayout({
      sourceAccountId: owner.id, idempotencyKey: "payout-ambiguous", destinationId: destination.id, asset: "USD", amountMicros: 200_000n,
    });
    const third = await treasury.requestPayout({
      sourceAccountId: owner.id, idempotencyKey: "payout-ambiguous-no-transfer",
      destinationId: destination.id, asset: "USD", amountMicros: 200_000n,
    });
    await treasury.claimPayouts("worker-ambiguous", 2);
    await treasury.markPayoutManualReview("worker-ambiguous", second.payoutId!, "acht_ambiguous_001", "provider response terms mismatched");
    await treasury.markPayoutManualReview("worker-ambiguous", third.payoutId!, undefined, "provider response was not parseable");
    expect((await treasury.payouts(owner.id)).find((item) => item.id === second.payoutId)?.state).toBe("manual_review");
    expect(await treasury.controlState()).toEqual(expect.objectContaining({
      fundingEnabled: false, payoutsEnabled: false, externalSpendEnabled: false,
    }));

    const attached = await treasury.resolvePayoutReview({
      payoutId: second.payoutId!, state: "submitted", providerTransferId: "acht_ambiguous_001",
      reviewReference: "INC-AMB-001", reason: "Column confirmed the transfer was submitted",
    });
    expect(attached).toEqual(expect.objectContaining({ state: "submitted", replayed: false }));
    expect((await treasury.resolvePayoutReview({
      payoutId: second.payoutId!, state: "submitted", providerTransferId: "acht_ambiguous_001",
      reviewReference: "INC-AMB-001", reason: "Column confirmed the transfer was submitted",
    })).replayed).toBe(true);
    await expect(treasury.resolvePayoutReview({
      payoutId: second.payoutId!, state: "submitted", providerTransferId: "acht_ambiguous_001",
      reviewReference: "INC-AMB-001", reason: "different review evidence",
    })).rejects.toThrow(/different terms/i);
    expect(await treasury.resolvePayoutReview({
      payoutId: third.payoutId!, state: "failed", reviewReference: "INC-AMB-002",
      reason: "Column confirmed no transfer was created",
    })).toEqual(expect.objectContaining({ state: "failed", replayed: false, reversalTransferId: expect.any(String) }));
    expect(await treasury.controlState()).toEqual(expect.objectContaining({
      fundingEnabled: false, payoutsEnabled: false, externalSpendEnabled: false,
    }));
    expect((await db.query<{ count: number }>("select count(*)::integer as count from money.treasury_payout_reviews")).rows[0]?.count).toBe(2);
    expect((await db.query<{ count: number }>(
      "select count(*)::integer as count from money.treasury_control_events where action = 'tripped'"
    )).rows[0]?.count).toBeGreaterThanOrEqual(2);
    expect(await ledger.balance(owner.id)).toBe(1_800_000n);
  });

  it("trips every breaker whenever Column itself reports manual review", async () => {
    const { owner } = await world();
    await settle("acht_provider_review_funding", 2_000_000n);
    const destination = await treasury.registerDestination({
      accountId: owner.id, provider: "column", providerRef: "ctpy_provider_review", label: "Review checking",
    });
    await linkTreasuryDestinationFixture(db, destination.id, "column:ctpy_provider_review");
    const first = await treasury.requestPayout({
      sourceAccountId: owner.id, idempotencyKey: "payout-review-response",
      destinationId: destination.id, asset: "USD", amountMicros: 200_000n,
    });
    const second = await treasury.requestPayout({
      sourceAccountId: owner.id, idempotencyKey: "payout-review-event",
      destinationId: destination.id, asset: "USD", amountMicros: 200_000n,
    });
    const claims = await treasury.claimPayouts("worker-provider-review", 2);
    const firstClaim = claims.find((item) => item.payoutId === first.payoutId)!;
    const secondClaim = claims.find((item) => item.payoutId === second.payoutId)!;
    await treasury.recordPayoutSubmission("worker-provider-review", secondClaim.payoutId, "acht_review_event", "submitted");
    await treasury.recordPayoutSubmission("worker-provider-review", firstClaim.payoutId, "acht_review_response", "manual_review");
    expect(await treasury.controlState()).toEqual(expect.objectContaining({
      fundingEnabled: false, payoutsEnabled: false, externalSpendEnabled: false,
    }));

    await treasury.transitionPayout({
      provider: "column", providerEventId: "evnt_outgoing_manual_review",
      eventType: "ach.outgoing_transfer.manual_review", providerTransferId: "acht_review_event",
      providerState: "manual_review", asset: "USD", amountMicros: 200_000n,
      occurredAt: occurredAt(), ...evidence("outgoing-manual-review"),
    });
    expect((await treasury.payouts(owner.id)).filter((item) => item.state === "manual_review")).toHaveLength(2);
  });

  it("reviews dead provider events without silently reopening controls", async () => {
    const queued = await treasury.enqueueEvent({
      provider: "column", providerEventId: "evnt_dead_review", endpointId: "webh_review",
      deliveryHash: createHash("sha256").update("dead-review").digest(),
    });
    const [firstClaim] = await treasury.claimEvents("event-review-worker", 1);
    expect(firstClaim?.inboxId).toBe(queued.inboxId);
    await treasury.failEvent("event-review-worker", queued.inboxId, "permanent fixture mismatch", 0, true);
    expect(await treasury.controlState()).toEqual(expect.objectContaining({
      fundingEnabled: false, payoutsEnabled: false, externalSpendEnabled: false,
    }));
    expect(await treasury.resolveEventReview({
      inboxId: queued.inboxId, resolution: "retry", reviewReference: "INC-EVT-001",
      reason: "adapter fix deployed",
    })).toBe("queued");
    const [retried] = await treasury.claimEvents("event-review-worker", 1);
    expect(retried).toEqual(expect.objectContaining({ inboxId: queued.inboxId, attempts: 1 }));
    await treasury.failEvent("event-review-worker", queued.inboxId, "verified non-economic fixture", 0, true);
    expect(await treasury.resolveEventReview({
      inboxId: queued.inboxId, resolution: "ignore", reviewReference: "INC-EVT-002",
      reason: "provider confirmed this was a test event",
    })).toBe("ignored");
    expect((await db.query<{ count: number }>(
      "select count(*)::integer as count from money.treasury_event_reviews where inbox_id = $1",
      [queued.inboxId.toString()]
    )).rows[0]?.count).toBe(2);
    expect(await treasury.controlState()).toEqual(expect.objectContaining({
      fundingEnabled: false, payoutsEnabled: false, externalSpendEnabled: false,
    }));
  });

  it("reconciles fresh external observations and trips every breaker on a material variance", async () => {
    await world();
    await settle("acht_reconcile_funding", 1_000_000n);
    await treasury.registerAssetAccount({ provider: "column", providerAccountRef: "bacc_treasury", asset: "USD", kind: "bank" });
    const clean = await treasury.recordAssetSnapshot({
      provider: "column", providerAccountRef: "bacc_treasury", asset: "USD",
      bookMicros: 1_000_000n, availableMicros: 1_000_000n,
      providerObservationId: "observation-clean", observedAt: occurredAt(),
    });
    expect(clean.withinTolerance).toBe(true);
    expect((await treasury.health())[0]).toEqual(expect.objectContaining({
      expectedAssetMicros: 1_000_000n, observedAssetMicros: 1_000_000n, withinTolerance: true,
    }));
    const drift = await treasury.recordAssetSnapshot({
      provider: "column", providerAccountRef: "bacc_treasury", asset: "USD",
      bookMicros: 3_000_000n, availableMicros: 3_000_000n,
      providerObservationId: "observation-drift", observedAt: new Date(),
    });
    expect(drift.withinTolerance).toBe(false);
    expect(await treasury.controlState()).toEqual(expect.objectContaining({
      fundingEnabled: false, payoutsEnabled: false, externalSpendEnabled: false,
      breakerReason: expect.stringMatching(/reconciliation exceeded tolerance/i),
    }));
    await treasury.recordAssetSnapshot({
      provider: "column", providerAccountRef: "bacc_treasury", asset: "USD",
      bookMicros: 1_000_000n, availableMicros: 1_000_000n,
      providerObservationId: "observation-restored", observedAt: new Date(),
    });
    const restored = await treasury.restoreControls("INC-REC-001 approved after clean reconciliation");
    expect(restored).toEqual(expect.objectContaining({
      fundingEnabled: true, payoutsEnabled: true, externalSpendEnabled: true,
    }));
    expect(restored).not.toHaveProperty("breakerReason");
  });
});
