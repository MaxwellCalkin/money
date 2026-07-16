import { randomUUID } from "node:crypto";
import { Ledger, InsufficientFundsError } from "./ledger.ts";
import { PolicyEngine, type MandateGrant } from "./policy.ts";
import { ReceiptChain } from "./receipts.ts";
import { JsonlStore, serializeMandate, type EventSink, type NetworkEvent } from "./store.ts";
import {
  assertMicros,
  type Account,
  type Challenge,
  type Mandate,
  type Micros,
  type PayResult,
  type Receipt,
  type Transfer,
} from "./types.ts";

/** The external boundary of the closed loop — the only account allowed to go negative. */
export const EXTERNAL_FUNDING = "external:funding";

const CHALLENGE_TTL_MS = 10 * 60_000;

export interface PayRequest {
  from: string;
  to: string;
  amount: Micros;
  memo: string;
  idempotencyKey: string;
}

/**
 * MoneyNetwork — the closed loop. Users fund balances; agents spend them
 * under mandates; agents pay each other and pay providers; every payment
 * inside the loop is a ledger row: instant, free, sub-cent capable.
 */
export class MoneyNetwork {
  readonly ledger: Ledger;
  readonly policy: PolicyEngine;
  readonly receipts: ReceiptChain;
  private accounts = new Map<string, Account>();
  private challenges = new Map<string, Challenge>();
  /** idempotencyKey → receipt id, so replays return the full original result. */
  private receiptByIdempotency = new Map<string, string>();
  /** idempotencyKey → denial, for keys whose transfer was reversed after apply. */
  private deniedByIdempotency = new Map<string, PayResult>();

  /**
   * A bare `new MoneyNetwork()` is in-memory only (state dies with the
   * process) — fine for tests and demos. For a durable network use
   * MoneyNetwork.open(), which replays the log before attaching the sink;
   * passing a sink here without replaying its existing log is a misuse.
   */
  constructor(private clock: () => number = Date.now, private sink?: EventSink) {
    this.ledger = new Ledger(clock);
    // Same-owner payees (the owner, or sibling agents they own) are inside
    // the trust domain: paying them never moves money out of the owner's
    // accounts, so the new-payee injection throttle does not apply to them.
    this.policy = new PolicyEngine(clock, (mandate, payeeId) => {
      const payee = this.accounts.get(payeeId);
      return !!payee && (payee.id === mandate.userId || payee.ownerId === mandate.userId);
    });
    this.receipts = new ReceiptChain(clock);
    this.accounts.set(EXTERNAL_FUNDING, {
      id: EXTERNAL_FUNDING,
      kind: "external",
      name: "External funding boundary",
      createdAt: clock(),
    });
    this.ledger.ensureAccount(EXTERNAL_FUNDING);
  }

  // ── Durability ──────────────────────────────────────────────────────────

  /**
   * Open a durable network backed by an append-only JSONL event log. Replays
   * the log to rebuild all state (accounts, ledger, mandates with counters,
   * receipt chain), verifies the invariants, then appends every future
   * mutation to the same log.
   */
  static open(path: string, clock: () => number = Date.now): MoneyNetwork {
    const store = new JsonlStore(path);
    const network = new MoneyNetwork(clock, store);
    network.replay(store.readAll());
    return network;
  }

  private emit(...events: NetworkEvent[]): void {
    this.sink?.append(...events);
  }

