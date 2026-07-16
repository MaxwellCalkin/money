import { randomUUID } from "node:crypto";
import type { StoredMandate } from "./store.ts";
import {
  assertMicros,
  fmt,
  type Decision,
  type Mandate,
  type Micros,
  type Permit,
} from "./types.ts";

const PERMIT_TTL_MS = 60_000;

export interface MandateGrant {
  userId: string;
  agentId: string;
  budget: Micros;
  perTxCap: Micros;
  dailyCap: Micros;
  escalateAbove: Micros;
  newPayeeCap: Micros;
  payeeAllowlist?: string[];
  /** Epoch ms. Defaults to 30 days from grant. */
  expiresAt?: number;
}

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Deterministic mandate evaluation. This is the "envelope": the security
 * boundary lives here, outside any model context. Nothing in an agent's
 * conversation can create or widen a mandate — only the owner can, via
 * grant() (in production: a passkey ceremony in the console).
 *
 * evaluate() is a read — it never mutates counters. consume() re-checks and
 * commits, so a failed transfer never burns budget and a permit can never be
 * spent twice.
 */
export class PolicyEngine {
  private mandates = new Map<string, Mandate>();
  private permits = new Map<string, Permit>();

  /**
   * @param isTrustedPayee Payees inside the owner's own trust domain (the
   * owner themself, or sibling agents the same user owns) are exempt from the
   * new-payee throttle — money paid to them never leaves the owner's accounts.
   * Every other limit still applies to them.
   */
  constructor(
    private clock: () => number = Date.now,
    private isTrustedPayee: (mandate: Mandate, payeeId: string) => boolean = () => false
  ) {}

  grant(input: MandateGrant): Mandate {
    for (const cap of [input.budget, input.perTxCap, input.dailyCap, input.escalateAbove, input.newPayeeCap]) {
      assertMicros(cap);
      if (cap < 0) throw new Error("mandate limits must be non-negative");
    }
    // A new grant supersedes all prior mandates for this agent. Without this,
    // revoking the newest mandate would silently resurrect an older, looser
    // one — and revoke must be a reliable kill switch.
    for (const m of this.mandates.values()) {
      if (m.agentId === input.agentId && !m.revoked) m.revoked = true;
    }
    const now = this.clock();
    const mandate: Mandate = {
      id: `mdt_${randomUUID()}`,
      userId: input.userId,
      agentId: input.agentId,
      budget: input.budget,
      perTxCap: input.perTxCap,
      dailyCap: input.dailyCap,
      escalateAbove: input.escalateAbove,
      newPayeeCap: input.newPayeeCap,
      payeeAllowlist: input.payeeAllowlist,
      expiresAt: input.expiresAt ?? now + 30 * 24 * 60 * 60 * 1000,
      revoked: false,
      spent: 0,
      spentToday: 0,
      today: utcDay(now),
      seenPayees: new Set(),
    };
    this.mandates.set(mandate.id, mandate);
    return mandate;
  }

  /**
   * Replay-only: load a mandate recorded in the event log. Applies the same
   * supersede rule as grant() — replaying the grants in log order must
   * revoke the same priors the live grants did. Counters start empty and are
   * rebuilt from the replayed transfers via replaySpend(), so the daily cap
   * is correct even when the restart lands on a different UTC day.
   */
  loadMandate(stored: StoredMandate): void {
    for (const m of this.mandates.values()) {
      if (m.agentId === stored.agentId && !m.revoked) m.revoked = true;
    }
    this.mandates.set(stored.id, {
      ...stored,
      spent: 0,
      spentToday: 0,
      today: utcDay(this.clock()),
      seenPayees: new Set(),
    });
  }

