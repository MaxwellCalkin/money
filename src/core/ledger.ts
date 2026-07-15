import { randomUUID } from "node:crypto";
import { assertMicros, type Micros, type Transfer } from "./types.ts";

export interface ApplyOptions {
  /**
   * Only external boundary accounts (funding/withdrawal) may go negative —
   * they are the edge of the closed loop. Everyone inside is fully funded.
   */
  allowOverdraft?: boolean;
}

export class InsufficientFundsError extends Error {
  constructor(account: string, balance: Micros, amount: Micros) {
    super(`insufficient funds: account ${account} has ${balance} micros, needs ${amount}`);
    this.name = "InsufficientFundsError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`idempotency key ${key} was already used with different transfer parameters`);
    this.name = "IdempotencyConflictError";
  }
}

/**
 * Double-entry ledger over integer micros. Append-only transfer log,
 * idempotency-keyed writes, and a zero-sum invariant across all balances.
 */
export class Ledger {
  private balances = new Map<string, Micros>();
  private transfers: Transfer[] = [];
  private byIdempotency = new Map<string, Transfer>();

  constructor(private clock: () => number = Date.now) {}

  ensureAccount(id: string): void {
    if (!this.balances.has(id)) this.balances.set(id, 0);
  }

  balance(id: string): Micros {
    return this.balances.get(id) ?? 0;
  }

  /**
   * Apply a transfer. Replaying the same idempotency key with identical
   * parameters returns the original transfer; replaying it with different
   * parameters is an error, never a silent second spend.
   */
  apply(
    input: Omit<Transfer, "id" | "ts">,
    opts: ApplyOptions = {}
  ): { transfer: Transfer; replayed: boolean } {
    const { from, to, amount, idempotencyKey } = input;
    assertMicros(amount);
    if (amount <= 0) throw new Error(`transfer amount must be positive, got ${amount}`);
    if (from === to) throw new Error("cannot transfer to self");
    if (!idempotencyKey) throw new Error("idempotencyKey is required");

    const prior = this.byIdempotency.get(idempotencyKey);
    if (prior) {
      if (prior.from !== from || prior.to !== to || prior.amount !== amount) {
        throw new IdempotencyConflictError(idempotencyKey);
      }
      return { transfer: prior, replayed: true };
    }

    this.ensureAccount(from);
    this.ensureAccount(to);

    const fromBalance = this.balance(from);
    if (!opts.allowOverdraft && fromBalance < amount) {
      throw new InsufficientFundsError(from, fromBalance, amount);
    }

    // Guard the *resulting* balances too: past 2^53 micros, float addition
    // silently loses money while zeroSum() can still read true.
    const newFrom = fromBalance - amount;
    const newTo = this.balance(to) + amount;
    assertMicros(newFrom);
    assertMicros(newTo);

    const transfer: Transfer = {
      ...input,
      id: `tr_${randomUUID()}`,
      ts: this.clock(),
    };

    this.balances.set(from, newFrom);
    this.balances.set(to, newTo);
    this.transfers.push(transfer);
    this.byIdempotency.set(idempotencyKey, transfer);

    return { transfer, replayed: false };
  }

  findByIdempotencyKey(key: string): Transfer | undefined {
    return this.byIdempotency.get(key);
  }

  history(limit?: number): Transfer[] {
    const all = [...this.transfers];
    return limit ? all.slice(-limit) : all;
  }

  /** Every credit has a matching debit, so the whole network must sum to zero. */
  zeroSum(): boolean {
    let sum = 0;
    for (const v of this.balances.values()) sum += v;
    return sum === 0;
  }
}
