import { randomBytes } from "node:crypto";
import { declarePaymentIdentifierExtension, PAYMENT_IDENTIFIER } from "@x402/extensions/payment-identifier";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockX402Server } from "../src/bridge/mock-x402.ts";
import { LocalEvmSigner } from "../src/bridge/evm-wallet.ts";
import { encodeSettlement, type Eip3009Authorization, type PaymentRequirements } from "../src/bridge/x402.ts";
import { X402V2EvmPaymentSigner, decodedV2Payment } from "../src/bridge/x402-v2.ts";
import { MockWallet, type ExternalWallet, type SigningDomain } from "../src/bridge/wallet.ts";
import { generateAgentKeypair, signedHeaders } from "../src/core/identity.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createPostgresApi } from "../src/server/postgres-api.ts";

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

type IdHeader = "x-user-id" | "x-agent-id";

function signedRequest(
  app: ReturnType<typeof createPostgresApi>["app"],
  path: string,
  method: "GET" | "POST",
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

const MOCK_ASSET = "0x00000000000000000000000000000000000c0ffe";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x209693bc6afc0c5328ba36faf03c514ef312287c";
const URL = "https://data.example.com/external/report";

function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "mock-local",
    maxAmountRequired: "50000",
    asset: MOCK_ASSET,
    payTo: PAY_TO,
    resource: "/external/report",
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}