  /** Replay-only: re-commit a spend recorded in the log to its mandate's counters. */
  replaySpend(mandateId: string, payeeId: string, amount: Micros, ts: number): void {
    const m = this.mandates.get(mandateId);
    if (!m) throw new Error(`replay: transfer references unknown mandate ${mandateId}`);
    m.spent += amount;
    m.seenPayees.add(payeeId);
    const day = utcDay(ts);
    // Same monotonic rule as rotateDay(): the day only rolls forward. The
    // boot day is the floor, so only spends on the mandate's current UTC day
    // count against the daily cap — older days' spends never do.
    if (day > m.today) {
      m.today = day;
      m.spentToday = 0;
    }
    if (day === m.today) m.spentToday += amount;
  }

  revoke(mandateId: string): void {
    const m = this.mandates.get(mandateId);
    if (m) m.revoked = true;
  }

  get(mandateId: string): Mandate | undefined {
    return this.mandates.get(mandateId);
  }

  /** The newest non-revoked mandate for an agent governs its spending. */
  activeMandateFor(agentId: string): Mandate | undefined {
    let latest: Mandate | undefined;
    for (const m of this.mandates.values()) {
      if (m.agentId === agentId && !m.revoked) latest = m;
    }
    return latest;
  }

  evaluate(agentId: string, payeeId: string, amount: Micros): Decision {
    try {
      assertMicros(amount);
    } catch {
      return { ok: false, code: "invalid_amount", reason: `amount must be integer micros, got ${amount}` };
    }
    if (amount <= 0) {
      return { ok: false, code: "invalid_amount", reason: "amount must be positive" };
    }

    const mandate = this.activeMandateFor(agentId);
    if (!mandate) {
      return { ok: false, code: "no_mandate", reason: `agent ${agentId} has no active mandate` };
    }

    const failure = this.checkAgainstMandate(mandate, payeeId, amount, { humanApproved: false });
    if (failure) return failure;

    return { ok: true, permit: this.mintPermit(mandate, agentId, payeeId, amount, false) };
  }

  /**
   * Approval-is-the-mandate: a human approval mints a one-time permit bound
   * to the exact payee + amount the human saw. It bypasses the escalation
   * line, the per-transaction cap, and the new-payee throttle — but never
   * the total budget or expiry.
   */
  humanApprove(mandateId: string, payeeId: string, amount: Micros): Decision {
    try {
      assertMicros(amount);
    } catch {
      return { ok: false, code: "invalid_amount", reason: `amount must be integer micros, got ${amount}` };
    }
    if (amount <= 0) {
      return { ok: false, code: "invalid_amount", reason: "amount must be positive" };
    }
    const mandate = this.mandates.get(mandateId);
    if (!mandate) return { ok: false, code: "no_mandate", reason: `mandate ${mandateId} not found` };

    const failure = this.checkAgainstMandate(mandate, payeeId, amount, { humanApproved: true });
    if (failure) return failure;

    return { ok: true, permit: this.mintPermit(mandate, mandate.agentId, payeeId, amount, true) };
  }

  /**
   * Consume a permit: verify the binding (agent, payee, amount), re-check the
   * mandate, mark the permit used, and commit the counters. Called by the
   * network at the moment the transfer commits.
   */
  consume(permitId: string, agentId: string, payeeId: string, amount: Micros): { ok: true; mandateId: string } | { ok: false; reason: string } {
    const permit = this.permits.get(permitId);
    if (!permit) return { ok: false, reason: "permit not found" };
    if (permit.used) return { ok: false, reason: "permit already used" };
    if (this.clock() > permit.expiresAt) return { ok: false, reason: "permit expired" };
    if (permit.agentId !== agentId || permit.payeeId !== payeeId || permit.amount !== amount) {
      return { ok: false, reason: "permit does not match this payment (agent, payee, and amount are bound at issuance)" };
    }
    const mandate = this.mandates.get(permit.mandateId);
    if (!mandate) return { ok: false, reason: "mandate not found" };

    const failure = this.checkAgainstMandate(mandate, payeeId, amount, { humanApproved: permit.humanApproved });
    if (failure) return { ok: false, reason: `mandate re-check failed: ${failure.code}` };

    permit.used = true;
    this.permits.delete(permitId); // consumed permits need no record; receipts carry the id
    this.rotateDay(mandate);
    mandate.spent += amount;
    mandate.spentToday += amount;
    mandate.seenPayees.add(payeeId);
    return { ok: true, mandateId: mandate.id };
  }

