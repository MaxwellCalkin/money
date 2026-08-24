import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresCards } from "../src/db/cards.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { PostgresDatabase } from "../src/db/postgres.ts";
import { PostgresPolicy } from "../src/db/policy.ts";
import { PostgresTreasury } from "../src/db/treasury.ts";
import { approveComplianceFixture, clearCounterpartyFixture } from "./helpers/compliance-fixture.ts";

const connectionString = process.env.MONEY_TEST_DATABASE_URL;

function assertDisposableDatabase(value: string): void {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("MONEY_TEST_DATABASE_URL must target a loopback PostgreSQL server");
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/(?:test|live|v\d+)/i.test(database)) {
    throw new Error("MONEY_TEST_DATABASE_URL must name an explicitly disposable test database");
  }
}

describe.skipIf(!connectionString)("live PostgreSQL release gate", () => {
  let db: PostgresDatabase;

  beforeAll(async () => {
    if (!connectionString) throw new Error("MONEY_TEST_DATABASE_URL is required");
    assertDisposableDatabase(connectionString);
    db = new PostgresDatabase({
      connectionString,
      applicationName: "money-postgres-release-test",
      maxConnections: 12,
      statementTimeoutMs: 20_000,
      ssl: false,
    });
    await runMigrations(db);
    const replay = await runMigrations(db);
    expect(replay.map(({ version, applied }) => ({ version, applied }))).toEqual(
      Array.from({ length: 13 }, (_, index) => ({
        version: String(index + 1).padStart(4, "0"),
        applied: false,
      })),
    );
    const roles = readFileSync(resolve("db/roles.sql"), "utf8");
    await db.executeScript(roles);
    await db.executeScript(roles);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("runs the exact migration set on a checksummed server", async () => {
    const server = await db.query<{
      server_version_num: string;
      data_checksums: string;
      server_address: string;
    }>(`
      select current_setting('server_version_num') as server_version_num,
             current_setting('data_checksums') as data_checksums,
             inet_server_addr()::text as server_address
    `);
    expect(Number(server.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(180_000);
    expect(server.rows[0]).toEqual(expect.objectContaining({
      data_checksums: "on",
      server_address: expect.any(String),
    }));

    const migrations = await db.query<{ version: string; checksum: string }>(`
      select version, checksum from money.schema_migrations order by version
    `);
    expect(migrations.rows.map((row) => row.version)).toEqual(
      Array.from({ length: 13 }, (_, index) => String(index + 1).padStart(4, "0")),
    );
    expect(migrations.rows.every((row) => /^[0-9a-f]{64}$/.test(row.checksum))).toBe(true);
  });

  it("enforces the high-risk effective privilege boundaries", async () => {
    const privileges = await db.query<Record<string, boolean>>(`
      select
        has_schema_privilege('public', 'money_private', 'USAGE') as public_private_schema,
        has_function_privilege('public', 'money_private.request_agent_payment(text,text,text,text,bigint,text)', 'EXECUTE') as public_pay,
        has_function_privilege('money_app', 'money_private.request_agent_payment(text,text,text,text,bigint,text)', 'EXECUTE') as app_safe_pay,
        has_function_privilege('money_app', 'money_private.post_agent_payment(text,text,text,text,bigint,text,jsonb)', 'EXECUTE') as app_raw_pay,
        has_function_privilege('money_app', 'money_private.register_public_identity(text,text,text,text,text,text,text)', 'EXECUTE') as app_safe_register,
        has_function_privilege('money_app', 'money_private.register_account(text,text,text,text,text,text)', 'EXECUTE') as app_raw_register,
        has_function_privilege('money_app', 'money_private.post_confirmed_funding(text,text,text,bigint,jsonb)', 'EXECUTE') as app_funding,
        has_function_privilege('money_app', 'money_private.reverse_external_payment(uuid)', 'EXECUTE') as app_external_reverse,
        has_table_privilege('money_app', 'money.balances', 'SELECT') as app_balances,
        has_table_privilege('money_app', 'money.external_payments', 'SELECT') as app_external_table,
        has_table_privilege('money_worker', 'money.outbox_events', 'UPDATE') as worker_outbox,
        has_function_privilege('money_worker', 'money_private.sweep_external_payments(integer)', 'EXECUTE') as worker_external_sweep,
        has_table_privilege('money_worker', 'money.ledger_entries', 'SELECT') as worker_ledger,
        has_function_privilege('money_treasury_ingress', 'money_private.enqueue_treasury_provider_event(text,text,text,bytea)', 'EXECUTE') as treasury_ingress_enqueue,
        has_function_privilege('money_treasury_ingress', 'money_private.settle_treasury_funding(text,text,text,text,text,text,bigint,timestamptz,bytea,jsonb)', 'EXECUTE') as treasury_ingress_settle,
        has_function_privilege('money_payout_worker', 'money_private.claim_treasury_payouts(text,integer)', 'EXECUTE') as payout_claim,
        has_table_privilege('money_payout_worker', 'money.treasury_payouts', 'SELECT') as payout_table,
        has_function_privilege('money_reconciler', 'money_private.record_treasury_asset_snapshot(text,text,text,bigint,bigint,bigint,bigint,bigint,text,timestamptz)', 'EXECUTE') as reconciler_snapshot,
        has_function_privilege('money_reconciler', 'money_private.request_treasury_payout(text,text,uuid,text,bigint)', 'EXECUTE') as reconciler_payout,
        has_function_privilege('money_compliance_ingress', 'money_private.enqueue_compliance_event(text,text,text,text,bytea)', 'EXECUTE') as compliance_ingress_enqueue,
        has_function_privilege('money_compliance_ingress', 'money_private.record_compliance_evidence(text,text,text,text,text,bytea,text,timestamptz,timestamptz,jsonb)', 'EXECUTE') as compliance_ingress_evidence,
        has_function_privilege('money_compliance_worker', 'money_private.record_compliance_event_evidence_set(text,bigint,jsonb)', 'EXECUTE') as compliance_worker_evidence_set,
        has_function_privilege('money_compliance_worker', 'money_private.enqueue_compliance_event(text,text,text,text,bytea)', 'EXECUTE') as compliance_worker_enqueue,
        has_function_privilege('money_compliance_onboarding', 'money_private.claim_compliance_verification_sessions(text,integer)', 'EXECUTE') as compliance_onboarding_claim,
        has_table_privilege('money_compliance_onboarding', 'money.compliance_verification_sessions', 'SELECT') as compliance_onboarding_table,
        has_function_privilege('money_compliance_console', 'money_private.approve_compliance_action_as_operator(bytea,uuid,text,text)', 'EXECUTE') as compliance_console_execute,
        has_function_privilege('money_compliance_console', 'money_private.approve_compliance_subject(text,text,timestamptz,text,text)', 'EXECUTE') as compliance_console_direct_approve,
        has_table_privilege('money_ops', 'money.ledger_entries', 'SELECT') as ops_ledger,
        has_table_privilege('money_ops', 'money.compliance_cases', 'SELECT') as ops_compliance_table,
        to_regprocedure('money_private.complete_compliance_event(text,bigint,uuid)') is null as split_completion_removed,
        has_function_privilege('money_card_ingress', 'money_private.decide_card_authorization(text,text,text,text,bigint,text,text,text,text,integer)', 'EXECUTE') as card_ingress_decide,
        has_function_privilege('money_card_ingress', 'money_private.enqueue_card_provider_event(text,text,text,bytea)', 'EXECUTE') as card_ingress_enqueue,
        has_function_privilege('money_card_ingress', 'money_private.settle_card_authorization(text,text,text,bigint,timestamptz,bytea,jsonb,integer)', 'EXECUTE') as card_ingress_settle,
        has_function_privilege('money_card_ingress', 'money_private.prepare_card(uuid,text,text,bigint,boolean,text,text[],timestamptz)', 'EXECUTE') as card_ingress_prepare,
        has_table_privilege('money_card_ingress', 'money.cards', 'SELECT') as card_ingress_table,
        has_function_privilege('money_card_worker', 'money_private.settle_card_authorization(text,text,text,bigint,timestamptz,bytea,jsonb,integer)', 'EXECUTE') as card_worker_settle,
        has_function_privilege('money_card_worker', 'money_private.trip_treasury_breaker(text)', 'EXECUTE') as card_worker_trip,
        has_function_privilege('money_app', 'money_private.treasury_control_state()', 'EXECUTE') as app_control_state,
        has_function_privilege('money_app', 'money_private.card_spend_control_state()', 'EXECUTE') as app_card_spend_state,
        has_function_privilege('money_treasury', 'money_private.card_spend_control_state()', 'EXECUTE') as treasury_card_spend_state,
        has_function_privilege('money_card_worker', 'money_private.card_spend_control_state()', 'EXECUTE') as card_worker_card_spend_state,
        has_function_privilege('money_card_worker', 'money_private.decide_card_authorization(text,text,text,text,bigint,text,text,text,text,integer)', 'EXECUTE') as card_worker_decide,
        has_function_privilege('money_card_worker', 'money_private.prepare_card(uuid,text,text,bigint,boolean,text,text[],timestamptz)', 'EXECUTE') as card_worker_prepare,
        has_table_privilege('money_card_worker', 'money.cards', 'SELECT') as card_worker_table,
        has_function_privilege('money_app', 'money_private.prepare_card(uuid,text,text,bigint,boolean,text,text[],timestamptz)', 'EXECUTE') as app_card_prepare,
        has_function_privilege('money_app', 'money_private.decide_card_authorization(text,text,text,text,bigint,text,text,text,text,integer)', 'EXECUTE') as app_card_decide,
        has_function_privilege('money_app', 'money_private.post_card_transfer(text,text,text,text,text,text,bigint,text,jsonb)', 'EXECUTE') as app_card_kernel,
        has_function_privilege('money_worker', 'money_private.sweep_cards(integer)', 'EXECUTE') as worker_card_sweep,
        has_function_privilege('money_metrics', 'money_private.public_metrics()', 'EXECUTE') as metrics_public,
        has_function_privilege('money_metrics', 'money_private.verify_receipt(uuid)', 'EXECUTE') as metrics_verify,
        has_function_privilege('money_metrics', 'money_private.metrics_weekly_series(integer)', 'EXECUTE') as metrics_internal_series,
        has_table_privilege('money_metrics', 'money.transfers', 'SELECT') as metrics_transfers_table,
        has_table_privilege('money_metrics', 'money.receipts', 'SELECT') as metrics_receipts_table,
        has_schema_privilege('money_metrics', 'money', 'USAGE') as metrics_money_schema,
        has_function_privilege('money_app', 'money_private.public_metrics()', 'EXECUTE') as app_public_metrics,
        has_function_privilege('money_ops', 'money_private.public_metrics()', 'EXECUTE') as ops_public_metrics
    `);
    expect(privileges.rows[0]).toEqual({
      public_private_schema: false,
      public_pay: false,
      app_safe_pay: true,
      app_raw_pay: false,
      app_safe_register: true,
      app_raw_register: false,
      app_funding: false,
      app_external_reverse: false,
      app_balances: false,
      app_external_table: false,
      worker_outbox: true,
      worker_external_sweep: true,
      worker_ledger: false,
      treasury_ingress_enqueue: true,
      treasury_ingress_settle: false,
      payout_claim: true,
      payout_table: false,
      reconciler_snapshot: true,
      reconciler_payout: false,
      compliance_ingress_enqueue: true,
      compliance_ingress_evidence: false,
      compliance_worker_evidence_set: true,
      compliance_worker_enqueue: false,
      compliance_onboarding_claim: true,
      compliance_onboarding_table: false,
      compliance_console_execute: true,
      compliance_console_direct_approve: false,
      ops_ledger: true,
      ops_compliance_table: false,
      split_completion_removed: true,
      card_ingress_decide: true,
      card_ingress_enqueue: true,
      card_ingress_settle: false,
      card_ingress_prepare: false,
      card_ingress_table: false,
      card_worker_settle: true,
      card_worker_trip: true,
      app_control_state: true,
      app_card_spend_state: true,
      treasury_card_spend_state: true,
      card_worker_card_spend_state: false,
      card_worker_decide: false,
      card_worker_prepare: false,
      card_worker_table: false,
      app_card_prepare: true,
      app_card_decide: false,
      app_card_kernel: false,
      worker_card_sweep: true,
      metrics_public: true,
      metrics_verify: true,
      metrics_internal_series: false,
      metrics_transfers_table: false,
      metrics_receipts_table: false,
      metrics_money_schema: false,
      app_public_metrics: false,
      ops_public_metrics: true,
    });
  });

  it("allows the signed application boundary while database bypasses fail", async () => {
    const suffix = Date.now().toString(36);
    const ownerId = `usr_role_${suffix}`;
    const publicKey = `live-role-public-key-${suffix}-${"x".repeat(40)}`;
    await db.transaction(async (tx) => {
      await tx.query("set local role money_app");
      const registered = await tx.query<{ id: string }>(
        "select id from money_private.register_public_identity(null, $1, 'user', 'Live role owner', null, null, $2)",
        [ownerId, publicKey],
      );
      expect(registered.rows).toEqual([{ id: ownerId }]);
      await tx.query(
        "select money_private.consume_signed_request($1, 'user', $2, $3, $4::bigint, $5::bytea)",
        [ownerId, publicKey, `live-role-nonce-${suffix}`, String(Date.now()), Buffer.alloc(32, 7)],
      );
      expect((await tx.query(
        "select * from money_private.account_state($1, 'USD')", [ownerId],
      )).rows).toHaveLength(1);
    });

    await expect(db.transaction(async (tx) => {
      await tx.query("set local role money_app");
      await tx.query(
        "select * from money_private.register_account($1, 'user', 'Bypass', null, null, $2)",
        [`usr_bypass_${suffix}`, `bypass-public-key-${suffix}-${"x".repeat(40)}`],
      );
    })).rejects.toThrow(/permission denied/);
    await expect(db.transaction(async (tx) => {
      await tx.query("set local role money_app");
      await tx.query("select * from money.balances");
    })).rejects.toThrow(/permission denied/);
  });

  it("serializes competing spends across real PostgreSQL connections and reconciles", async () => {
    const suffix = Date.now().toString(36);
    const ownerId = `usr_live_${suffix}`;
    const agentId = `agt_livea_${suffix}`;
    const peerId = `agt_liveb_${suffix}`;
    const ledger = new PostgresLedger(db);
    const policy = new PostgresPolicy(db);
    await ledger.registerAccount({ id: ownerId, kind: "user", name: "Live owner" });
    await ledger.registerAccount({ id: agentId, kind: "agent", name: "Live payer", ownerId });
    await ledger.registerAccount({ id: peerId, kind: "agent", name: "Live payee", ownerId });
    await approveComplianceFixture(db, ownerId);
    await ledger.postTransfer({
      actorId: ownerId,
      operation: "fund",
      idempotencyKey: `live-fund-${suffix}`,
      from: "external:funding",
      to: ownerId,
      amountMicros: 10n,
    });
    await ledger.postTransfer({
      actorId: ownerId,
      operation: "allocate",
      idempotencyKey: `live-allocate-${suffix}`,
      from: ownerId,
      to: agentId,
      amountMicros: 10n,
    });
    const mandate = await policy.grantMandate({
      userId: ownerId,
      agentId,
      budgetMicros: 5n,
      dailyCapMicros: 5n,
      perTxCapMicros: 5n,
      escalateAboveMicros: 5n,
      newPayeeCapMicros: 5n,
      expiresAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: `live-mandate-${suffix}`,
    });

    const results = await Promise.all([
      policy.requestPayment({
        agentId, to: peerId, amountMicros: 4n, idempotencyKey: `live-race-a-${suffix}`,
      }),
      policy.requestPayment({
        agentId, to: peerId, amountMicros: 4n, idempotencyKey: `live-race-b-${suffix}`,
      }),
    ]);
    expect(results.filter((result) => result.status === "posted")).toHaveLength(1);
    expect(results.filter((result) => result.status === "denied")).toEqual([
      expect.objectContaining({ code: "budget" }),
    ]);
    expect(await policy.mandate(ownerId, mandate.mandateId)).toEqual(expect.objectContaining({
      spentMicros: 4n,
      spentTodayMicros: 4n,
    }));
    expect(await ledger.balance(agentId)).toBe(6n);
    expect(await ledger.balance(peerId)).toBe(4n);
    expect((await ledger.reconcile()).every((row) => row.matches)).toBe(true);
    const journal = await db.query<{ unbalanced: string }>(`
      select count(*)::text as unbalanced from (
        select transfer_seq from money.ledger_entries
        group by transfer_seq having sum(amount_micros) <> 0
      ) entries
    `);
    expect(journal.rows).toEqual([{ unbalanced: "0" }]);
  });

  it("never exceeds a card's reserve under 20 concurrent authorization decisions on real connections", async () => {
    const suffix = Date.now().toString(36);
    const ownerId = `usr_cardl_${suffix}`;
    const agentId = `agt_cardl_${suffix}`;
    const ledger = new PostgresLedger(db);
    const policy = new PostgresPolicy(db);
    const treasury = new PostgresTreasury(db);
    const cards = new PostgresCards(db);
    await ledger.registerAccount({ id: ownerId, kind: "user", name: "Card owner" });
    await ledger.registerAccount({ id: agentId, kind: "agent", name: "Card agent", ownerId });
    await approveComplianceFixture(db, ownerId);
    await clearCounterpartyFixture(db, "card:hint:mock-shop.example", "merchant");
    await treasury.configureControls({
      fundingEnabled: true, payoutsEnabled: true, externalSpendEnabled: true,
      maxPayoutMicros: 100_000_000_000n, maxPendingPayoutMicros: 1_000_000_000_000n,
      maxOpenExposureMicros: 100_000_000_000n, maxReconciliationVarianceMicros: 1_000_000n,
      reason: `live card fixture ${suffix}`,
    });
    await treasury.setCardSpendEnabled(true, `live card fixture ${suffix}`);
    await ledger.postTransfer({
      actorId: ownerId, operation: "fund", idempotencyKey: `live-card-fund-${suffix}`,
      from: "external:funding", to: ownerId, amountMicros: 1_000_000_000n,
    });
    await ledger.postTransfer({
      actorId: ownerId, operation: "allocate", idempotencyKey: `live-card-allocate-${suffix}`,
      from: ownerId, to: agentId, amountMicros: 1_000_000_000n,
    });
    await policy.grantMandate({
      userId: ownerId, agentId,
      budgetMicros: 1_000_000_000n, dailyCapMicros: 1_000_000_000n, perTxCapMicros: 1_000_000_000n,
      escalateAboveMicros: 1_000_000_000n, newPayeeCapMicros: 1_000_000_000n,
      expiresAt: new Date(Date.now() + 86_400_000), idempotencyKey: `live-card-mandate-${suffix}`,
    });
    const prepared = await cards.prepare({
      cardId: randomUUID(), agentId, idempotencyKey: `live-card-${suffix}`, capMicros: 500_000_000n,
      singleUse: false, merchantHint: "mock-shop.example", expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(prepared.status).toBe("prepared");
    const activated = await cards.activate({
      agentId, cardId: prepared.cardId!, provider: "mock", providerCardRef: `ic_live_${suffix}`,
      last4: "4242", expMonth: 12, expYear: 2030,
    });
    expect(activated).toEqual(expect.objectContaining({ status: "posted", cardState: "pending" }));

    const decisions = await Promise.all(Array.from({ length: 20 }, (_, index) => cards.decideAuthorization({
      provider: "mock", providerEventId: `evt_live_${suffix}_${index}`, providerAuthorizationRef: `iauth_live_${suffix}_${index}`,
      providerCardRef: `ic_live_${suffix}`, amountMicros: 50_000_000n,
      merchantDescriptor: "MOCK SHOP EXAMPLE", merchantMcc: "5734", merchantCountry: "US",
    })));
    expect(decisions.filter((decision) => decision.decision === "approved")).toHaveLength(10);
    expect(decisions.filter((decision) => decision.declineCode === "card_cap")).toHaveLength(10);
    const card = await cards.get(agentId, prepared.cardId!);
    expect(card?.heldMicros).toBe(500_000_000n);
    expect(await cards.decideAuthorization({
      provider: "mock", providerEventId: `evt_live_${suffix}_0`, providerAuthorizationRef: `iauth_live_${suffix}_0`,
      providerCardRef: `ic_live_${suffix}`, amountMicros: 50_000_000n,
      merchantDescriptor: "MOCK SHOP EXAMPLE", merchantMcc: "5734", merchantCountry: "US",
    })).toEqual({ ...decisions[0], replayed: true });
    expect((await ledger.reconcile()).every((row) => row.matches)).toBe(true);
    const health = await db.query<{ zero_sum: boolean; receipts_ok: boolean }>("select * from money_private.ledger_health()");
    expect(health.rows[0]).toEqual({ zero_sum: true, receipts_ok: true });
  }, 60_000);
});
