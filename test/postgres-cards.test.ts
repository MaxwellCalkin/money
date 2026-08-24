import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresCards, type CardIssuerMaterial } from "../src/db/cards.ts";
import { PostgresControlPlane } from "../src/db/control-plane.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresExternal } from "../src/db/external.ts";
import { sweepCardsOnce } from "../src/db/external-worker.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { PostgresPolicy } from "../src/db/policy.ts";
import { PostgresTreasury } from "../src/db/treasury.ts";
import { approveComplianceFixture, clearCounterpartyFixture } from "./helpers/compliance-fixture.ts";

class EmbeddedPostgres implements TransactionalDatabase {
  constructor(readonly pg: PGliteInterface) {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryRows<T>> {
    const result = await this.pg.query<T>(text, [...values]);
    return { rows: result.rows, affectedRows: result.affectedRows };
  }

  async executeScript(text: string): Promise<void> {
    await this.pg.exec(text);
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (transaction: Transaction) => work({
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = []
      ): Promise<QueryRows<R>> => {
        const result = await transaction.query<R>(text, [...values]);
        return { rows: result.rows, affectedRows: result.affectedRows };
      },
      executeScript: async (text: string) => {
        await transaction.exec(text);
      },
    }));
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

const HINT = "mock-shop.example";
const POLICY_PAYEE = `card:hint:${HINT}`;
const PROVIDER = "mock";
const key = (name: string) => `public-key-card-${name}-${"x".repeat(32)}`;
const sha = (value: string) => createHash("sha256").update(value).digest();
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function issuer(ref: string): CardIssuerMaterial {
  return { provider: PROVIDER, providerCardRef: `ic_${ref}`, last4: "4242", expMonth: 12, expYear: 2030 };
}

function evidence(name: string) {
  return { payloadHash: sha(`payload:${name}`), canonicalPayload: { fixture: name } };
}

describe("Postgres card rail state machine", () => {
  let db: EmbeddedPostgres;
  let control: PostgresControlPlane;
  let ledger: PostgresLedger;
  let policy: PostgresPolicy;
  let treasury: PostgresTreasury;
  let cards: PostgresCards;
  let eventCounter = 0;
  const eventId = () => `evt_card_${String(++eventCounter).padStart(4, "0")}`;
  const authRef = () => `iauth_${String(++eventCounter).padStart(4, "0")}`;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    control = new PostgresControlPlane(db);
    ledger = new PostgresLedger(db);
    policy = new PostgresPolicy(db);
    treasury = new PostgresTreasury(db);
    cards = new PostgresCards(db);
    await treasury.configureControls({
      fundingEnabled: true, payoutsEnabled: true, externalSpendEnabled: true,
      maxPayoutMicros: 100_000_000_000n, maxPendingPayoutMicros: 1_000_000_000_000n,
      maxOpenExposureMicros: 100_000_000_000n, maxReconciliationVarianceMicros: 1_000_000n,
      reason: "test fixture enables treasury controls",
    });
    expect(await treasury.setCardSpendEnabled(true, "test fixture enables card spend")).toBe(true);
  }, 30_000);

  afterEach(async () => {
    await db.close();
  });

  async function world(options: {
    fundMicros?: bigint;
    budgetMicros?: bigint;
    perTxCapMicros?: bigint;
    escalateAboveMicros?: bigint;
    newPayeeCapMicros?: bigint;
    payeeAllowlist?: string[];
    clearHint?: boolean;
  } = {}) {
    const fund = options.fundMicros ?? 1_000_000n;
    const budget = options.budgetMicros ?? fund;
    const owner = await control.registerIdentity({
      id: "usr_card00001", kind: "user", name: "Owner", handle: "owner-card", publicKey: key("owner"),
    });
    const agent = await control.registerIdentity({
      actorId: owner.id, id: "agt_card00001", kind: "agent", ownerId: owner.id,
      name: "Scout", handle: "scout-card", publicKey: key("agent"),
    });
    const otherOwner = await control.registerIdentity({
      id: "usr_card00002", kind: "user", name: "Other", handle: "other-card", publicKey: key("other"),
    });
    const otherAgent = await control.registerIdentity({
      actorId: otherOwner.id, id: "agt_card00002", kind: "agent", ownerId: otherOwner.id,
      name: "Other agent", handle: "other-agent-card", publicKey: key("other-agent"),
    });
    await approveComplianceFixture(db, owner.id);
    if (options.clearHint !== false) await clearCounterpartyFixture(db, POLICY_PAYEE, "merchant");
    await ledger.postTransfer({
      actorId: owner.id, operation: "fund", idempotencyKey: "card-fund",
      from: "external:funding", to: owner.id, amountMicros: fund * 2n,
    });
    await ledger.postTransfer({
      actorId: owner.id, operation: "allocate", idempotencyKey: "card-allocate",
      from: owner.id, to: agent.id, amountMicros: fund,
    });
    const granted = await policy.grantMandate({
      userId: owner.id,
      agentId: agent.id,
      budgetMicros: budget,
      perTxCapMicros: options.perTxCapMicros ?? budget,
      dailyCapMicros: budget,
      escalateAboveMicros: options.escalateAboveMicros ?? budget,
      newPayeeCapMicros: options.newPayeeCapMicros ?? 100_000n,
      ...(options.payeeAllowlist ? { payeeAllowlist: options.payeeAllowlist } : {}),
      expiresAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: "card-mandate",
    });
    return { owner, agent, otherOwner, otherAgent, mandateId: granted.mandateId, fund };
  }

  function cardInput(agentId: string, idempotencyKey: string, input: {
    capMicros?: bigint;
    singleUse?: boolean;
    merchantHint?: string;
    mccAllowlist?: string[];
    expiresAt?: Date;
  } = {}) {
    return {
      cardId: randomUUID(),
      agentId,
      idempotencyKey,
      capMicros: input.capMicros ?? 100_000n,
      singleUse: input.singleUse ?? true,
      merchantHint: input.merchantHint ?? HINT,
      ...(input.mccAllowlist ? { mccAllowlist: input.mccAllowlist } : {}),
      expiresAt: input.expiresAt ?? new Date(Date.now() + 3_600_000),
    };
  }

  /** Prepare, then activate with mock issuer material, like the API does. */
  async function issue(agentId: string, idempotencyKey: string, input: Parameters<typeof cardInput>[2] & {
    authTtlSeconds?: number;
  } = {}) {
    const prepared = await cards.prepare(cardInput(agentId, idempotencyKey, input));
    if (prepared.status !== "prepared" || !prepared.cardId) return prepared;
    return cards.activate({
      agentId, cardId: prepared.cardId, ...issuer(idempotencyKey),
      ...(input.authTtlSeconds ? { authTtlSeconds: input.authTtlSeconds } : {}),
    });
  }

  function purchase(cardRef: string, input: {
    amountMicros: bigint;
    descriptor?: string;
    mcc?: string;
    networkId?: string;
    eventId?: string;
    authorizationRef?: string;
    authTtlSeconds?: number;
  }) {
    return cards.decideAuthorization({
      provider: PROVIDER,
      providerEventId: input.eventId ?? eventId(),
      providerAuthorizationRef: input.authorizationRef ?? authRef(),
      providerCardRef: `ic_${cardRef}`,
      amountMicros: input.amountMicros,
      merchantDescriptor: input.descriptor ?? "MOCK SHOP EXAMPLE",
      merchantMcc: input.mcc ?? "5734",
      ...(input.networkId ? { merchantNetworkId: input.networkId } : {}),
      merchantCountry: "US",
      ...(input.authTtlSeconds ? { authTtlSeconds: input.authTtlSeconds } : {}),
    });
  }

  async function cardRow(cardId: string) {
    const result = await db.query<Record<string, unknown>>("select * from money.cards where id = $1::uuid", [cardId]);
    return result.rows[0]!;
  }

