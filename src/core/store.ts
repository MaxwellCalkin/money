import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import type { Account, ExternalPayment, Mandate, PayResult, Receipt, Transfer } from "./types.ts";

/**
 * Durability = event sourcing to an append-only JSONL log. Every state
 * mutation the network performs appends one line (a reversal pair goes in a
 * single atomic write). Events store concrete outcomes — the generated ids,
 * timestamps, and receipt hashes — so replay is pure data application: no
 * randomUUID, no clock reads, no re-validation.
 *
 * Not persisted: 402 challenges (short-lived, per-server) and unconsumed
 * permits (60s TTL). Losing an unredeemed paid challenge on restart means the
 * agent may re-pay for that resource once — bounded by the challenge price.
 */

/** A mandate with its Set serialized for JSON. Stored counters are the
 *  grant-time values; replay rebuilds them from the transfer events. */
export type StoredMandate = Omit<Mandate, "seenPayees"> & { seenPayees: string[] };

export type NetworkEvent =
  | { type: "account_created"; account: Account }
  | { type: "key_rotated"; accountId: string; publicKey: string }
  | { type: "mandate_granted"; mandate: StoredMandate }
  | { type: "mandate_revoked"; mandateId: string }
  | {
      type: "transfer";
      transfer: Transfer;
      /** Present for successful agent pays — the hash-chained evidence. */
      receipt?: Receipt;
      /** Present on the reversal leg of a reversed pay: the denial that the
       *  original idempotency key must replay to after a restart. */
      denial?: { forKey: string; result: PayResult };
    }
  /** Bridge lifecycle: record created pending (its debit is the preceding
   *  transfer event), then confirmed or auto-reversed (whose refund is the
   *  preceding transfer event). */
  | { type: "external_payment"; payment: ExternalPayment }
  | { type: "external_confirmed"; paymentId: string; transaction?: string }
  | { type: "external_reversed"; paymentId: string; reversalTransferId: string };

export interface EventSink {
  /** Append events durably. Multiple events go down in one atomic write. */
  append(...events: NetworkEvent[]): void;
}

export function serializeMandate(m: Mandate): StoredMandate {
  return { ...m, seenPayees: [...m.seenPayees] };
}

export class JsonlStore implements EventSink {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.healTornTail();
  }

  /**
   * One emit() = one line = one JSON array of its events. Framing the whole
   * batch as a single line is what makes it crash-atomic: a torn append can
   * only ever produce a partial final line with no trailing "\n", which
   * healTornTail discards WHOLE — never a prefix of the batch. Writing the
   * events as separate lines (as an earlier version did) let a crash keep
   * the first event of a pair and drop the second: a reversal without its
   * bookkeeping, a debit without its record.
   */
  append(...events: NetworkEvent[]): void {
    if (events.length === 0) return;
    appendFileSync(this.path, JSON.stringify(events) + "\n", "utf8");
  }

  /**
   * Read every event in the log. The constructor already discarded a torn
   * tail, so every remaining line must parse; corruption anywhere is not
   * survivable for a ledger — throw rather than replay half a log. Each line
   * is a JSON array of events (a batch); a bare object is also accepted for
   * logs written by the pre-batch format.
   */
  readAll(): NetworkEvent[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, "utf8");
    const events: NetworkEvent[] = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!.replace(/\r$/, "");
      if (text === "") continue;
      try {
        const parsed = JSON.parse(text) as NetworkEvent | NetworkEvent[];
        if (Array.isArray(parsed)) events.push(...parsed);
        else events.push(parsed);
      } catch (err) {
        throw new Error(`event log ${this.path} is corrupt at line ${i + 1}: ${(err as Error).message}`);
      }
    }
    return events;
  }

  /**
   * WAL-style crash recovery: if the log doesn't end in a newline, the last
   * append was torn mid-write by a crash — the event never finished, so its
   * outcome was never returned to any caller. Truncate the partial line away;
   * leaving it would corrupt the log permanently once new events append
   * after it.
   */
  private healTornTail(): void {
    if (!existsSync(this.path)) return;
    const buf = readFileSync(this.path);
    if (buf.length === 0 || buf[buf.length - 1] === 0x0a) return;
    const lastNewline = buf.lastIndexOf(0x0a); // -1 → keep nothing
    truncateSync(this.path, lastNewline + 1);
    console.warn(`event log ${this.path}: discarded a torn final line (crash mid-append)`);
  }
}
