import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCardAuthorizationApp } from "../src/cards/authorization-server.ts";
import { drainIssuerCloses, runCardEventBatch } from "../src/cards/event-worker.ts";
import { CardIssuerApiError, signIssuerWebhook } from "../src/cards/issuer.ts";
import { createMockIssuerNetwork, MockIssuer } from "../src/cards/mock-issuer.ts";
import { generateAgentKeypair, signedHeaders } from "../src/core/identity.ts";
import { PostgresCards } from "../src/db/cards.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { PostgresTreasury } from "../src/db/treasury.ts";
import { createPostgresApi } from "../src/server/postgres-api.ts";
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

const ROOT = resolve(import.meta.dirname, "..");
const SECRET = "whsec_cards_api_secret_00000001";
const ENDPOINT = "we_cards_api";
const WORKER = "cards-api-worker";
const HINT = "mock-shop.example";
const POLICY_PAYEE = `card:hint:${HINT}`;
const MOCK_PAN = "4242424242424242";
const REVEAL_KEY = randomBytes(32);

type IdHeader = "x-user-id" | "x-agent-id";
type HonoApp = ReturnType<typeof createPostgresApi>["app"];

/**
 * Every agent-facing body, owner-facing body, MCP tool text, and captured log
 * line is swept for PAN-shaped digit runs. Long hex strings (receipt evidence
 * hashes) are stripped first — 64 hex characters can contain accidental
 * decimal runs, while a 13-19 digit PAN is far too short to be mistaken for
 * one. Whatever remains may contain only 13-digit values that are plausible
 * epoch-millisecond timestamps or micro-dollar configuration amounts, all
 * below 2.2e12. Every real network PAN begins with 2-6 (and 13-digit PANs are
 * Visa's, beginning with 4), so even a PAN's 13-digit prefix lands above that
 * ceiling, and the 16-digit mock PAN fails the length check outright.
 */
function assertNoPan(label: string, value: string): void {
  expect(value.includes(MOCK_PAN), `${label} must never contain the raw test PAN`).toBe(false);
  const sanitized = value.replace(/[0-9a-fA-F]{24,}/g, "");
  for (const match of sanitized.matchAll(/\d{13,19}/g)) {
    const run = match[0]!;
    expect(run.length, `${label} leaked a PAN-shaped digit run: ${run}`).toBe(13);
    const numeric = Number(run);
    expect(numeric, `${label} leaked a PAN-shaped digit run: ${run}`).toBeGreaterThanOrEqual(1_000_000_000_000);
    expect(numeric, `${label} leaked a PAN-shaped digit run: ${run}`).toBeLessThan(2_200_000_000_000);
  }
}

