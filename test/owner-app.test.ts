import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAgentKeypair, signedHeaders } from "../src/core/identity.ts";
import { MockIssuer } from "../src/cards/mock-issuer.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { PostgresTreasury } from "../src/db/treasury.ts";
import { ownerAppHtml } from "../src/server/owner-app.ts";
import { createPostgresApi } from "../src/server/postgres-api.ts";
import { approveComplianceFixture, clearCounterpartyFixture } from "./helpers/compliance-fixture.ts";
// @ts-expect-error plain-mjs helper without type declarations
import { scanText } from "../scripts/lint-vocabulary.mjs";

const SANDBOX_SENTENCE = "SANDBOX — no real funds; nothing here is a bank, card, or deposit account.";

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

type Api = ReturnType<typeof createPostgresApi>;
type IdHeader = "x-user-id" | "x-agent-id" | "x-provider-id";

function signedRequest(
  app: Api["app"],
  path: string,
  method: "GET" | "POST" | "DELETE",
  value: unknown,
  accountId: string,
  privateKey: string,
  idHeader: IdHeader
) {
  const body = method === "GET" ? "" : JSON.stringify(value);
  return app.request(path, {
    method,
    headers: {
      ...(method !== "GET" ? { "content-type": "application/json" } : {}),
      ...signedHeaders(accountId, privateKey, { method, path, body }, idHeader),
    },
    ...(method !== "GET" ? { body } : {}),
  });
}

function bearerRequest(
  app: Api["app"],
  path: string,
  method: "GET" | "POST" | "DELETE",
  token: string,
  value?: unknown
) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method !== "GET" ? { "content-type": "application/json" } : {}),
    },
    ...(method !== "GET" ? { body: JSON.stringify(value ?? {}) } : {}),
  });
}

