import { randomUUID } from "node:crypto";
import { Ledger, InsufficientFundsError } from "./ledger.ts";
import { PolicyEngine, type MandateGrant } from "./policy.ts";
import { ReceiptChain } from "./receipts.ts";
import { JsonlStore, serializeMandate, type EventSink, type NetworkEvent } from "./store.ts";
import {
  assertMicros,
  type Account,
  type Challenge,
  type ExternalPayment,
  type ExternalPayResult,
  type Mandate,
  type Micros,
  type PayResult,
  type Receipt,
  type RefundResult,
  type Service,
  type Transfer,
} from "./types.ts";

/** The external boundary of the closed loop — the only account allowed to go negative. */
export const EXTERNAL_FUNDING = "external:funding";
/** Where money that leaves the loop via the x402 bridge lands. Its balance is
 *  the FACE VALUE of external outflows (fees/slippage are not modeled). */
export const EXTERNAL_X402 = "external:x402";

const CHALLENGE_TTL_MS = 10 * 60_000;
const HANDLE_RE = /^[a-z][a-z0-9_-]{2,31}$/;
const SERVICE_SLUG_RE = /^[a-z][a-z0-9-]{1,47}$/;

/** Handles are stored without @ and compared case-insensitively. */
export function normalizeHandle(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

export function isValidHandle(value: string): boolean {
  return HANDLE_RE.test(normalizeHandle(value));
}

export function normalizeServiceSlug(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidServiceSlug(value: string): boolean {
  return SERVICE_SLUG_RE.test(normalizeServiceSlug(value));
}

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
  private accountsByHandle = new Map<string, string>();
  private services = new Map<string, Service>();
  private servicesByAddress = new Map<string, string>();
  private serviceByIdempotency = new Map<string, string>();
  private challenges = new Map<string, Challenge>();
  /** Only challenges that reached a signed payment attempt are durable. */
  private persistedChallenges = new Set<string>();
  private externalPayments = new Map<string, ExternalPayment>();
  /** client idempotency key → external payment id, for exactly-once creates. */
  private externalByClientKey = new Map<string, string>();
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
    this.accounts.set(EXTERNAL_X402, {
      id: EXTERNAL_X402,
      kind: "external",
      name: "External x402 bridge",
      createdAt: clock(),
    });
    this.ledger.ensureAccount(EXTERNAL_X402);
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

  /** Live observers (dashboard SSE, etc.). Distinct from the durable sink. */
  private listeners = new Set<(e: NetworkEvent) => void>();

  /** Subscribe to every state mutation as it commits. Returns unsubscribe. */
  onEvent(listener: (e: NetworkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(...events: NetworkEvent[]): void {
    this.sink?.append(...events);
    for (const e of events) {
      for (const listener of this.listeners) {
        try {
          listener(e);
        } catch {
          // An observer must never be able to break a payment.
        }
      }
    }
  }

  /** Rebuild state from the log. Raw application only — no ids, no clock reads, no re-validation, no re-logging. */
  private replay(events: NetworkEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case "account_created":
          if (this.accounts.has(e.account.id)) {
            throw new Error(`replay: duplicate or reserved account id ${e.account.id}`);
          }
          if (e.account.handle) {
            const handle = normalizeHandle(e.account.handle);
            if (!isValidHandle(handle) || this.accountsByHandle.has(handle)) {
              throw new Error(`replay: invalid or duplicate account handle @${e.account.handle}`);
            }
            e.account.handle = handle;
            this.accountsByHandle.set(handle, e.account.id);
          }
          this.accounts.set(e.account.id, e.account);
          this.ledger.ensureAccount(e.account.id);
          break;
        case "key_rotated": {
          const account = this.accounts.get(e.accountId);
          if (!account) throw new Error(`replay: key rotation references unknown account ${e.accountId}`);
          account.publicKey = e.publicKey;
          break;
        }
        case "service_registered": {
          const provider = this.accounts.get(e.service.providerId);
          if (!provider || provider.kind !== "provider") {
            throw new Error(`replay: service references unknown provider ${e.service.providerId}`);
          }
          if (!provider.ownerId || !provider.publicKey || !provider.handle) {
            throw new Error(`replay: service ${e.service.id} belongs to an incomplete provider identity`);
          }
          if (!isValidServiceSlug(e.service.slug) || e.service.slug !== normalizeServiceSlug(e.service.slug)) {
            throw new Error(`replay: service ${e.service.id} has an invalid slug`);
          }
          try {
            const endpoint = new URL(e.service.endpointUrl);
            if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("bad protocol");
          } catch {
            throw new Error(`replay: service ${e.service.id} has an invalid endpoint`);
          }
          assertMicros(e.service.price);
          if (e.service.price <= 0) throw new Error(`replay: service ${e.service.id} has an invalid price`);
          const address = this.serviceAddress(e.service.providerId, e.service.slug);
          if (
            this.services.has(e.service.id) ||
            this.servicesByAddress.has(address) ||
            this.serviceByIdempotency.has(e.service.idempotencyKey)
          ) {
            throw new Error(`replay: duplicate service ${e.service.id} or address ${address}`);
          }
          this.services.set(e.service.id, e.service);
          this.servicesByAddress.set(address, e.service.id);
          this.serviceByIdempotency.set(e.service.idempotencyKey, e.service.id);
          break;
        }
        case "challenge_created": {
          if (this.challenges.has(e.challenge.id)) throw new Error(`replay: duplicate challenge ${e.challenge.id}`);
          const provider = this.accounts.get(e.challenge.providerId);
          if (!provider || provider.kind !== "provider") {
            throw new Error(`replay: challenge references unknown provider ${e.challenge.providerId}`);
          }
          assertMicros(e.challenge.amount);
          if (e.challenge.amount <= 0 || e.challenge.expiresAt <= e.challenge.createdAt || e.challenge.redeemed) {
            throw new Error(`replay: challenge ${e.challenge.id} has invalid terms`);
          }
          if (e.challenge.serviceId) {
            const service = this.services.get(e.challenge.serviceId);
            if (
              !service ||
              service.providerId !== e.challenge.providerId ||
              service.price !== e.challenge.amount ||
              service.endpointUrl !== e.challenge.resource
            ) {
              throw new Error(`replay: challenge ${e.challenge.id} does not match its registered service`);
            }
          }
          this.challenges.set(e.challenge.id, e.challenge);
          this.persistedChallenges.add(e.challenge.id);
          break;
        }
        case "challenge_redeemed": {
          const challenge = this.challenges.get(e.challengeId);
          if (!challenge) throw new Error(`replay: redemption references unknown challenge ${e.challengeId}`);
          if (challenge.redeemed || !challenge.receiptId) {
            throw new Error(`replay: challenge ${e.challengeId} was redeemed twice or before payment`);
          }
          challenge.redeemed = true;
          break;
        }
        case "mandate_granted":
          this.policy.loadMandate(e.mandate);
          break;
        case "mandate_revoked":
          this.policy.revoke(e.mandateId);
          break;
        case "transfer": {
          if (!this.accounts.has(e.transfer.from) || !this.accounts.has(e.transfer.to)) {
            throw new Error(`replay: transfer ${e.transfer.id} references an unknown account`);
          }
          assertMicros(e.transfer.amount);
          if (e.transfer.amount <= 0 || e.transfer.from === e.transfer.to || !e.transfer.idempotencyKey) {
            throw new Error(`replay: transfer ${e.transfer.id} has invalid terms`);
          }
          if (e.receipt && this.receipts.get(e.receipt.id)) {
            throw new Error(`replay: duplicate receipt id ${e.receipt.id}`);
          }
          const refundOf = e.receipt?.refundOf ?? e.transfer.refundOf;
          if (refundOf !== undefined) {
            const original = refundOf ? this.receipts.get(refundOf) : undefined;
            if (
              !original ||
              original.refundOf ||
              original.to !== e.transfer.from ||
              original.from !== e.transfer.to ||
              e.transfer.amount > original.amount - this.refundedAmount(original.id) ||
              this.ledger.balance(e.transfer.from) < e.transfer.amount ||
              e.receipt?.mandateId ||
              e.receipt?.permitId ||
              e.receipt?.externalPayee
            ) {
              throw new Error(`replay: refund transfer ${e.transfer.id} is invalid`);
            }
          }
          this.ledger.insert(e.transfer);
          if (e.receipt) {
            const r = e.receipt;
            // The receipt must describe its transfer — a log where they
            // disagree has been tampered with, whatever the hashes say.
            if (
              r.transferId !== e.transfer.id ||
              r.from !== e.transfer.from ||
              r.to !== e.transfer.to ||
              r.amount !== e.transfer.amount ||
              r.memo !== e.transfer.memo ||
              (r.permitId ?? null) !== (e.transfer.permitId ?? null) ||
              (r.externalPayee ?? null) !== (e.transfer.externalPayee ?? null) ||
              (r.refundOf ?? null) !== (e.transfer.refundOf ?? null)
            ) {
              throw new Error(`replay: receipt ${r.id} does not match transfer ${e.transfer.id} — the event log is corrupt`);
            }
            this.receipts.insertRaw(r);
            this.receiptByIdempotency.set(e.transfer.idempotencyKey, r.id);
            // Challenge payment state is derived from the durable transfer,
            // so a crash between payment and the caller receiving its response
            // can never require a second charge after restart.
            if (e.transfer.idempotencyKey.startsWith("chl_")) {
              const challenge = this.challenges.get(e.transfer.idempotencyKey.slice(4));
              if (challenge) {
                if (
                  e.transfer.to !== challenge.providerId ||
                  e.transfer.amount !== challenge.amount ||
                  e.transfer.memo !== `402:${challenge.resource}` ||
                  r.refundOf
                ) {
                  throw new Error(`replay: payment does not match challenge ${challenge.id}`);
                }
                challenge.paidBy = e.transfer.from;
                challenge.receiptId = r.id;
              }
            }
            if (r.mandateId) {
              // Counters rebuild against the POLICY payee: for bridge
              // payments that is the vendor host, not the boundary account.
              this.policy.replaySpend(r.mandateId, e.transfer.externalPayee ?? e.transfer.to, e.transfer.amount, e.transfer.ts);
            }
          }
          if (e.denial) this.deniedByIdempotency.set(e.denial.forKey, e.denial.result);
          break;
        }
        case "external_payment":
          this.externalPayments.set(e.payment.id, e.payment);
          this.externalByClientKey.set(e.payment.idempotencyKey, e.payment.id);
          break;
        case "external_confirmed": {
          const payment = this.externalPayments.get(e.paymentId);
          if (!payment) throw new Error(`replay: confirmation references unknown external payment ${e.paymentId}`);
          payment.state = "confirmed";
          payment.settledTx = e.transaction;
          break;
        }
        case "external_reversed": {
          const payment = this.externalPayments.get(e.paymentId);
          if (!payment) throw new Error(`replay: reversal references unknown external payment ${e.paymentId}`);
          payment.state = "reversed";
          payment.reversalTransferId = e.reversalTransferId;
          break;
        }
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

  /** publicKey (base64 SPKI Ed25519) is the owner's registered identity —
   *  required to authenticate admin HTTP requests (fund, agents, mandates). */
  createUser(name: string, publicKey?: string, handle?: string): Account {
    return this.createAccount("user", name, undefined, publicKey, handle);
  }

  /** publicKey (base64 SPKI Ed25519) is the agent's registered identity —
   *  required to authenticate HTTP spend requests. */
  createAgent(name: string, ownerId: string, publicKey?: string, handle?: string): Account {
    const owner = this.accounts.get(ownerId);
    if (!owner || owner.kind !== "user") throw new Error(`agent owner ${ownerId} must be a user account`);
    return this.createAccount("agent", name, ownerId, publicKey, handle);
  }

  createProvider(name: string, ownerId?: string, publicKey?: string, handle?: string): Account {
    if (ownerId) {
      const owner = this.accounts.get(ownerId);
      if (!owner || owner.kind !== "user") throw new Error(`provider owner ${ownerId} must be a user account`);
    }
    return this.createAccount("provider", name, ownerId, publicKey, handle);
  }

  private createAccount(kind: Account["kind"], name: string, ownerId?: string, publicKey?: string, rawHandle?: string): Account {
    const handle = rawHandle ? normalizeHandle(rawHandle) : undefined;
    if (handle && !isValidHandle(handle)) {
      throw new Error("handle must be 3-32 characters: lowercase letters, numbers, _ or -, starting with a letter");
    }
    if (handle && this.accountsByHandle.has(handle)) throw new Error(`handle @${handle} is already taken`);
    const prefix = { user: "usr", agent: "agt", provider: "prv", external: "ext" }[kind];
    const account: Account = {
      id: `${prefix}_${randomUUID().slice(0, 8)}`,
      kind,
      name,
      handle,
      ownerId,
      publicKey,
      createdAt: this.clock(),
    };
    this.accounts.set(account.id, account);
    if (handle) this.accountsByHandle.set(handle, account.id);
    this.ledger.ensureAccount(account.id);
    this.emit({ type: "account_created", account });
    return account;
  }

  account(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  accountByHandle(handle: string): Account | undefined {
    const id = this.accountsByHandle.get(normalizeHandle(handle));
    return id ? this.accounts.get(id) : undefined;
  }

  /** Resolve either an opaque account id or a public @handle. */
  resolveAccount(idOrHandle: string): Account | undefined {
    return this.accounts.get(idOrHandle) ?? this.accountByHandle(idOrHandle);
  }

  listAccounts(): Account[] {
    return [...this.accounts.values()];
  }

  balanceOf(id: string): Micros {
    return this.ledger.balance(id);
  }

  // Seller services

  registerService(input: {
    providerId: string;
    slug: string;
    name: string;
    description?: string;
    endpointUrl: string;
    price: Micros;
    idempotencyKey: string;
  }): { service: Service; replayed: boolean } {
    const provider = this.mustAccount(input.providerId);
    if (provider.kind !== "provider") throw new Error("services must belong to a provider account");
    if (!provider.ownerId || !provider.publicKey || !provider.handle) {
      throw new Error("provider must be owner-controlled, keyed, and have a public handle");
    }
    const slug = normalizeServiceSlug(input.slug);
    if (!isValidServiceSlug(slug)) {
      throw new Error("service slug must be 2-48 lowercase letters, numbers, or hyphens, starting with a letter");
    }
    if (!input.idempotencyKey) throw new Error("idempotencyKey is required");
    assertMicros(input.price);
    if (input.price <= 0) throw new Error("service price must be positive");
    let endpoint: URL;
    try {
      endpoint = new URL(input.endpointUrl);
    } catch {
      throw new Error("endpointUrl must be a valid absolute URL");
    }
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new Error("endpointUrl must use http or https");
    }

    const priorId = this.serviceByIdempotency.get(input.idempotencyKey);
    const prior = priorId ? this.services.get(priorId) : undefined;
    if (prior) {
      if (
        prior.providerId !== input.providerId ||
        prior.slug !== slug ||
        prior.name !== input.name ||
        prior.description !== (input.description ?? "") ||
        prior.endpointUrl !== endpoint.toString() ||
        prior.price !== input.price
      ) {
        throw new Error(`service idempotency key ${input.idempotencyKey} was already used with different terms`);
      }
      return { service: prior, replayed: true };
    }

    const address = this.serviceAddress(provider.id, slug);
    if (this.servicesByAddress.has(address)) throw new Error(`@${provider.handle}/${slug} is already registered`);
    const service: Service = {
      id: `svc_${randomUUID().slice(0, 12)}`,
      providerId: provider.id,
      slug,
      name: input.name,
      description: input.description ?? "",
      endpointUrl: endpoint.toString(),
      price: input.price,
      active: true,
      idempotencyKey: input.idempotencyKey,
      createdAt: this.clock(),
    };
    this.services.set(service.id, service);
    this.servicesByAddress.set(address, service.id);
    this.serviceByIdempotency.set(input.idempotencyKey, service.id);
    this.emit({ type: "service_registered", service });
    return { service, replayed: false };
  }

  service(id: string): Service | undefined {
    return this.services.get(id);
  }

  listServices(): Service[] {
    return [...this.services.values()].filter((service) => service.active);
  }

  serviceByAddress(providerHandle: string, slug: string): Service | undefined {
    const provider = this.accountByHandle(providerHandle);
    if (!provider || provider.kind !== "provider") return undefined;
    const id = this.servicesByAddress.get(this.serviceAddress(provider.id, normalizeServiceSlug(slug)));
    return id ? this.services.get(id) : undefined;
  }

  /** Issue a challenge from durable registry terms, never seller-supplied price. */
  createServiceChallenge(providerId: string, serviceId: string): Challenge {
    const service = this.services.get(serviceId);
    if (!service || !service.active) throw new Error(`unknown or inactive service ${serviceId}`);
    if (service.providerId !== providerId) throw new Error("service does not belong to the signing provider");
    return this.createChallenge(providerId, service.price, service.endpointUrl, service.id);
  }

  private serviceAddress(providerId: string, slug: string): string {
    return `${providerId}:${slug}`;
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
    const { mandate, replayed } = this.policy.grant(input);
    if (!replayed) this.emit({ type: "mandate_granted", mandate: serializeMandate(mandate) });
    return mandate;
  }

  /**
   * Replace an account's registered public key (user or agent). Authorized
   * at the API layer by the OWNER's current key — this is the remediation
   * path for a leaked key, so the old key stops verifying immediately.
   */
  rotateKey(accountId: string, publicKey: string): Account {
    const account = this.mustAccount(accountId);
    if (account.kind !== "user" && account.kind !== "agent" && account.kind !== "provider") {
      throw new Error("only user, agent, and provider accounts carry identity keys");
    }
    if (!publicKey) throw new Error("publicKey is required");
    account.publicKey = publicKey;
    this.emit({ type: "key_rotated", accountId, publicKey });
    return account;
  }

  listMandates(): Mandate[] {
    return this.policy.listMandates();
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
    const payee = this.mustAccount(req.to);
    if (payee.kind === "external") {
      // Boundary accounts record real money crossing the edge. Letting an
      // (injectable) agent credit them directly would fabricate external
      // outflows that never happened — only fund() touches external:funding
      // and only payExternal() credits external:x402.
      return { status: "denied", code: "payee_not_allowed", reason: "external boundary accounts cannot be paid directly" };
    }
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
    const approvedPayee = this.mustAccount(req.to);
    if (approvedPayee.kind === "external") {
      return { status: "denied", code: "payee_not_allowed", reason: "external boundary accounts cannot be paid directly" };
    }
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

  /** Provider-signed return of value tied to an original purchase receipt.
   * Refunds never restore mandate budget: a compromised agent must not be
   * able to recycle spend capacity by colluding with a seller. */
  refund(req: {
    providerId: string;
    receiptId: string;
    amount: Micros;
    memo: string;
    idempotencyKey: string;
  }): RefundResult {
    const provider = this.mustAccount(req.providerId);
    if (provider.kind !== "provider") {
      return { status: "denied", code: "refund_invalid", reason: "only providers can issue refunds" };
    }
    const original = this.receipts.get(req.receiptId);
    if (!original || original.refundOf) {
      return { status: "denied", code: "refund_invalid", reason: "original purchase receipt not found" };
    }
    if (original.to !== provider.id) {
      return { status: "denied", code: "refund_invalid", reason: "receipt was not paid to this provider" };
    }
    try {
      assertMicros(req.amount);
    } catch {
      return { status: "denied", code: "invalid_amount", reason: "refund amount must be integer micros" };
    }
    if (req.amount <= 0) return { status: "denied", code: "invalid_amount", reason: "refund amount must be positive" };
    if (!req.idempotencyKey) throw new Error("idempotencyKey is required");

    const prior = this.ledger.findByIdempotencyKey(req.idempotencyKey);
    const alreadyRefunded = this.refundedAmount(original.id);
    const remainingBefore = original.amount - alreadyRefunded;
    if (!prior && req.amount > remainingBefore) {
      return {
        status: "denied",
        code: "refund_invalid",
        reason: `refund exceeds remaining refundable amount (${remainingBefore} micros)`,
      };
    }

    if (prior) {
      if (
        prior.from !== provider.id ||
        prior.to !== original.from ||
        prior.amount !== req.amount ||
        prior.refundOf !== original.id
      ) {
        return { status: "denied", code: "idempotency_conflict", reason: "idempotency key reused with different refund parameters" };
      }
      const receiptId = this.receiptByIdempotency.get(req.idempotencyKey);
      const receipt = receiptId ? this.receipts.get(receiptId) : undefined;
      if (!receipt) throw new Error("refund ledger/receipt mismatch on idempotent replay");
      return {
        status: "refunded",
        transfer: prior,
        receipt,
        replayed: true,
        remaining: original.amount - this.refundedAmount(original.id),
      };
    }

    let transfer: Transfer;
    try {
      transfer = this.ledger.apply({
        from: provider.id,
        to: original.from,
        amount: req.amount,
        memo: req.memo || `refund for ${original.id}`,
        idempotencyKey: req.idempotencyKey,
        refundOf: original.id,
      }).transfer;
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        return { status: "denied", code: "insufficient_funds", reason: err.message };
      }
      throw err;
    }
    const receipt = this.receipts.append({
      transferId: transfer.id,
      from: provider.id,
      to: original.from,
      amount: req.amount,
      memo: transfer.memo,
      refundOf: original.id,
    });
    this.receiptByIdempotency.set(req.idempotencyKey, receipt.id);
    this.emit({ type: "transfer", transfer, receipt });
    return {
      status: "refunded",
      transfer,
      receipt,
      replayed: false,
      remaining: remainingBefore - req.amount,
    };
  }

  refundedAmount(receiptId: string): Micros {
    let total = 0;
    for (const receipt of this.receipts.list()) {
      if (receipt.refundOf === receiptId) total += receipt.amount;
    }
    assertMicros(total);
    return total;
  }

  createChallenge(providerId: string, amount: Micros, resource: string, serviceId?: string): Challenge {
    assertMicros(amount);
    if (amount <= 0) throw new Error("challenge amount must be positive");
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
      serviceId,
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
    // Unpaid anonymous challenges stay in memory so bots cannot fill the
    // durable ledger merely by requesting a paid page. Once an authenticated
    // agent attempts payment, persist the terms BEFORE money can move.
    if (!this.persistedChallenges.has(challenge.id)) {
      this.emit({ type: "challenge_created", challenge });
      this.persistedChallenges.add(challenge.id);
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

  redeemServiceChallenge(
    providerId: string,
    serviceId: string,
    challengeId: string,
    receiptId: string
  ): { ok: true; challenge: Challenge } | { ok: false; reason: string } {
    const service = this.services.get(serviceId);
    if (!service || !service.active) return { ok: false, reason: "service not found or inactive" };
    if (service.providerId !== providerId) return { ok: false, reason: "service does not belong to the signing provider" };
    const challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.serviceId !== serviceId) {
      return { ok: false, reason: "challenge was not issued for this service" };
    }
    return this.redeemChallenge(challengeId, receiptId, {
      resource: service.endpointUrl,
      amount: service.price,
    });
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
    this.emit({ type: "challenge_redeemed", challengeId: challenge.id });
    return { ok: true, challenge };
  }

  // ── External x402 bridge (money leaving the loop) ───────────────────────

  /**
   * Pay an external x402 seller from an agent's mandate. Two-phase:
   *
   *   1. HERE — policy-check against the vendor host ("x402:<host>"), debit
   *      agent → external:x402, mint the receipt, record a PENDING payment
   *      carrying the exact payment header issued.
   *   2. confirmExternal() finalizes on settlement; sweepExternal()
   *      auto-reverses anything unconfirmed past reverseAfter, because money
   *      that left the loop has no in-loop counterparty to claw back from.
   *
   * The policy payee is the vendor host while the ledger destination is the
   * boundary account — the permit binds to the host, and the transfer +
   * receipt carry externalPayee so replay rebuilds the throttle state
   * exactly. Replaying the client key returns the ORIGINAL record and
   * header: one purchase, one authorization, ever.
   */
  payExternal(req: {
    agentId: string;
    host: string;
    payTo: string;
    asset: string;
    network: string;
    resource: string;
    amount: Micros;
    idempotencyKey: string;
    paymentHeader: string;
    reverseAfter: number;
  }): ExternalPayResult {
    const from = this.mustAccount(req.agentId);
    if (from.kind !== "agent") throw new Error("payExternal is the agent spend path");
    if (!req.idempotencyKey) throw new Error("idempotencyKey is required");
    if (!req.payTo) throw new Error("payTo is required");
    // The policy identity binds BOTH the vendor host AND the on-chain
    // destination. Binding the host alone would let an injected agent name a
    // trusted/seen host while redirecting the signed authorization to an
    // attacker address: the new-payee throttle and payeeAllowlist would wave
    // it through because they'd only ever see the host label, not where the
    // money actually goes. A fresh destination is a fresh payee.
    const payee = `x402:${req.host}:${req.payTo.toLowerCase()}`;

    // Replay: return the original record and the SAME payment header. Run the
    // sweep AFTER this lookup, so a replay observes exactly the state the
    // original create returned — never a "paid" result for a payment the
    // top-of-call sweep just auto-reversed.
    const priorId = this.externalByClientKey.get(req.idempotencyKey);
    if (priorId) {
      const payment = this.externalPayments.get(priorId)!;
      if (payment.agentId !== req.agentId || payment.host !== req.host || payment.amount !== req.amount || payment.payTo !== req.payTo) {
        return { status: "denied", code: "idempotency_conflict", reason: "idempotency key reused with different parameters" };
      }
      const transfer = this.ledger.findByIdempotencyKey(req.idempotencyKey)!;
      const receipt = this.receipts.get(payment.receiptId)!;
      // A reversed payment is no longer live — never report it as paid or
      // hand back its (now worthless, but confusing) authorization header.
      if (payment.state === "reversed") {
        return { status: "denied", code: "permit_invalid", reason: "external payment was auto-reversed (unconfirmed past its deadline)" };
      }
      return { status: "paid", payment, transfer, receipt, replayed: true };
    }
    this.sweepExternal();
    if (this.ledger.findByIdempotencyKey(req.idempotencyKey)) {
      return { status: "denied", code: "idempotency_conflict", reason: "idempotency key was already used for a non-external payment" };
    }

    const decision = this.policy.evaluate(req.agentId, payee, req.amount);
    if (!decision.ok) {
      if (decision.code === "escalate") {
        return { status: "escalate", reason: decision.reason, mandateId: decision.mandateId };
      }
      return { status: "denied", code: decision.code, reason: decision.reason };
    }
    const permitId = decision.permit.id;

    let transfer: Transfer;
    try {
      const applied = this.ledger.apply({
        from: req.agentId,
        to: EXTERNAL_X402,
        amount: req.amount,
        memo: `x402:${req.resource} → ${req.payTo}`,
        idempotencyKey: req.idempotencyKey,
        permitId,
        externalPayee: payee,
      });
      transfer = applied.transfer;
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        this.policy.release(permitId);
        return { status: "denied", code: "insufficient_funds", reason: err.message };
      }
      throw err;
    }

    const consumed = this.policy.consume(permitId, req.agentId, payee, req.amount);
    if (!consumed.ok) {
      const { transfer: reversal } = this.ledger.apply({
        from: EXTERNAL_X402,
        to: req.agentId,
        amount: req.amount,
        memo: `reversal: ${consumed.reason}`,
        idempotencyKey: `rev_${transfer.id}`,
      });
      this.policy.release(permitId);
      const denial: ExternalPayResult = { status: "denied", code: "permit_invalid", reason: consumed.reason };
      this.deniedByIdempotency.set(req.idempotencyKey, { status: "denied", code: "permit_invalid", reason: consumed.reason });
      this.emit(
        { type: "transfer", transfer },
        { type: "transfer", transfer: reversal, denial: { forKey: req.idempotencyKey, result: { status: "denied", code: "permit_invalid", reason: consumed.reason } } }
      );
      return denial;
    }

    const receipt = this.receipts.append({
      transferId: transfer.id,
      from: req.agentId,
      to: EXTERNAL_X402,
      amount: req.amount,
      memo: transfer.memo,
      mandateId: consumed.mandateId,
      permitId,
      externalPayee: payee,
    });
    this.receiptByIdempotency.set(req.idempotencyKey, receipt.id);

    const payment: ExternalPayment = {
      id: `ext_${randomUUID()}`,
      agentId: req.agentId,
      host: req.host,
      payTo: req.payTo,
      asset: req.asset,
      network: req.network,
      resource: req.resource,
      amount: req.amount,
      transferId: transfer.id,
      receiptId: receipt.id,
      idempotencyKey: req.idempotencyKey,
      paymentHeader: req.paymentHeader,
      state: "pending",
      createdAt: this.clock(),
      reverseAfter: req.reverseAfter,
    };
    this.externalPayments.set(payment.id, payment);
    this.externalByClientKey.set(req.idempotencyKey, payment.id);
    this.emit({ type: "transfer", transfer, receipt }, { type: "external_payment", payment });

    return { status: "paid", payment, transfer, receipt, replayed: false };
  }

  /** Finalize a pending external payment once settlement is confirmed.
   *  Idempotent on confirmed; a reversed payment can never be confirmed. */
  confirmExternal(paymentId: string, transaction?: string): { ok: true; payment: ExternalPayment } | { ok: false; reason: string } {
    const payment = this.externalPayments.get(paymentId);
    if (!payment) return { ok: false, reason: `unknown external payment ${paymentId}` };
    if (payment.state === "confirmed") return { ok: true, payment };
    if (payment.state === "reversed") {
      return { ok: false, reason: "payment was already auto-reversed (unconfirmed past its deadline) — money returned to the agent" };
    }
    payment.state = "confirmed";
    payment.settledTx = transaction;
    this.emit({ type: "external_confirmed", paymentId, transaction });
    return { ok: true, payment };
  }

  /**
   * Auto-reverse pending external payments whose confirmation deadline has
   * passed. Mandate counters are deliberately NOT decremented — a reversal
   * must never hand budget back to a possibly-compromised agent. The window
   * where the seller settled but never confirmed is a bounded company loss
   * (≤ per-tx cap); closing it needs real facilitator integration.
   */
  sweepExternal(): ExternalPayment[] {
    const now = this.clock();
    const reversed: ExternalPayment[] = [];
    for (const payment of this.externalPayments.values()) {
      if (payment.state !== "pending" || now <= payment.reverseAfter) continue;
      const { transfer: reversal, replayed } = this.ledger.apply({
        from: EXTERNAL_X402,
        to: payment.agentId,
        amount: payment.amount,
        memo: `reversal: external payment ${payment.id} unconfirmed past deadline`,
        idempotencyKey: `rev_${payment.transferId}`,
      });
      payment.state = "reversed";
      payment.reversalTransferId = reversal.id;
      // If the reversal already applied (e.g. a prior torn write left the
      // ledger reversed but the state un-flipped), don't re-emit the transfer
      // — a duplicate rev_ key in the log would make the next replay refuse
      // to load. Just record the state transition. Matches the !replayed
      // guard on every other emit site.
      this.emit(
        ...(replayed ? [] : [{ type: "transfer" as const, transfer: reversal }]),
        { type: "external_reversed", paymentId: payment.id, reversalTransferId: reversal.id }
      );
      reversed.push(payment);
    }
    return reversed;
  }

  externalPayment(id: string): ExternalPayment | undefined {
    return this.externalPayments.get(id);
  }

  listExternalPayments(): ExternalPayment[] {
    return [...this.externalPayments.values()];
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
