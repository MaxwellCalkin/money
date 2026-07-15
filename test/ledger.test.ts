import { describe, expect, it } from "vitest";
import { IdempotencyConflictError, InsufficientFundsError, Ledger } from "../src/core/ledger.ts";
import { usd } from "../src/core/types.ts";

const base = { memo: "t", idempotencyKey: "k1" };

describe("Ledger", () => {
  it("moves money and stays zero-sum", () => {
    const l = new Ledger();
    l.apply({ from: "ext", to: "a", amount: usd(10), ...base }, { allowOverdraft: true });
    l.apply({ from: "a", to: "b", amount: usd(4), memo: "t", idempotencyKey: "k2" });
    expect(l.balance("a")).toBe(usd(6));
    expect(l.balance("b")).toBe(usd(4));
    expect(l.balance("ext")).toBe(-usd(10));
    expect(l.zeroSum()).toBe(true);
  });

  it("rejects overdraft for internal accounts", () => {
    const l = new Ledger();
    expect(() => l.apply({ from: "a", to: "b", amount: usd(1), ...base })).toThrow(InsufficientFundsError);
  });

  it("rejects non-integer and non-positive amounts", () => {
    const l = new Ledger();
    expect(() => l.apply({ from: "a", to: "b", amount: 0.5, ...base })).toThrow();
    expect(() => l.apply({ from: "a", to: "b", amount: 0, ...base })).toThrow();
    expect(() => l.apply({ from: "a", to: "b", amount: -5, ...base })).toThrow();
  });

  it("replays idempotency keys without double-spending", () => {
    const l = new Ledger();
    l.apply({ from: "ext", to: "a", amount: usd(10), ...base }, { allowOverdraft: true });
    const first = l.apply({ from: "a", to: "b", amount: usd(1), memo: "t", idempotencyKey: "pay-1" });
    const second = l.apply({ from: "a", to: "b", amount: usd(1), memo: "t", idempotencyKey: "pay-1" });
    expect(second.replayed).toBe(true);
    expect(second.transfer.id).toBe(first.transfer.id);
    expect(l.balance("a")).toBe(usd(9));
  });

  it("refuses idempotency key reuse with different parameters", () => {
    const l = new Ledger();
    l.apply({ from: "ext", to: "a", amount: usd(10), ...base }, { allowOverdraft: true });
    l.apply({ from: "a", to: "b", amount: usd(1), memo: "t", idempotencyKey: "pay-1" });
    expect(() => l.apply({ from: "a", to: "b", amount: usd(2), memo: "t", idempotencyKey: "pay-1" })).toThrow(
      IdempotencyConflictError
    );
  });

  it("rejects self-transfers", () => {
    const l = new Ledger();
    expect(() => l.apply({ from: "a", to: "a", amount: usd(1), ...base })).toThrow();
  });

  it("rejects transfers whose resulting balances leave safe-integer range", () => {
    const l = new Ledger();
    const huge = 9_000_000_000_000_000; // 9e15 micros = $9B, near 2^53
    l.apply({ from: "ext", to: "a", amount: huge, memo: "t", idempotencyKey: "h1" }, { allowOverdraft: true });
    expect(() =>
      l.apply({ from: "ext", to: "a", amount: huge, memo: "t", idempotencyKey: "h2" }, { allowOverdraft: true })
    ).toThrow(); // 1.8e16 > 2^53 would silently lose micros
    expect(l.balance("a")).toBe(huge); // first transfer intact, second never half-applied
  });
});