  /** Rebuild state from the log. Raw application only — no ids, no clock reads, no re-validation, no re-logging. */
  private replay(events: NetworkEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case "account_created":
          this.accounts.set(e.account.id, e.account);
          this.ledger.ensureAccount(e.account.id);
          break;
        case "mandate_granted":
          this.policy.loadMandate(e.mandate);
          break;
        case "mandate_revoked":
          this.policy.revoke(e.mandateId);
          break;
        case "transfer":
          this.ledger.insert(e.transfer);
          if (e.receipt) {
            const r = e.receipt;
            // The receipt must describe its transfer — a log where they
            // disagree has been tampered with, whatever the hashes say.
            if (r.transferId !== e.transfer.id || r.from !== e.transfer.from || r.to !== e.transfer.to || r.amount !== e.transfer.amount) {
              throw new Error(`replay: receipt ${r.id} does not match transfer ${e.transfer.id} — the event log is corrupt`);
            }
            this.receipts.insertRaw(r);
            this.receiptByIdempotency.set(e.transfer.idempotencyKey, r.id);
            if (r.mandateId) {
              this.policy.replaySpend(r.mandateId, e.transfer.to, e.transfer.amount, e.transfer.ts);
            }
          }
          if (e.denial) this.deniedByIdempotency.set(e.denial.forKey, e.denial.result);
          break;
      }
    }
    // A rebuilt network must satisfy the same invariants as a live one; a
    // tampered or corrupt log must fail loudly here, not misprice later.
    if (!this.ledger.zeroSum()) {
      throw new Error("replay: rebuilt ledger is not zero-sum — the event log is corrupt");
    }
    const v = this.receipts.verify();
    if (!v.ok) {
      throw new Error(`replay: rebuilt receipt chain is broken at seq ${v.brokenAt} — the event log was tampered with or corrupted`);
    }
  }

  // ── Accounts ────────────────────────────────────────────────────────────

  createUser(name: string): Account {
    return this.createAccount("user", name);
  }

  /** publicKey (base64 SPKI Ed25519) is the agent's registered identity —
   *  required to authenticate HTTP spend requests. */
  createAgent(name: string, ownerId: string, publicKey?: string): Account {
    const owner = this.accounts.get(ownerId);
    if (!owner || owner.kind !== "user") throw new Error(`agent owner ${ownerId} must be a user account`);
    return this.createAccount("agent", name, ownerId, publicKey);
  }

  createProvider(name: string): Account {
    return this.createAccount("provider", name);
  }

  private createAccount(kind: Account["kind"], name: string, ownerId?: string, publicKey?: string): Account {
    const prefix = { user: "usr", agent: "agt", provider: "prv", external: "ext" }[kind];
    const account: Account = {
      id: `${prefix}_${randomUUID().slice(0, 8)}`,
      kind,
      name,
      ownerId,
      publicKey,
      createdAt: this.clock(),
    };
    this.accounts.set(account.id, account);
    this.ledger.ensureAccount(account.id);
    this.emit({ type: "account_created", account });
    return account;
  }

  account(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  listAccounts(): Account[] {
    return [...this.accounts.values()];
  }

  balanceOf(id: string): Micros {
    return this.ledger.balance(id);
  }

  // ── Funding (the edge of the loop) ──────────────────────────────────────

  /** Simulates an external top-up (card / ACH / stablecoin onramp in production). */
  fund(accountId: string, amount: Micros, idempotencyKey: string): Transfer {
    assertMicros(amount);
    const account = this.mustAccount(accountId);
    if (account.kind !== "user") throw new Error("only user accounts can be funded from outside");
    const { transfer, replayed } = this.ledger.apply(
      { from: EXTERNAL_FUNDING, to: accountId, amount, memo: "top-up", idempotencyKey },
      { allowOverdraft: true }
    );
    if (!replayed) this.emit({ type: "transfer", transfer });
    return transfer;
  }

  /**
   * An owner allocating their own funds to their own agent. Not a mandate-
   * governed spend — it is the user moving money between pockets they own.
   */
  allocate(userId: string, agentId: string, amount: Micros, idempotencyKey: string): Transfer {
    const user = this.mustAccount(userId);
    const agent = this.mustAccount(agentId);
    if (user.kind !== "user") throw new Error("allocate: source must be a user");
    if (agent.kind !== "agent" || agent.ownerId !== userId) {
      throw new Error("allocate: destination must be an agent owned by this user");
    }
    const { transfer, replayed } = this.ledger.apply({
      from: userId,
      to: agentId,
      amount,
      memo: "allocation from owner",
      idempotencyKey,
    });
    if (!replayed) this.emit({ type: "transfer", transfer });
    return transfer;
  }

  // ── Mandates ────────────────────────────────────────────────────────────

  grantMandate(input: MandateGrant): Mandate {
    const user = this.mustAccount(input.userId);
    const agent = this.mustAccount(input.agentId);
    if (user.kind !== "user") throw new Error("mandates are granted by users");
    if (agent.kind !== "agent" || agent.ownerId !== user.id) {
      throw new Error("mandates can only be granted to the user's own agents");
    }
    const mandate = this.policy.grant(input);
    this.emit({ type: "mandate_granted", mandate: serializeMandate(mandate) });
    return mandate;
  }

  /** The owner's kill switch. Idempotent: re-revoking is a no-op. */
  revokeMandate(mandateId: string): void {
    const mandate = this.policy.get(mandateId);
    if (!mandate) throw new Error(`unknown mandate: ${mandateId}`);
    if (mandate.revoked) return;
    this.policy.revoke(mandateId);
    this.emit({ type: "mandate_revoked", mandateId });
  }

  // ── Paying (the core loop) ──────────────────────────────────────────────

  /**
   * An agent pays any account on the network — another agent, a provider,
   * or a user. Full path: idempotency replay check → policy evaluation →
   * permit → ledger transfer → permit consumption → receipt.
   */
  pay(req: PayRequest): PayResult {
    const from = this.mustAccount(req.from);
    if (from.kind !== "agent") throw new Error("pay() is the agent spend path; use allocate()/fund() for user moves");
    this.mustAccount(req.to);
    if (req.from === req.to) {
      return { status: "denied", code: "payee_not_allowed", reason: "an agent cannot pay itself" };
    }
    if (!req.idempotencyKey) throw new Error("idempotencyKey is required");

    // Replay? Return the original outcome — never re-evaluate, never re-spend.
    const priorTransfer = this.ledger.findByIdempotencyKey(req.idempotencyKey);
    if (priorTransfer) {
      if (priorTransfer.from !== req.from || priorTransfer.to !== req.to || priorTransfer.amount !== req.amount) {
        return { status: "denied", code: "idempotency_conflict", reason: "idempotency key reused with different parameters" };
      }
      const receiptId = this.receiptByIdempotency.get(req.idempotencyKey);
      const receipt = receiptId ? this.receipts.get(receiptId) : undefined;
      if (!receipt) {
        // The transfer applied but was later reversed — replay the denial.
        const denial = this.deniedByIdempotency.get(req.idempotencyKey);
        if (denial) return denial;
        throw new Error("ledger/receipt mismatch on idempotent replay — this is a bug");
      }
      return { status: "paid", transfer: priorTransfer, receipt, replayed: true };
    }

    const decision = this.policy.evaluate(req.from, req.to, req.amount);
    if (!decision.ok) {
      if (decision.code === "escalate") {
        return { status: "escalate", reason: decision.reason, mandateId: decision.mandateId };
      }
      return { status: "denied", code: decision.code, reason: decision.reason };
    }

    return this.settle(req, decision.permit.id);
  }

  /**
   * The human approval path: mints a permit bound to the exact payee+amount
   * the human saw (approval-is-the-mandate), then settles.
   */
  approveAndPay(mandateId: string, req: PayRequest): PayResult {
    const priorTransfer = this.ledger.findByIdempotencyKey(req.idempotencyKey);
    if (priorTransfer) return this.pay(req); // funnel replays through the normal replay path

    // Same validations as pay(): the permit binds to the mandate's agent, so
    // req.from must BE that agent or the ledger and permit would disagree.
    const mandate = this.policy.get(mandateId);
    if (!mandate) {
      return { status: "denied", code: "no_mandate", reason: `mandate ${mandateId} not found` };
    }
    if (mandate.agentId !== req.from) {
      return { status: "denied", code: "no_mandate", reason: "mandate is not bound to the paying agent" };
    }
    this.mustAccount(req.from);
    this.mustAccount(req.to);
    if (req.from === req.to) {
      return { status: "denied", code: "payee_not_allowed", reason: "an agent cannot pay itself" };
    }
    if (!req.idempotencyKey) throw new Error("idempotencyKey is required");

    const decision = this.policy.humanApprove(mandateId, req.to, req.amount);
    if (!decision.ok) {
      if (decision.code === "escalate") {
        return { status: "escalate", reason: decision.reason, mandateId: decision.mandateId };
      }
      return { status: "denied", code: decision.code, reason: decision.reason };
    }
    return this.settle(req, decision.permit.id);
  }

  private settle(req: PayRequest, permitId: string): PayResult {
    let transfer: Transfer;
    try {
      const applied = this.ledger.apply({
        from: req.from,
        to: req.to,
        amount: req.amount,
        memo: req.memo,
        idempotencyKey: req.idempotencyKey,
        permitId,
      });
      transfer = applied.transfer;
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        this.policy.release(permitId);
        return { status: "denied", code: "insufficient_funds", reason: err.message };
      }
      throw err;
    }

    const consumed = this.policy.consume(permitId, req.from, req.to, req.amount);
    if (!consumed.ok) {
      // The transfer applied but the permit re-check failed — reverse it.
      // Reversal key derives from the server-generated transfer id, so a
      // client-chosen idempotency key can never collide with it.
      const { transfer: reversal } = this.ledger.apply({
        from: req.to,
        to: req.from,
        amount: req.amount,
        memo: `reversal: ${consumed.reason}`,
        idempotencyKey: `rev_${transfer.id}`,
      });
      this.policy.release(permitId);
      const denial: PayResult = { status: "denied", code: "permit_invalid", reason: consumed.reason };
      // The key now maps to a reversed transfer with no receipt — remember the
      // denial so replays of this key return it instead of crashing.
      this.deniedByIdempotency.set(req.idempotencyKey, denial);
      // One atomic write: the applied transfer, its reversal, and the denial
      // the original key must replay to after a restart.
      this.emit(
        { type: "transfer", transfer },
        { type: "transfer", transfer: reversal, denial: { forKey: req.idempotencyKey, result: denial } }
      );
      return denial;
    }

    const receipt = this.receipts.append({
      transferId: transfer.id,
      from: req.from,
      to: req.to,
      amount: req.amount,
      memo: req.memo,
      mandateId: consumed.mandateId,
      permitId,
    });
    this.receiptByIdempotency.set(req.idempotencyKey, receipt.id);
    this.emit({ type: "transfer", transfer, receipt });

    return { status: "paid", transfer, receipt, replayed: false };
  }

  // ── HTTP 402 challenges (pay-per-call, exactly-once) ────────────────────

  createChallenge(providerId: string, amount: Micros, resource: string): Challenge {
    assertMicros(amount);
    const provider = this.mustAccount(providerId);
    if (provider.kind !== "provider") throw new Error("challenges are created by providers");
    const now = this.clock();
    // Evict expired unpaid challenges — anonymous 402 traffic must not grow
    // memory without bound. Paid ones survive for redemption and replay.
    for (const [id, ch] of this.challenges) {
      if (now > ch.expiresAt && !ch.receiptId) this.challenges.delete(id);
    }
    const challenge: Challenge = {
      id: `chl_${randomUUID()}`,
      providerId,
      amount,
      resource,
      createdAt: now,
      expiresAt: now + CHALLENGE_TTL_MS,
      redeemed: false,
    };
    this.challenges.set(challenge.id, challenge);
    return challenge;
  }

  /** The payer side: settle a challenge from an agent's mandate. Idempotent per challenge. */
  payChallenge(agentId: string, challengeId: string): PayResult {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) return { status: "denied", code: "challenge_invalid", reason: `challenge ${challengeId} not found` };
    // Replay must win over expiry: an agent that already paid but lost the
    // response has to be able to recover its receipt after the TTL — money
    // was taken; "expired" would strand it.
    const alreadyPaid = this.ledger.findByIdempotencyKey(`chl_${challenge.id}`);
    if (!alreadyPaid && this.clock() > challenge.expiresAt) {
      this.challenges.delete(challengeId);
      return { status: "denied", code: "challenge_invalid", reason: "challenge expired" };
    }
    const result = this.pay({
      from: agentId,
      to: challenge.providerId,
      amount: challenge.amount,
      memo: `402:${challenge.resource}`,
      idempotencyKey: `chl_${challenge.id}`, // one payment per challenge, ever
    });
    if (result.status === "paid") {
      challenge.paidBy = agentId;
      challenge.receiptId = result.receipt.id;
    }
    return result;
  }

  /**
   * The provider side: verify payment and mark the challenge served. Single-use.
   * `expect` binds redemption to the endpoint doing the redeeming — without it,
   * a challenge paid for a cheap resource would unlock an expensive one.
   */
  redeemChallenge(
    challengeId: string,
    receiptId: string,
    expect?: { resource: string; amount: Micros }
  ): { ok: true; challenge: Challenge } | { ok: false; reason: string } {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) return { ok: false, reason: "challenge not found" };
    if (challenge.redeemed) return { ok: false, reason: "challenge already redeemed (single-use)" };
    if (expect && (challenge.resource !== expect.resource || challenge.amount !== expect.amount)) {
      return { ok: false, reason: "challenge was issued for a different resource or price" };
    }
    if (!challenge.receiptId || challenge.receiptId !== receiptId) {
      return { ok: false, reason: "no payment recorded for this challenge/receipt" };
    }
    const receipt = this.receipts.get(receiptId);
    if (!receipt || receipt.to !== challenge.providerId || receipt.amount !== challenge.amount) {
      return { ok: false, reason: "receipt does not match challenge" };
    }
    challenge.redeemed = true;
    return { ok: true, challenge };
  }

  // ── Introspection ───────────────────────────────────────────────────────

  feed(limit = 20): Receipt[] {
    return this.receipts.list(limit);
  }

  verifyReceipts(): ReturnType<ReceiptChain["verify"]> {
    return this.receipts.verify();
  }

  private mustAccount(id: string): Account {
    const account = this.accounts.get(id);
    if (!account) throw new Error(`unknown account: ${id}`);
    return account;
  }
}