describe("owner app (Postgres API dashboard)", () => {
  let db: EmbeddedPostgres;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
  }, 30_000);

  afterEach(async () => {
    await db.close();
  });

  async function signup(api: Api, name: string, handle: string) {
    const keys = generateAgentKeypair();
    const response = await api.app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, handle, publicKey: keys.publicKey }),
    });
    expect(response.status).toBe(200);
    const user = await response.json() as { id: string };
    await approveComplianceFixture(db, user.id);
    return { user, keys };
  }

  async function createAgent(api: Api, ownerId: string, ownerPrivateKey: string, name: string, handle: string) {
    const keys = generateAgentKeypair();
    const response = await signedRequest(
      api.app, "/agents", "POST",
      { name, handle, ownerId, publicKey: keys.publicKey },
      ownerId, ownerPrivateKey, "x-user-id"
    );
    expect(response.status).toBe(200);
    return { agent: await response.json() as { id: string }, keys };
  }

  async function session(api: Api, userId: string, privateKey: string) {
    const response = await signedRequest(api.app, "/owner/sessions", "POST", {}, userId, privateKey, "x-user-id");
    expect(response.status).toBe(200);
    return (await response.json() as { token: string }).token;
  }

  it("flagship page is self-contained and honest", async () => {
    const api = createPostgresApi(db, { allowDevelopmentFunding: true, allowSessionOwnerWrites: true });
    const res = await api.app.request("/dashboard");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    const html = await res.text();

    // Fully self-contained: no external scripts, styles, imports, or fetches.
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/@import/);
    expect(html).not.toMatch(/url\(http/i);

    // The one inline script parses as JavaScript.
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();

    // Honest sandbox label and the exact-approval verb.
    expect(html).toContain(SANDBOX_SENTENCE);
    expect(html).toContain("Approve exact payment");

    // The card-rail lexicon holds on this surface (extends the vocabulary
    // gate beyond the file list scripts/lint-vocabulary.mjs walks itself).
    expect(scanText(html)).toEqual([]);

    // No 13-19 digit runs anywhere in the page (PAN hygiene).
    expect(html).not.toMatch(/\d{13}/);

    // The client renders exclusively from ownerSnapshot: every `s.<key>`
    // reference in the page script must be a key ownerSnapshot serves.
    const snapshotKeys = new Set([
      "now", "integrity", "accounts", "services", "mandates",
      "approvals", "feed", "external", "cards", "treasury", "compliance",
    ]);
    const used = [...new Set([...script!.matchAll(/\bs\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]!))];
    expect(used.length).toBeGreaterThan(5);
    for (const key of used) {
      expect(snapshotKeys.has(key), `client reads s.${key}, which ownerSnapshot does not serve`).toBe(true);
    }

    // Production rendering: same sheets, but writes are owner-signed and the
    // sandbox sentence is absent.
    const production = ownerAppHtml({ sessionOwnerWrites: false, developmentFunding: false });
    expect(production).toContain("owner-signed");
    expect(production).toContain("npm run onboard");
    expect(production).not.toContain(SANDBOX_SENTENCE);
    expect(scanText(production)).toEqual([]);
  });

  it("a session alone cannot move money in production mode", async () => {
    // Dev funding is enabled so ONLY the auth model is under test.
    const api = createPostgresApi(db, { allowDevelopmentFunding: true });
    const { user, keys } = await signup(api, "Max", "max");
    const { agent } = await createAgent(api, user.id, keys.privateKey, "Scout", "scout");
    const preGranted = await signedRequest(api.app, "/mandates", "POST", {
      userId: user.id, agentId: agent.id, budgetMicros: 10_000_000,
      perTxCapMicros: 10_000_000, dailyCapMicros: 10_000_000,
      escalateAboveMicros: 10_000_000, newPayeeCapMicros: 10_000_000,
      idempotencyKey: "pre-granted-mandate",
    }, user.id, keys.privateKey, "x-user-id");
    expect(preGranted.status).toBe(200);
    const preGrantedId = (await preGranted.json() as { id: string }).id;
    const token = await session(api, user.id, keys.privateKey);

    // Every owner-money write refuses the bearer token with the
    // signed-request-required reason.
    const attempts: Array<[string, unknown]> = [
      ["/fund", { userId: user.id, amountMicros: 5_000_000, idempotencyKey: "bearer-fund" }],
      ["/allocate", { userId: user.id, agentId: agent.id, amountMicros: 1_000_000, idempotencyKey: "bearer-allocate" }],
      ["/mandates", {
        userId: user.id, agentId: agent.id, budgetMicros: 99_000_000,
        perTxCapMicros: 99_000_000, dailyCapMicros: 99_000_000,
        escalateAboveMicros: 99_000_000, newPayeeCapMicros: 99_000_000,
        idempotencyKey: "bearer-mandate",
      }],
      [`/mandates/${preGrantedId}/revoke`, {}],
    ];
    for (const [path, body] of attempts) {
      const response = await bearerRequest(api.app, path, "POST", token, body);
      expect(response.status, path).toBe(401);
      expect((await response.json() as { reason: string }).reason, path).toMatch(/signed request required/);
    }

    // Provably unchanged: no account funded, no second mandate, the
    // pre-created mandate still unrevoked.
    const state = await signedRequest(api.app, "/owner/state", "GET", undefined, user.id, keys.privateKey, "x-user-id");
    expect(state.status).toBe(200);
    const snapshot = await state.json() as {
      accounts: Array<{ id: string; balanceMicros: number }>;
      mandates: Array<{ id: string; revoked: boolean }>;
    };
    for (const account of snapshot.accounts) expect(account.balanceMicros, account.id).toBe(0);
    expect(snapshot.mandates).toHaveLength(1);
    expect(snapshot.mandates[0]).toMatchObject({ id: preGrantedId, revoked: false });

    // The signature fallback path is byte-identical: the same four requests,
    // owner-signed, all succeed.
    expect((await signedRequest(api.app, "/fund", "POST",
      { userId: user.id, amountMicros: 5_000_000, idempotencyKey: "signed-fund" },
      user.id, keys.privateKey, "x-user-id")).status).toBe(200);
    expect((await signedRequest(api.app, "/allocate", "POST",
      { userId: user.id, agentId: agent.id, amountMicros: 1_000_000, idempotencyKey: "signed-allocate" },
      user.id, keys.privateKey, "x-user-id")).status).toBe(200);
    const regrant = await signedRequest(api.app, "/mandates", "POST", {
      userId: user.id, agentId: agent.id, budgetMicros: 2_000_000,
      perTxCapMicros: 2_000_000, dailyCapMicros: 2_000_000,
      escalateAboveMicros: 2_000_000, newPayeeCapMicros: 2_000_000,
      idempotencyKey: "signed-mandate",
    }, user.id, keys.privateKey, "x-user-id");
    expect(regrant.status).toBe(200);
    const regrantId = (await regrant.json() as { id: string }).id;
    expect((await signedRequest(api.app, `/mandates/${regrantId}/revoke`, "POST", {},
      user.id, keys.privateKey, "x-user-id")).status).toBe(200);
  });

  it("sandbox session writes work and stay tuple-bound", async () => {
    const api = createPostgresApi(db, { allowDevelopmentFunding: true, allowSessionOwnerWrites: true });
    const { user, keys } = await signup(api, "Max", "max");
    const { agent } = await createAgent(api, user.id, keys.privateKey, "Scout", "scout");
    const token = await session(api, user.id, keys.privateKey);

    const funded = await bearerRequest(api.app, "/fund", "POST", token,
      { userId: user.id, amountMicros: 20_000_000, idempotencyKey: "sb-fund" });
    expect(funded.status).toBe(200);
    expect(await funded.json()).toEqual(expect.objectContaining({ status: "posted" }));

    const allocateBody = { userId: user.id, agentId: agent.id, amountMicros: 5_000_000, idempotencyKey: "sb-allocate" };
    const allocated = await bearerRequest(api.app, "/allocate", "POST", token, allocateBody);
    expect(allocated.status).toBe(200);
    expect(await allocated.json()).toEqual(expect.objectContaining({ status: "posted", replayed: false }));

    // Exact replay returns the prior result and never double-debits.
    const replay = await bearerRequest(api.app, "/allocate", "POST", token, allocateBody);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(expect.objectContaining({ status: "posted", replayed: true }));
    expect(await api.ledger.balance(agent.id)).toBe(5_000_000n);
    expect(await api.ledger.balance(user.id)).toBe(15_000_000n);

    const granted = await bearerRequest(api.app, "/mandates", "POST", token, {
      userId: user.id, agentId: agent.id, budgetMicros: 5_000_000,
      perTxCapMicros: 5_000_000, dailyCapMicros: 5_000_000,
      escalateAboveMicros: 5_000_000, newPayeeCapMicros: 5_000_000,
      idempotencyKey: "sb-mandate",
    });
    expect(granted.status).toBe(200);
    const mandateId = (await granted.json() as { id: string }).id;

    // The tuple binding survives session auth: the body userId must equal the
    // session's resolved owner.
    const forged = await bearerRequest(api.app, "/allocate", "POST", token,
      { userId: "someone-else", agentId: agent.id, amountMicros: 1_000_000, idempotencyKey: "sb-forged" });
    expect(forged.status).toBe(400);
    expect(await forged.json()).toEqual(expect.objectContaining({ error: "invalid_request" }));

    // A second owner's session gets no authority over the first owner's world.
    const { user: mallory, keys: malloryKeys } = await signup(api, "Mallory", "mallory");
    const malloryToken = await session(api, mallory.id, malloryKeys.privateKey);
    const crossUser = await bearerRequest(api.app, "/allocate", "POST", malloryToken,
      { userId: user.id, agentId: agent.id, amountMicros: 1_000_000, idempotencyKey: "cross-user" });
    expect(crossUser.status).toBe(400); // body userId is not Mallory's session owner
    const crossAgent = await bearerRequest(api.app, "/allocate", "POST", malloryToken,
      { userId: mallory.id, agentId: agent.id, amountMicros: 1_000_000, idempotencyKey: "cross-agent" });
    expect([400, 403, 404]).toContain(crossAgent.status); // kernel: allocate only to your own agent
    const crossMandate = await bearerRequest(api.app, "/mandates", "POST", malloryToken, {
      userId: mallory.id, agentId: agent.id, budgetMicros: 1_000_000,
      perTxCapMicros: 1_000_000, dailyCapMicros: 1_000_000,
      escalateAboveMicros: 1_000_000, newPayeeCapMicros: 1_000_000,
      idempotencyKey: "cross-mandate",
    });
    expect([400, 403, 404]).toContain(crossMandate.status);
    const crossRevoke = await bearerRequest(api.app, `/mandates/${mandateId}/revoke`, "POST", malloryToken, {});
    expect([400, 403, 404]).toContain(crossRevoke.status);
    const intact = await bearerRequest(api.app, "/owner/state", "GET", token);
    const intactSnapshot = await intact.json() as {
      accounts: Array<{ id: string; balanceMicros: number }>;
      mandates: Array<{ id: string; revoked: boolean }>;
    };
    expect(intactSnapshot.accounts.find((account) => account.id === agent.id)?.balanceMicros).toBe(5_000_000);
    expect(intactSnapshot.mandates.find((mandate) => mandate.id === mandateId)?.revoked).toBe(false);

    // The owner's own session can revoke; a revoked session cannot write.
    const revoked = await bearerRequest(api.app, `/mandates/${mandateId}/revoke`, "POST", token, {});
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual(expect.objectContaining({ ok: true, changed: true }));
    expect((await bearerRequest(api.app, "/owner/sessions/current", "DELETE", token)).status).toBe(200);
    const afterLogout = await bearerRequest(api.app, "/allocate", "POST", token,
      { userId: user.id, agentId: agent.id, amountMicros: 1_000_000, idempotencyKey: "after-logout" });
    expect(afterLogout.status).toBe(401);
  });

  it("dashboard state auth is unchanged and the snapshot carries every field the page renders", async () => {
    const treasury = new PostgresTreasury(db);
    await treasury.configureControls({
      fundingEnabled: true, payoutsEnabled: true, externalSpendEnabled: true,
      maxPayoutMicros: 100_000_000_000n, maxPendingPayoutMicros: 1_000_000_000_000n,
      maxOpenExposureMicros: 100_000_000_000n, maxReconciliationVarianceMicros: 1_000_000n,
      reason: "owner-app test enables treasury controls",
    });
    await treasury.setCardSpendEnabled(true, "owner-app test enables card spend");
    const issuer = new MockIssuer();
    const api = createPostgresApi(db, {
      allowDevelopmentFunding: true, allowSessionOwnerWrites: true, cardIssuer: issuer,
    });
    const { user, keys } = await signup(api, "Max", "max");
    const { agent, keys: agentKeys } = await createAgent(api, user.id, keys.privateKey, "Scout", "scout");

    expect((await api.app.request("/dashboard/state")).status).toBe(401);

    const token = await session(api, user.id, keys.privateKey);
    expect((await bearerRequest(api.app, "/fund", "POST", token,
      { userId: user.id, amountMicros: 50_000_000, idempotencyKey: "world-fund" })).status).toBe(200);
    expect((await bearerRequest(api.app, "/allocate", "POST", token,
      { userId: user.id, agentId: agent.id, amountMicros: 20_000_000, idempotencyKey: "world-allocate" })).status).toBe(200);
    expect((await bearerRequest(api.app, "/mandates", "POST", token, {
      userId: user.id, agentId: agent.id, budgetMicros: 20_000_000,
      perTxCapMicros: 10_000_000, dailyCapMicros: 20_000_000,
      escalateAboveMicros: 6_000_000, newPayeeCapMicros: 10_000_000,
      idempotencyKey: "world-mandate",
    })).status).toBe(200);

    // One pending and one rejected escalation (the decline row in the feed).
    const pendingAsk = await signedRequest(api.app, "/pay", "POST",
      { to: user.id, amountMicros: 7_000_000, memo: "large research job", idempotencyKey: "world-pending" },
      agent.id, agentKeys.privateKey, "x-agent-id");
    expect(pendingAsk.status).toBe(202);
    const rejectedAsk = await signedRequest(api.app, "/pay", "POST",
      { to: user.id, amountMicros: 8_000_000, memo: "bulk order", idempotencyKey: "world-rejected" },
      agent.id, agentKeys.privateKey, "x-agent-id");
    expect(rejectedAsk.status).toBe(202);
    const rejectedId = ((await rejectedAsk.json()) as { approval: { id: string } }).approval.id;
    const reject = await bearerRequest(api.app, `/owner/approvals/${rejectedId}/reject`, "POST", token,
      { reason: "Declined in owner app" });
    expect(reject.status).toBe(200);

    // One reserved card via the mock issuer (merchant screened, cap under the
    // new-payee throttle), and a recorded ledger verdict.
    await clearCounterpartyFixture(db, "card:hint:mock-shop.example", "merchant");
    const card = await signedRequest(api.app, "/cards", "POST",
      { idempotencyKey: "world-card", capUsd: 5, merchantHint: "mock-shop.example" },
      agent.id, agentKeys.privateKey, "x-agent-id");
    expect(card.status).toBe(200);
    expect((await card.json() as { status: string }).status).toBe("active");
    await db.query("select * from money_private.record_ledger_health()");

    const res = await bearerRequest(api.app, "/dashboard/state", "GET", token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // No CORS headers: a cross-origin page cannot carry the bearer token.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const state = await res.json() as any;

    // Top-level contract.
    for (const key of ["now", "integrity", "accounts", "services", "mandates", "approvals", "feed", "external", "cards", "treasury"]) {
      expect(state, key).toHaveProperty(key);
    }
    expect(state.integrity).toEqual({ zeroSum: true, receiptsOk: true, verifiedAt: expect.any(Number) });

    // accountView fields the agent cards and owner-funds panel read.
    const ownerAccount = state.accounts.find((account: any) => account.kind === "user");
    const agentAccount = state.accounts.find((account: any) => account.kind === "agent");
    expect(ownerAccount).toMatchObject({ id: user.id, name: "Max", handle: "max", status: "active", balanceMicros: 30_000_000 });
    expect(agentAccount).toMatchObject({ id: agent.id, handle: "scout", status: "active", balanceMicros: 15_000_000 });

    // mandateView fields the meter reads (view names, no Micros suffix).
    expect(state.mandates[0]).toMatchObject({
      id: expect.any(String), agentId: agent.id,
      budget: 20_000_000, perTxCap: 10_000_000, dailyCap: 20_000_000,
      escalateAbove: 6_000_000, newPayeeCap: 10_000_000,
      spent: 5_000_000, spentToday: 5_000_000,
      expiresAt: expect.any(Number), revoked: false, createdAt: expect.any(Number),
    });

    // approvalView fields the prompt and the decline rows read.
    const pending = state.approvals.find((approval: any) => approval.status === "pending");
    expect(pending).toMatchObject({
      id: expect.any(String), agentId: agent.id, to: user.id, amount: 7_000_000,
      memo: "large research job", createdAt: expect.any(Number), expiresAt: expect.any(Number),
    });
    const rejected = state.approvals.find((approval: any) => approval.status === "rejected");
    expect(rejected).toMatchObject({
      id: rejectedId, amount: 8_000_000, reason: "Declined in owner app", resolvedAt: expect.any(Number),
    });

    // evidenceView fields the feed rows read.
    expect(state.feed.length).toBeGreaterThan(0);
    expect(state.feed[0]).toMatchObject({
      seq: expect.any(Number), id: expect.any(String), ts: expect.any(Number),
      transferId: expect.any(String), from: expect.any(String), to: expect.any(String),
      amount: expect.anything(), hash: expect.any(String),
    });

    // cardView fields the reserved-card rows read.
    expect(state.cards[0]).toMatchObject({
      id: expect.any(String), agentId: agent.id, state: "pending",
      capMicros: 5_000_000, capDisplay: "$5.00",
      heldMicros: expect.anything(), settledMicros: expect.anything(),
      singleUse: true, merchantHint: "mock-shop.example",
      expiresAt: expect.any(Number), revealCount: expect.any(Number),
    });

    // treasury fields the panel reads.
    expect(state.treasury.controls).toMatchObject({
      fundingEnabled: true, payoutsEnabled: true, externalSpendEnabled: true,
    });
    for (const key of ["destinations", "payouts", "fundings", "exposures"]) {
      expect(Array.isArray(state.treasury[key]), `treasury.${key}`).toBe(true);
    }

    // compliance chip fields.
    expect(state.compliance).toMatchObject({ state: "approved", screeningState: "clear" });

    // Session auth still bites: no token, no snapshot.
    expect((await api.app.request("/dashboard/state")).status).toBe(401);
  }, 30_000);
});