  /** Discard an issued-but-unconsumed permit (e.g. the transfer failed). */
  release(permitId: string): void {
    const permit = this.permits.get(permitId);
    if (permit && !permit.used) this.permits.delete(permitId);
  }

  private mintPermit(mandate: Mandate, agentId: string, payeeId: string, amount: Micros, humanApproved: boolean): Permit {
    const now = this.clock();
    // Opportunistic sweep so orphaned permits don't accumulate forever.
    for (const [id, p] of this.permits) {
      if (now > p.expiresAt) this.permits.delete(id);
    }
    const permit: Permit = {
      id: `pmt_${randomUUID()}`,
      mandateId: mandate.id,
      agentId,
      payeeId,
      amount,
      issuedAt: now,
      expiresAt: now + PERMIT_TTL_MS,
      used: false,
      humanApproved,
    };
    this.permits.set(permit.id, permit);
    return permit;
  }

  private rotateDay(mandate: Mandate): void {
    const day = utcDay(this.clock());
    // Monotonic: only roll forward (ISO dates compare lexicographically). A
    // backward clock reading (NTP correction, cross-node skew later) must not
    // re-zero the daily counter — that would let the cap be reset at will.
    if (day > mandate.today) {
      mandate.today = day;
      mandate.spentToday = 0;
    }
  }

  private checkAgainstMandate(
    mandate: Mandate,
    payeeId: string,
    amount: Micros,
    opts: { humanApproved: boolean }
  ): Decision & { ok: false } | undefined {
    if (mandate.revoked) {
      return { ok: false, code: "revoked", reason: "mandate has been revoked" };
    }
    if (this.clock() > mandate.expiresAt) {
      return { ok: false, code: "expired", reason: "mandate has expired" };
    }
    if (mandate.payeeAllowlist && !mandate.payeeAllowlist.includes(payeeId)) {
      return { ok: false, code: "payee_not_allowed", reason: `payee ${payeeId} is not on this mandate's allowlist` };
    }
    if (mandate.spent + amount > mandate.budget) {
      return {
        ok: false,
        code: "budget",
        reason: `would exceed total budget: spent ${fmt(mandate.spent)} of ${fmt(mandate.budget)}, requested ${fmt(amount)}`,
      };
    }

    this.rotateDay(mandate);
    if (mandate.spentToday + amount > mandate.dailyCap) {
      return {
        ok: false,
        code: "daily_cap",
        reason: `would exceed daily cap: spent ${fmt(mandate.spentToday)} of ${fmt(mandate.dailyCap)} today, requested ${fmt(amount)}`,
      };
    }

    if (!opts.humanApproved) {
      if (amount > mandate.escalateAbove) {
        return {
          ok: false,
          code: "escalate",
          reason: `${fmt(amount)} is above the ${fmt(mandate.escalateAbove)} escalation line — human approval required`,
          mandateId: mandate.id,
        };
      }
      if (amount > mandate.perTxCap) {
        return {
          ok: false,
          code: "per_tx_cap",
          reason: `${fmt(amount)} exceeds the ${fmt(mandate.perTxCap)} per-transaction cap`,
        };
      }
      if (
        !mandate.seenPayees.has(payeeId) &&
        !this.isTrustedPayee(mandate, payeeId) &&
        amount > mandate.newPayeeCap
      ) {
        return {
          ok: false,
          code: "new_payee_cap",
          reason: `first payment to unseen payee ${payeeId} is capped at ${fmt(mandate.newPayeeCap)} (injection throttle)`,
        };
      }
    }

    return undefined;
  }
}
