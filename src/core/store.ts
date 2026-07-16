import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname } from "node:path";
import type { Account, Mandate, PayResult, Receipt, Transfer } from "./types.ts";

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
    };

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

  append(...events: NetworkEvent[]): void {
    if (events.length === 0) return;
    const lines = events.map((e) => JSON.stringify(e) + "\n").join("");
    appendFileSync(this.path, lines, "utf8");
  }

  /**
   * Read every event in the log. The constructor already discarded a torn
   * tail, so every remaining line must parse; corruption anywhere is not
   * survivable for a ledger — throw rather than replay half a log.
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
        events.push(JSON.parse(text) as NetworkEvent);
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
