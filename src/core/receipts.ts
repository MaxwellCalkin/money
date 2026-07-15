import { createHash, randomUUID } from "node:crypto";
import type { Receipt } from "./types.ts";

/**
 * Hash-chained evidence log: every payment produces a receipt whose hash
 * covers the previous receipt's hash. Tampering with any historical entry
 * breaks the chain from that point forward. This is the audit trail that
 * disputes, accounting exports, and (eventually) agent-error insurance
 * are built on.
 */
export class ReceiptChain {
  private chain: Receipt[] = [];

  constructor(private clock: () => number = Date.now) {}

  append(data: Omit<Receipt, "seq" | "id" | "ts" | "prevHash" | "hash">): Receipt {
    const prev = this.chain[this.chain.length - 1];
    const partial = {
      seq: this.chain.length,
      id: `rcp_${randomUUID()}`,
      ts: this.clock(),
      ...data,
      prevHash: prev ? prev.hash : "genesis",
    };
    const receipt: Receipt = { ...partial, hash: hashReceipt(partial) };
    this.chain.push(receipt);
    return receipt;
  }

  get(id: string): Receipt | undefined {
    return this.chain.find((r) => r.id === id);
  }

  list(limit?: number): Receipt[] {
    const all = [...this.chain];
    return limit ? all.slice(-limit) : all;
  }

  get length(): number {
    return this.chain.length;
  }

  verify(): { ok: true } | { ok: false; brokenAt: number } {
    return verifyChain(this.chain);
  }
}

/** Canonical serialization: fixed key order, so the hash is deterministic. */
function canonical(r: Omit<Receipt, "hash">): string {
  return JSON.stringify({
    seq: r.seq,
    id: r.id,
    ts: r.ts,
    transferId: r.transferId,
    from: r.from,
    to: r.to,
    amount: r.amount,
    memo: r.memo,
    mandateId: r.mandateId ?? null,
    permitId: r.permitId ?? null,
    prevHash: r.prevHash,
  });
}

export function hashReceipt(r: Omit<Receipt, "hash">): string {
  return createHash("sha256").update(canonical(r)).digest("hex");
}

export function verifyChain(chain: readonly Receipt[]): { ok: true } | { ok: false; brokenAt: number } {
  let prevHash = "genesis";
  for (let i = 0; i < chain.length; i++) {
    const r = chain[i]!;
    if (r.prevHash !== prevHash || r.hash !== hashReceipt(r) || r.seq !== i) {
      return { ok: false, brokenAt: i };
    }
    prevHash = r.hash;
  }
  return { ok: true };
}
