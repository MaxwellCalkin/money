import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAgentKeypair, signedHeaders } from "../src/core/identity.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createMoneySellerClient, moneyPaid } from "../src/seller/middleware.ts";
import { createPostgresApi } from "../src/server/postgres-api.ts";
import { approveComplianceFixture } from "./helpers/compliance-fixture.ts";

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

type IdHeader = "x-user-id" | "x-agent-id" | "x-provider-id";

function signedPost(
  app: ReturnType<typeof createPostgresApi>["app"],
  path: string,
  value: unknown,
  accountId: string,
  privateKey: string,
  idHeader: IdHeader
) {
  const body = JSON.stringify(value);
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signedHeaders(accountId, privateKey, { method: "POST", path, body }, idHeader),
    },
    body,
  });
}

function signedGet(
  app: ReturnType<typeof createPostgresApi>["app"],
  path: string,
  accountId: string,
  privateKey: string,
  idHeader: IdHeader
) {
  return app.request(path, {
    method: "GET",
    headers: signedHeaders(accountId, privateKey, { method: "GET", path, body: "" }, idHeader),
  });
}

function fetchThrough(app: ReturnType<typeof createPostgresApi>["app"]): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    return app.request(url.pathname + url.search, init);
  }) as typeof globalThis.fetch;
}

