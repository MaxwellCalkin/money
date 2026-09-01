/**
 * Founder preview of the owner app, one command, one link.
 *
 *   npm run dashboard:preview
 *
 * Dev-only (NOT a build entrypoint; refuses NODE_ENV=production). Boots the
 * real Postgres product API (`createPostgresApi`) on an in-process PGlite
 * database, the mock issuer network that speaks the Stripe Issuing wire
 * shape, and the card event worker, then seeds a believable sandbox world:
 *
 *   - owner @max with $250.00 of owner funds
 *   - @scout with $66.00 of agent funds under a spend mandate up to $100.00
 *     ($40 per payment · escalates above $60 · $15 first payment to someone
 *     new), a settled $29.00 reserved card, an active $5.00 reserved card,
 *     a $5.00 payment to @writer-agent, and a DECLINED $400.00 gift-card
 *     authorization
 *   - @writer-agent with the $5.00 it earned
 *   - one PENDING $61.00 escalation and one REJECTED $68.00 escalation
 *   - a verified treasury payout destination and a recorded ledger verdict
 *
 * The API runs with allowDevelopmentFunding and allowSessionOwnerWrites (both
 * sandbox-only; production preflight refuses each), mints an owner session,
 * and prints a ready-to-open /dashboard#token=... URL — opening it is the
 * whole login.
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { createCardAuthorizationApp } from "./cards/authorization-server.ts";
import { drainIssuerCloses, runCardEventBatch } from "./cards/event-worker.ts";
import { createMockIssuerNetwork, MockIssuer } from "./cards/mock-issuer.ts";
import { generateAgentKeypair, signedHeaders } from "./core/identity.ts";
import { PostgresCards } from "./db/cards.ts";
import { PostgresCompliance } from "./db/compliance.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "./db/database.ts";
import { runMigrations } from "./db/migrate.ts";
import { PostgresTreasury } from "./db/treasury.ts";
import { createPostgresApi } from "./server/postgres-api.ts";

const SANDBOX_LABEL = "SANDBOX — no real funds; nothing here is a bank, card, or deposit account.";
const SECRET = "whsec_preview_dashboard_sandbox_0001";
const ENDPOINT = "we_preview_dashboard";
const WORKER = "preview-dashboard-worker";
const HINT = "mock-shop.example";
const POLICY_PAYEE = `card:hint:${HINT}`;

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

/** Deterministic, non-PII sandbox compliance evidence: the owner is cleared and
 * the demo merchant is registered + screened (the card rail fails closed on
 * unscreened `card:hint:*` counterparties). Same fixture shape as demo-card.ts
 * and the integration suite; production evidence comes from the real workers. */
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

/** A verified, compliance-linked payout destination so the Cash out form is
 * live in the preview. */