describe("Postgres signed card API", () => {
  let db: EmbeddedPostgres;
  let treasury: PostgresTreasury;
  let captured: Array<{ label: string; text: string }>;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    treasury = new PostgresTreasury(db);
    await treasury.configureControls({
      fundingEnabled: true, payoutsEnabled: true, externalSpendEnabled: true,
      maxPayoutMicros: 100_000_000_000n, maxPendingPayoutMicros: 1_000_000_000_000n,
      maxOpenExposureMicros: 100_000_000_000n, maxReconciliationVarianceMicros: 1_000_000n,
      reason: "test fixture enables treasury controls",
    });
    await treasury.setCardSpendEnabled(true, "test fixture enables card spend");
    captured = [];
  }, 60_000);

  afterEach(async () => {
    await db.close();
  });

  function record(label: string, text: string): void {
    captured.push({ label, text });
  }

  function sweepCaptured(): void {
    for (const entry of captured) assertNoPan(entry.label, entry.text);
  }

  async function signedJson(
    app: HonoApp,
    path: string,
    method: "GET" | "POST",
    value: unknown,
    accountId: string,
    privateKey: string,
    idHeader: IdHeader,
    options: { omitRecord?: boolean } = {}
  ) {
    const body = method === "GET" ? "" : JSON.stringify(value ?? {});
    const headers: Record<string, string> = {
      ...(method !== "GET" ? { "content-type": "application/json" } : {}),
      ...signedHeaders(accountId, privateKey, { method, path, body }, idHeader),
    };
    const response = await app.request(path, {
      method,
      headers,
      ...(method !== "GET" ? { body } : {}),
    });
    const raw = await response.text();
    if (!options.omitRecord) record(`${method} ${path}`, raw);
    let parsed: any = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = raw;
    }
    return { status: response.status, headers: response.headers, body: parsed, raw };
  }

  let worldCounter = 0;

  async function world(api: ReturnType<typeof createPostgresApi>, options: {
    budgetMicros?: number;
    perTxCapMicros?: number;
    escalateAboveMicros?: number;
    newPayeeCapMicros?: number;
  } = {}) {
    const suffix = `${Date.now().toString(36)}${(worldCounter += 1)}`;
    const budget = options.budgetMicros ?? 1_000_000_000;
    const ownerKeys = generateAgentKeypair();
    const signup = await api.app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Max", handle: `max-card-${suffix}`, publicKey: ownerKeys.publicKey }),
    });
    expect(signup.status).toBe(200);
    const user = await signup.json() as { id: string };
    await approveComplianceFixture(db, user.id);
    await clearCounterpartyFixture(db, POLICY_PAYEE, "merchant");

    const createAgent = async (name: string, handle: string) => {
      const keys = generateAgentKeypair();
      const response = await signedJson(api.app, "/agents", "POST", {
        name, handle, ownerId: user.id, publicKey: keys.publicKey,
      }, user.id, ownerKeys.privateKey, "x-user-id");
      expect(response.status).toBe(200);
      return { agent: response.body as { id: string }, keys };
    };
    const { agent, keys: agentKeys } = await createAgent("Scout", `scout-card-${suffix}`);
    const { agent: otherAgent, keys: otherAgentKeys } = await createAgent("Writer", `writer-card-${suffix}`);

    expect((await signedJson(api.app, "/fund", "POST", {
      userId: user.id, amountMicros: 2_000_000_000, idempotencyKey: "card-api-fund",
    }, user.id, ownerKeys.privateKey, "x-user-id")).status).toBe(200);
    expect((await signedJson(api.app, "/allocate", "POST", {
      userId: user.id, agentId: agent.id, amountMicros: 1_000_000_000, idempotencyKey: "card-api-allocate",
    }, user.id, ownerKeys.privateKey, "x-user-id")).status).toBe(200);
    const mandate = await signedJson(api.app, "/mandates", "POST", {
      userId: user.id,
      agentId: agent.id,
      budgetMicros: budget,
      perTxCapMicros: options.perTxCapMicros ?? budget,
      dailyCapMicros: budget,
      escalateAboveMicros: options.escalateAboveMicros ?? budget,
      newPayeeCapMicros: options.newPayeeCapMicros ?? budget,
      idempotencyKey: "card-api-mandate",
    }, user.id, ownerKeys.privateKey, "x-user-id");
    expect(mandate.status).toBe(200);
    return {
      user, ownerKeys, agent, agentKeys, otherAgent, otherAgentKeys,
      mandateId: (mandate.body as { id: string }).id,
    };
  }

  function issuerWorld() {
    const issuer = new MockIssuer();
    const createSpy = vi.spyOn(issuer, "createCard");
    const closeSpy = vi.spyOn(issuer, "closeCard");
    const workerCards = new PostgresCards(db);
    const authApp = createCardAuthorizationApp(workerCards, {
      provider: "mock", secrets: [SECRET], endpointId: ENDPOINT,
    });
    const network = createMockIssuerNetwork({
      secret: SECRET, issuer, authorizationApp: authApp, eventsApp: authApp,
    });
    return { issuer, createSpy, closeSpy, workerCards, authApp, network };
  }

  async function authorizationRowCount(): Promise<number> {
    const result = await db.query<{ count: number }>(
      "select count(*)::integer as count from money.card_authorizations"
    );
    return result.rows[0]!.count;
  }

  it("carries a reserved card from MCP create through authorization, clearing, and close without exposing a PAN anywhere", async () => {
    const { issuer, createSpy, workerCards, network } = issuerWorld();
    const api = createPostgresApi(db, { allowDevelopmentFunding: true, cardIssuer: issuer });
    const { user, ownerKeys, agent, agentKeys, otherAgent, otherAgentKeys, mandateId } =
      await world(api, { newPayeeCapMicros: 15_000_000 });
    // The new-payee throttle binds on the hint at reserve and on the real
    // merchant key at authorization; this loop seeds both for the shop so the
    // $29 purchase clears, then proves the $400 gift-card merchant declines.
    await db.query(
      "insert into money.mandate_seen_payees(mandate_id, payee_id) values ($1::uuid, $2), ($1::uuid, $3) on conflict do nothing",
      [mandateId, POLICY_PAYEE, "card:5734:mock-shop-example"]
    );

    const logs: string[] = [];
    const spies = ([
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
    ] as const).map((spy) => spy.mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    }));
    const stderrChunks: string[] = [];
    const server = serve({ fetch: api.app.fetch, hostname: "127.0.0.1", port: 0 }) as unknown as Server;
    let client: Client | undefined;
    try {
      await new Promise<void>((resolveListen) => {
        if (server.address()) return resolveListen();
        server.once("listening", () => resolveListen());
      });
      const port = (server.address() as AddressInfo).port;
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "mcp", "server.ts")],
        env: {
          ...getDefaultEnvironment(),
          MONEY_API: `http://127.0.0.1:${port}`,
          MONEY_AGENT_ID: agent.id,
          MONEY_AGENT_KEY: agentKeys.privateKey,
        },
        stderr: "pipe",
      });
      client = new Client({ name: "cards-api-test", version: "0.0.0" });
      await client.connect(transport);
      transport.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));

      const callTool = async (name: string, args: Record<string, unknown>) => {
        const result = await client!.callTool({ name, arguments: args });
        const first = (result.content as Array<{ type: string; text: string }>)[0];
        expect(first?.type).toBe("text");
        record(`mcp ${name}`, first!.text);
        return JSON.parse(first!.text) as any;
      };

      // The tool surface itself: card verbs present, descriptions lexicon-clean.
      const tools = await client.listTools();
      const byName = new Map(tools.tools.map((tool) => [tool.name, tool.description ?? ""]));
      for (const name of [
        "money_balance", "money_pay", "money_fetch",
        "money_card_create", "money_card_status", "money_card_close", "money_feed",
      ]) expect([...byName.keys()], `tool ${name} is registered`).toContain(name);
      expect(byName.get("money_balance")).toMatch(/spend under its owner's mandate/);
      expect(byName.get("money_card_create")).toMatch(/reserved virtual card/);
      for (const name of ["money_card_create", "money_card_status", "money_card_close"]) {
        const description = (byName.get(name) ?? "").toLowerCase();
        expect(description, `${name} description avoids banned vocabulary`).not.toMatch(/prepaid|debit|balance|p2p|send money/);
      }
      record("mcp tool list", JSON.stringify(tools.tools.map((tool) => ({ name: tool.name, description: tool.description }))));

      // Create through the MCP: reserve moves at issue, exactly one issuer card.
      const created = await callTool("money_card_create", {
        amount_usd: 29, merchant: HINT, idempotency_key: "mcp-card-1",
      });
      expect(created).toEqual(expect.objectContaining({
        status: "active", cardId: expect.any(String), last4: "4242",
        cap: "$29.00", merchant: HINT, receiptId: expect.any(String),
      }));
      expect(created.checkoutToken).toBeUndefined();
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(await api.ledger.balance(agent.id)).toBe(1_000_000_000n - 29_000_000n);
      expect(await api.ledger.balance("external:card")).toBe(29_000_000n);

      const replayed = await callTool("money_card_create", {
        amount_usd: 29, merchant: HINT, idempotency_key: "mcp-card-1",
      });
      expect(replayed).toEqual(expect.objectContaining({ status: "active", cardId: created.cardId }));
      expect(createSpy).toHaveBeenCalledTimes(1);

      const cardId: string = created.cardId;
      const stored = await api.cards.get(agent.id, cardId);
      const providerCardRef = stored!.providerCardRef!;
      expect(providerCardRef).toMatch(/^ic_mock_/);

      // Synchronous approval on the wire, decided against the reserve.
      const purchase = await network.purchase(providerCardRef, {
        amountCents: 2_900, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734", country: "US",
      });
      record("network purchase shop", JSON.stringify(purchase));
      expect(purchase).toEqual(expect.objectContaining({ approved: true, reason: "webhook_approved" }));
      expect((purchase.responseBody as any).metadata).toEqual(expect.objectContaining({
        agentmoney_decision: "approved", agentmoney_card: cardId,
      }));

      // The async created event is enqueued; nothing moves until the worker runs.
      expect((await api.cards.get(agent.id, cardId))!).toEqual(expect.objectContaining({
        heldMicros: 29_000_000n, settledMicros: 0n,
      }));
      expect(await runCardEventBatch(workerCards, issuer, WORKER)).toEqual({
        claimed: 1, completed: 1, ignored: 0, failed: 0,
      });

      const capture = await network.capture(purchase.authorizationRef!, 2_900);
      expect((await api.cards.get(agent.id, cardId))!).toEqual(expect.objectContaining({
        heldMicros: 29_000_000n, settledMicros: 0n,
      }));
      expect(await api.ledger.balance(agent.id)).toBe(1_000_000_000n - 29_000_000n);
      expect(capture.eventId).toBeTruthy();
      expect(await runCardEventBatch(workerCards, issuer, WORKER)).toEqual({
        claimed: 1, completed: 1, ignored: 0, failed: 0,
      });
      expect((await api.cards.get(agent.id, cardId))!).toEqual(expect.objectContaining({
        state: "confirmed", heldMicros: 0n, settledMicros: 29_000_000n,
      }));

      // Single-use card closes itself; the issuer-side cancel is drained.
      const drained = await drainIssuerCloses(workerCards, issuer);
      expect(drained).toEqual(expect.objectContaining({ closed: 1, failed: 0 }));
      expect(issuer.card(providerCardRef)?.status).toBe("canceled");
      expect(await runCardEventBatch(workerCards, issuer, WORKER)).toEqual({
        claimed: 1, completed: 0, ignored: 1, failed: 0,
      });

      const status = await callTool("money_card_status", { card_id: cardId });
      expect(status.card).toEqual(expect.objectContaining({ state: "confirmed", last4: "4242" }));
      expect(status.card.providerCardRef).toBeUndefined();
      expect(status.authorizations).toEqual([expect.objectContaining({ state: "confirmed" })]);

      // A second, multi-use card; the $400 gift-card merchant (MCC 6051) is
      // visibly declined by the new-payee throttle, and a declined
      // authorization never marks the merchant as seen.
      const cardB = await signedJson(api.app, "/cards", "POST", {
        idempotencyKey: "card-api-b", capUsd: 400, merchantHint: HINT, singleUse: false,
      }, agent.id, agentKeys.privateKey, "x-agent-id");
      expect(cardB.status).toBe(200);
      expect(cardB.headers.get("cache-control")).toBe("no-store");
      const cardBId: string = (cardB.body as any).card.id;
      expect((cardB.body as any).card.providerCardRef).toBeUndefined();
      const cardBRef = (await api.cards.get(agent.id, cardBId))!.providerCardRef!;
      const declined = await network.purchase(cardBRef, {
        amountCents: 40_000, descriptor: "GIFT EMPORIUM", mcc: "6051", country: "US",
      });
      record("network purchase gift", JSON.stringify(declined));
      expect(declined).toEqual(expect.objectContaining({ approved: false, declineCode: "new_payee_cap" }));
      const giftKey = (await db.query<{ payee: string }>(
        "select money_private.card_policy_payee('6051', null, 'GIFT EMPORIUM') as payee"
      )).rows[0]!.payee;
      const seen = await db.query<{ count: number }>(
        "select count(*)::integer as count from money.mandate_seen_payees where mandate_id = $1::uuid and payee_id = $2",
        [mandateId, giftKey]
      );
      expect(seen.rows[0]!.count, "a declined authorization never marks the payee seen").toBe(0);
      expect(await runCardEventBatch(workerCards, issuer, WORKER)).toEqual(
        expect.objectContaining({ failed: 0 })
      );

      // Cross-agent access: another agent can neither read nor close the card.
      expect((await signedJson(api.app, `/cards/${cardBId}`, "GET", undefined,
        otherAgent.id, otherAgentKeys.privateKey, "x-agent-id")).status).toBe(404);
      expect((await signedJson(api.app, `/cards/${cardBId}/close`, "POST", {},
        otherAgent.id, otherAgentKeys.privateKey, "x-agent-id")).status).toBe(403);

      // Reveal surface does not exist in the default `none` mode.
      expect((await signedJson(api.app, `/cards/${cardBId}/reveal`, "POST", { checkoutToken: "A".repeat(43) },
        agent.id, agentKeys.privateKey, "x-agent-id")).status).toBe(404);

      const closedB = await callTool("money_card_close", { card_id: cardBId });
      expect(closedB).toEqual(expect.objectContaining({ state: "reversed", cardId: cardBId }));
      expect(await api.ledger.balance(agent.id)).toBe(1_000_000_000n - 29_000_000n);
      expect(await drainIssuerCloses(workerCards, issuer)).toEqual(expect.objectContaining({ closed: 1 }));

      // The reserve is ordinary hash-chained receipt evidence in the feed.
      const feed = await callTool("money_feed", { limit: 20 });
      expect(feed).toEqual(expect.arrayContaining([
        expect.objectContaining({ to: "external:card", amount: 29_000_000, memo: `card:${HINT}` }),
      ]));

      const agentState = await signedJson(api.app, "/agent/state", "GET", undefined,
        agent.id, agentKeys.privateKey, "x-agent-id");
      expect(agentState.body.cards).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: cardId, state: "confirmed" }),
        expect.objectContaining({ id: cardBId, state: "reversed" }),
      ]));
      const ownerState = await signedJson(api.app, "/owner/state", "GET", undefined,
        user.id, ownerKeys.privateKey, "x-user-id");
      expect(ownerState.body.cards).toHaveLength(2);
      const ownerCards = await signedJson(api.app, "/owner/cards", "GET", undefined,
        user.id, ownerKeys.privateKey, "x-user-id");
      expect(ownerCards.status).toBe(200);
      expect(ownerCards.body).toHaveLength(2);

      expect(await api.control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });

      // No body, MCP text, or captured log line ever contained the issuer card
      // reference or anything PAN-shaped.
      for (const entry of captured) {
        if (entry.label.startsWith("network purchase")) continue;
        expect(entry.text, `${entry.label} must not expose the issuer card reference`).not.toContain(providerCardRef);
      }
      sweepCaptured();
      for (const line of logs) assertNoPan("console", line);
      assertNoPan("mcp stderr", stderrChunks.join("\n"));
    } finally {
      await client?.close().catch(() => undefined);
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      for (const spy of spies) spy.mockRestore();
    }
  }, 240_000);

  it("persists an exact card approval, creates exactly one issuer card, and closes the issuer card on a denial after approval", async () => {
    const { issuer, createSpy, closeSpy } = issuerWorld();
    const api = createPostgresApi(db, { allowDevelopmentFunding: true, cardIssuer: issuer });
    const { user, ownerKeys, agent, agentKeys } = await world(api, {
      budgetMicros: 100_000_000, escalateAboveMicros: 10_000_000,
    });

    const requested = await signedJson(api.app, "/cards", "POST", {
      idempotencyKey: "card-approval-a", capUsd: 29, merchantHint: HINT,
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(requested.status).toBe(202);
    expect(requested.body).toEqual(expect.objectContaining({
      status: "approval_required",
      cardId: expect.any(String),
      approval: expect.objectContaining({ status: "pending", to: "external:card", amount: 29_000_000 }),
      note: expect.stringMatching(/^Scout wants a card for up to \$29\.00 at mock-shop\.example, expires in \d+ min$/),
    }));
    expect(createSpy).not.toHaveBeenCalled();
    expect(await api.ledger.balance(agent.id)).toBe(1_000_000_000n);

    const approvalId: string = requested.body.approval.id;
    const approved = await signedJson(api.app, `/owner/approvals/${approvalId}/approve`, "POST", {},
      user.id, ownerKeys.privateKey, "x-user-id");
    expect(approved.status).toBe(200);
    expect(approved.body).toEqual(expect.objectContaining({
      status: "active",
      approval: expect.objectContaining({ status: "approved", receiptId: expect.any(String) }),
      card: expect.objectContaining({ id: requested.body.cardId, state: "pending", last4: "4242" }),
      receiptId: expect.any(String),
      replayed: false,
    }));
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await api.ledger.balance(agent.id)).toBe(1_000_000_000n - 29_000_000n);

    // Owner replay and agent same-key retry both find the existing card and
    // never create a second issuer card.
    const reApproved = await signedJson(api.app, `/owner/approvals/${approvalId}/approve`, "POST", {},
      user.id, ownerKeys.privateKey, "x-user-id");
    expect(reApproved.status).toBe(200);
    expect(reApproved.body).toEqual(expect.objectContaining({ status: "active", replayed: true }));
    const retried = await signedJson(api.app, "/cards", "POST", {
      idempotencyKey: "card-approval-a", capUsd: 29, merchantHint: HINT,
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual(expect.objectContaining({
      status: "active", replayed: true, card: expect.objectContaining({ id: requested.body.cardId }),
    }));
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Request an escalating card while the budget still allows it, then spend
    // the budget down before the owner decides: the atomic recheck at approval
    // must deny, and the API closes the already-created issuer card.
    const overBudget = await signedJson(api.app, "/cards", "POST", {
      idempotencyKey: "card-approval-b", capUsd: 30, merchantHint: HINT,
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(overBudget.status).toBe(202);
    for (let index = 0; index < 5; index += 1) {
      const autonomous = await signedJson(api.app, "/cards", "POST", {
        idempotencyKey: `card-auto-${index}`, capUsd: 10, merchantHint: HINT,
      }, agent.id, agentKeys.privateKey, "x-agent-id");
      expect(autonomous.status).toBe(200);
    }
    expect(createSpy).toHaveBeenCalledTimes(6);
    const denied = await signedJson(api.app, `/owner/approvals/${overBudget.body.approval.id}/approve`, "POST", {},
      user.id, ownerKeys.privateKey, "x-user-id");
    expect(denied.status).toBe(409);
    expect(denied.body).toEqual(expect.objectContaining({
      status: "denied", code: "approval_failed",
      reason: expect.stringContaining("budget"),
      approval: expect.objectContaining({ status: "failed" }),
      card: expect.objectContaining({ state: "cancelled" }),
    }));
    expect(createSpy).toHaveBeenCalledTimes(7);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(await api.ledger.balance(agent.id)).toBe(1_000_000_000n - 79_000_000n);

    // Rejection is durable: the same idempotency key replays the rejection.
    const rejectable = await signedJson(api.app, "/cards", "POST", {
      idempotencyKey: "card-approval-c", capUsd: 20, merchantHint: HINT,
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(rejectable.status).toBe(202);
    const rejected = await signedJson(api.app, `/owner/approvals/${rejectable.body.approval.id}/reject`, "POST",
      { reason: "not this vendor" }, user.id, ownerKeys.privateKey, "x-user-id");
    expect(rejected.status).toBe(200);
    expect(rejected.body).toEqual(expect.objectContaining({
      status: "rejected",
      approval: expect.objectContaining({ status: "rejected", reason: "not this vendor" }),
      card: expect.objectContaining({ state: "cancelled" }),
    }));
    const rejectedRetry = await signedJson(api.app, "/cards", "POST", {
      idempotencyKey: "card-approval-c", capUsd: 20, merchantHint: HINT,
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(rejectedRetry.status).toBe(402);
    expect(rejectedRetry.body).toEqual(expect.objectContaining({ status: "denied", code: "approval_rejected" }));
    expect(createSpy).toHaveBeenCalledTimes(7);

    expect(await api.control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
    sweepCaptured();
  }, 180_000);

  it("fails closed: no issuer, forged or stale deliveries, malformed amounts, unknown cards, thrown decisions, paused card spend", async () => {
    const { issuer, workerCards, authApp, network } = issuerWorld();
    const api = createPostgresApi(db, { allowDevelopmentFunding: true, cardIssuer: issuer });
    const { agent, agentKeys } = await world(api);

    // Without an issuer adapter the card bridge is down, not degraded.
    const bare = createPostgresApi(db);
    const unavailable = await signedJson(bare.app, "/cards", "POST", {
      idempotencyKey: "bridge-off", capUsd: 5, merchantHint: HINT,
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual(expect.objectContaining({ error: "card_bridge_unavailable" }));

    const created = await signedJson(api.app, "/cards", "POST", {
      idempotencyKey: "fail-closed-card", capUsd: 50, merchantHint: HINT, singleUse: false,
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(created.status).toBe(200);
    const cardRef = (await api.cards.get(agent.id, created.body.card.id))!.providerCardRef!;

    // Forged and stale deliveries answer 401 and leave no authorization row.
    const forged = await network.unsigned().purchase(cardRef, {
      amountCents: 700, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734",
    });
    expect(forged).toEqual(expect.objectContaining({ approved: false, responseStatus: 401 }));
    const stale = await network.stale().purchase(cardRef, {
      amountCents: 700, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734",
    });
    expect(stale).toEqual(expect.objectContaining({ approved: false, responseStatus: 401 }));
    expect(await authorizationRowCount()).toBe(0);

    // A malformed amount from an authenticated issuer declines without a row.
    const malformed = JSON.stringify({
      id: "evt_bad_amount_0001", object: "event", created: Math.floor(Date.now() / 1_000),
      type: "issuing_authorization.request",
      data: {
        object: {
          id: "iauth_bad_amount_0001", object: "issuing.authorization", approved: false, currency: "usd",
          card: { id: cardRef },
          merchant_data: { category_code: "5734", name: "MOCK SHOP EXAMPLE", country: "US" },
          pending_request: { amount: -1, currency: "usd" },
          status: "pending",
        },
      },
    });
    const malformedResponse = await authApp.request("/webhooks/mock/authorization", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signIssuerWebhook(malformed, SECRET, Math.floor(Date.now() / 1_000)),
      },
      body: malformed,
    });
    expect(malformedResponse.status).toBe(200);
    expect(await malformedResponse.json()).toEqual(expect.objectContaining({
      approved: false,
      metadata: expect.objectContaining({ agentmoney_decline_code: "invalid_request" }),
    }));
    expect(await authorizationRowCount()).toBe(0);

    // A card the issuer knows but the ledger does not is declined, not trusted.
    const ghost = await issuer.createCard({
      cardId: randomUUID(), capMicros: 10_000_000n, expiresAt: new Date(Date.now() + 3_600_000),
      merchantHint: HINT, singleUse: true, agentId: "agt_ghost", ownerId: "usr_ghost",
    });
    const unknown = await network.purchase(ghost.providerCardRef, {
      amountCents: 500, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734",
    });
    expect(unknown).toEqual(expect.objectContaining({ approved: false, declineCode: "card_not_active" }));
    expect(await authorizationRowCount()).toBe(0);

    // Any thrown exception in the decision path is a decline, never a 500.
    const failingApp = createCardAuthorizationApp({
      decideAuthorization: async () => { throw new Error("database is down"); },
      enqueueEvent: workerCards.enqueueEvent.bind(workerCards),
    } as unknown as PostgresCards, { provider: "mock", secrets: [SECRET], endpointId: ENDPOINT });
    const failingNetwork = createMockIssuerNetwork({
      secret: SECRET, issuer, authorizationApp: failingApp, eventsApp: failingApp,
    });
    const thrown = await failingNetwork.purchase(cardRef, {
      amountCents: 900, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734",
    });
    expect(thrown).toEqual(expect.objectContaining({ approved: false, declineCode: "system" }));

    // Pausing card spend refuses fresh issuance with a typed 503.
    await treasury.setCardSpendEnabled(false, "operator pauses card spend");
    const paused = await signedJson(api.app, "/cards", "POST", {
      idempotencyKey: "paused-card", capUsd: 5, merchantHint: HINT,
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(paused.status).toBe(503);
    expect(paused.body).toEqual(expect.objectContaining({ error: "treasury_unavailable" }));

    sweepCaptured();
  }, 180_000);

  it("resumes a prepared card over HTTP and keeps the issuer card open through a retryable card-spend pause", async () => {
    const { issuer, createSpy, closeSpy, network } = issuerWorld();
    const api = createPostgresApi(db, { allowDevelopmentFunding: true, cardIssuer: issuer });
    const { agent, agentKeys } = await world(api);

    // Crash recovery between prepare and issuer create: the issuer call fails,
    // the card stays `prepared` with no reserve, and POST /cards/:id/resume
    // finishes the activation later.
    createSpy.mockRejectedValueOnce(new CardIssuerApiError("mock issuer is briefly unreachable", 503, true));
    const crashed = await signedJson(api.app, "/cards", "POST", {
      idempotencyKey: "resume-prepared", capUsd: 21, merchantHint: HINT,
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(crashed.status).toBe(502);
    expect(crashed.body).toEqual(expect.objectContaining({ error: "card_issuer_unavailable" }));
    const prepared = await api.cards.byKey(agent.id, "resume-prepared");
    expect(prepared).toEqual(expect.objectContaining({ state: "prepared" }));
    expect(await api.ledger.balance(agent.id)).toBe(1_000_000_000n);

    const resumed = await signedJson(api.app, `/cards/${prepared!.id}/resume`, "POST", {},
      agent.id, agentKeys.privateKey, "x-agent-id");
    expect(resumed.status).toBe(200);
    expect(resumed.body).toEqual(expect.objectContaining({
      status: "active",
      card: expect.objectContaining({ id: prepared!.id, state: "pending", last4: "4242" }),
      receiptId: expect.any(String),
    }));
    expect(await api.ledger.balance(agent.id)).toBe(1_000_000_000n - 21_000_000n);
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(closeSpy).not.toHaveBeenCalled();

    // Resuming an already-active card replays without a second issuer create.
    const resumeReplay = await signedJson(api.app, `/cards/${prepared!.id}/resume`, "POST", {},
      agent.id, agentKeys.privateKey, "x-agent-id");
    expect(resumeReplay.status).toBe(200);
    expect(resumeReplay.body).toEqual(expect.objectContaining({ status: "active", replayed: true }));
    expect(createSpy).toHaveBeenCalledTimes(2);

    // Mid-flight pause: card spend flips off between the issuer create and the
    // atomic activation, which raises the retryable 55000. The API must NOT
    // close the issuer card — the later same-key retry replays the issuer
    // create (Idempotency-Key = card id) and would receive canceled material.
    // A prepared card can never be approved by decide_card_authorization, so
    // the open issuer card is spend-inert while the pause lasts.
    let pausedRef = "";
    createSpy.mockImplementationOnce(async (input) => {
      const material = await MockIssuer.prototype.createCard.call(issuer, input);
      pausedRef = material.providerCardRef;
      await treasury.setCardSpendEnabled(false, "operator pauses card spend mid-activation");
      return material;
    });
    const pausedCreate = await signedJson(api.app, "/cards", "POST", {
      idempotencyKey: "paused-mid-flight", capUsd: 13, merchantHint: HINT, singleUse: false,
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(pausedCreate.status).toBe(503);
    expect(pausedCreate.body).toEqual(expect.objectContaining({ error: "treasury_unavailable" }));
    expect(closeSpy).not.toHaveBeenCalled();
    const pausedCard = await api.cards.byKey(agent.id, "paused-mid-flight");
    expect(pausedCard).toEqual(expect.objectContaining({ state: "prepared" }));
    expect(issuer.card(pausedRef)?.status).toBe("active");
    // While paused, the ledger reserved nothing against the inert issuer card.
    expect(await api.ledger.balance(agent.id)).toBe(1_000_000_000n - 21_000_000n);

    // The operator re-enables spend; the same-key retry replays the issuer
    // create for the SAME still-active card and completes the activation.
    await treasury.setCardSpendEnabled(true, "operator resumes card spend");
    const retried = await signedJson(api.app, "/cards", "POST", {
      idempotencyKey: "paused-mid-flight", capUsd: 13, merchantHint: HINT, singleUse: false,
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual(expect.objectContaining({
      status: "active",
      card: expect.objectContaining({ id: pausedCard!.id, state: "pending" }),
      receiptId: expect.any(String),
    }));
    expect((await api.cards.get(agent.id, pausedCard!.id))!.providerCardRef).toBe(pausedRef);
    expect(issuer.card(pausedRef)?.status).toBe("active");
    expect(closeSpy).not.toHaveBeenCalled();
    expect(await api.ledger.balance(agent.id)).toBe(1_000_000_000n - 21_000_000n - 13_000_000n);

    // The recovered card is live end to end: an authorization on it approves.
    const purchase = await network.purchase(pausedRef, {
      amountCents: 1_100, descriptor: "MOCK SHOP EXAMPLE", mcc: "5734", country: "US",
    });
    expect(purchase).toEqual(expect.objectContaining({ approved: true }));

    expect(await api.control.ledgerHealth()).toEqual({ zeroSum: true, receiptsOk: true });
    sweepCaptured();
  }, 180_000);

  it("binds token-mode reveals to the signer, consumes tokens once, bounds reveals to three, and refuses replayed signatures", async () => {
    const { issuer } = issuerWorld();
    const api = createPostgresApi(db, {
      allowDevelopmentFunding: true,
      cardIssuer: issuer,
      cardRevealMode: "token",
      cardRevealTokenKey: REVEAL_KEY,
    });
    const { agent, agentKeys, otherAgent, otherAgentKeys } = await world(api);

    // Signature replay and changed-body replay on POST /cards.
    const createPath = "/cards";
    const createBody = JSON.stringify({ idempotencyKey: "token-card", capUsd: 29, merchantHint: HINT });
    const createHeaders = {
      "content-type": "application/json",
      ...signedHeaders(agent.id, agentKeys.privateKey, { method: "POST", path: createPath, body: createBody }),
    };
    const first = await api.app.request(createPath, { method: "POST", headers: createHeaders, body: createBody });
    expect(first.status).toBe(200);
    const created = JSON.parse(await first.text()) as any;
    record("POST /cards token-mode", JSON.stringify(created));
    expect(created).toEqual(expect.objectContaining({
      status: "active",
      checkoutToken: expect.any(String),
      checkoutTokenExpiresAt: expect.any(Number),
    }));
    const cardId: string = created.card.id;
    expect((await api.app.request(createPath, { method: "POST", headers: createHeaders, body: createBody })).status).toBe(401);
    expect((await api.app.request(createPath, {
      method: "POST", headers: createHeaders,
      body: JSON.stringify({ idempotencyKey: "token-card", capUsd: 30, merchantHint: HINT }),
    })).status).toBe(401);
    expect((await db.query<{ count: number }>("select count(*)::integer as count from money.cards")).rows[0]!.count).toBe(1);

    // First reveal returns the PAN exactly once, with no-store.
    const revealPath = `/cards/${cardId}/reveal`;
    const revealBody = JSON.stringify({ checkoutToken: created.checkoutToken });
    const revealHeaders = {
      "content-type": "application/json",
      ...signedHeaders(agent.id, agentKeys.privateKey, { method: "POST", path: revealPath, body: revealBody }),
    };
    const revealed = await api.app.request(revealPath, { method: "POST", headers: revealHeaders, body: revealBody });
    expect(revealed.status).toBe(200);
    expect(revealed.headers.get("cache-control")).toBe("no-store");
    expect(await revealed.json()).toEqual(expect.objectContaining({
      cardId, pan: MOCK_PAN, cvc: expect.any(String),
      expMonth: expect.any(Number), expYear: expect.any(Number),
    }));

    // Signature replay and changed-body replay on the reveal route.
    expect((await api.app.request(revealPath, { method: "POST", headers: revealHeaders, body: revealBody })).status).toBe(401);
    expect((await api.app.request(revealPath, {
      method: "POST", headers: revealHeaders, body: JSON.stringify({ checkoutToken: "B".repeat(43) }),
    })).status).toBe(401);

    // A freshly signed second use of the consumed token conflicts.
    const secondUse = await signedJson(api.app, revealPath, "POST", { checkoutToken: created.checkoutToken },
      agent.id, agentKeys.privateKey, "x-agent-id", { omitRecord: true });
    expect(secondUse.status).toBe(409);

    // Resume issues the second bounded token; another agent cannot consume it.
    const resumed = await signedJson(api.app, `/cards/${cardId}/resume`, "POST", {},
      agent.id, agentKeys.privateKey, "x-agent-id");
    expect(resumed.status).toBe(200);
    const tokenTwo: string = resumed.body.checkoutToken;
    expect(tokenTwo).toEqual(expect.any(String));
    const foreign = await signedJson(api.app, revealPath, "POST", { checkoutToken: tokenTwo },
      otherAgent.id, otherAgentKeys.privateKey, "x-agent-id", { omitRecord: true });
    expect(foreign.status).toBe(403);
    // Posting the token to a different card's reveal path conflicts without
    // burning it: the kernel refuses the mismatched card BEFORE consuming, so
    // the token still works for its real card below.
    const wrongCard = await signedJson(api.app, "/cards/00000000-0000-4000-8000-000000000000/reveal", "POST",
      { checkoutToken: tokenTwo }, agent.id, agentKeys.privateKey, "x-agent-id", { omitRecord: true });
    expect(wrongCard.status).toBe(409);
    const legitimate = await signedJson(api.app, revealPath, "POST", { checkoutToken: tokenTwo },
      agent.id, agentKeys.privateKey, "x-agent-id", { omitRecord: true });
    expect(legitimate.status).toBe(200);
    expect((legitimate.body as any).pan).toBe(MOCK_PAN);

    // Third token works; issuing a fourth is refused.
    const third = await signedJson(api.app, `/cards/${cardId}/resume`, "POST", {},
      agent.id, agentKeys.privateKey, "x-agent-id");
    expect(third.status).toBe(200);
    const thirdReveal = await signedJson(api.app, revealPath, "POST", { checkoutToken: third.body.checkoutToken },
      agent.id, agentKeys.privateKey, "x-agent-id", { omitRecord: true });
    expect(thirdReveal.status).toBe(200);
    const fourth = await signedJson(api.app, `/cards/${cardId}/resume`, "POST", {},
      agent.id, agentKeys.privateKey, "x-agent-id");
    expect(fourth.status).toBe(409);
    expect(fourth.body).toEqual(expect.objectContaining({ error: "reveal_limit" }));

    // Unknown and malformed tokens fail closed.
    expect((await signedJson(api.app, revealPath, "POST", { checkoutToken: randomBytes(32).toString("base64url") },
      agent.id, agentKeys.privateKey, "x-agent-id", { omitRecord: true })).status).toBe(404);
    expect((await signedJson(api.app, revealPath, "POST", { checkoutToken: "short" },
      agent.id, agentKeys.privateKey, "x-agent-id", { omitRecord: true })).status).toBe(400);

    // Exactly one owner-visible reveal trail per consumed token.
    const revealedEvents = await db.query<{ count: number }>(
      "select count(*)::integer as count from money.outbox_events where topic = 'card.revealed' and aggregate_id = $1",
      [cardId]
    );
    expect(revealedEvents.rows[0]!.count).toBe(3);

    // Nothing recorded outside the reveal responses ever carried the PAN.
    sweepCaptured();
  }, 180_000);
});