describe("Postgres marketplace HTTP API", () => {
  let db: EmbeddedPostgres;
  let api: ReturnType<typeof createPostgresApi>;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    api = createPostgresApi(db, { allowDevelopmentFunding: true });
  }, 30_000);

  afterEach(async () => {
    await db.close();
  });

  async function world(input: { priceMicros?: number; escalateAboveMicros?: number } = {}) {
    const ownerKeys = generateAgentKeypair();
    const agentKeys = generateAgentKeypair();
    const providerKeys = generateAgentKeypair();
    const signup = await api.app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Max", handle: "max", publicKey: ownerKeys.publicKey }),
    });
    const owner = await signup.json() as { id: string };
    await approveComplianceFixture(db, owner.id);
    const agentResponse = await signedPost(api.app, "/agents", {
      name: "Scout", handle: "scout", ownerId: owner.id, publicKey: agentKeys.publicKey,
    }, owner.id, ownerKeys.privateKey, "x-user-id");
    const agent = await agentResponse.json() as { id: string };
    const providerResponse = await signedPost(api.app, "/providers", {
      name: "Research Cloud", handle: "research-cloud", ownerId: owner.id, publicKey: providerKeys.publicKey,
    }, owner.id, ownerKeys.privateKey, "x-user-id");
    const provider = await providerResponse.json() as { id: string };
    expect((await signedPost(api.app, "/fund", {
      userId: owner.id, amountMicros: 20_000_000, idempotencyKey: "market-fund",
    }, owner.id, ownerKeys.privateKey, "x-user-id")).status).toBe(200);
    expect((await signedPost(api.app, "/allocate", {
      userId: owner.id, agentId: agent.id, amountMicros: 10_000_000, idempotencyKey: "market-allocate",
    }, owner.id, ownerKeys.privateKey, "x-user-id")).status).toBe(200);
    expect((await signedPost(api.app, "/mandates", {
      userId: owner.id,
      agentId: agent.id,
      budgetMicros: 10_000_000,
      perTxCapMicros: 10_000_000,
      dailyCapMicros: 10_000_000,
      escalateAboveMicros: input.escalateAboveMicros ?? 10_000_000,
      newPayeeCapMicros: 10_000_000,
      idempotencyKey: "market-mandate",
    }, owner.id, ownerKeys.privateKey, "x-user-id")).status).toBe(200);
    const serviceResponse = await signedPost(api.app, "/services", {
      slug: "market-report",
      name: "Market report",
      description: "Fresh agent-economy data",
      endpointUrl: "https://seller.example/report",
      priceMicros: input.priceMicros ?? 50_000,
      idempotencyKey: "market-service",
    }, provider.id, providerKeys.privateKey, "x-provider-id");
    expect(serviceResponse.status).toBe(200);
    const service = await serviceResponse.json() as { id: string; address: string; replayed: boolean };
    return { owner, agent, provider, service, ownerKeys, agentKeys, providerKeys };
  }

  it("lets an independent seller challenge, collect, and serve one paid request", async () => {
    const { agent, provider, service, agentKeys, providerKeys } = await world();
    expect(service.address).toBe("@research-cloud/market-report");
    expect(await (await api.app.request("/catalog/research-cloud/market-report")).json()).toEqual(
      expect.objectContaining({ id: service.id, priceMicros: 50_000 })
    );
    expect(await (await api.app.request("/services")).json()).toEqual([
      expect.objectContaining({ id: service.id, address: service.address }),
    ]);

    const seller = new Hono();
    seller.get("/report", moneyPaid({
      networkUrl: "https://network.example",
      providerId: provider.id,
      providerKey: providerKeys.privateKey,
      serviceId: service.id,
      fetch: fetchThrough(api.app),
    }), (c) => c.json({ report: "Agents settle in micros." }));

    const first = await seller.request("/report");
    expect(first.status).toBe(402);
    const challenge = await first.json() as { challengeId: string; amountMicros: number; payTo: string };
    expect(challenge).toEqual(expect.objectContaining({ amountMicros: 50_000, payTo: provider.id }));
    const paidResponse = await signedPost(api.app, "/pay-challenge", {
      challengeId: challenge.challengeId,
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(paidResponse.status).toBe(200);
    const paid = await paidResponse.json() as { replayed: boolean; receipt: { id: string; amount: number } };
    expect(paid).toEqual(expect.objectContaining({
      replayed: false,
      receipt: expect.objectContaining({ amount: 50_000 }),
    }));

    const headers = {
      "x-payment-challenge": challenge.challengeId,
      "x-payment-receipt": paid.receipt.id,
    };
    const delivered = await seller.request("/report", { headers });
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toEqual({ report: "Agents settle in micros." });
    expect((await seller.request("/report", { headers })).status).toBe(402);

    const replay = await signedPost(api.app, "/pay-challenge", {
      challengeId: challenge.challengeId,
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(await replay.json()).toEqual(expect.objectContaining({
      status: "paid", replayed: true, receipt: expect.objectContaining({ id: paid.receipt.id }),
    }));
  });

  it("surfaces challenge-bound approvals in agent state and resumes after owner approval", async () => {
    const { owner, agent, service, ownerKeys, agentKeys, providerKeys, provider } = await world({
      priceMicros: 3_000_000,
      escalateAboveMicros: 2_000_000,
    });
    const client = createMoneySellerClient({
      networkUrl: "https://network.example",
      providerId: provider.id,
      providerKey: providerKeys.privateKey,
      fetch: fetchThrough(api.app),
    });
    const issued = await client.challenge(service.id);
    const challengeId = issued.body.challengeId as string;
    const requested = await signedPost(api.app, "/pay-challenge", { challengeId }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(requested.status).toBe(202);
    const pending = await requested.json() as any;
    expect(pending).toEqual(expect.objectContaining({
      status: "approval_required",
      approval: expect.objectContaining({
        challenge: expect.objectContaining({ id: challengeId, redeemed: false }),
      }),
    }));
    const state = await signedGet(api.app, "/agent/state", agent.id, agentKeys.privateKey, "x-agent-id");
    expect(await state.json()).toEqual(expect.objectContaining({
      approvals: [expect.objectContaining({
        id: pending.approval.id,
        challenge: expect.objectContaining({ id: challengeId }),
      })],
    }));

    const sessionResponse = await signedPost(api.app, "/owner/sessions", {}, owner.id, ownerKeys.privateKey, "x-user-id");
    const token = (await sessionResponse.json() as { token: string }).token;
    const approved = await api.app.request(`/owner/approvals/${pending.approval.id}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(approved.status).toBe(200);
    const resumed = await signedPost(api.app, "/pay-challenge", { challengeId }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(await resumed.json()).toEqual(expect.objectContaining({
      status: "paid",
      replayed: true,
      challenge: expect.objectContaining({ id: challengeId, paidBy: agent.id }),
    }));
  });

  it("lets only the paid provider issue retry-safe, capped refunds", async () => {
    const { owner, agent, provider, providerKeys, agentKeys } = await world();
    const purchaseResponse = await signedPost(api.app, "/pay", {
      to: provider.id,
      amountMicros: 500_000,
      memo: "report",
      idempotencyKey: "refund-purchase",
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    const purchase = await purchaseResponse.json() as { receipt: { id: string } };
    const seller = createMoneySellerClient({
      networkUrl: "https://network.example",
      providerId: provider.id,
      providerKey: providerKeys.privateKey,
      fetch: fetchThrough(api.app),
    });
    const terms = {
      receiptId: purchase.receipt.id,
      amountMicros: 200_000,
      memo: "partial refund",
      idempotencyKey: "refund-1",
    };
    const refunded = await seller.refund(terms);
    expect(refunded).toEqual(expect.objectContaining({
      status: 200,
      body: expect.objectContaining({
        status: "refunded",
        replayed: false,
        remaining: 300_000,
        receipt: expect.objectContaining({ refundOf: purchase.receipt.id }),
      }),
    }));
    expect(await seller.refund(terms)).toEqual(expect.objectContaining({
      status: 200,
      body: expect.objectContaining({ replayed: true, remaining: 300_000 }),
    }));
    expect((await seller.refund({ ...terms, amountMicros: 100_000 })).status).toBe(409);
    expect((await seller.refund({
      ...terms, amountMicros: 400_000, idempotencyKey: "refund-too-much",
    })).status).toBe(400);

    const mandate = await db.query<{ spent_micros: string }>(
      "select spent_micros::text as spent_micros from money.mandates where agent_id = $1",
      [agent.id]
    );
    expect(mandate.rows[0]?.spent_micros).toBe("500000");
    const balances = await db.query<{ id: string; amount: string }>(`
      select a.id, b.available_micros::text as amount
      from money.accounts a join money.balances b on b.account_id = a.id and b.asset_code = 'USD'
      where a.id = any($1::text[]) order by a.id
    `, [[agent.id, provider.id, owner.id]]);
    expect(Object.fromEntries(balances.rows.map((row) => [row.id, row.amount]))).toEqual(expect.objectContaining({
      [agent.id]: "9700000",
      [provider.id]: "300000",
    }));
  });

  it("rejects forged provider actions and malformed marketplace identifiers cleanly", async () => {
    const { agent, provider, service, ownerKeys, agentKeys, providerKeys } = await world();
    const forged = await signedPost(api.app, "/services", {
      slug: "forged",
      name: "Forged",
      endpointUrl: "https://evil.example",
      priceMicros: 1,
      idempotencyKey: "forged-service",
    }, provider.id, ownerKeys.privateKey, "x-provider-id");
    expect(forged.status).toBe(401);
    expect((await signedPost(api.app, "/merchant/challenges", {
      serviceId: "not-a-uuid",
    }, provider.id, providerKeys.privateKey, "x-provider-id")).status).toBe(400);
    expect((await signedPost(api.app, "/pay-challenge", {
      challengeId: "not-a-uuid",
    }, agent.id, agentKeys.privateKey, "x-agent-id")).status).toBe(400);
    expect((await api.app.request(`/services/${service.id}`)).status).toBe(200);
  });
});
