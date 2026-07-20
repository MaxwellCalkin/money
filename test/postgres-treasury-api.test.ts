import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAgentKeypair, signedHeaders } from "../src/core/identity.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createPostgresApi } from "../src/server/postgres-api.ts";

class EmbeddedPostgres implements TransactionalDatabase {
  constructor(readonly pg: PGliteInterface) {}
  async query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<QueryRows<T>> {
    const result = await this.pg.query<T>(text, [...values]);
    return { rows: result.rows, affectedRows: result.affectedRows };
  }
  async executeScript(text: string) { await this.pg.exec(text); }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (transaction: Transaction) => work({
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        const result = await transaction.query<R>(text, [...values]);
        return { rows: result.rows, affectedRows: result.affectedRows };
      },
      executeScript: async (text: string) => { await transaction.exec(text); },
    }));
  }
  async close() { await this.pg.close(); }
}

type IdentityHeader = "x-user-id" | "x-provider-id";

function signed(
  app: ReturnType<typeof createPostgresApi>["app"],
  path: string,
  body: unknown,
  accountId: string,
  privateKey: string,
  header: IdentityHeader,
  method: "GET" | "POST" = "POST"
) {
  const encoded = method === "GET" ? "" : JSON.stringify(body);
  return app.request(path, {
    method,
    headers: {
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...signedHeaders(accountId, privateKey, { method, path, body: encoded }, header),
    },
    ...(method === "POST" ? { body: encoded } : {}),
  });
}

describe("signed treasury product API", () => {
  let db: EmbeddedPostgres;
  let api: ReturnType<typeof createPostgresApi>;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    api = createPostgresApi(db, { allowDevelopmentFunding: true });
    await api.treasury.configureControls({
      fundingEnabled: true, payoutsEnabled: true, externalSpendEnabled: true,
      maxPayoutMicros: 100_000_000_000n, maxPendingPayoutMicros: 1_000_000_000_000n,
      maxOpenExposureMicros: 100_000_000_000n, maxReconciliationVarianceMicros: 1_000_000n,
      reason: "test fixture enables treasury controls",
    });
  }, 30_000);
  afterEach(async () => { await db.close(); });

  async function signup(name: string, handle: string) {
    const keys = generateAgentKeypair();
    const response = await api.app.request("/users", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, handle, publicKey: keys.publicKey }),
    });
    expect(response.status).toBe(200);
    return { account: await response.json() as { id: string }, keys };
  }

  async function fund(userId: string, privateKey: string, key: string) {
    const response = await signed(api.app, "/fund", {
      userId, amountMicros: 2_000_000, idempotencyKey: key,
    }, userId, privateKey, "x-user-id");
    expect(response.status).toBe(200);
  }

  it("scopes owner payout creation, replay, cancellation, and state", async () => {
    const { account: owner, keys } = await signup("Treasury API Owner", "treasury-api-owner");
    const { account: other, keys: otherKeys } = await signup("Other Treasury Owner", "other-treasury-owner");
    await fund(owner.id, keys.privateKey, "fund-owner-treasury-api");
    await fund(other.id, otherKeys.privateKey, "fund-other-treasury-api");
    const destination = await api.treasury.registerDestination({
      accountId: owner.id, provider: "column", providerRef: "ctpy_api_owner", label: "Verified checking",
    });

    const body = { destinationId: destination.id, amountMicros: 500_000, idempotencyKey: "owner-api-payout" };
    const first = await signed(api.app, "/owner/payouts", body, owner.id, keys.privateKey, "x-user-id");
    expect(first.status).toBe(202);
    const firstJson = await first.json() as any;
    expect(firstJson).toEqual(expect.objectContaining({
      replayed: false,
      payout: expect.objectContaining({ destinationId: destination.id, amountMicros: 500_000, state: "queued" }),
    }));
    const replay = await signed(api.app, "/owner/payouts", body, owner.id, keys.privateKey, "x-user-id");
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(expect.objectContaining({
      replayed: true, payout: expect.objectContaining({ id: firstJson.payout.id }),
    }));

    const foreign = await signed(api.app, "/owner/payouts", {
      destinationId: destination.id, amountMicros: 100_000, idempotencyKey: "foreign-destination",
    }, other.id, otherKeys.privateKey, "x-user-id");
    expect(foreign.status).toBe(403);

    const cancelled = await signed(
      api.app, `/owner/payouts/${firstJson.payout.id}/cancel`, {}, owner.id, keys.privateKey, "x-user-id"
    );
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual(expect.objectContaining({
      payout: expect.objectContaining({ id: firstJson.payout.id, state: "cancelled" }),
    }));
    const state = await signed(api.app, "/owner/treasury", {}, owner.id, keys.privateKey, "x-user-id", "GET");
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual(expect.objectContaining({
      destinations: [expect.objectContaining({ id: destination.id, label: "Verified checking" })],
      payouts: [expect.objectContaining({ id: firstJson.payout.id, state: "cancelled" })],
      controls: expect.objectContaining({ payoutsEnabled: true }),
    }));
  });

  it("requires the provider itself to sign and fails closed when the breaker is open", async () => {
    const { account: owner, keys } = await signup("Provider Owner", "provider-owner-treasury");
    await fund(owner.id, keys.privateKey, "fund-provider-owner");
    const providerKeys = generateAgentKeypair();
    const created = await signed(api.app, "/providers", {
      ownerId: owner.id, name: "Treasury Merchant", handle: "treasury-merchant", publicKey: providerKeys.publicKey,
    }, owner.id, keys.privateKey, "x-user-id");
    expect(created.status).toBe(200);
    const provider = await created.json() as { id: string };
    const ownerDestination = await api.treasury.registerDestination({
      accountId: owner.id, provider: "column", providerRef: "ctpy_owner_not_provider", label: "Owner only",
    });
    const scoped = await signed(api.app, "/provider/payouts", {
      destinationId: ownerDestination.id, amountMicros: 100_000, idempotencyKey: "provider-cross-scope",
    }, provider.id, providerKeys.privateKey, "x-provider-id");
    expect(scoped.status).toBe(403);

    await api.treasury.configureControls({
      fundingEnabled: false, payoutsEnabled: false, externalSpendEnabled: false,
      maxPayoutMicros: 100_000_000_000n, maxPendingPayoutMicros: 1_000_000_000_000n,
      maxOpenExposureMicros: 100_000_000_000n, maxReconciliationVarianceMicros: 1_000_000n,
      reason: "operator incident test",
    });
    const blocked = await signed(api.app, "/owner/payouts", {
      destinationId: ownerDestination.id, amountMicros: 100_000, idempotencyKey: "breaker-blocked",
    }, owner.id, keys.privateKey, "x-user-id");
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toEqual(expect.objectContaining({ error: "treasury_unavailable" }));
  });
});
