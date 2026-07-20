import { describe, expect, it, vi } from "vitest";
import type { PostgresTreasury } from "../src/db/treasury.ts";
import { ColumnApiError, type ColumnAchTransfer, type ColumnClient } from "../src/treasury/column.ts";
import { pollMissedColumnEvents, runTreasuryEventBatch } from "../src/treasury/event-worker.ts";
import { runTreasuryPayoutBatch } from "../src/treasury/payout-worker.ts";
import { EvmUsdcAssetSource, runTreasuryReconciliation } from "../src/treasury/reconciler.ts";

function transfer(overrides: Partial<ColumnAchTransfer> = {}): ColumnAchTransfer {
  return {
    id: "acht_worker_001", amount: 50, account_number_id: "acno_worker_001",
    bank_account_id: "bacc_worker_001", counterparty_id: "ctpy_worker_001",
    currency_code: "USD", is_incoming: true, status: "SETTLED", type: "CREDIT",
    created_at: "2026-07-19T10:00:00.000Z", updated_at: "2026-07-19T10:01:00.000Z",
    settled_at: "2026-07-19T10:01:00.000Z", ...overrides,
  };
}

describe("treasury workers", () => {
  it("re-fetches provider evidence before posting and acknowledges only afterward", async () => {
    const event = {
      id: "evnt_worker_001", created_at: "2026-07-19T10:01:00.000Z",
      type: "ach.incoming_transfer.settled", data: transfer(),
    };
    const claimEvents = vi.fn(async () => [{ inboxId: 1n, provider: "column", providerEventId: event.id, attempts: 1 }]);
    const settleFunding = vi.fn(async () => ({ status: "settled", replayed: false }));
    const completeEvent = vi.fn(async () => undefined);
    const treasury = {
      claimEvents, settleFunding, completeEvent,
      failEvent: vi.fn(async () => undefined),
    } as unknown as PostgresTreasury;
    const getEvent = vi.fn(async () => event);
    const getAchTransfer = vi.fn(async () => transfer());
    const column = { getEvent, getAchTransfer } as unknown as ColumnClient;

    expect(await runTreasuryEventBatch(treasury, column, "event-worker", 10)).toEqual({
      claimed: 1, completed: 1, ignored: 0, failed: 0,
    });
    expect(getEvent.mock.invocationCallOrder[0]).toBeLessThan(getAchTransfer.mock.invocationCallOrder[0]!);
    expect(getAchTransfer.mock.invocationCallOrder[0]).toBeLessThan(settleFunding.mock.invocationCallOrder[0]!);
    expect(settleFunding.mock.invocationCallOrder[0]).toBeLessThan(completeEvent.mock.invocationCallOrder[0]!);
  });

  it("retries an out-of-order database transition without dead-lettering it", async () => {
    const returned = transfer({ status: "RETURNED", returned_at: "2026-07-20T10:00:00.000Z" });
    const event = {
      id: "evnt_worker_return", created_at: "2026-07-20T10:00:00.000Z",
      type: "ach.incoming_transfer.returned", data: returned,
    };
    const notFound = Object.assign(new Error("settled funding does not exist yet"), { code: "P0002" });
    const failEvent = vi.fn(async () => undefined);
    const treasury = {
      claimEvents: vi.fn(async () => [{ inboxId: 2n, provider: "column", providerEventId: event.id, attempts: 1 }]),
      returnFunding: vi.fn(async () => { throw notFound; }),
      failEvent,
    } as unknown as PostgresTreasury;
    const column = {
      getEvent: vi.fn(async () => event), getAchTransfer: vi.fn(async () => returned),
    } as unknown as ColumnClient;
    expect(await runTreasuryEventBatch(treasury, column, "event-worker", 10)).toEqual({
      claimed: 1, completed: 0, ignored: 0, failed: 1,
    });
    expect(failEvent).toHaveBeenCalledWith("event-worker", 2n, expect.any(String), expect.any(Number), false);
  });

  it("never advances a missed-event cursor when provider pagination stalls", async () => {
    const setPollCursor = vi.fn(async () => new Date());
    const tripBreaker = vi.fn(async () => undefined);
    const treasury = {
      pollCursor: vi.fn(async () => undefined),
      enqueueEvent: vi.fn(async () => ({ inboxId: 1n, replayed: false, state: "queued" })),
      setPollCursor,
      tripBreaker,
    } as unknown as PostgresTreasury;
    const stalledPage = Array.from({ length: 100 }, () => ({
      id: "evnt_stalled", created_at: "2026-07-19T10:00:00.000Z",
      type: "ach.incoming_transfer.settled", data: transfer(),
    }));
    const listWebhookEvents = vi.fn(async () => stalledPage);
    const column = { listWebhookEvents } as unknown as ColumnClient;

    await expect(pollMissedColumnEvents(treasury, column, new Date("2026-07-19T10:10:00.000Z")))
      .rejects.toThrow("pagination stalled");
    expect(listWebhookEvents).toHaveBeenCalledTimes(2);
    expect(setPollCursor).not.toHaveBeenCalled();
    expect(tripBreaker).toHaveBeenCalledWith(expect.stringContaining("pagination stalled"));
  });

  it("separates accepted, definitively rejected, retryable, and ambiguous payout outcomes", async () => {
    const claims = [
      { payoutId: "accepted", provider: "column", providerRef: "ctpy_worker_001", sourceAccountId: "usr_1", asset: "USD", amountMicros: 500_000n, attempts: 1 },
      { payoutId: "rejected", provider: "column", providerRef: "ctpy_worker_002", sourceAccountId: "usr_1", asset: "USD", amountMicros: 500_000n, attempts: 1 },
      { payoutId: "retry", provider: "column", providerRef: "ctpy_worker_003", sourceAccountId: "usr_1", asset: "USD", amountMicros: 500_000n, attempts: 2 },
      { payoutId: "ambiguous", provider: "column", providerRef: "ctpy_worker_004", sourceAccountId: "usr_1", asset: "USD", amountMicros: 500_000n, attempts: 1 },
    ];
    const recordPayoutSubmission = vi.fn(async () => ({ payoutId: "accepted", state: "submitted", replayed: false }));
    const failPayoutSubmission = vi.fn(async () => undefined);
    const releasePayoutClaim = vi.fn(async () => undefined);
    const markPayoutManualReview = vi.fn(async () => undefined);
    const treasury = {
      claimPayouts: vi.fn(async () => claims), recordPayoutSubmission,
      failPayoutSubmission, releasePayoutClaim, markPayoutManualReview,
    } as unknown as PostgresTreasury;
    const createAchPayout = vi.fn(async (input: { payoutId: string }) => {
      if (input.payoutId === "rejected") throw new ColumnApiError("invalid counterparty", 422, false);
      if (input.payoutId === "retry") throw new ColumnApiError("provider unavailable", 503, true);
      if (input.payoutId === "ambiguous") throw new Error("provider response does not match reserved payout terms");
      return transfer({ id: "acht_worker_payout", is_incoming: false, status: "SUBMITTED" });
    });
    const column = { createAchPayout } as unknown as ColumnClient;
    expect(await runTreasuryPayoutBatch(treasury, column, "payout-worker", { bankAccountId: "bacc_worker_001" }, 10))
      .toEqual({ claimed: 4, submitted: 1, reversed: 1, retrying: 1, manualReview: 1 });
    expect(recordPayoutSubmission).toHaveBeenCalledWith("payout-worker", "accepted", "acht_worker_payout", "submitted");
    expect(failPayoutSubmission).toHaveBeenCalledWith("payout-worker", "rejected", expect.any(String));
    expect(releasePayoutClaim).toHaveBeenCalledWith("payout-worker", "retry", expect.any(String), expect.any(Number));
    expect(markPayoutManualReview).toHaveBeenCalledWith("payout-worker", "ambiguous", undefined, expect.any(String));
  });

  it("pins a stablecoin balance observation to one exact EVM block", async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      calls.push(body);
      const call = body.params[0] as { data?: string } | undefined;
      const result = body.method === "eth_blockNumber" ? "0x10"
        : call?.data === "0x313ce567" ? `0x${6n.toString(16).padStart(64, "0")}`
          : `0x${42n.toString(16).padStart(64, "0")}`;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        headers: { "content-type": "application/json" },
      });
    });
    const source = new EvmUsdcAssetSource({
      provider: "evm-base",
      rpcUrl: "http://127.0.0.1:8545",
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      fetch: fetcher as typeof fetch,
      allowInsecureLocalhost: true,
    });

    const observation = await source.observe();
    expect(calls.map((call) => call.method)).toEqual(["eth_blockNumber", "eth_call", "eth_call"]);
    expect(calls[1]?.params[1]).toBe("0x10");
    expect(calls[2]?.params[1]).toBe("0x10");
    expect(observation).toEqual(expect.objectContaining({
      provider: "evm-base", asset: "USD", bookMicros: 42n,
      providerObservationId: expect.stringMatching(/^0x10:/),
    }));
  });

  it("opens the breaker when reconciliation is incomplete or stale", async () => {
    const observation = {
      provider: "column", providerAccountRef: "bacc_worker_001", asset: "USD",
      bookMicros: 1_000_000n, availableMicros: 1_000_000n,
      holdingMicros: 0n, lockedMicros: 0n, pendingMicros: 0n,
      providerObservationId: "obs_worker_001", observedAt: new Date(),
    };
    const tripBreaker = vi.fn(async () => undefined);
    const treasury = {
      recordAssetSnapshot: vi.fn(async () => ({ snapshotId: 1n, replayed: false, withinTolerance: false })),
      health: vi.fn(async () => [{
        asset: "USD", expectedAssetMicros: 1_000_000n, observedAssetMicros: 0n,
        uncertainOutflowMicros: 0n, shortfallMicros: 1_000_000n, excessMicros: 0n,
        openExposureMicros: 0n, activeAssetAccounts: 2, observedAssetAccounts: 1,
        snapshotComplete: false, withinTolerance: false,
      }]),
      tripBreaker,
    } as unknown as PostgresTreasury;
    const source = { observe: vi.fn(async () => observation) };

    expect(await runTreasuryReconciliation(treasury, [source])).toEqual(expect.objectContaining({ ok: false }));
    expect(tripBreaker).toHaveBeenCalledWith(expect.stringContaining("reconciliation is not healthy"));
  });
});
