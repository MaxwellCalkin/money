/**
 * Card-rail demo: the headline sentence, end to end, in sandbox.
 *
 *   "I put $100 in, my agent spends it at a normal website like a card,
 *    it is visibly declined off-mandate, and it pays another agent for a
 *    service — one feed."
 *
 * Dev-only. Boots the real Postgres product API (`createPostgresApi`) on an
 * in-process PGlite database (a devDependency), the mock issuer network that
 * speaks the Stripe Issuing wire shape, the card authorization app, and the
 * card event worker — all in one process, no servers, no browser, no real
 * funds. This file is deliberately NOT a build entrypoint: production runs
 * the same code paths against real Postgres via `src/server/postgres-api.ts`,
 * `src/cards/authorization-server.ts`, and `src/cards/event-worker.ts`.
 *
 * The transcript is deterministic: no ids, hashes, timestamps, or latencies
 * are printed, so two runs produce byte-identical output. Latency against the
 * issuer's 2-second synchronous deadline is measured and asserted, then
 * reported as the bound rather than a per-run number.
 *
 * Run: npm run demo:card
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { createCardAuthorizationApp } from "./cards/authorization-server.ts";
import { drainIssuerCloses, runCardEventBatch } from "./cards/event-worker.ts";
import { createMockIssuerNetwork, MockIssuer } from "./cards/mock-issuer.ts";
import { generateAgentKeypair, signedHeaders } from "./core/identity.ts";
import { fmt } from "./core/types.ts";
import { PostgresCards } from "./db/cards.ts";
import { PostgresCompliance } from "./db/compliance.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "./db/database.ts";
import { runMigrations } from "./db/migrate.ts";
import { PostgresTreasury } from "./db/treasury.ts";
import { createPostgresApi } from "./server/postgres-api.ts";

const SANDBOX_LABEL = "SANDBOX — no real funds; nothing here is a bank, card, or deposit account.";
const SECRET = "whsec_demo_card_rail_sandbox_0001";
const ENDPOINT = "we_demo_card";
const WORKER = "demo-card-worker";
const HINT = "mock-shop.example";
const POLICY_PAYEE = `card:hint:${HINT}`;
/** The issuer's synchronous decision deadline (Stripe Issuing gives 2 s). */
const DECISION_DEADLINE_MS = 2_000;

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

const hash = (value: string) => createHash("sha256").update(value).digest();

/**
 * Deterministic, non-PII sandbox compliance evidence: the owner is cleared and
 * the demo merchant is registered + screened as a merchant counterparty (the
 * card rail fails closed on unscreened `card:hint:*` counterparties). This is
 * the same fixture shape the integration suite uses; production evidence comes
 * from the real compliance workers.
 */
async function sandboxComplianceFixture(db: SqlExecutor, userId: string): Promise<void> {
  const compliance = new PostgresCompliance(db);
  const observedAt = new Date(Date.now() - 1_000);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
  await compliance.beginVerification({
    userId,
    subjectType: "individual",
    countryCode: "US",
    expectedSingleMicros: 5_000_000_000n,
    expectedMonthlyMicros: 50_000_000_000n,
  });
  await compliance.recordEvidence({
    subjectAccountId: userId,
    kind: "identity",
    provider: "fixture",
    providerResultRef: `identity-${userId}`,
    decision: "clear",
    evidenceHash: hash(`identity:${userId}`),
    listVersion: "identity-v1",
    observedAt,
    expiresAt,
    normalized: { identityVerified: true },
  });
  await compliance.recordEvidence({
    subjectAccountId: userId,
    kind: "sanctions",
    provider: "fixture",
    providerResultRef: `sanctions-${userId}`,
    decision: "clear",
    evidenceHash: hash(`sanctions:${userId}`),
    listVersion: "screening-v1",
    observedAt,
    expiresAt,
    normalized: { matches: 0 },
  });
  await compliance.approveSubject({
    subjectAccountId: userId,
    riskTier: "standard",
    nextReviewAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
    reviewReference: `CASE-${userId}`,
    reason: "sandbox fixture evidence reviewed",
  });
  const refHash = createHash("sha256").update(POLICY_PAYEE).digest("hex").slice(0, 24);
  const counterparty = await compliance.registerCounterparty({
    kind: "merchant",
    canonicalRef: POLICY_PAYEE,
    label: "Sandbox merchant mock-shop.example",
    provider: "fixture",
    providerRef: `merchant-${refHash}`,
  });
  await compliance.recordCounterpartyScreening({
    counterpartyId: counterparty.id,
    state: "clear",
    evidenceHash: hash(`counterparty:${POLICY_PAYEE}`),
    listVersion: "screening-v1",
    screenedAt: observedAt,
    expiresAt,
  });
}