async function sandboxPayoutDestination(db: SqlExecutor, treasury: PostgresTreasury, accountId: string): Promise<void> {
  const destination = await treasury.registerDestination({
    accountId,
    provider: "column",
    providerRef: "ctpy_preview_owner",
    label: "Column checking",
  });
  const compliance = new PostgresCompliance(db);
  const canonicalRef = "column:ctpy_preview_owner";
  const refHash = createHash("sha256").update(canonicalRef).digest("hex").slice(0, 24);
  const counterparty = await compliance.registerCounterparty({
    kind: "bank_destination",
    canonicalRef,
    label: "Preview payout destination",
    provider: "fixture",
    providerRef: `bank_destination-${refHash}`,
  });
  await compliance.recordCounterpartyScreening({
    counterpartyId: counterparty.id,
    state: "clear",
    evidenceHash: hash(`counterparty:${canonicalRef}`),
    listVersion: "screening-v1",
    screenedAt: new Date(Date.now() - 1_000),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
  });
  await compliance.linkTreasuryDestination({
    destinationId: destination.id,
    counterpartyId: counterparty.id,
    reviewReference: "PREVIEW-DESTINATION-REVIEW",
  });
}

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`preview seed failed: ${message}`);
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("the dashboard preview is sandbox-only and refuses to start with NODE_ENV=production");
  }
  const port = Number(process.env.PORT ?? 4022);
  const db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));

  console.log("agentmoney · owner app preview");
  console.log(SANDBOX_LABEL);
  console.log();
  await runMigrations(db);

  const treasury = new PostgresTreasury(db);
  await treasury.configureControls({
    fundingEnabled: true,
    payoutsEnabled: true,
    externalSpendEnabled: true,
    maxPayoutMicros: 100_000_000_000n,
    maxPendingPayoutMicros: 1_000_000_000_000n,
    maxOpenExposureMicros: 100_000_000_000n,
    maxReconciliationVarianceMicros: 1_000_000n,
    reason: "sandbox preview configures treasury controls",
  });
  await treasury.setCardSpendEnabled(true, "sandbox preview enables card spend");

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
  const api = createPostgresApi(db, {
    allowDevelopmentFunding: true,
    allowSessionOwnerWrites: true,
    cardIssuer: issuer,
  });

  const request = async (
    path: string,
    method: "GET" | "POST",
    value: unknown,
    accountId: string,
    privateKey: string,
    idHeader: "x-user-id" | "x-agent-id" | "x-provider-id"
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
  const runWorker = async () => {
    const batch = await runCardEventBatch(workerCards, issuer, WORKER);
    must(batch.failed === 0, `card event worker batch failed: ${JSON.stringify(batch)}`);
  };

  // ---- owner, agents, provider -------------------------------------------
  const ownerKeys = generateAgentKeypair();
  const signup = await api.app.request("/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Max", handle: "max", publicKey: ownerKeys.publicKey }),
  });
  must(signup.status === 200, "owner signup must succeed");
  const owner = (await signup.json()) as { id: string };
  await sandboxComplianceFixture(db, owner.id);
  await sandboxPayoutDestination(db, treasury, owner.id);

  const createAgent = async (name: string, handle: string) => {
    const keys = generateAgentKeypair();
    const response = await request("/agents", "POST", {
      name, handle, ownerId: owner.id, publicKey: keys.publicKey,
    }, owner.id, ownerKeys.privateKey, "x-user-id");
    must(response.status === 200, `agent ${handle} must be created`);
    return { id: response.body.id as string, keys };
  };
  const scout = await createAgent("Scout", "scout");
  const writer = await createAgent("Writer", "writer-agent");

  const providerKeys = generateAgentKeypair();
  const provider = await request("/providers", "POST", {
    name: "Research Cloud", handle: "research-cloud", ownerId: owner.id, publicKey: providerKeys.publicKey,
  }, owner.id, ownerKeys.privateKey, "x-user-id");
  must(provider.status === 200, "provider @research-cloud must be created");
  const service = await request("/services", "POST", {
    slug: "reports",
    name: "Market research reports",
    description: "Deep-dive market research on demand.",
    endpointUrl: "https://research-cloud.example/reports",
    priceMicros: 500_000,
    idempotencyKey: "preview-service",
  }, provider.body.id, providerKeys.privateKey, "x-provider-id");
  must(service.status === 200, "the research-cloud service must register");

  // ---- funds and the spend mandate ---------------------------------------
  const funded = await request("/fund", "POST", {
    userId: owner.id, amountMicros: 355_000_000, idempotencyKey: "preview-fund",
  }, owner.id, ownerKeys.privateKey, "x-user-id");
  must(funded.status === 200, "sandbox funding must post");
  const allocated = await request("/allocate", "POST", {
    userId: owner.id, agentId: scout.id, amountMicros: 105_000_000, idempotencyKey: "preview-allocate",
  }, owner.id, ownerKeys.privateKey, "x-user-id");
  must(allocated.status === 200, "allocation to @scout must post");

  const mandate = await request("/mandates", "POST", {
    userId: owner.id,
    agentId: scout.id,
    budgetMicros: 100_000_000,
    perTxCapMicros: 40_000_000,
    dailyCapMicros: 100_000_000,
    escalateAboveMicros: 60_000_000,
    newPayeeCapMicros: 15_000_000,
    idempotencyKey: "preview-mandate",
  }, owner.id, ownerKeys.privateKey, "x-user-id");
  must(mandate.status === 200, "the spend mandate must be granted");
  const mandateId = mandate.body.id as string;

  // ---- one rejected and one pending escalation ---------------------------
  const rejectedAsk = await request("/pay", "POST", {
    to: "@research-cloud",
    amountMicros: 68_000_000,
    memo: "Premium data add-on, annual plan",
    idempotencyKey: "preview-rejected-ask",
  }, scout.id, scout.keys.privateKey, "x-agent-id");
  must(rejectedAsk.status === 202, "the $68 escalation must wait for approval");
  const rejected = await request(`/owner/approvals/${rejectedAsk.body.approval.id}/reject`, "POST", {
    reason: "Annual plans need a human review first.",
  }, owner.id, ownerKeys.privateKey, "x-user-id");
  must(rejected.status === 200, "the $68 escalation must be rejected");

  const pendingAsk = await request("/pay", "POST", {
    to: "@research-cloud",
    amountMicros: 61_000_000,
    memo: "Quarterly research data license",
    idempotencyKey: "preview-pending-ask",
  }, scout.id, scout.keys.privateKey, "x-agent-id");
  must(pendingAsk.status === 202, "the $61 escalation must sit pending in the inbox");

  // The sandbox marks mock-shop.example as a previously seen merchant so the
  // $29 story clears the $15 new-payee throttle while the gift-card merchant
  // below stays cold and declines.
  await db.query(
    "insert into money.mandate_seen_payees(mandate_id, payee_id) values ($1::uuid, $2), ($1::uuid, $3) on conflict do nothing",
    [mandateId, POLICY_PAYEE, "card:5734:mock-shop-example"]
  );

  // ---- reserved card #1: $29 at mock-shop.example, settled ---------------
  const shopCard = await request("/cards", "POST", {
    idempotencyKey: "preview-card-shop", capUsd: 29, merchantHint: HINT,
  }, scout.id, scout.keys.privateKey, "x-agent-id");
  must(shopCard.status === 200 && shopCard.body.status === "active", "the $29 reserved card must issue");
  const shopCardRef = (await api.cards.get(scout.id, shopCard.body.card.id))!.providerCardRef!;
  const purchase = await network.purchase(shopCardRef, {
    amountCents: 2_900, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734", country: "US",
  });
  must(purchase.approved, `the $29 purchase must be approved: ${JSON.stringify(purchase)}`);
  await runWorker();
  const captured = await network.capture(purchase.authorizationRef!, 2_900);
  must(Boolean(captured.eventId), "the capture must emit a clearing event");
  await runWorker();
  const drained = await drainIssuerCloses(workerCards, issuer);
  must(drained.failed === 0, "the issuer-side close must drain");
  await runWorker();

  // ---- reserved card #2: active $5 card, then a $400 decline -------------
  const standingCard = await request("/cards", "POST", {
    idempotencyKey: "preview-card-standing", capUsd: 5, merchantHint: HINT,
    singleUse: false, expiresInSeconds: 172_800,
  }, scout.id, scout.keys.privateKey, "x-agent-id");
  must(standingCard.status === 200 && standingCard.body.status === "active", "the active reserved card must issue");
  const standingCardRef = (await api.cards.get(scout.id, standingCard.body.card.id))!.providerCardRef!;
  const giftAttempt = await network.purchase(standingCardRef, {
    amountCents: 40_000, descriptor: "GIFT CARD EMPORIUM", mcc: "6051", country: "US",
  });
  must(!giftAttempt.approved, "the $400 gift-card authorization must be DECLINED");
  await runWorker();

  // ---- the agent pays another agent --------------------------------------
  const paid = await request("/pay", "POST", {
    to: "@writer-agent",
    amountMicros: 5_000_000,
    memo: "product summary: mock-shop.example findings",
    idempotencyKey: "preview-a2a",
  }, scout.id, scout.keys.privateKey, "x-agent-id");
  must(paid.status === 200 && paid.body.status === "paid", "the $5 agent-to-agent payment must post");

  // ---- verify the seeded numbers and record a ledger verdict -------------
  const scoutFunds = await api.ledger.balance(scout.id);
  must(scoutFunds === 66_000_000n, `@scout must hold $66.00, saw ${scoutFunds}`);
  const ownerFunds = await api.ledger.balance(owner.id);
  must(ownerFunds === 250_000_000n, `@max must hold $250.00, saw ${ownerFunds}`);
  const writerFunds = await api.ledger.balance(writer.id);
  must(writerFunds === 5_000_000n, `@writer-agent must hold $5.00, saw ${writerFunds}`);
  await db.query("select * from money_private.record_ledger_health()");

  // ---- session + server ---------------------------------------------------
  const session = await request("/owner/sessions", "POST", {}, owner.id, ownerKeys.privateKey, "x-user-id");
  must(session.status === 200 && session.body.dashboardPath, "the owner session must mint");

  serve({ fetch: api.app.fetch, hostname: "127.0.0.1", port });
  // Keep the card lifecycle live while the founder clicks around: the event
  // worker and the issuer-close drain run on a short loop, so closing a
  // reserved card in the app settles instead of hanging at "closing…".
  const workerLoop = setInterval(() => {
    void (async () => {
      try {
        await runCardEventBatch(workerCards, issuer, WORKER);
        await drainIssuerCloses(workerCards, issuer);
      } catch (error) {
        console.error("preview card worker loop failed", error);
      }
    })();
  }, 2_000);
  workerLoop.unref?.();
  const url = `http://127.0.0.1:${port}${session.body.dashboardPath}`;
  console.log("Seeded: @max $250.00 owner funds · @scout $66.00 under a $100.00 spend mandate");
  console.log("        one pending $61.00 approval · one rejected $68.00 ask in the Live Feed");
  console.log("        a settled $29.00 reserved card · an active $5.00 reserved card · @writer-agent earned $5.00");
  console.log("        (a $400.00 gift-card authorization was also DECLINED server-side by the card rail —");
  console.log("         fail-closed at the network, so it never reaches the app's feed)");
  console.log();
  console.log("Open your owner app (the link carries a one-session token):");
  console.log();
  console.log(`  ${url}`);
  console.log();
  console.log(`Session expires ${new Date(session.body.expiresAt).toLocaleString()}. Ctrl+C stops the sandbox.`);
  console.log(SANDBOX_LABEL);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