  it("reserves once, replays one reservation, conflicts on changed cap, scopes reads by tenant, and releases the remainder on close", async () => {
    const { owner, agent, otherOwner, otherAgent, mandateId } = await world();
    const first = await issue(agent.id, "card-one");
    expect(first).toEqual(expect.objectContaining({
      status: "posted", replayed: false, cardState: "pending",
      cardId: expect.any(String), transferId: expect.any(String), receiptId: expect.any(String),
    }));
    expect(await ledger.balance(agent.id)).toBe(900_000n);
    expect(await ledger.balance("external:card")).toBe(100_000n);
    expect(await policy.mandate(owner.id, mandateId)).toEqual(expect.objectContaining({
      spentMicros: 100_000n, spentTodayMicros: 100_000n,
    }));

    const replay = await issue(agent.id, "card-one");
    expect(replay).toEqual(expect.objectContaining({
      status: "posted", replayed: true, cardId: first.cardId, transferId: first.transferId, receiptId: first.receiptId,
    }));
    expect(await ledger.balance(agent.id)).toBe(900_000n);
    const conflict = await cards.prepare(cardInput(agent.id, "card-one", { capMicros: 99_999n }));
    expect(conflict).toEqual(expect.objectContaining({ status: "denied", code: "idempotency_conflict", replayed: true }));

    const listed = await cards.list(agent.id);
    expect(listed[0]).toEqual(expect.objectContaining({
      id: first.cardId, policyPayee: POLICY_PAYEE, state: "pending", last4: "4242",
      capMicros: 100_000n, heldMicros: 0n, settledMicros: 0n, singleUse: true,
    }));
    expect((await cards.list(owner.id))[0]?.id).toBe(first.cardId);
    expect(await cards.list(otherOwner.id)).toEqual([]);
    expect(await cards.list(otherAgent.id)).toEqual([]);
    expect(await cards.get(otherAgent.id, first.cardId!)).toBeUndefined();
    expect(await cards.get(otherOwner.id, first.cardId!)).toBeUndefined();
    expect((await cards.get(owner.id, first.cardId!))?.id).toBe(first.cardId);
    expect((await cards.byKey(agent.id, "card-one"))?.id).toBe(first.cardId);
    expect(await cards.byKey(otherAgent.id, "card-one")).toBeUndefined();
    await expect(cards.closeCard(otherAgent.id, first.cardId!)).rejects.toMatchObject({ code: "42501" });
    await expect(cards.closeCard(otherOwner.id, first.cardId!)).rejects.toMatchObject({ code: "42501" });

    const closed = await cards.closeCard(agent.id, first.cardId!, "done shopping");
    expect(closed).toEqual(expect.objectContaining({
      cardId: first.cardId, state: "reversed", replayed: false, releaseTransferId: expect.any(String),
    }));
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);
    expect(await ledger.balance("external:card")).toBe(0n);
    expect((await policy.mandate(owner.id, mandateId))?.spentMicros).toBe(100_000n);
    expect((await cards.get(agent.id, first.cardId!))).toEqual(expect.objectContaining({
      state: "reversed", releaseTransferSeq: expect.any(BigInt), closeReason: "done shopping",
    }));
    expect((await cards.closeCard(agent.id, first.cardId!)).replayed).toBe(true);
    const release = await db.query<{ operation: string; external_payee: string; amount_micros: string | number }>(
      "select operation, external_payee, amount_micros from money.transfers where id = $1::uuid", [closed.releaseTransferId]
    );
    expect(release.rows[0]).toEqual(expect.objectContaining({ operation: "card_release", external_payee: POLICY_PAYEE }));
    expect(BigInt(release.rows[0]!.amount_micros)).toBe(100_000n);
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
  });

  it("fails closed without a cleared card:hint counterparty and reserves after the fixture clears it", async () => {
    const { agent } = await world({ clearHint: false });
    const denied = await issue(agent.id, "card-unscreened");
    expect(denied).toEqual(expect.objectContaining({
      status: "denied", code: "compliance_required", cardId: expect.any(String),
    }));
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);
    expect(await ledger.balance("external:card")).toBe(0n);
    expect(await cards.byKey(agent.id, "card-unscreened")).toEqual(expect.objectContaining({
      state: "cancelled", providerCardRef: "ic_card-unscreened", closeRequestedAt: expect.any(Date),
    }));
    expect((await cards.awaitingIssuerClose()).map((card) => card.providerCardRef)).toEqual(["ic_card-unscreened"]);
    expect(await issue(agent.id, "card-unscreened")).toEqual(expect.objectContaining({
      status: "denied", code: "compliance_required", replayed: true,
    }));

    await clearCounterpartyFixture(db, POLICY_PAYEE, "merchant");
    const reserved = await issue(agent.id, "card-screened");
    expect(reserved).toEqual(expect.objectContaining({ status: "posted", cardState: "pending" }));
    expect(await ledger.balance(agent.id)).toBe(900_000n);
    const decision = await db.query<{ outcome: string; operation: string }>(
      "select outcome, operation from money.risk_decisions where idempotency_key = $1", [reserved.cardId]
    );
    expect(decision.rows[0]).toEqual({ outcome: "allow", operation: "card_reserve" });
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
  });

  it("keeps a prepared card unreserved while card spend is disabled or the treasury breaker is tripped", async () => {
    const { agent } = await world();
    expect(await treasury.setCardSpendEnabled(false, "operator pauses card spend")).toBe(true);
    expect((await treasury.controlState()).cardSpendEnabled).toBe(false);
    await expect(issue(agent.id, "card-paused")).rejects.toMatchObject({ code: "55000" });
    await expect(issue(agent.id, "card-paused")).rejects.toThrow(/card-spend circuit breaker is open/i);
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);
    const prepared = await cards.byKey(agent.id, "card-paused");
    expect(prepared).toEqual(expect.objectContaining({ state: "prepared" }));
    expect(prepared?.providerCardRef).toBeUndefined();

    expect(await treasury.setCardSpendEnabled(true, "operator resumes card spend")).toBe(true);
    expect(await cards.activate({ agentId: agent.id, cardId: prepared!.id, ...issuer("card-paused") })).toEqual(
      expect.objectContaining({ status: "posted", cardState: "pending", replayed: false })
    );
    expect(await ledger.balance(agent.id)).toBe(900_000n);

    await treasury.tripBreaker("reconciliation incident");
    expect(await treasury.controlState()).toEqual(expect.objectContaining({
      cardSpendEnabled: false, externalSpendEnabled: false, breakerReason: "reconciliation incident",
    }));
    await expect(issue(agent.id, "card-tripped")).rejects.toMatchObject({ code: "55000" });
    expect(await purchase("card-paused", { amountMicros: 10_000n })).toEqual(expect.objectContaining({
      decision: "declined", declineCode: "treasury_breaker",
    }));
    // A tripped breaker cannot be undone for cards by a single treasury call.
    await expect(treasury.setCardSpendEnabled(true, "operator flips card spend back on"))
      .rejects.toMatchObject({ code: "55000" });
    await expect(treasury.setCardSpendEnabled(true, "operator flips card spend back on"))
      .rejects.toThrow(/treasury breaker must be restored/i);
    expect((await treasury.controlState()).cardSpendEnabled).toBe(false);
    const closed = await cards.closeCard(agent.id, prepared!.id, "contain incident");
    expect(closed.state).toBe("reversed");
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);
    const events = await db.query<{ action: string; card_spend_enabled: boolean }>(
      "select action, card_spend_enabled from money.treasury_control_events order by id desc limit 3"
    );
    expect(events.rows).toEqual([
      { action: "tripped", card_spend_enabled: false },
      { action: "card_spend_configured", card_spend_enabled: true },
      { action: "card_spend_configured", card_spend_enabled: false },
    ]);
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
  });

  it("persists exact owner approval terms, reserves only after approval, and makes rejection, expiry, and revocation durable", async () => {
    const { owner, agent, otherOwner, mandateId } = await world({ escalateAboveMicros: 10_000n });
    const requested = await cards.prepare(cardInput(agent.id, "card-approval"));
    expect(requested).toEqual(expect.objectContaining({
      status: "approval_required", replayed: false, cardState: "approval_required", approvalId: expect.any(String),
    }));
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);
    expect(await policy.approval(owner.id, requested.approvalId!)).toEqual(expect.objectContaining({
      to: "external:card", amountMicros: 100_000n, memo: `card:${HINT}`, status: "pending", agentId: agent.id,
    }));
    expect(await cards.isCardApproval(owner.id, requested.approvalId!)).toBe(true);
    expect(await cards.isCardApproval(otherOwner.id, requested.approvalId!)).toBe(false);
    expect((await cards.byApproval(owner.id, requested.approvalId!))?.state).toBe("approval_required");
    expect(await cards.byApproval(otherOwner.id, requested.approvalId!)).toBeUndefined();
    expect(await cards.prepare(cardInput(agent.id, "card-approval"))).toEqual(expect.objectContaining({
      status: "approval_required", replayed: true, approvalId: requested.approvalId,
    }));

    await expect(cards.resolveApproval(owner.id, requested.approvalId!, "approve"))
      .rejects.toThrow(/invalid issuer card material/);
    await expect(cards.resolveApproval(owner.id, requested.approvalId!, "reject", undefined, issuer("x")))
      .rejects.toThrow(/must not carry issuer card material/);
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);
    const approved = await cards.resolveApproval(owner.id, requested.approvalId!, "approve", undefined, issuer("card-approval"));
    expect(approved).toEqual(expect.objectContaining({
      status: "posted", cardId: requested.cardId, cardState: "pending", approvalId: requested.approvalId,
      transferId: expect.any(String), receiptId: expect.any(String),
    }));
    expect(await ledger.balance(agent.id)).toBe(900_000n);
    expect(await policy.approval(owner.id, requested.approvalId!)).toEqual(expect.objectContaining({
      status: "approved", receiptId: approved.receiptId,
    }));
    const authorization = await db.query<{ decision: string; approval_id: string }>(
      "select decision, approval_id from money.transfer_authorizations ta join money.transfers t on t.seq = ta.transfer_seq where t.id = $1::uuid",
      [approved.transferId]
    );
    expect(authorization.rows[0]).toEqual({ decision: "human_approved", approval_id: requested.approvalId });
    expect(await cards.resolveApproval(owner.id, requested.approvalId!, "approve")).toEqual(expect.objectContaining({
      status: "posted", replayed: true, transferId: approved.transferId,
    }));
    await expect(cards.resolveApproval(owner.id, requested.approvalId!, "approve", undefined, issuer("another")))
      .rejects.toMatchObject({ code: "55000" });
    await expect(cards.resolveApproval(otherOwner.id, requested.approvalId!, "approve", undefined, issuer("card-approval")))
      .rejects.toMatchObject({ code: "42501" });

    const rejected = await cards.prepare(cardInput(agent.id, "card-reject"));
    const rejection = await cards.resolveApproval(owner.id, rejected.approvalId!, "reject", "not this vendor");
    expect(rejection).toEqual(expect.objectContaining({ status: "denied", code: "approval_rejected", cardState: "cancelled" }));
    expect(await ledger.balance(agent.id)).toBe(900_000n);
    expect(await cards.prepare(cardInput(agent.id, "card-reject"))).toEqual(expect.objectContaining({
      status: "denied", code: "approval_rejected", replayed: true,
    }));
    expect(await cards.prepare(cardInput(agent.id, "card-reject-again"))).toEqual(expect.objectContaining({
      status: "denied", code: "approval_rejected", reason: expect.stringContaining("5 minute cooldown"),
    }));

    const expiring = await cards.prepare(cardInput(agent.id, "card-expire", { capMicros: 50_000n }));
    expect(expiring.status).toBe("approval_required");
    await db.query(
      "update money.approvals set expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid",
      [expiring.approvalId]
    );
    expect(await cards.resolveApproval(owner.id, expiring.approvalId!, "approve", undefined, issuer("card-expire"))).toEqual(
      expect.objectContaining({ status: "denied", code: "approval_expired", cardState: "cancelled", replayed: true })
    );
    expect((await policy.approval(owner.id, expiring.approvalId!))?.status).toBe("expired");
    expect(await ledger.balance(agent.id)).toBe(900_000n);

    const autonomous = await issue(agent.id, "card-autonomous", { capMicros: 5_000n });
    expect(autonomous.status).toBe("posted");
    const awaiting = await cards.prepare(cardInput(agent.id, "card-revoked", { capMicros: 20_000n }));
    expect(awaiting.status).toBe("approval_required");
    expect(await policy.revokeMandate(owner.id, mandateId)).toBe(true);
    expect((await policy.approval(owner.id, awaiting.approvalId!))?.status).toBe("failed");
    expect((await cards.get(agent.id, awaiting.cardId!))?.state).toBe("cancelled");
    expect(await cards.get(agent.id, autonomous.cardId!)).toEqual(expect.objectContaining({
      state: "pending", closeRequestedAt: expect.any(Date), closeReason: "mandate revoked",
    }));
    expect(await purchase("card-autonomous", { amountMicros: 1_000n })).toEqual(expect.objectContaining({
      decision: "declined", declineCode: "card_not_active",
    }));
    const closeEvents = await db.query<{ count: number }>(
      "select count(*)::integer as count from money.outbox_events where topic = 'card.close_requested' and aggregate_id = $1",
      [autonomous.cardId]
    );
    expect(closeEvents.rows[0]?.count).toBe(1);
    expect(await cards.get(agent.id, requested.cardId!)).toEqual(expect.objectContaining({
      state: "pending", closeRequestedAt: expect.any(Date), closeReason: "mandate revoked",
    }));
    const swept = await sweepCardsOnce(cards, 10);
    expect(swept.finalizedCards).toHaveLength(2);
    expect(swept.finalizedCards).toEqual(expect.arrayContaining([
      expect.objectContaining({ cardId: requested.cardId, state: "reversed", releaseTransferId: expect.any(String) }),
      expect.objectContaining({ cardId: autonomous.cardId, state: "reversed", releaseTransferId: expect.any(String) }),
    ]));
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);
    expect(await ledger.balance("external:card")).toBe(0n);
    expect((await policy.mandate(owner.id, mandateId))?.spentMicros).toBe(105_000n);
    expect(await cards.prepare(cardInput(agent.id, "card-after-revoke"))).toEqual(expect.objectContaining({
      status: "denied", code: "no_mandate",
    }));
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
  });

  it("runs the full decline ladder in order and lets verification authorizations through single-use", async () => {
    const { agent, mandateId } = await world({
      fundMicros: 2_000_000_000n, newPayeeCapMicros: 15_000_000n,
      payeeAllowlist: [POLICY_PAYEE, "card:hint:other.example"],
    });
    await db.query(
      "insert into money.mandate_seen_payees(mandate_id, payee_id) values ($1::uuid, $2)", [mandateId, POLICY_PAYEE]
    );
    const shopKey = (await db.query<{ payee: string }>(
      "select money_private.card_policy_payee('5734', null, 'MOCK SHOP EXAMPLE') as payee"
    )).rows[0]!.payee;
    expect(shopKey).toBe("card:5734:mock-shop-example");
    await db.query("insert into money.mandate_seen_payees(mandate_id, payee_id) values ($1::uuid, $2)", [mandateId, shopKey]);

    // card_not_active: unknown issuer card, then a card the agent has already closed.
    expect(await purchase("unknown", { amountMicros: 1_000n })).toEqual({ decision: "declined", declineCode: "card_not_active", replayed: false });
    const closed = await issue(agent.id, "ladder-closed", { capMicros: 10_000_000n });
    await cards.closeCard(agent.id, closed.cardId!);
    expect(await purchase("ladder-closed", { amountMicros: 1_000n })).toEqual(expect.objectContaining({
      decision: "declined", declineCode: "card_not_active", cardId: closed.cardId,
    }));

    // card_expired: the database clock is authoritative regardless of the webhook timestamp.
    const expiring = await issue(agent.id, "ladder-expired", { capMicros: 10_000_000n, expiresAt: new Date(Date.now() + 250) });
    await sleep(350);
    expect((await purchase("ladder-expired", { amountMicros: 1_000n })).declineCode).toBe("card_expired");

    // treasury_breaker
    const card = await issue(agent.id, "ladder", { capMicros: 500_000_000n, singleUse: false });
    expect(card.status).toBe("posted");
    await treasury.setCardSpendEnabled(false, "pause");
    expect((await purchase("ladder", { amountMicros: 1_000n })).declineCode).toBe("treasury_breaker");
    await treasury.setCardSpendEnabled(true, "resume");

    // mandate_revoked (defense in depth: revocation normally closes the card first)
    await db.query("alter table money.mandates disable trigger mandates_cancel_cards");
    await db.query("update money.mandates set revoked_at = clock_timestamp() where id = $1::uuid", [mandateId]);
    await db.query("alter table money.mandates enable trigger mandates_cancel_cards");
    expect((await purchase("ladder", { amountMicros: 1_000n })).declineCode).toBe("mandate_revoked");
    await db.query("update money.mandates set revoked_at = null where id = $1::uuid", [mandateId]);

    // mandate_expired
    await db.query("update money.mandates set expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid", [mandateId]);
    expect((await purchase("ladder", { amountMicros: 1_000n })).declineCode).toBe("mandate_expired");
    await db.query("update money.mandates set expires_at = clock_timestamp() + interval '1 day' where id = $1::uuid", [mandateId]);

    // duplicate_authorization: the same issuer authorization under a new event id.
    const first = await purchase("ladder", { amountMicros: 29_000_000n, authorizationRef: "iauth_ladder_1" });
    expect(first).toEqual(expect.objectContaining({ decision: "approved", authorizationId: expect.any(String), replayed: false }));
    expect((await purchase("ladder", { amountMicros: 29_000_000n, authorizationRef: "iauth_ladder_1" })).declineCode).toBe("duplicate_authorization");
    expect((await cards.get(agent.id, card.cardId!))).toEqual(expect.objectContaining({ heldMicros: 29_000_000n, lockedPayee: shopKey }));

    // mcc_not_allowed: the card's own category allowlist.
    const restricted = await issue(agent.id, "ladder-mcc", { capMicros: 10_000_000n, mccAllowlist: ["5734"] });
    expect(restricted.status).toBe("posted");
    expect((await purchase("ladder-mcc", { amountMicros: 1_000n, mcc: "6051", descriptor: "GIFT CARDS R US" })).declineCode).toBe("mcc_not_allowed");

    // payee_not_allowed: the mandate allowlist judged against the SQL-computed real merchant key.
    await db.query("update money.mandates set payee_allowlist = array['card:1234:*'] where id = $1::uuid", [mandateId]);
    expect((await purchase("ladder-mcc", { amountMicros: 1_000n })).declineCode).toBe("payee_not_allowed");
    await db.query("update money.mandates set payee_allowlist = $2::text[] where id = $1::uuid", [mandateId, [POLICY_PAYEE, "card:hint:other.example"]]);

    // merchant_lock: the first approval bound the multi-use card to mock-shop.
    expect((await purchase("ladder", { amountMicros: 1_000n, descriptor: "ANOTHER STORE", mcc: "5734" })).declineCode).toBe("merchant_lock");

    // single_use: a pending purchase already consumed the single-use card; verification auths pass.
    const single = await issue(agent.id, "ladder-single", { capMicros: 40_000_000n });
    expect((await purchase("ladder-single", { amountMicros: 1_000_000n })).decision).toBe("approved");
    expect((await purchase("ladder-single", { amountMicros: 29_000_000n })).decision).toBe("approved");
    expect((await purchase("ladder-single", { amountMicros: 2_000_000n })).declineCode).toBe("single_use");
    expect((await purchase("ladder-single", { amountMicros: 1_000_000n })).decision).toBe("approved");
    expect((await cards.get(agent.id, single.cardId!))?.heldMicros).toBe(31_000_000n);

    // new_payee_cap: $400 at an unseen MCC 6051 merchant on the card with room for it.
    const fresh = await issue(agent.id, "ladder-fresh", { capMicros: 500_000_000n, singleUse: false });
    expect(fresh.status).toBe("posted");
    // A card-on-file $0 verification at the unseen merchant is approved but must
    // neither mark the merchant seen nor lock the card, or it would bypass the throttle.
    const verification = await purchase("ladder-fresh", { amountMicros: 0n, mcc: "6051", descriptor: "GIFT CARDS R US" });
    expect(verification).toEqual(expect.objectContaining({ decision: "approved", replayed: false }));
    const unseenAfterVerification = await db.query<{ payee_id: string }>(
      "select payee_id from money.mandate_seen_payees where mandate_id = $1::uuid and payee_id like 'card:6051:%'", [mandateId]
    );
    expect(unseenAfterVerification.rows).toEqual([]);
    expect(await cards.get(agent.id, fresh.cardId!)).toEqual(expect.objectContaining({ heldMicros: 0n }));
    expect((await cards.get(agent.id, fresh.cardId!))?.lockedPayee).toBeUndefined();
    const gift = await purchase("ladder-fresh", { amountMicros: 400_000_000n, mcc: "6051", descriptor: "GIFT CARDS R US" });
    expect(gift).toEqual(expect.objectContaining({ decision: "declined", declineCode: "new_payee_cap" }));
    const seen = await db.query<{ payee_id: string }>(
      "select payee_id from money.mandate_seen_payees where mandate_id = $1::uuid and payee_id like 'card:6051:%'", [mandateId]
    );
    expect(seen.rows).toEqual([]);
    expect((await purchase("ladder-fresh", { amountMicros: 10_000_000n, mcc: "6051", descriptor: "GIFT CARDS R US" })).decision).toBe("approved");
    expect((await db.query<{ payee_id: string }>(
      "select payee_id from money.mandate_seen_payees where mandate_id = $1::uuid and payee_id like 'card:6051:%'", [mandateId]
    )).rows).toEqual([{ payee_id: "card:6051:gift-cards-r-us" }]);

    // card_cap: held + settled + amount must stay within the reserve.
    expect((await purchase("ladder-fresh", { amountMicros: 490_000_001n, mcc: "6051", descriptor: "GIFT CARDS R US" })).declineCode).toBe("card_cap");
    expect((await purchase("ladder-fresh", { amountMicros: 490_000_000n, mcc: "6051", descriptor: "GIFT CARDS R US" })).decision).toBe("approved");
    expect((await cards.get(agent.id, fresh.cardId!))?.heldMicros).toBe(500_000_000n);
    expect((await cards.get(agent.id, expiring.cardId!))?.state).toBe("pending");

    const authorizations = await cards.listAuthorizations(agent.id, fresh.cardId!);
    expect(authorizations.map((item) => [item.state, item.declineCode ?? null])).toEqual([
      ["pending", null], ["declined", "card_cap"], ["pending", null], ["declined", "new_payee_cap"], ["pending", null],
    ]);
    expect((await cards.get(agent.id, fresh.cardId!))?.lockedPayee).toBe("card:6051:gift-cards-r-us");
    expect(await cards.listAuthorizations("agt_card00002", fresh.cardId!)).toEqual([]);
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
  }, 20_000);

  // PGlite serialises every statement over one connection, so this proves the
  // arithmetic only. Real row-lock contention for invariant 3 is exercised by
  // the mirrored case in test/postgres-live.test.ts (npm run test:postgres-live).
  it("never exceeds the cap under concurrent authorizations and replays stored decisions", async () => {
    const { agent } = await world({ fundMicros: 1_000_000_000n, newPayeeCapMicros: 1_000_000_000n });
    const card = await issue(agent.id, "race", { capMicros: 500_000_000n, singleUse: false });
    expect(card.status).toBe("posted");
    const attempts = Array.from({ length: 20 }, (_, index) => ({
      eventId: `evt_race_${index}`, authorizationRef: `iauth_race_${index}`, amountMicros: 50_000_000n,
    }));
    const decisions = await Promise.all(attempts.map((attempt) => purchase("race", attempt)));
    const approved = decisions.filter((decision) => decision.decision === "approved");
    expect(approved).toHaveLength(10);
    expect(decisions.filter((decision) => decision.declineCode === "card_cap")).toHaveLength(10);
    const row = await cards.get(agent.id, card.cardId!);
    expect(row?.heldMicros).toBe(500_000_000n);
    expect(row!.heldMicros + row!.settledMicros).toBeLessThanOrEqual(row!.capMicros);

    const replay = await purchase("race", attempts[0]!);
    expect(replay).toEqual({ ...decisions[0], replayed: true });
    expect(await purchase("race", { ...attempts[0]!, eventId: "evt_race_retry" })).toEqual(expect.objectContaining({
      decision: "declined", declineCode: decisions[0]!.decision === "approved" ? "duplicate_authorization" : "card_cap",
    }));
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
  });

  it("clears partially, rejects over-capture, voids, expires, refunds within the cleared amount, and requires the authorization row", async () => {
    const { owner, agent, mandateId } = await world({ fundMicros: 1_000_000_000n, newPayeeCapMicros: 1_000_000_000n });
    const card = await issue(agent.id, "clear", { capMicros: 500_000_000n, singleUse: false });
    expect(card.status).toBe("posted");
    const spent = (await policy.mandate(owner.id, mandateId))!.spentMicros;

    const partial = await purchase("clear", { amountMicros: 50_000_000n, authorizationRef: "iauth_partial" });
    expect(partial.decision).toBe("approved");
    expect((await purchase("clear", { amountMicros: 50_000_000n, authorizationRef: "iauth_partial" })).declineCode).toBe("duplicate_authorization");
    expect(await cards.authorizationByRef(PROVIDER, "iauth_partial")).toEqual(expect.objectContaining({
      authorizationId: partial.authorizationId, cardId: card.cardId, state: "pending", amountMicros: 50_000_000n, isVerification: false,
    }));
    const settled = await cards.settleAuthorization({
      provider: PROVIDER, providerEventId: "evt_capture_partial", providerAuthorizationRef: "iauth_partial",
      settledMicros: 30_000_000n, occurredAt: new Date(), ...evidence("capture-partial"),
    });
    expect(settled).toEqual(expect.objectContaining({
      status: "confirmed", replayed: false, cardState: "pending", heldMicros: 0n, settledMicros: 30_000_000n,
    }));
    expect(await cards.settleAuthorization({
      provider: PROVIDER, providerEventId: "evt_capture_partial", providerAuthorizationRef: "iauth_partial",
      settledMicros: 30_000_000n, occurredAt: new Date(), ...evidence("capture-partial"),
    })).toEqual(expect.objectContaining({ status: "confirmed", replayed: true }));
    await expect(cards.settleAuthorization({
      provider: PROVIDER, providerEventId: "evt_capture_partial_changed", providerAuthorizationRef: "iauth_partial",
      settledMicros: 31_000_000n, occurredAt: new Date(), ...evidence("capture-partial-changed"),
    })).rejects.toMatchObject({ code: "22023" });
    // A second clearing under a new issuer event id is never a safe duplicate,
    // even at the same amount: it is unapplied evidence and must surface.
    await expect(cards.settleAuthorization({
      provider: PROVIDER, providerEventId: "evt_capture_partial_second", providerAuthorizationRef: "iauth_partial",
      settledMicros: 30_000_000n, occurredAt: new Date(), ...evidence("capture-partial-second"),
    })).rejects.toThrow(/different provider event/);
    expect((await cards.get(agent.id, card.cardId!))?.settledMicros).toBe(30_000_000n);

    const over = await purchase("clear", { amountMicros: 50_000_000n, authorizationRef: "iauth_over" });
    expect(over.decision).toBe("approved");
    await expect(cards.settleAuthorization({
      provider: PROVIDER, providerEventId: "evt_capture_over", providerAuthorizationRef: "iauth_over",
      settledMicros: 50_000_001n, occurredAt: new Date(), ...evidence("capture-over"),
    })).rejects.toMatchObject({ code: "22023" });
    expect(await cards.settleAuthorization({
      provider: PROVIDER, providerEventId: "evt_capture_over_ok", providerAuthorizationRef: "iauth_over",
      settledMicros: 50_500_000n, occurredAt: new Date(), overcaptureBps: 100, ...evidence("capture-over-ok"),
    })).toEqual(expect.objectContaining({ status: "confirmed", settledMicros: 80_500_000n, heldMicros: 0n }));

    const voided = await purchase("clear", { amountMicros: 20_000_000n, authorizationRef: "iauth_void" });
    expect(voided.decision).toBe("approved");
    expect((await cards.get(agent.id, card.cardId!))?.heldMicros).toBe(20_000_000n);
    expect(await cards.voidAuthorization({
      provider: PROVIDER, providerEventId: "evt_void", providerAuthorizationRef: "iauth_void",
      occurredAt: new Date(), ...evidence("void"),
    })).toEqual(expect.objectContaining({ status: "reversed", replayed: false, heldMicros: 0n }));
    expect(await cards.voidAuthorization({
      provider: PROVIDER, providerEventId: "evt_void", providerAuthorizationRef: "iauth_void",
      occurredAt: new Date(), ...evidence("void"),
    })).toEqual(expect.objectContaining({ status: "reversed", replayed: true }));
    await expect(cards.settleAuthorization({
      provider: PROVIDER, providerEventId: "evt_capture_voided", providerAuthorizationRef: "iauth_void",
      settledMicros: 1n, occurredAt: new Date(), ...evidence("capture-voided"),
    })).rejects.toMatchObject({ code: "55000" });
    await expect(cards.voidAuthorization({
      provider: PROVIDER, providerEventId: "evt_void_settled", providerAuthorizationRef: "iauth_partial",
      occurredAt: new Date(), ...evidence("void-settled"),
    })).rejects.toMatchObject({ code: "55000" });

    const shortLived = await purchase("clear", { amountMicros: 5_000_000n, authorizationRef: "iauth_short", authTtlSeconds: 1 });
    const longLived = await purchase("clear", { amountMicros: 7_000_000n, authorizationRef: "iauth_long" });
    expect([shortLived.decision, longLived.decision]).toEqual(["approved", "approved"]);
    expect(await cards.sweepAuthorizations(10)).toEqual([]);
    await sleep(1_200);
    const [firstSweep, secondSweep] = await Promise.all([cards.sweepAuthorizations(10), cards.sweepAuthorizations(10)]);
    expect([...firstSweep, ...secondSweep]).toEqual([{ authorizationId: shortLived.authorizationId, cardId: card.cardId }]);
    expect((await cards.get(agent.id, card.cardId!))?.heldMicros).toBe(7_000_000n);
    const expired = (await cards.listAuthorizations(agent.id, card.cardId!)).find((item) => item.id === shortLived.authorizationId);
    expect(expired?.state).toBe("reversed");

    await expect(cards.refundAuthorization({
      provider: PROVIDER, providerEventId: "evt_refund_over", providerRefundRef: "ipi_refund_over",
      providerAuthorizationRef: "iauth_partial", amountMicros: 30_000_001n, occurredAt: new Date(), ...evidence("refund-over"),
    })).rejects.toMatchObject({ code: "22023" });
    const balanceBefore = await ledger.balance(agent.id);
    const refund = await cards.refundAuthorization({
      provider: PROVIDER, providerEventId: "evt_refund", providerRefundRef: "ipi_refund_1",
      providerAuthorizationRef: "iauth_partial", amountMicros: 10_000_000n, occurredAt: new Date(), ...evidence("refund"),
    });
    expect(refund).toEqual(expect.objectContaining({
      status: "refunded", replayed: false, transferId: expect.any(String), receiptId: expect.any(String),
      agentBalanceMicros: balanceBefore + 10_000_000n,
    }));
    expect(await ledger.balance(agent.id)).toBe(balanceBefore + 10_000_000n);
    expect((await policy.mandate(owner.id, mandateId))!.spentMicros).toBe(spent);
    expect((await cards.get(agent.id, card.cardId!))?.settledMicros).toBe(80_500_000n);
    expect(await cards.refundAuthorization({
      provider: PROVIDER, providerEventId: "evt_refund_replay", providerRefundRef: "ipi_refund_1",
      providerAuthorizationRef: "iauth_partial", amountMicros: 10_000_000n, occurredAt: new Date(), ...evidence("refund-replay"),
    })).toEqual(expect.objectContaining({ status: "refunded", replayed: true, transferId: refund.transferId }));
    await expect(cards.refundAuthorization({
      provider: PROVIDER, providerEventId: "evt_refund_remaining_over", providerRefundRef: "ipi_refund_2",
      providerAuthorizationRef: "iauth_partial", amountMicros: 20_000_001n, occurredAt: new Date(), ...evidence("refund-remaining"),
    })).rejects.toMatchObject({ code: "22023" });
    await expect(cards.refundAuthorization({
      provider: PROVIDER, providerEventId: "evt_refund_pending", providerRefundRef: "ipi_refund_3",
      providerAuthorizationRef: "iauth_long", amountMicros: 1n, occurredAt: new Date(), ...evidence("refund-pending"),
    })).rejects.toMatchObject({ code: "55000" });
    await expect(db.query("delete from money.card_refunds")).rejects.toThrow(/append-only/);
    await expect(db.query("update money.card_refunds set amount_micros = 1")).rejects.toThrow(/append-only/);

    await expect(cards.settleAuthorization({
      provider: PROVIDER, providerEventId: "evt_capture_orphan", providerAuthorizationRef: "iauth_never_decided",
      settledMicros: 1n, occurredAt: new Date(), ...evidence("capture-orphan"),
    })).rejects.toMatchObject({ code: "P0002" });

    const closed = await cards.closeCard(owner.id, card.cardId!, "owner closes the card");
    expect(closed).toEqual(expect.objectContaining({ state: "pending", replayed: false, closeRequestedAt: expect.any(Date) }));
    expect((await purchase("clear", { amountMicros: 1n })).declineCode).toBe("card_not_active");
    expect(await cards.sweepCards(10)).toEqual([]);
    expect(await cards.settleAuthorization({
      provider: PROVIDER, providerEventId: "evt_capture_long", providerAuthorizationRef: "iauth_long",
      settledMicros: 7_000_000n, occurredAt: new Date(), ...evidence("capture-long"),
    })).toEqual(expect.objectContaining({ status: "confirmed", cardState: "confirmed", heldMicros: 0n, settledMicros: 87_500_000n }));
    expect(await ledger.balance(agent.id)).toBe(1_000_000_000n - 87_500_000n + 10_000_000n);
    expect(await ledger.balance("external:card")).toBe(87_500_000n - 10_000_000n);
    expect((await policy.mandate(owner.id, mandateId))!.spentMicros).toBe(spent);
    expect((await cards.awaitingIssuerClose()).map((item) => item.cardId)).toEqual([card.cardId]);
    expect(await cards.markIssuerClosed(card.cardId!, "ic_clear")).toBe(true);
    expect(await cards.markIssuerClosed(card.cardId!, "ic_clear")).toBe(false);
    await expect(cards.markIssuerClosed(card.cardId!, "ic_other")).rejects.toMatchObject({ code: "22023" });
    expect(await cards.awaitingIssuerClose()).toEqual([]);
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
  });

  it("finalizes a single-use card on clearing and expires idle cards through the sweep", async () => {
    const { agent } = await world({ fundMicros: 1_000_000_000n, newPayeeCapMicros: 1_000_000_000n });
    const single = await issue(agent.id, "single", { capMicros: 50_000_000n });
    const auth = await purchase("single", { amountMicros: 29_000_000n, authorizationRef: "iauth_single" });
    expect(auth.decision).toBe("approved");
    expect(await cards.settleAuthorization({
      provider: PROVIDER, providerEventId: "evt_single_capture", providerAuthorizationRef: "iauth_single",
      settledMicros: 29_000_000n, occurredAt: new Date(), ...evidence("single-capture"),
    })).toEqual(expect.objectContaining({ status: "confirmed", cardState: "confirmed", settledMicros: 29_000_000n }));
    expect(await cards.get(agent.id, single.cardId!)).toEqual(expect.objectContaining({
      state: "confirmed", heldMicros: 0n, settledMicros: 29_000_000n, releaseTransferSeq: expect.any(BigInt),
      closeReason: "single-use card cleared",
    }));
    expect(await ledger.balance(agent.id)).toBe(1_000_000_000n - 29_000_000n);
    expect(await ledger.balance("external:card")).toBe(29_000_000n);

    const idle = await issue(agent.id, "idle", { capMicros: 10_000_000n, expiresAt: new Date(Date.now() + 200), authTtlSeconds: 1 });
    expect(idle.status).toBe("posted");
    expect(await cards.sweepCards(10)).toEqual([]);
    await sleep(1_400);
    const swept = await sweepCardsOnce(cards, 10);
    expect(swept.finalizedCards).toEqual([expect.objectContaining({ cardId: idle.cardId, state: "reversed", releaseTransferId: expect.any(String) })]);
    expect(await ledger.balance(agent.id)).toBe(1_000_000_000n - 29_000_000n);
    expect(await sweepCardsOnce(cards, 10)).toEqual({ expiredAuthorizations: [], finalizedCards: [] });
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
  });

  it("replays activation for the same issuer card after a restart and refuses a different issuer card", async () => {
    const { agent } = await world();
    const prepared = await cards.prepare(cardInput(agent.id, "restart"));
    expect(prepared.status).toBe("prepared");
    const activated = await cards.activate({ agentId: agent.id, cardId: prepared.cardId!, ...issuer("restart") });
    expect(activated).toEqual(expect.objectContaining({ status: "posted", replayed: false, cardState: "pending" }));
    expect(await cards.activate({ agentId: agent.id, cardId: prepared.cardId!, ...issuer("restart") })).toEqual(
      expect.objectContaining({ status: "posted", replayed: true, transferId: activated.transferId })
    );
    await expect(cards.activate({ agentId: agent.id, cardId: prepared.cardId!, ...issuer("restart-other") }))
      .rejects.toMatchObject({ code: "55000" });
    await expect(cards.activate({ agentId: "agt_card00002", cardId: prepared.cardId!, ...issuer("restart") }))
      .rejects.toMatchObject({ code: "P0002" });
    expect(await ledger.balance(agent.id)).toBe(900_000n);
    expect(await cards.prepare(cardInput(agent.id, "restart"))).toEqual(expect.objectContaining({
      status: "posted", replayed: true, cardId: prepared.cardId,
    }));
  });

  it("issues bounded single-use reveal tokens bound to the card's agent", async () => {
    const { agent } = await world();
    const card = await issue(agent.id, "reveal");
    const token = await cards.issueRevealToken({ agentId: agent.id, cardId: card.cardId!, tokenHash: sha("t1"), ttlSeconds: 60 });
    expect(token).toEqual({ cardId: card.cardId, expiresAt: expect.any(Date), revealCount: 1 });
    await expect(cards.issueRevealToken({ agentId: "agt_card00002", cardId: card.cardId!, tokenHash: sha("t-x"), ttlSeconds: 60 }))
      .rejects.toMatchObject({ code: "42501" });
    await expect(cards.issueRevealToken({ agentId: agent.id, cardId: card.cardId!, tokenHash: sha("t-long"), ttlSeconds: 601 }))
      .rejects.toMatchObject({ code: "22023" });
    await expect(cards.consumeRevealToken(sha("t1"), "agt_card00002", card.cardId!)).rejects.toMatchObject({ code: "42501" });
    await expect(cards.consumeRevealToken(sha("t1"), "", card.cardId!)).rejects.toMatchObject({ code: "22023" });
    await expect(db.query("select * from money_private.consume_card_reveal_token($1::bytea, null, $2::uuid)",
      [Buffer.from(sha("t1")), card.cardId]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(db.query("select * from money_private.consume_card_reveal_token($1::bytea, $2, null)",
      [Buffer.from(sha("t1")), agent.id]))
      .rejects.toMatchObject({ code: "22023" });
    // A mismatched card id refuses BEFORE consuming: the token survives for the
    // real card, so a mistaken consume never burns one of the bounded reveals.
    await expect(cards.consumeRevealToken(sha("t1"), agent.id, "00000000-0000-4000-8000-000000000000"))
      .rejects.toMatchObject({ code: "55000" });
    expect(await cards.consumeRevealToken(sha("t1"), agent.id, card.cardId!)).toEqual({
      cardId: card.cardId, agentId: agent.id, provider: PROVIDER, providerCardRef: "ic_reveal",
    });
    await expect(cards.consumeRevealToken(sha("t1"), agent.id, card.cardId!)).rejects.toMatchObject({ code: "55000" });
    await expect(cards.consumeRevealToken(sha("missing"), agent.id, card.cardId!)).rejects.toMatchObject({ code: "P0002" });
    await cards.issueRevealToken({ agentId: agent.id, cardId: card.cardId!, tokenHash: sha("t2"), ttlSeconds: 1 });
    await cards.issueRevealToken({ agentId: agent.id, cardId: card.cardId!, tokenHash: sha("t3"), ttlSeconds: 60 });
    await expect(cards.issueRevealToken({ agentId: agent.id, cardId: card.cardId!, tokenHash: sha("t4"), ttlSeconds: 60 }))
      .rejects.toMatchObject({ code: "55000" });
    await sleep(1_100);
    await expect(cards.consumeRevealToken(sha("t2"), agent.id, card.cardId!)).rejects.toThrow(/expired/);
    await cards.closeCard(agent.id, card.cardId!);
    await expect(cards.consumeRevealToken(sha("t3"), agent.id, card.cardId!)).rejects.toThrow(/not active/);
    const revealed = await db.query<{ count: number }>(
      "select count(*)::integer as count from money.outbox_events where topic = 'card.revealed' and aggregate_id = $1", [card.cardId]
    );
    expect(revealed.rows[0]?.count).toBe(1);
  });

  it("keeps the product, ingress, and worker roles apart and rejects raw kernel use and tampering", async () => {
    const { owner, agent } = await world();
    const card = await issue(agent.id, "roles");
    expect(card.status).toBe("posted");
    await cards.issueRevealToken({ agentId: agent.id, cardId: card.cardId!, tokenHash: sha("roles-token"), ttlSeconds: 60 });
    await db.executeScript(readFileSync(resolve("db/roles.sql"), "utf8"));
    const reserve = (cardId: string, from: string, to: string) => db.query(
      `select * from money_private.post_card_transfer($1, 'card_reserve', $2, $1, $3, 'USD', 1000, 'card:x', $4::jsonb)`,
      [from, `raw-${cardId}-${to}`, to, JSON.stringify({ cardId, mandateId: "m", clientIdempotencyKey: "k", externalPayee: POLICY_PAYEE })]
    );
    await expect(reserve(card.cardId!, owner.id, "external:card")).rejects.toMatchObject({ code: "42501" });
    await expect(reserve(card.cardId!, agent.id, "external:x402")).rejects.toMatchObject({ code: "42501" });
    await expect(db.query(
      `select * from money_private.post_card_transfer('external:card', 'card_release', 'raw-release', 'external:card', $1, 'USD', 1000, 'x', $2::jsonb)`,
      [agent.id, JSON.stringify({ cardId: card.cardId, originalTransferSeq: "1", externalPayee: "card:hint:other.example" })]
    )).rejects.toMatchObject({ code: "22023" });
    await expect(ledger.postTransfer({
      actorId: agent.id, operation: "pay", idempotencyKey: "raw-pay-card", from: agent.id, to: "external:card", amountMicros: 1_000n,
    })).rejects.toMatchObject({ code: "42501" });

    const asRole = async (role: string, work: () => Promise<unknown>) => {
      await db.query(`set role ${role}`);
      try { return await work(); } finally { await db.query("reset role"); }
    };
    const permissionDenied = { code: "42501" };
    await expect(asRole("money_app", () => reserve(card.cardId!, agent.id, "external:card"))).rejects.toMatchObject(permissionDenied);
    await expect(asRole("money_app", () => purchase("roles", { amountMicros: 1n }))).rejects.toMatchObject(permissionDenied);
    await expect(asRole("money_app", () => cards.settleAuthorization({
      provider: PROVIDER, providerEventId: "evt_app", providerAuthorizationRef: "iauth_app",
      settledMicros: 1n, occurredAt: new Date(), ...evidence("app"),
    }))).rejects.toMatchObject(permissionDenied);
    await expect(asRole("money_app", () => cards.sweepCards(1))).rejects.toMatchObject(permissionDenied);
    expect(await asRole("money_app", () => cards.list(agent.id))).toHaveLength(1);
    expect(await asRole("money_app", () => cards.closeCard(agent.id, card.cardId!, "app closes"))).toEqual(
      expect.objectContaining({ state: "reversed" })
    );

    expect(await asRole("money_card_ingress", () => purchase("roles", { amountMicros: 1n }))).toEqual(
      expect.objectContaining({ decision: "declined", declineCode: "card_not_active" })
    );
    expect(await asRole("money_card_ingress", () => cards.enqueueEvent({
      provider: PROVIDER, providerEventId: "evt_ingress", endpointId: "we_1", deliveryHash: sha("delivery"),
    }))).toEqual(expect.objectContaining({ replayed: false, state: "queued" }));
    await expect(asRole("money_card_ingress", () => cards.settleAuthorization({
      provider: PROVIDER, providerEventId: "evt_ingress_settle", providerAuthorizationRef: "iauth_x",
      settledMicros: 1n, occurredAt: new Date(), ...evidence("ingress"),
    }))).rejects.toMatchObject(permissionDenied);
    await expect(asRole("money_card_ingress", () => cards.prepare(cardInput(agent.id, "ingress-card")))).rejects.toMatchObject(permissionDenied);
    await expect(asRole("money_card_ingress", () => cards.list(agent.id))).rejects.toMatchObject(permissionDenied);
    await expect(asRole("money_card_ingress", () => cards.claimEvents("w", 1))).rejects.toMatchObject(permissionDenied);
    await expect(asRole("money_card_ingress", () => db.query("select * from money.cards"))).rejects.toMatchObject(permissionDenied);

    await expect(asRole("money_card_worker", () => purchase("roles", { amountMicros: 1n }))).rejects.toMatchObject(permissionDenied);
    await expect(asRole("money_card_worker", () => cards.prepare(cardInput(agent.id, "worker-card")))).rejects.toMatchObject(permissionDenied);
    await expect(asRole("money_card_worker", () => cards.enqueueEvent({
      provider: PROVIDER, providerEventId: "evt_worker", endpointId: "we_1", deliveryHash: sha("delivery"),
    }))).rejects.toMatchObject(permissionDenied);
    await expect(asRole("money_card_worker", () => cards.settleAuthorization({
      provider: PROVIDER, providerEventId: "evt_worker_settle", providerAuthorizationRef: "iauth_missing",
      settledMicros: 1n, occurredAt: new Date(), ...evidence("worker"),
    }))).rejects.toMatchObject({ code: "P0002" });
    const claimed = await asRole("money_card_worker", () => cards.claimEvents("worker-1", 5)) as Array<{ providerEventId: string; inboxId: bigint }>;
    expect(claimed.map((item) => item.providerEventId)).toEqual(["evt_ingress"]);
    await asRole("money_card_worker", () => cards.failEvent("worker-1", claimed[0]!.inboxId, "issuer unreachable", 0));
    await expect(asRole("money_card_worker", () => cards.completeEvent("worker-2", claimed[0]!.inboxId, "completed")))
      .rejects.toMatchObject(permissionDenied);
    const reclaimed = await asRole("money_card_worker", () => cards.claimEvents("worker-2", 5)) as Array<{ attempts: number; inboxId: bigint }>;
    expect(reclaimed[0]?.attempts).toBe(2);
    await asRole("money_card_worker", () => cards.failEvent("worker-2", reclaimed[0]!.inboxId, "poison event", 0, true));
    expect(await treasury.controlState()).toEqual(expect.objectContaining({
      cardSpendEnabled: false, breakerReason: expect.stringContaining("card event dead-lettered"),
    }));
    const deadInboxId = reclaimed[0]!.inboxId;
    await expect(treasury.setCardSpendEnabled(true, "operator flips card spend back on"))
      .rejects.toMatchObject({ code: "55000" });
    await expect(asRole("money_card_worker", () => treasury.resolveCardEventReview({
      inboxId: deadInboxId, resolution: "ignore", reviewReference: "REV-1", reason: "worker may not review",
    }))).rejects.toMatchObject(permissionDenied);
    await expect(treasury.resolveCardEventReview({
      inboxId: deadInboxId, resolution: "drop" as "ignore", reviewReference: "REV-1", reason: "bad resolution",
    })).rejects.toMatchObject({ code: "22023" });
    await expect(treasury.resolveCardEventReview({
      inboxId: 999_999n, resolution: "ignore", reviewReference: "REV-1", reason: "missing row",
    })).rejects.toMatchObject({ code: "P0002" });
    expect(await asRole("money_treasury", () => treasury.resolveCardEventReview({
      inboxId: deadInboxId, resolution: "retry", reviewReference: "REV-1", reason: "issuer outage resolved",
    }))).toBe("queued");
    await expect(treasury.resolveCardEventReview({
      inboxId: deadInboxId, resolution: "ignore", reviewReference: "REV-2", reason: "not dead anymore",
    })).rejects.toMatchObject({ code: "55000" });
    const retried = await asRole("money_card_worker", () => cards.claimEvents("worker-3", 5)) as Array<{ attempts: number; inboxId: bigint }>;
    expect(retried).toEqual([expect.objectContaining({ inboxId: deadInboxId, attempts: 1 })]);
    await asRole("money_card_worker", () => cards.failEvent("worker-3", deadInboxId, "still poison", 0, true));
    await expect(treasury.setCardSpendEnabled(true, "still blocked")).rejects.toMatchObject({ code: "55000" });
    expect(await asRole("money_treasury", () => treasury.resolveCardEventReview({
      inboxId: deadInboxId, resolution: "ignore", reviewReference: "REV-2", reason: "manually reconciled with issuer",
    }))).toBe("ignored");
    // The dead letter is resolved but the breaker it tripped is still open:
    // card spend only resumes after restore_treasury_controls' review gates pass.
    await expect(treasury.setCardSpendEnabled(true, "breaker still tripped")).rejects.toThrow(/treasury breaker must be restored/i);
    await treasury.registerAssetAccount({ provider: "column", providerAccountRef: "bacc_cards", asset: "USD", kind: "bank" });
    const [health] = await treasury.health();
    await treasury.recordAssetSnapshot({
      provider: "column", providerAccountRef: "bacc_cards", asset: "USD",
      bookMicros: health!.expectedAssetMicros, availableMicros: health!.expectedAssetMicros,
      providerObservationId: "observation-cards-clean", observedAt: new Date(),
    });
    expect(await treasury.restoreControls("INC-CARD-001 dead letter reviewed and reconciled")).not.toHaveProperty("breakerReason");
    expect(await treasury.controlState()).toEqual(expect.objectContaining({ cardSpendEnabled: false, externalSpendEnabled: true }));
    expect(await treasury.setCardSpendEnabled(true, "operator resumes card spend after review")).toBe(true);
    // Migration 0012 leaves treasury_control_state() and its grants intact. A
    // login that db/roles.sql has not re-granted yet keeps the external-spend
    // gate and reads the card flag as disabled (fail closed) until it is.
    expect(await asRole("money_app", () => treasury.controlState())).toEqual(expect.objectContaining({
      cardSpendEnabled: true, externalSpendEnabled: true,
    }));
    await db.query("revoke execute on function money_private.card_spend_control_state() from money_app");
    expect(await asRole("money_app", () => treasury.controlState())).toEqual(expect.objectContaining({
      cardSpendEnabled: false, externalSpendEnabled: true,
    }));
    await db.executeScript(readFileSync(resolve("db/roles.sql"), "utf8"));
    expect((await asRole("money_app", () => treasury.controlState()) as { cardSpendEnabled?: boolean }).cardSpendEnabled).toBe(true);
    expect(await treasury.setCardSpendEnabled(false, "operator pauses card spend for the rest of the test")).toBe(true);
    const reviews = await db.query<{ resolution: string; prior_error: string; review_reference: string }>(
      "select resolution, prior_error, review_reference from money.card_event_reviews where inbox_id = $1::bigint order by created_at",
      [deadInboxId.toString()]
    );
    expect(reviews.rows).toEqual([
      { resolution: "retry", prior_error: "poison event", review_reference: "REV-1" },
      { resolution: "ignore", prior_error: "still poison", review_reference: "REV-2" },
    ]);
    await expect(db.query("delete from money.card_event_reviews")).rejects.toThrow(/append-only/);
    await expect(db.query("update money.card_event_reviews set reason = 'edited'")).rejects.toThrow(/append-only/);
    expect(await asRole("money_card_worker", () => cards.awaitingIssuerClose())).toEqual([
      expect.objectContaining({ cardId: card.cardId, providerCardRef: "ic_roles", state: "reversed" }),
    ]);
    expect(await asRole("money_card_worker", () => cards.byProviderRef(PROVIDER, "ic_roles"))).toEqual(expect.objectContaining({
      cardId: card.cardId, agentId: agent.id, state: "reversed", heldMicros: 0n, capMicros: 100_000n,
    }));
    expect(await asRole("money_card_worker", () => cards.byProviderRef(PROVIDER, "ic_unknown"))).toBeUndefined();
    expect(await asRole("money_card_worker", () => cards.authorizationByRef(PROVIDER, "iauth_nothing"))).toBeUndefined();
    await expect(asRole("money_card_ingress", () => cards.byProviderRef(PROVIDER, "ic_roles"))).rejects.toMatchObject(permissionDenied);
    await expect(asRole("money_app", () => cards.authorizationByRef(PROVIDER, "iauth_nothing"))).rejects.toMatchObject(permissionDenied);

    await expect(db.query("update money.cards set cap_micros = cap_micros + 1 where id = $1::uuid", [card.cardId]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(db.query("update money.cards set state = 'pending' where id = $1::uuid", [card.cardId]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(db.query("update money.cards set provider_card_ref = 'ic_replaced' where id = $1::uuid", [card.cardId]))
      .rejects.toMatchObject({ code: "55000" });
    expect(await cards.recordEvent({
      provider: PROVIDER, providerEventId: "evt_evidence", eventType: "card.clearing", providerObjectId: "iauth_evidence",
      ...evidence("evidence"),
    })).toBe(false);
    await expect(db.query("delete from money.cards where id = $1::uuid", [card.cardId])).rejects.toThrow(/append-only/);
    await expect(db.query("delete from money.card_event_inbox")).rejects.toThrow(/append-only/);
    await expect(db.query("delete from money.card_reveal_tokens")).rejects.toThrow(/append-only/);
    await expect(db.query("delete from money.card_provider_events")).rejects.toThrow(/append-only/);
    await expect(db.query("delete from money.card_authorizations")).rejects.toThrow(/append-only/);
    await expect(db.query("update money.card_authorizations set amount_micros = amount_micros + 1")).rejects.toMatchObject({ code: "55000" });
    const sibling = await control.registerIdentity({
      actorId: owner.id, id: "agt_card00003", kind: "agent", ownerId: owner.id,
      name: "Sibling", handle: "sibling-card", publicKey: key("sibling"),
    });
    await expect(db.query("select * from money_private.post_transfer_kernel($1, 'pay', 'ext-on-pay', $1, $2, 'USD', 1, '', $3::jsonb, null)",
      [agent.id, sibling.id, JSON.stringify({ externalPayee: POLICY_PAYEE })])).rejects.toMatchObject({ code: "22023" });
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
  });

  it("reports ledger health true after the card lifecycle and false after reserve accounting is corrupted", async () => {
    const { agent } = await world({ fundMicros: 1_000_000_000n, newPayeeCapMicros: 1_000_000_000n });
    const card = await issue(agent.id, "health", { capMicros: 100_000_000n, singleUse: false });
    const auth = await purchase("health", { amountMicros: 40_000_000n, authorizationRef: "iauth_health" });
    expect(auth.decision).toBe("approved");
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });

    await db.query("update money.cards set held_micros = held_micros + 1 where id = $1::uuid", [card.cardId]);
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: false });
    await db.query("update money.cards set held_micros = held_micros - 1 where id = $1::uuid", [card.cardId]);
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });

    await cards.settleAuthorization({
      provider: PROVIDER, providerEventId: "evt_health_capture", providerAuthorizationRef: "iauth_health",
      settledMicros: 40_000_000n, occurredAt: new Date(), ...evidence("health"),
    });
    await db.query("update money.cards set settled_micros = settled_micros - 1, held_micros = held_micros + 1 where id = $1::uuid", [card.cardId]);
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: false });
    await db.query("update money.cards set settled_micros = settled_micros + 1, held_micros = held_micros - 1 where id = $1::uuid", [card.cardId]);
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });

    const closed = await cards.closeCard(agent.id, card.cardId!);
    expect(closed.state).toBe("confirmed");
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
    await expect(db.query("update money.cards set release_transfer_seq = null where id = $1::uuid", [card.cardId]))
      .rejects.toMatchObject({ code: "55000" });
    await db.query("alter table money.cards disable trigger cards_protect_transition");
    await expect(db.query("update money.cards set release_transfer_seq = null where id = $1::uuid", [card.cardId]))
      .rejects.toMatchObject({ code: "23514" });
    await db.query("update money.cards set release_transfer_seq = transfer_seq where id = $1::uuid", [card.cardId]);
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: false });
    await db.query("update money.cards set release_transfer_seq = $2::bigint where id = $1::uuid", [card.cardId, (await db.query<{ seq: string }>(
      "select seq from money.transfers where id = $1::uuid", [closed.releaseTransferId]
    )).rows[0]!.seq]);
    await db.query("alter table money.cards enable trigger cards_protect_transition");
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
  });

  it("cancels unreserved requests on close, keeps issuer material on failed rechecks, and completes claimed events", async () => {
    const { owner, agent, otherOwner, mandateId } = await world({ escalateAboveMicros: 10_000n });
    const prepared = await cards.prepare(cardInput(agent.id, "close-prepared", { capMicros: 5_000n }));
    expect(prepared.status).toBe("prepared");
    expect(await cards.closeCard(owner.id, prepared.cardId!, "changed my mind")).toEqual(expect.objectContaining({
      cardId: prepared.cardId, state: "cancelled", replayed: false,
    }));
    expect(await cards.prepare(cardInput(agent.id, "close-prepared", { capMicros: 5_000n }))).toEqual(expect.objectContaining({
      status: "denied", code: "permit_invalid", replayed: true, cardState: "cancelled", reason: "changed my mind",
    }));
    expect(await cards.awaitingIssuerClose()).toEqual([]);
    // The API created the issuer card before the close landed: the material
    // binds to the cancelled row so the issuer-close drain retires it.
    await expect(cards.activate({ agentId: agent.id, cardId: prepared.cardId!, ...issuer("close-prepared") })).resolves.toEqual(
      expect.objectContaining({ status: "denied", code: "permit_invalid", replayed: true })
    );
    expect(await cards.get(agent.id, prepared.cardId!)).toEqual(expect.objectContaining({
      state: "cancelled", providerCardRef: "ic_close-prepared", last4: "4242", closeReason: "changed my mind",
    }));
    expect(await cards.awaitingIssuerClose()).toEqual([
      expect.objectContaining({ cardId: prepared.cardId, providerCardRef: "ic_close-prepared", state: "cancelled" }),
    ]);
    await expect(cards.activate({ agentId: agent.id, cardId: prepared.cardId!, ...issuer("close-prepared-other") }))
      .rejects.toMatchObject({ code: "55000" });
    expect(await cards.activate({ agentId: agent.id, cardId: prepared.cardId!, ...issuer("close-prepared") })).toEqual(
      expect.objectContaining({ status: "denied", code: "permit_invalid", replayed: true })
    );
    expect(await cards.markIssuerClosed(prepared.cardId!, "ic_close-prepared")).toBe(true);
    expect(await cards.awaitingIssuerClose()).toEqual([]);
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);

    const awaiting = await cards.prepare(cardInput(agent.id, "close-awaiting"));
    expect(awaiting.status).toBe("approval_required");
    expect(await cards.closeCard(agent.id, awaiting.cardId!)).toEqual(expect.objectContaining({ state: "cancelled", replayed: false }));
    expect(await policy.approval(owner.id, awaiting.approvalId!)).toEqual(expect.objectContaining({
      status: "failed", reason: `closed by ${agent.id}`,
    }));
    expect(await cards.resolveApproval(owner.id, awaiting.approvalId!, "approve", undefined, issuer("close-awaiting"))).toEqual(
      expect.objectContaining({ status: "denied", code: "approval_failed", cardState: "cancelled", replayed: true })
    );
    expect(await cards.get(agent.id, awaiting.cardId!)).toEqual(expect.objectContaining({
      state: "cancelled", providerCardRef: "ic_close-awaiting", closeReason: `closed by ${agent.id}`,
    }));
    await expect(cards.resolveApproval(owner.id, awaiting.approvalId!, "approve", undefined, issuer("close-awaiting-other")))
      .rejects.toMatchObject({ code: "55000" });
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);

    const stale = await cards.prepare(cardInput(agent.id, "stale-request", { capMicros: 5_000n, expiresAt: new Date(Date.now() + 200) }));
    expect(stale.status).toBe("prepared");
    await sleep(300);
    expect(await cards.activate({ agentId: agent.id, cardId: stale.cardId!, ...issuer("stale-request") })).toEqual(expect.objectContaining({
      status: "denied", code: "permit_invalid", cardId: stale.cardId, reason: "card request expired before activation",
    }));
    expect(await cards.get(agent.id, stale.cardId!)).toEqual(expect.objectContaining({
      state: "cancelled", providerCardRef: "ic_stale-request", last4: "4242", closeRequestedAt: expect.any(Date),
    }));
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);

    expect(await cards.prepare(cardInput(agent.id, "cooldown"))).toEqual(expect.objectContaining({
      status: "denied", code: "approval_rejected", reason: expect.stringContaining("5 minute cooldown"),
    }));
    const approvable = await cards.prepare(cardInput(agent.id, "recheck-approval", { capMicros: 50_000n }));
    expect(approvable.status).toBe("approval_required");
    await db.query("update money.mandates set expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid", [mandateId]);
    expect(await cards.resolveApproval(owner.id, approvable.approvalId!, "approve", undefined, issuer("recheck-approval"))).toEqual(
      expect.objectContaining({ status: "denied", code: "approval_failed", cardState: "cancelled", reason: "mandate expired before approval" })
    );
    expect((await policy.approval(owner.id, approvable.approvalId!))?.status).toBe("failed");
    expect((await cards.awaitingIssuerClose()).map((item) => item.providerCardRef).sort()).toEqual(["ic_close-awaiting", "ic_recheck-approval", "ic_stale-request"]);
    expect(await ledger.balance(agent.id)).toBe(1_000_000n);
    expect(await cards.list(otherOwner.id)).toEqual([]);
    expect((await cards.list(owner.id)).map((item) => item.state)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);

    expect(await treasury.setCardSpendEnabled(true, "already enabled")).toBe(false);
    const enqueued = await cards.enqueueEvent({ provider: PROVIDER, providerEventId: "evt_complete", endpointId: "we_1", deliveryHash: sha("d") });
    expect(await cards.enqueueEvent({ provider: PROVIDER, providerEventId: "evt_complete", endpointId: "we_1", deliveryHash: sha("d") })).toEqual(
      expect.objectContaining({ inboxId: enqueued.inboxId, replayed: true, state: "queued" })
    );
    const claimed = await cards.claimEvents("worker-a", 10);
    expect(claimed).toEqual([expect.objectContaining({ inboxId: enqueued.inboxId, providerEventId: "evt_complete", attempts: 1 })]);
    expect(await cards.claimEvents("worker-b", 10)).toEqual([]);
    await cards.completeEvent("worker-a", enqueued.inboxId, "completed");
    expect((await db.query<{ state: string }>("select state from money.card_event_inbox where id = $1::bigint", [enqueued.inboxId.toString()])).rows[0]?.state).toBe("completed");
    expect(await control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
  });

  it("preserves x402 settlement behaviour across the live 0012 migration", async () => {
    const legacyDb = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
    try {
      const files = readdirSync(migrations).filter((entry) => /^\d{4}_[a-z0-9_-]+\.sql$/.test(entry)).sort();
      const cardRailIndex = files.indexOf("0012_card_rail.sql");
      expect(cardRailIndex).toBeGreaterThan(0);
      for (const file of files.slice(0, cardRailIndex)) {
        await legacyDb.executeScript(readFileSync(join(migrations, file), "utf8"));
      }
      const legacyControl = new PostgresControlPlane(legacyDb);
      const legacyLedger = new PostgresLedger(legacyDb);
      const legacyPolicy = new PostgresPolicy(legacyDb);
      const legacyExternal = new PostgresExternal(legacyDb);
      await new PostgresTreasury(legacyDb).configureControls({
        fundingEnabled: true, payoutsEnabled: true, externalSpendEnabled: true,
        maxPayoutMicros: 100_000_000_000n, maxPendingPayoutMicros: 1_000_000_000_000n,
        maxOpenExposureMicros: 100_000_000_000n, maxReconciliationVarianceMicros: 1_000_000n,
        reason: "legacy fixture enables treasury controls",
      });
      const owner = await legacyControl.registerIdentity({
        id: "usr_cardupgrade", kind: "user", name: "Upgrade owner", handle: "upgrade-owner", publicKey: key("upgrade-owner"),
      });
      const agent = await legacyControl.registerIdentity({
        actorId: owner.id, id: "agt_cardupgrade", kind: "agent", ownerId: owner.id,
        name: "Upgrade agent", handle: "upgrade-agent", publicKey: key("upgrade-agent"),
      });
      const payTo = "0x209693bc6afc0c5328ba36faf03c514ef312287c";
      const x402Payee = `x402:data.example.com:${payTo}`;
      await approveComplianceFixture(legacyDb, owner.id);
      await clearCounterpartyFixture(legacyDb, x402Payee);
      await legacyLedger.postTransfer({
        actorId: owner.id, operation: "fund", idempotencyKey: "upgrade-fund",
        from: "external:funding", to: owner.id, amountMicros: 2_000_000n,
      });
      await legacyLedger.postTransfer({
        actorId: owner.id, operation: "allocate", idempotencyKey: "upgrade-allocate",
        from: owner.id, to: agent.id, amountMicros: 1_000_000n,
      });
      await legacyPolicy.grantMandate({
        userId: owner.id, agentId: agent.id,
        budgetMicros: 1_000_000n, perTxCapMicros: 1_000_000n, dailyCapMicros: 1_000_000n,
        escalateAboveMicros: 1_000_000n, newPayeeCapMicros: 100_000n,
        expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: "upgrade-mandate",
      });
      const x402Input = {
        externalId: randomUUID(), agentId: agent.id, idempotencyKey: "upgrade-x402",
        host: "data.example.com", payTo, settlementAsset: "0x00000000000000000000000000000000000c0ffe",
        settlementNetwork: "mock-local", resource: "https://data.example.com/report", policyPayee: x402Payee,
        amountMicros: 50_000n,
        paymentHeaderCiphertext: Buffer.concat([Buffer.alloc(32, 7), Buffer.from("authorization:upgrade")]),
        authorizationHash: sha("authorization:upgrade"),
        authorizationExpiresAt: new Date(Date.now() + 60_000), reverseAfter: new Date(Date.now() + 120_000),
      };
      const legacyPayment = await legacyExternal.request(x402Input);
      expect(legacyPayment).toEqual(expect.objectContaining({ status: "posted", externalState: "pending" }));
      expect(await legacyLedger.balance(agent.id)).toBe(950_000n);
      expect(await legacyControl.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });

      await legacyDb.executeScript(readFileSync(join(migrations, "0012_card_rail.sql"), "utf8"));
      expect(await legacyControl.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
      const upgradedExternal = new PostgresExternal(legacyDb);
      expect(await upgradedExternal.request(x402Input)).toEqual(expect.objectContaining({
        status: "posted", replayed: true, externalId: legacyPayment.externalId, receiptId: legacyPayment.receiptId,
      }));
      expect(await upgradedExternal.confirm(agent.id, legacyPayment.externalId!, "0xupgradedtx")).toEqual({
        ok: true, replayed: false, state: "confirmed", settledTx: "0xupgradedtx",
      });
      expect(await upgradedExternal.request({ ...x402Input, externalId: randomUUID(), idempotencyKey: "upgrade-x402-2", amountMicros: 40_000n }))
        .toEqual(expect.objectContaining({ status: "posted", externalState: "pending" }));
      expect(await legacyLedger.balance(agent.id)).toBe(910_000n);
      await expect(legacyLedger.postTransfer({
        actorId: agent.id, operation: "pay", idempotencyKey: "upgrade-pay-external", from: agent.id, to: "external:x402", amountMicros: 1n,
      })).rejects.toMatchObject({ code: "42501" });

      const upgradedTreasury = new PostgresTreasury(legacyDb);
      expect((await upgradedTreasury.controlState()).cardSpendEnabled).toBe(false);
      await upgradedTreasury.setCardSpendEnabled(true, "enable card spend after upgrade");
      await clearCounterpartyFixture(legacyDb, POLICY_PAYEE, "merchant");
      const upgradedCards = new PostgresCards(legacyDb);
      const prepared = await upgradedCards.prepare(cardInput(agent.id, "upgrade-card", { capMicros: 100_000n }));
      expect(prepared.status).toBe("prepared");
      expect(await upgradedCards.activate({ agentId: agent.id, cardId: prepared.cardId!, ...issuer("upgrade-card") })).toEqual(
        expect.objectContaining({ status: "posted", cardState: "pending" })
      );
      expect(await legacyLedger.balance(agent.id)).toBe(810_000n);
      expect(await legacyLedger.balance("external:card")).toBe(100_000n);
      expect(await legacyControl.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
    } finally {
      await legacyDb.close();
    }
  }, 60_000);
});