/** Card ids leak into release memos; redact them so the transcript is stable. */
function redactIds(value: string): string {
  return value.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    "<card-id>"
  );
}

function demoAssert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`demo failed: ${message}`);
}

export async function runCardDemo(log: (line: string) => void = console.log): Promise<void> {
  const line = (s = "") => log(s);
  const section = (title: string) => {
    line();
    line(`━━ ${title} ${"━".repeat(Math.max(4, 64 - title.length))}`);
  };
  const ok = (s: string) => line(`  ✓ ${s}`);
  const no = (s: string) => line(`  ✗ ${s}`);

  const db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
  try {
    line("agentmoney · reserved-card rail demo");
    line(SANDBOX_LABEL);

    section("Setup: the sandbox network boots");
    await runMigrations(db);
    ok("migrations 0001-0012 applied to an in-process Postgres (PGlite, dev-only)");
    const treasury = new PostgresTreasury(db);
    await treasury.configureControls({
      fundingEnabled: true,
      payoutsEnabled: true,
      externalSpendEnabled: true,
      maxPayoutMicros: 100_000_000_000n,
      maxPendingPayoutMicros: 1_000_000_000_000n,
      maxOpenExposureMicros: 100_000_000_000n,
      maxReconciliationVarianceMicros: 1_000_000n,
      reason: "sandbox demo configures treasury controls",
    });
    await treasury.setCardSpendEnabled(true, "sandbox demo enables card spend");
    ok("treasury controls configured; operator enabled card spend");
    const issuer = new MockIssuer();
    const workerCards = new PostgresCards(db);
    const authApp = createCardAuthorizationApp(workerCards, {
      provider: "mock",
      secrets: [SECRET],
      endpointId: ENDPOINT,
    });
    const network = createMockIssuerNetwork({
      secret: SECRET,
      issuer,
      authorizationApp: authApp,
      eventsApp: authApp,
    });
    const api = createPostgresApi(db, { allowDevelopmentFunding: true, cardIssuer: issuer });
    ok("mock issuer network online, speaking the Stripe Issuing wire shape");
    ok("card test material stays with the issuer adapter — no card number appears below");

    const request = async (
      path: string,
      method: "GET" | "POST",
      value: unknown,
      accountId: string,
      privateKey: string,
      idHeader: "x-user-id" | "x-agent-id"
    ) => {
      const body = method === "GET" ? "" : JSON.stringify(value ?? {});
      const response = await api.app.request(path, {
        method,
        headers: {
          ...(method === "GET" ? {} : { "content-type": "application/json" }),
          ...signedHeaders(accountId, privateKey, { method, path, body }, idHeader),
        },
        ...(method === "GET" ? {} : { body }),
      });
      const raw = await response.text();
      return { status: response.status, body: (raw ? JSON.parse(raw) : {}) as any };
    };
    const agentFunds = async (agentId: string) => fmt(Number(await api.ledger.balance(agentId)));
    const runWorker = async () => {
      const batch = await runCardEventBatch(workerCards, issuer, WORKER);
      demoAssert(batch.failed === 0, `event worker batch failed: ${JSON.stringify(batch)}`);
      return batch;
    };

    section("1 · Owner funds $100 and signs a spend mandate");
    const ownerKeys = generateAgentKeypair();
    const signup = await api.app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Max", handle: "max", publicKey: ownerKeys.publicKey }),
    });
    demoAssert(signup.status === 200, "owner signup must succeed");
    const owner = (await signup.json()) as { id: string };
    await sandboxComplianceFixture(db, owner.id);
    ok("owner @max onboarded; sandbox compliance fixture: owner cleared,");
    ok(`  ${HINT} registered and screened clear as a merchant counterparty`);

    const createAgent = async (name: string, handle: string) => {
      const keys = generateAgentKeypair();
      const response = await request("/agents", "POST", {
        name, handle, ownerId: owner.id, publicKey: keys.publicKey,
      }, owner.id, ownerKeys.privateKey, "x-user-id");
      demoAssert(response.status === 200, `agent ${handle} must be created`);
      return { id: response.body.id as string, keys };
    };
    const scout = await createAgent("Scout", "scout");
    const writer = await createAgent("Writer", "writer-agent");

    const funded = await request("/fund", "POST", {
      userId: owner.id, amountMicros: 100_000_000, idempotencyKey: "demo-card-fund",
    }, owner.id, ownerKeys.privateKey, "x-user-id");
    demoAssert(funded.status === 200, "dev funding must post");
    ok("owner funded $100.00 (dev funding — sandbox, no real funds)");
    const allocated = await request("/allocate", "POST", {
      userId: owner.id, agentId: scout.id, amountMicros: 100_000_000, idempotencyKey: "demo-card-allocate",
    }, owner.id, ownerKeys.privateKey, "x-user-id");
    demoAssert(allocated.status === 200, "allocation must post");
    ok(`$100.00 allocated to @scout — agent funds: ${await agentFunds(scout.id)}`);

    const mandate = await request("/mandates", "POST", {
      userId: owner.id,
      agentId: scout.id,
      budgetMicros: 100_000_000,
      perTxCapMicros: 40_000_000,
      dailyCapMicros: 100_000_000,
      escalateAboveMicros: 60_000_000,
      newPayeeCapMicros: 15_000_000,
      // The allowlist is exact: card spend may only reach the one merchant
      // hint, and internal payments may only reach the one named agent.
      payeeAllowlist: [POLICY_PAYEE, writer.id],
      idempotencyKey: "demo-card-mandate",
    }, owner.id, ownerKeys.privateKey, "x-user-id");
    demoAssert(mandate.status === 200, "mandate grant must succeed");
    const mandateId = mandate.body.id as string;
    ok("spend mandate up to $100.00 signed by the owner:");
    ok("  $40.00 per transaction · human approval above $60.00");
    ok("  first purchase at an unseen merchant capped at $15.00");
    ok(`  payee allowlist: ${POLICY_PAYEE} · @writer-agent`);
    // The new-payee throttle binds twice — on the merchant hint when a card is
    // requested and on the SQL-computed real merchant key when the network
    // asks — and an allowlist entry does not bypass it. The sandbox seeds
    // mock-shop.example as a merchant this mandate has bought from before, so
    // the $29 story clears while the $400 gift-card merchant below stays cold.
    await db.query(
      "insert into money.mandate_seen_payees(mandate_id, payee_id) values ($1::uuid, $2), ($1::uuid, $3) on conflict do nothing",
      [mandateId, POLICY_PAYEE, "card:5734:mock-shop-example"]
    );
    ok(`sandbox fixture: ${HINT} recorded as a previously seen merchant`);
    ok("  (unseen merchants stay throttled at $15.00 — watch the decline below)");

    section("2 · A reserved card: spend mandate up to $29.00 at mock-shop.example");
    const created = await request("/cards", "POST", {
      idempotencyKey: "demo-card-shop", capUsd: 29, merchantHint: HINT,
    }, scout.id, scout.keys.privateKey, "x-agent-id");
    demoAssert(created.status === 200 && created.body.status === "active", "card issuance must be active");
    const shopCard = created.body.card as { id: string; last4: string; singleUse: boolean };
    demoAssert(Boolean(created.body.receiptId), "card reserve must carry a receipt");
    ok(`@scout requested a reserved card — active, single-use, last4 ${shopCard.last4}`);
    ok(`issuing the card reserved its full $29.00 cap from the agent funds — agent funds: ${await agentFunds(scout.id)}`);
    ok("the reserve is one receipt on the hash-chained evidence feed");
    const shopCardRef = (await api.cards.get(scout.id, shopCard.id))!.providerCardRef!;

    section("3 · The merchant network asks; agentmoney answers in real time");
    const approvalStarted = Date.now();
    const purchase = await network.purchase(shopCardRef, {
      amountCents: 2_900, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734", country: "US",
    });
    const approvalMs = Date.now() - approvalStarted;
    demoAssert(purchase.approved, `the $29 purchase must be approved: ${JSON.stringify(purchase)}`);
    demoAssert(approvalMs < DECISION_DEADLINE_MS, `decision took ${approvalMs}ms, over the ${DECISION_DEADLINE_MS}ms deadline`);
    ok("APPROVED · $29.00 at MOCK SHOP EXAMPLE (MCC 5734)");
    ok("decision latency: <2 s — measured against the issuer's hard synchronous");
    ok("  deadline and asserted on every run (this run held it)");
    await runWorker();
    ok("event worker re-fetched the authorization from the issuer before trusting it");
    const captured = await network.capture(purchase.authorizationRef!, 2_900);
    demoAssert(Boolean(captured.eventId), "capture must emit a clearing event");
    await runWorker();
    const settledCard = (await api.cards.get(scout.id, shopCard.id))!;
    demoAssert(settledCard.state === "confirmed" && settledCard.settledMicros === 29_000_000n,
      "the clearing must settle the card");
    ok("merchant captured $29.00 — the worker settled the clearing: card confirmed,");
    ok(`  $29.00 settled under the mandate — agent funds: ${await agentFunds(scout.id)}`);
    const drained = await drainIssuerCloses(workerCards, issuer);
    demoAssert(drained.closed === 1 && drained.failed === 0, "issuer-side close must drain");
    await runWorker();
    ok("single-use card closed at the issuer after settlement");

    section("4 · $400 of gift cards at an unseen merchant: declined");
    const secondCard = await request("/cards", "POST", {
      idempotencyKey: "demo-card-standing", capUsd: 40, merchantHint: HINT, singleUse: false,
    }, scout.id, scout.keys.privateKey, "x-agent-id");
    demoAssert(secondCard.status === 200 && secondCard.body.status === "active", "the standing card must issue");
    ok("@scout holds a second reserved card (multi-use), spend mandate up to $40.00");
    ok(`  at ${HINT} — agent funds: ${await agentFunds(scout.id)}`);
    const secondCardRef = (await api.cards.get(scout.id, secondCard.body.card.id))!.providerCardRef!;
    const declineStarted = Date.now();
    const giftAttempt = await network.purchase(secondCardRef, {
      amountCents: 40_000, descriptor: "GIFT CARD EMPORIUM", mcc: "6051", country: "US",
    });
    const declineMs = Date.now() - declineStarted;
    demoAssert(!giftAttempt.approved && giftAttempt.declineCode === "new_payee_cap",
      `the gift-card attempt must decline new_payee_cap: ${JSON.stringify(giftAttempt)}`);
    demoAssert(declineMs < DECISION_DEADLINE_MS, `decline took ${declineMs}ms, over the ${DECISION_DEADLINE_MS}ms deadline`);
    no("DECLINED · $400.00 at GIFT CARD EMPORIUM (MCC 6051)");
    no("decline code: new_payee_cap — in plain words: this owner has never bought");
    no("  from this merchant, and a first purchase at an unseen merchant may not");
    no("  exceed the mandate's $15.00 new-payee cap. The agent cannot be lured");
    no("  into $400.00 of gift cards.");
    ok("the decline was decided in the same <2 s synchronous window; no funds moved");
    await runWorker();

    section("5 · The agent pays another agent for a service");
    const paid = await request("/pay", "POST", {
      to: "@writer-agent",
      amountMicros: 5_000_000,
      memo: "product summary: mock-shop.example findings",
      idempotencyKey: "demo-card-a2a",
    }, scout.id, scout.keys.privateKey, "x-agent-id");
    demoAssert(paid.status === 200 && paid.body.status === "paid", "the agent-to-agent payment must post");
    ok('@scout paid @writer-agent $5.00 — memo: "product summary: mock-shop.example findings"');
    ok(`instant internal settlement, one hash-chained receipt — agent funds: ${await agentFunds(scout.id)}`);

    section("6 · Close the standing card: the unspent remainder returns");
    const closed = await request(`/cards/${secondCard.body.card.id}/close`, "POST", {},
      scout.id, scout.keys.privateKey, "x-agent-id");
    demoAssert(closed.status === 200 && closed.body.state === "reversed", "closing the unused card must reverse it");
    ok(`@scout closed the card — unspent $40.00 returned to the agent funds: ${await agentFunds(scout.id)}`);
    const spent = await db.query<{ spent: string }>(
      "select spent_micros::text as spent from money.mandates where id = $1::uuid", [mandateId]
    );
    demoAssert(spent.rows[0]!.spent === "74000000", "mandate authority must remain spent after the close");
    ok("mandate authority is never restored by a close or a refund:");
    ok("  $74.00 of the $100.00 spend mandate remains spent");
    const drainedClose = await drainIssuerCloses(workerCards, issuer);
    demoAssert(drainedClose.failed === 0, "the issuer-side cancel must drain");
    await runWorker();

    section("7 · One feed, verified");
    const state = await request("/agent/state?limit=12", "GET", undefined,
      scout.id, scout.keys.privateKey, "x-agent-id");
    demoAssert(state.status === 200 && Array.isArray(state.body.feed), "the agent feed must be readable");
    const nameOf = (id: string, account?: { handle?: string }) =>
      account?.handle ? `@${account.handle}` : id;
    for (const entry of state.body.feed as Array<{
      from: string; to: string; amount: number; memo: string;
      fromAccount?: { handle?: string }; toAccount?: { handle?: string };
    }>) {
      line(`    ${nameOf(entry.from, entry.fromAccount).padEnd(14)} → ${nameOf(entry.to, entry.toAccount).padEnd(14)} ${fmt(entry.amount).padStart(8)}  ${redactIds(entry.memo)}`.trimEnd());
    }
    ok("the $29.00 card reserve and the $5.00 agent payment sit on the same feed,");
    ok("  each receipt hash-chained to the transfer evidence beneath it");
    const health = await api.control.ledgerHealth();
    demoAssert(health.zeroSum && health.receiptsOk, `ledger health must hold: ${JSON.stringify(health)}`);
    ok("ledger_health: zero-sum true · receipt evidence recomputed from the ledger: true");

    section("Done");
    line("  One spend mandate. A reserved card for an ordinary merchant, a hard");
    line("  decline for the one the owner never approved, and an agent paying an");
    line("  agent for a service — all on one verified feed.");
    line(`  ${SANDBOX_LABEL}`);
    line();
  } finally {
    await db.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCardDemo()
    .then(() => {
      // PGlite is closed above; exit hard like src/demo.ts so stray timers
      // never keep the sandbox process alive.
      process.exit(0);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