describe("owner app client rendering", () => {
  // Runs the page's real inline script in a minimal hand-rolled DOM stub (no
  // new dependencies): sessionStorage hands the script a token, fetch serves a
  // hostile snapshot, and the render pass writes innerHTML into stub elements
  // we can assert against. This locks two contracts at once:
  //   1. every snapshot-derived string is escaped before it reaches innerHTML
  //      (XSS regression guard on the feed, agent cards, approvals, cards,
  //      services, and treasury surfaces), and
  //   2. the client's nested field names match what ownerSnapshot serves —
  //      a typo (card.capMicros vs cap, mandate.spent vs spentMicros) breaks
  //      the pinned dollar figures below.

  function stubElement(id: string) {
    const classes = new Set<string>();
    return {
      id,
      value: "",
      textContent: "",
      innerHTML: "",
      dataset: {} as Record<string, string>,
      classList: {
        add: (...cs: string[]) => { for (const c of cs) classes.add(c); },
        remove: (...cs: string[]) => { for (const c of cs) classes.delete(c); },
        toggle: (c: string, force?: boolean) => {
          const on = force === undefined ? !classes.has(c) : Boolean(force);
          if (on) classes.add(c); else classes.delete(c);
          return on;
        },
        contains: (c: string) => classes.has(c),
      },
      addEventListener: () => {},
      setAttribute: () => {},
      getAttribute: () => null,
      close: () => {},
      showModal: () => {},
      querySelector: () => null,
    };
  }

  // Synthetic click targets. Injected into the page script as `Element` so the
  // delegated handler's `event.target instanceof Element` check passes.
  class SyntheticTarget {
    constructor(readonly attrs: Record<string, string>) {}
    closest(selector: string) {
      if (selector === "button") return null;
      return this.attrs["data-action"] || this.attrs["data-preset"] ? this : null;
    }
    getAttribute(name: string) { return this.attrs[name] ?? null; }
  }

  type FetchCall = { method: string; path: string; body: any };
  type Routed = { status: number; json?: unknown } | null | undefined;

  async function renderWithSnapshot(
    snapshot: unknown,
    route?: (method: string, path: string, body: any) => Routed
  ) {
    const html = ownerAppHtml({ sessionOwnerWrites: true, developmentFunding: true });
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();

    const elements = new Map<string, ReturnType<typeof stubElement>>();
    const byId = (id: string) => {
      let element = elements.get(id);
      if (!element) { element = stubElement(id); elements.set(id, element); }
      return element;
    };
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const documentStub = {
      getElementById: byId,
      documentElement: { dataset: {} as Record<string, string> },
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        const bucket = listeners.get(type) ?? [];
        bucket.push(listener);
        listeners.set(type, bucket);
      },
      querySelectorAll: () => [],
      hidden: false,
    };
    const storageStub = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const sessionStorageStub = {
      getItem: (key: string) => (key === "money_owner_token" ? "test-render-token" : null),
      setItem: () => {},
      removeItem: () => {},
    };
    const calls: FetchCall[] = [];
    const fetchStub = async (path: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: String(path), body });
      if (method === "GET" && String(path).startsWith("/dashboard/state")) {
        return { ok: true, status: 200, json: async () => snapshot };
      }
      const routed = route ? route(method, String(path), body) : null;
      if (routed) {
        return {
          ok: routed.status >= 200 && routed.status < 300,
          status: routed.status,
          json: async () => routed.json ?? {},
        };
      }
      throw new Error("unexpected fetch " + method + " " + path);
    };

    const run = new Function(
      "document", "localStorage", "sessionStorage", "location", "history",
      "fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "Element",
      script!
    );
    run(
      documentStub, storageStub, sessionStorageStub,
      { hash: "", pathname: "/dashboard", search: "" }, { replaceState: () => {} },
      fetchStub, () => 0, () => {}, () => 0, () => {}, SyntheticTarget
    );
    // refresh() (and the async write handlers) await fetch then res.json();
    // flush the microtask queue several rounds so chained awaits settle.
    const flush = async (rounds = 8) => {
      for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    await flush();
    // Dispatch a click through the page's own delegated handler.
    const click = async (attrs: Record<string, string>) => {
      for (const listener of listeners.get("click") ?? []) {
        listener({ target: new SyntheticTarget(attrs), preventDefault: () => {} });
      }
      await flush();
    };
    return { byId, calls, click, flush };
  }

  it("escapes hostile snapshot fields end-to-end and renders every nested field", async () => {
    const now = Date.now();
    const later = now + 3_600_000;
    const XSS_NAME = "<script>alert(1)</script>";
    const XSS_ATTR = '"><img src=x onerror=alert(2)>';
    const snapshot = {
      now,
      integrity: { zeroSum: true, receiptsOk: true, verifiedAt: now },
      accounts: [
        { id: "user_1", kind: "user", name: "Max " + XSS_NAME, handle: "max", status: "active", balanceMicros: 30_000_000 },
        { id: "agent_1", kind: "agent", name: XSS_NAME, handle: "scout" + XSS_ATTR, status: "active", balanceMicros: 15_000_000 },
      ],
      services: [{ address: "svc " + XSS_NAME, name: "svc", endpointUrl: "https://x/" + XSS_ATTR, priceDisplay: "$1.00" }],
      mandates: [{
        id: "man_1", agentId: "agent_1", budget: 20_000_000, perTxCap: 10_000_000,
        dailyCap: 20_000_000, escalateAbove: 6_000_000, newPayeeCap: 10_000_000,
        spent: 5_000_000, spentToday: 5_000_000, expiresAt: later, revoked: false, createdAt: now,
      }],
      approvals: [
        {
          id: "appr_1", agentId: "agent_1", to: "user_1", amount: 7_000_000, status: "pending",
          memo: "job " + XSS_NAME, createdAt: now, expiresAt: later,
        },
        {
          id: "appr_2", agentId: "agent_1", to: "user_1", amount: 8_000_000, status: "rejected",
          memo: "bulk " + XSS_ATTR, reason: "declined " + XSS_NAME, createdAt: now, expiresAt: later, resolvedAt: now,
        },
      ],
      feed: [{
        seq: 1, id: "rcpt_1", ts: now, transferId: "tr_1", from: "agent_1", to: "ext_shop",
        amount: 1_000_000, hash: "abc123", memo: "buy " + XSS_NAME, mandateId: "man_1",
        fromAccount: { id: "agent_1", name: XSS_NAME, handle: "scout" + XSS_ATTR },
        toAccount: { id: "ext_shop", name: "shop " + XSS_NAME },
      }],
      external: [{
        id: "ext_1", state: "reversed", agentId: "agent_1", host: "evil.example" + XSS_ATTR,
        amountMicros: 2_000_000, updatedAt: now, transferId: "tr_2", receiptId: "rcpt_2",
      }],
      cards: [{
        id: "card_1", agentId: "agent_1", state: "pending", capMicros: 5_000_000, capDisplay: "$5.00",
        heldMicros: 0, settledMicros: 0, singleUse: true, merchantHint: "shop.example" + XSS_ATTR,
        expiresAt: later, revealCount: 0, last4: "1234", closeRequestedAt: null,
      }],
      treasury: {
        controls: {
          fundingEnabled: true, payoutsEnabled: true, externalSpendEnabled: false,
          breakerReason: "paused " + XSS_NAME,
        },
        destinations: [], payouts: [], fundings: [], exposures: [],
      },
      compliance: { state: "approved", screeningState: "clear" },
    };

    const { byId } = await renderWithSnapshot(snapshot);

    // The render pass completed: an exception anywhere in render() would land
    // in refresh()'s catch and leave the pill on "reconnecting".
    expect(byId("netText").textContent).toBe("live · private");
    expect(byId("modeChip").textContent).toBe("sandbox");

    const surfaces = [
      "apprList", "agentGrid", "feedList", "cardList", "serviceList",
      "treasuryRows", "treasuryStrip", "complianceRow", "ownerActions",
    ];
    const rendered = surfaces.map((id) => byId(id).innerHTML).join("\n");

    // No hostile markup survives anywhere on any surface: no tag ever forms
    // (the payload text may remain, inert, because its brackets and quotes
    // are escaped) and no attribute breakout happens.
    expect(rendered).not.toContain("<script>alert");
    expect(rendered).not.toContain("<img");
    expect(rendered).not.toContain('"><img');
    // ...because it was escaped, not dropped.
    expect(rendered).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(rendered).toContain("&quot;&gt;&lt;img");
    expect(byId("agentGrid").innerHTML).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(byId("feedList").innerHTML).toContain("buy &lt;script&gt;");
    expect(byId("apprList").innerHTML).toContain("job &lt;script&gt;");
    expect(byId("treasuryStrip").innerHTML).toContain("paused &lt;script&gt;");

    // Nested-field contract: these figures only appear when the client reads
    // the exact field names ownerSnapshot serves.
    expect(byId("ownerFigure").textContent).toBe("$30.00");             // owner balanceMicros
    expect(byId("setAside").textContent).toContain("$15.00");           // agent balanceMicros
    expect(byId("agentGrid").innerHTML).toContain("spent $5.00 of $20.00 mandate"); // mandate spent/budget
    expect(byId("agentGrid").innerHTML).toContain("asks above $6.00");  // mandate escalateAbove
    expect(byId("apprList").innerHTML).toContain("$7.00");              // approval amount
    expect(byId("cardList").innerHTML).toContain("·· 1234");            // card last4
    expect(byId("cardList").innerHTML).toContain("reserved $5.00");     // card capDisplay
    expect(byId("feedCount").textContent).toBe("3 entries");            // receipt + rejected + reversed
    expect(byId("complianceRow").innerHTML).toContain("identity verified");
  });

  // A small legible world for driving the write handlers through the page's
  // own delegated click handler (not by calling server routes directly).
  function writeWorld() {
    const now = Date.now();
    const later = now + 30 * 86_400_000;
    return {
      now,
      integrity: { zeroSum: true, receiptsOk: true, verifiedAt: now },
      accounts: [
        { id: "user_1", kind: "user", name: "Max", handle: "max", status: "active", balanceMicros: 30_000_000 },
        { id: "agent_1", kind: "agent", name: "Scout", handle: "scout", status: "active", balanceMicros: 15_000_000 },
      ],
      services: [],
      mandates: [{
        // Sub-cent caps (CLI-granted): $0.505 per payment, $0.25 new payee.
        id: "man_1", agentId: "agent_1", budget: 20_000_000, perTxCap: 505_000,
        dailyCap: 20_000_000, escalateAbove: 6_000_000, newPayeeCap: 250_000,
        spent: 0, spentToday: 0, expiresAt: later, revoked: false, createdAt: now,
      }],
      approvals: [
        { id: "appr_1", agentId: "agent_1", to: "user_1", amount: 7_000_000, status: "pending", memo: "large job", createdAt: now, expiresAt: later },
        { id: "appr_2", agentId: "agent_1", to: "user_1", amount: 8_000_000, status: "pending", memo: "bulk order", createdAt: now, expiresAt: later },
      ],
      feed: [],
      external: [],
      cards: [],
      treasury: {
        controls: { fundingEnabled: true, payoutsEnabled: true, externalSpendEnabled: true },
        destinations: [{ id: "dest_1", label: "Owner checking", provider: "mock", status: "verified" }],
        payouts: [], fundings: [], exposures: [],
      },
      compliance: { state: "approved", screeningState: "clear" },
    };
  }

  it("mandate edit prefills sub-cent caps exactly and a failed re-grant shows the revoked-but-not-granted banner", async () => {
    const { byId, calls, click } = await renderWithSnapshot(writeWorld(), (method, path) => {
      if (method === "POST" && path === "/mandates/man_1/revoke") return { status: 200, json: { ok: true, changed: true } };
      if (method === "POST" && path === "/mandates") return { status: 403, json: { reason: "treasury paused" } };
      return null;
    });

    await click({ "data-action": "open-mandate", "data-id": "agent_1" });
    // Full-precision round-trip: editing must never silently narrow a
    // CLI-granted sub-cent cap to the whole cent.
    expect(byId("mPerTx").value).toBe("0.505");
    expect(byId("mNewPayee").value).toBe("0.25");
    expect(byId("mBudget").value).toBe("20");

    await click({ "data-action": "mandate-save" });

    // Fail-closed edit order: revoke FIRST, then grant.
    const revokeAt = calls.findIndex((c) => c.method === "POST" && c.path === "/mandates/man_1/revoke");
    const grantAt = calls.findIndex((c) => c.method === "POST" && c.path === "/mandates");
    expect(revokeAt).toBeGreaterThanOrEqual(0);
    expect(grantAt).toBeGreaterThan(revokeAt);
    // The re-grant body preserved the exact micros, not a truncated cent.
    expect(calls[grantAt]!.body).toMatchObject({
      userId: "user_1", agentId: "agent_1",
      perTxCapMicros: "505000", newPayeeCapMicros: "250000", budgetMicros: "20000000",
    });

    // The grant failed after the revoke succeeded: the sheet says so plainly
    // and names the consequence (fail-closed — the agent cannot spend).
    const error = byId("mandateError");
    expect(error.classList.contains("hidden")).toBe(false);
    expect(error.textContent).toContain("Old mandate revoked; the new grant failed: treasury paused");
    expect(error.textContent).toContain("@scout cannot spend until you grant again");
  });

  it("approve, decline, add-funds, and payout flows run through the page script's own handlers", async () => {
    let allocateAttempts = 0;
    const { byId, calls, click } = await renderWithSnapshot(writeWorld(), (method, path) => {
      if (method !== "POST") return null;
      if (path === "/owner/approvals/appr_1/approve") return { status: 200, json: { ok: true, card: { last4: "4242" } } };
      if (path === "/owner/approvals/appr_2/reject") return { status: 200, json: { ok: true } };
      if (path === "/allocate") {
        allocateAttempts += 1;
        return allocateAttempts === 1
          ? { status: 402, json: { error: "insufficient_funds", code: "insufficient_funds", fromBalanceMicros: 1_000_000 } }
          : { status: 200, json: { status: "posted", replayed: false } };
      }
      if (path === "/owner/payouts") return { status: 200, json: { ok: true, state: "queued" } };
      return null;
    });

    // Approve: the card-issuing variant of the toast, empty exact-tuple body.
    await click({ "data-action": "approve", "data-id": "appr_1" });
    expect(byId("toast").textContent).toBe("Reserved card ·· 4242 issued");
    expect(calls.find((c) => c.path === "/owner/approvals/appr_1/approve")?.body).toEqual({});

    // Decline carries the standard reason.
    await click({ "data-action": "reject", "data-id": "appr_2" });
    expect(byId("toast").textContent).toBe("Declined");
    expect(calls.find((c) => c.path === "/owner/approvals/appr_2/reject")?.body).toEqual({ reason: "Declined in owner app" });

    // Add funds: the insufficient-funds strip shows the arithmetic, then a
    // successful retry clears it.
    await click({ "data-action": "open-funds", "data-id": "agent_1" });
    byId("fundsAmount").value = "12.34";
    await click({ "data-action": "funds-submit" });
    expect(byId("fundsError").classList.contains("hidden")).toBe(false);
    expect(byId("fundsError").textContent).toBe("Owner funds $1.00 — not enough for $12.34.");
    await click({ "data-action": "funds-submit" });
    expect(byId("fundsError").classList.contains("hidden")).toBe(true);
    const allocations = calls.filter((c) => c.path === "/allocate");
    expect(allocations).toHaveLength(2);
    expect(allocations[0]!.body).toMatchObject({ userId: "user_1", agentId: "agent_1", amountMicros: "12340000" });

    // Cash out through the payout form.
    byId("payoutDestination").value = "dest_1";
    byId("payoutAmount").value = "3";
    await click({ "data-action": "payout" });
    expect(byId("toast").textContent).toBe("Cash out requested");
    expect(calls.find((c) => c.path === "/owner/payouts")?.body).toMatchObject({ destinationId: "dest_1", amountMicros: "3000000" });
  });
});