describe("Postgres signed external-payment API", () => {
  let db: EmbeddedPostgres;
  let signer: MockWallet;
  let wallet: ExternalWallet;
  let signatures: number;
  let verifierCalls: number;
  let verifierAccepts: boolean;
  let api: ReturnType<typeof createPostgresApi>;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    signer = new MockWallet();
    signatures = 0;
    wallet = {
      address: signer.address,
      signAuthorization(auth: Eip3009Authorization, domain: SigningDomain) {
        signatures += 1;
        return signer.signAuthorization(auth, domain);
      },
    };
    verifierCalls = 0;
    verifierAccepts = true;
    api = createPostgresApi(db, {
      allowDevelopmentFunding: true,
      externalWallet: wallet,
      externalHeaderKey: randomBytes(32),
      verifyExternalSettlement: ({ payment, authorization, settlement }) => {
        verifierCalls += 1;
        const auth = authorization.authorization;
        return {
          ok: verifierAccepts
            && settlement.transaction.startsWith("0xmock")
            && payment.payTo.toLowerCase() === auth.to.toLowerCase(),
          ...(!verifierAccepts ? { reason: "facilitator could not verify settlement" } : {}),
        };
      },
    });
  }, 30_000);

  afterEach(async () => {
    await db.close();
  });

  async function signup(name: string, handle: string) {
    const keys = generateAgentKeypair();
    const response = await api.app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, handle, publicKey: keys.publicKey }),
    });
    expect(response.status).toBe(200);
    return { user: await response.json() as { id: string }, keys };
  }

  async function createAgent(user: { id: string }, ownerPrivateKey: string, name: string, handle: string) {
    const keys = generateAgentKeypair();
    const response = await signedRequest(api.app, "/agents", "POST", {
      name, handle, ownerId: user.id, publicKey: keys.publicKey,
    }, user.id, ownerPrivateKey, "x-user-id");
    expect(response.status).toBe(200);
    return { agent: await response.json() as { id: string }, keys };
  }

  async function world(escalateAboveMicros = 1_000_000) {
    const { user, keys: ownerKeys } = await signup("Max", `max-${escalateAboveMicros}`);
    const { agent, keys: agentKeys } = await createAgent(user, ownerKeys.privateKey, "Scout", `scout-${escalateAboveMicros}`);
    const { agent: otherAgent, keys: otherAgentKeys } = await createAgent(user, ownerKeys.privateKey, "Writer", `writer-${escalateAboveMicros}`);
    expect((await signedRequest(api.app, "/fund", "POST", {
      userId: user.id, amountMicros: 2_000_000, idempotencyKey: "external-api-fund",
    }, user.id, ownerKeys.privateKey, "x-user-id")).status).toBe(200);
    expect((await signedRequest(api.app, "/allocate", "POST", {
      userId: user.id, agentId: agent.id, amountMicros: 1_000_000, idempotencyKey: "external-api-allocate",
    }, user.id, ownerKeys.privateKey, "x-user-id")).status).toBe(200);
    expect((await signedRequest(api.app, "/mandates", "POST", {
      userId: user.id,
      agentId: agent.id,
      budgetMicros: 1_000_000,
      perTxCapMicros: 1_000_000,
      dailyCapMicros: 1_000_000,
      escalateAboveMicros,
      newPayeeCapMicros: 100_000,
      idempotencyKey: "external-api-mandate",
    }, user.id, ownerKeys.privateKey, "x-user-id")).status).toBe(200);
    return { user, ownerKeys, agent, agentKeys, otherAgent, otherAgentKeys };
  }

  it("pays a protocol-shaped seller, stores only ciphertext, verifies settlement, and replays without resigning", async () => {
    const { user, ownerKeys, agent, agentKeys, otherAgent, otherAgentKeys } = await world();
    const seller = createMockX402Server({
      payTo: PAY_TO,
      asset: MOCK_ASSET,
      network: "mock-local",
      priceAtomic: "50000",
      resourcePath: "/external/report",
      verify: (auth, domain, signature) => signer.verifyAuthorization(auth, domain, signature),
    });
    const demand = await seller.app.request("/external/report");
    const req = (await demand.json() as { accepts: PaymentRequirements[] }).accepts[0]!;
    const body = { url: URL, requirement: req, idempotencyKey: "external-api-one" };
    const paidResponse = await signedRequest(api.app, "/pay-external", "POST", body, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(paidResponse.status).toBe(200);
    const paid = await paidResponse.json() as any;
    expect(paid).toEqual(expect.objectContaining({
      status: "paid",
      state: "pending",
      policyPayee: `x402:data.example.com:${PAY_TO}`,
      amountMicros: 50_000,
      paymentHeader: expect.any(String),
      receipt: expect.objectContaining({ to: "external:x402", amount: 50_000 }),
      replayed: false,
    }));
    expect(signatures).toBe(1);

    const lookupPath = `/pay-external/unresolved?resource=${encodeURIComponent(URL)}`;
    const lookup = await signedRequest(
      api.app, lookupPath, "GET", undefined,
      agent.id, agentKeys.privateKey, "x-agent-id"
    );
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual(expect.objectContaining({ externalId: paid.externalId, state: "pending" }));
    expect((await signedRequest(
      api.app, lookupPath, "GET", undefined,
      otherAgent.id, otherAgentKeys.privateKey, "x-agent-id"
    )).status).toBe(404);

    const stored = await db.query<{ payment_header_ciphertext: Uint8Array; authorization_hash: Uint8Array }>(
      "select payment_header_ciphertext, authorization_hash from money.external_payments where id = $1::uuid",
      [paid.externalId]
    );
    const ciphertext = Buffer.from(stored.rows[0]!.payment_header_ciphertext);
    expect(ciphertext.equals(Buffer.from(paid.paymentHeader, "utf8"))).toBe(false);
    expect(ciphertext.includes(Buffer.from(paid.paymentHeader, "utf8"))).toBe(false);
    expect(Buffer.from(stored.rows[0]!.authorization_hash).toString("hex")).toMatch(/^[0-9a-f]{64}$/);

    const resumedById = await signedRequest(
      api.app, `/pay-external/${paid.externalId}/resume`, "POST", {},
      agent.id, agentKeys.privateKey, "x-agent-id"
    );
    expect(resumedById.status).toBe(200);
    expect(await resumedById.json()).toEqual(expect.objectContaining({
      externalId: paid.externalId, paymentHeader: paid.paymentHeader, replayed: true,
    }));
    expect(signatures).toBe(1);

    const replayResponse = await signedRequest(api.app, "/pay-external", "POST", body, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(replayResponse.status).toBe(200);
    const replay = await replayResponse.json() as any;
    expect(replay).toEqual(expect.objectContaining({
      externalId: paid.externalId, paymentHeader: paid.paymentHeader, replayed: true,
    }));
    expect(signatures).toBe(1);

    const served = await seller.app.request("/external/report", { headers: { "x-payment": paid.paymentHeader } });
    expect(served.status).toBe(200);
    const settlement = served.headers.get("x-payment-response")!;
    const confirmedResponse = await signedRequest(
      api.app, `/pay-external/${paid.externalId}/confirm`, "POST", { settlement },
      agent.id, agentKeys.privateKey, "x-agent-id"
    );
    expect(confirmedResponse.status).toBe(200);
    const confirmed = await confirmedResponse.json() as any;
    expect(confirmed).toEqual(expect.objectContaining({ ok: true, state: "confirmed", settledTx: expect.stringMatching(/^0xmock/) }));
    expect(verifierCalls).toBe(1);
    expect((await signedRequest(
      api.app, lookupPath, "GET", undefined,
      agent.id, agentKeys.privateKey, "x-agent-id"
    )).status).toBe(404);

    const confirmedReplay = await signedRequest(
      api.app, `/pay-external/${paid.externalId}/confirm`, "POST", { settlement },
      agent.id, agentKeys.privateKey, "x-agent-id"
    );
    expect(await confirmedReplay.json()).toEqual(expect.objectContaining({ ok: true, replayed: true, state: "confirmed" }));
    expect(verifierCalls).toBe(1);

    const ownerState = await signedRequest(api.app, "/owner/state", "GET", undefined, user.id, ownerKeys.privateKey, "x-user-id");
    expect(await ownerState.json()).toEqual(expect.objectContaining({
      external: [expect.objectContaining({ id: paid.externalId, state: "confirmed", settledTx: confirmed.settledTx })],
    }));
  });

  it("persists an exact approval, releases no header to the owner, and lets the agent resume", async () => {
    const { user, ownerKeys, agent, agentKeys } = await world(10_000);
    const body = { url: URL, requirement: requirement(), idempotencyKey: "external-api-approval" };
    const requestedResponse = await signedRequest(api.app, "/pay-external", "POST", body, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(requestedResponse.status).toBe(202);
    const requested = await requestedResponse.json() as any;
    expect(requested).toEqual(expect.objectContaining({
      status: "approval_required",
      state: "approval_required",
      approval: expect.objectContaining({ status: "pending", amount: 50_000, to: "external:x402" }),
    }));
    expect(requested.paymentHeader).toBeUndefined();
    expect(signatures).toBe(0);

    const approvedResponse = await signedRequest(
      api.app, `/owner/approvals/${requested.approval.id}/approve`, "POST", {},
      user.id, ownerKeys.privateKey, "x-user-id"
    );
    expect(approvedResponse.status).toBe(200);
    const approved = await approvedResponse.json() as any;
    expect(approved).toEqual(expect.objectContaining({
      approval: expect.objectContaining({ status: "approved" }),
      external: expect.objectContaining({ status: "paid", state: "pending" }),
    }));
    expect(approved.external.paymentHeader).toBeUndefined();
    expect(signatures).toBe(1);

    const resumedResponse = await signedRequest(api.app, "/pay-external", "POST", body, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(resumedResponse.status).toBe(200);
    expect(await resumedResponse.json()).toEqual(expect.objectContaining({
      externalId: requested.externalId, state: "pending", paymentHeader: expect.any(String), replayed: true,
    }));
    expect(signatures).toBe(1);
  });

  it("signs, resumes, and confirms an official x402 v2 PAYMENT-SIGNATURE flow", async () => {
    const { agent, agentKeys } = await world();
    const evm = new LocalEvmSigner(`0x${"11".repeat(32)}`);
    let independentChecks = 0;
    const v2Api = createPostgresApi(db, {
      externalHeaderKey: randomBytes(32),
      externalPaymentSigner: new X402V2EvmPaymentSigner(evm),
      verifyExternalSettlement: ({ authorization, settlement }) => {
        independentChecks += 1;
        return {
          ok: authorization.protocolVersion === 2
            && authorization.accepted?.network === "eip155:84532"
            && settlement.transaction === `0x${"ab".repeat(32)}`,
        };
      },
    });
    const body = {
      url: URL,
      idempotencyKey: "external-api-v2",
      x402Version: 2,
      resource: { url: URL, description: "v2 report" },
      extensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true) },
      requirement: {
        scheme: "exact",
        network: "eip155:84532",
        amount: "50000",
        asset: BASE_SEPOLIA_USDC,
        payTo: PAY_TO,
        maxTimeoutSeconds: 137,
        extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
      },
    };
    const paidResponse = await signedRequest(
      v2Api.app, "/pay-external", "POST", body,
      agent.id, agentKeys.privateKey, "x-agent-id"
    );
    expect(paidResponse.status).toBe(200);
    const paid = await paidResponse.json() as any;
    expect(paid).toEqual(expect.objectContaining({
      status: "paid",
      protocolVersion: 2,
      paymentHeaderName: "payment-signature",
      settlementHeaderName: "payment-response",
      paymentHeader: expect.any(String),
    }));
    const decoded = decodedV2Payment(paid.paymentHeader);
    expect(decoded).toEqual(expect.objectContaining({
      protocolVersion: 2,
      network: "eip155:84532",
      asset: BASE_SEPOLIA_USDC,
    }));
    expect((decoded?.payload as any)?.accepted?.maxTimeoutSeconds).toBe(137);
    expect((decoded?.payload as any)?.resource?.description).toBe("v2 report");
    expect((decoded?.payload as any)?.extensions?.[PAYMENT_IDENTIFIER]?.info?.id)
      .toMatch(/^pay_[0-9a-f]{32}$/);

    const resumed = await signedRequest(
      v2Api.app, `/pay-external/${paid.externalId}/resume`, "POST", {},
      agent.id, agentKeys.privateKey, "x-agent-id"
    );
    expect(await resumed.json()).toEqual(expect.objectContaining({
      paymentHeader: paid.paymentHeader,
      paymentHeaderName: "payment-signature",
      replayed: true,
    }));
    const changedContext = await signedRequest(
      v2Api.app, "/pay-external", "POST",
      { ...body, requirement: { ...body.requirement, maxTimeoutSeconds: 138 } },
      agent.id, agentKeys.privateKey, "x-agent-id"
    );
    expect(changedContext.status).toBe(409);
    expect(await changedContext.json()).toEqual(expect.objectContaining({ code: "idempotency_conflict" }));

    const settlement = encodeSettlement({
      success: true,
      transaction: `0x${"ab".repeat(32)}`,
      network: "eip155:84532",
      payer: evm.address,
      amount: "50000",
    });
    const confirmed = await signedRequest(
      v2Api.app, `/pay-external/${paid.externalId}/confirm`, "POST", { settlement },
      agent.id, agentKeys.privateKey, "x-agent-id"
    );
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual(expect.objectContaining({ ok: true, state: "confirmed" }));
    expect(independentChecks).toBe(1);
  });

  it("fails closed on missing rails, malformed requirements, forged claims, and cross-agent confirmation", async () => {
    const { agent, agentKeys, otherAgent, otherAgentKeys } = await world();
    const unavailable = createPostgresApi(db);
    const unavailableResponse = await signedRequest(unavailable.app, "/pay-external", "POST", {
      url: URL, requirement: requirement(), idempotencyKey: "bridge-off",
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(unavailableResponse.status).toBe(503);

    const bad = await signedRequest(api.app, "/pay-external", "POST", {
      url: URL, requirement: requirement({ network: "attacker-chain" }), idempotencyKey: "bad-network",
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(bad.status).toBe(400);
    expect(signatures).toBe(0);

    const paidResponse = await signedRequest(api.app, "/pay-external", "POST", {
      url: URL, requirement: requirement(), idempotencyKey: "claim-check",
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    const paid = await paidResponse.json() as any;
    expect(paidResponse.status).toBe(200);
    const path = `/pay-external/${paid.externalId}/confirm`;
    expect((await signedRequest(api.app, path, "POST", { transaction: "0xraw" }, agent.id, agentKeys.privateKey, "x-agent-id")).status).toBe(400);
    expect((await signedRequest(api.app, path, "POST", {
      settlement: encodeSettlement({ success: true, transaction: "0xmockfake", network: "wrong", payer: wallet.address }),
    }, agent.id, agentKeys.privateKey, "x-agent-id")).status).toBe(409);
    expect(verifierCalls).toBe(0);

    verifierAccepts = false;
    const forged = await signedRequest(api.app, path, "POST", {
      settlement: encodeSettlement({ success: true, transaction: "0xmockfake", network: "mock-local", payer: wallet.address }),
    }, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(forged.status).toBe(409);
    expect(await forged.json()).toEqual(expect.objectContaining({ error: "settlement_unverified", reason: expect.stringMatching(/facilitator/) }));
    expect(verifierCalls).toBe(1);
    expect((await signedRequest(api.app, path, "POST", {
      settlement: encodeSettlement({ success: true, transaction: "0xmockfake", network: "mock-local", payer: wallet.address }),
    }, otherAgent.id, otherAgentKeys.privateKey, "x-agent-id")).status).toBe(404);
    expect((await signedRequest(api.app, "/pay-external/not-a-uuid/confirm", "POST", { settlement: "x" }, agent.id, agentKeys.privateKey, "x-agent-id")).status).toBe(400);
  });
});
