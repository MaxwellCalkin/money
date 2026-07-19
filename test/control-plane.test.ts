import { describe, expect, it } from "vitest";
import { generateAgentKeypair, signedHeaders } from "../src/core/identity.ts";
import { MoneyNetwork } from "../src/core/network.ts";
import { createApi } from "../src/server/api.ts";
import { usd } from "../src/core/types.ts";

type IdHeader = "x-user-id" | "x-agent-id" | "x-provider-id";

function signedRequest(
  app: ReturnType<typeof createApi>["app"],
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
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      ...signedHeaders(accountId, privateKey, { method, path, body }, idHeader),
    },
    ...(method === "POST" ? { body } : {}),
  });
}

async function session(
  app: ReturnType<typeof createApi>["app"],
  userId: string,
  privateKey: string
) {
  const response = await signedRequest(app, "/owner/sessions", "POST", {}, userId, privateKey, "x-user-id");
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

function setup() {
  const network = new MoneyNetwork();
  const { app } = createApi(network);
  const ownerKeys = generateAgentKeypair();
  const agentKeys = generateAgentKeypair();
  const user = network.createUser("Max", ownerKeys.publicKey, "max");
  const agent = network.createAgent("Scout", user.id, agentKeys.publicKey, "scout");
  const payee = network.createAgent("Writer", user.id, undefined, "writer");
  network.fund(user.id, usd(20), "fund");
  network.allocate(user.id, agent.id, usd(10), "allocate");
  network.grantMandate({
    userId: user.id,
    agentId: agent.id,
    budget: usd(10),
    perTxCap: usd(10),
    dailyCap: usd(10),
    escalateAbove: usd(2),
    newPayeeCap: usd(0.1),
    idempotencyKey: "mandate",
  });
  return { network, app, user, agent, payee, ownerKeys, agentKeys };
}

describe("tenant-scoped API and approval inbox", () => {
  it("takes an escalated agent payment from durable request to exact owner approval", async () => {
    const { network, app, user, agent, payee, ownerKeys, agentKeys } = setup();
    const payBody = {
      to: "@writer",
      amountMicros: usd(3),
      memo: "large research job",
      idempotencyKey: "api-large-job",
    };
    const requested = await signedRequest(app, "/pay", "POST", payBody, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(requested.status).toBe(202);
    const pending = await requested.json() as any;
    expect(pending).toEqual(expect.objectContaining({
      status: "approval_required",
      approval: expect.objectContaining({ to: payee.id, amount: usd(3), status: "pending" }),
    }));
    expect(network.balanceOf(agent.id)).toBe(usd(10));

    const signedOwnerState = await signedRequest(app, "/owner/state", "GET", undefined, user.id, ownerKeys.privateKey, "x-user-id");
    expect(signedOwnerState.status).toBe(200);
    expect((await signedOwnerState.json() as any).approvals[0].id).toBe(pending.approval.id);

    const otherKeys = generateAgentKeypair();
    const other = network.createUser("Ada", otherKeys.publicKey, "ada");
    const otherToken = await session(app, other.id, otherKeys.privateKey);
    const otherState = await app.request("/owner/state", { headers: { authorization: `Bearer ${otherToken}` } });
    expect((await otherState.json() as any).approvals).toEqual([]);
    const forbidden = await app.request(`/owner/approvals/${pending.approval.id}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(forbidden.status).toBe(403);

    const token = await session(app, user.id, ownerKeys.privateKey);
    const ownerState = await app.request("/owner/state", { headers: { authorization: `Bearer ${token}` } });
    expect(ownerState.status).toBe(200);
    expect((await ownerState.json() as any).approvals).toEqual([
      expect.objectContaining({ id: pending.approval.id, status: "pending" }),
    ]);

    const approved = await app.request(`/owner/approvals/${pending.approval.id}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual(expect.objectContaining({
      approval: expect.objectContaining({ status: "approved" }),
      payment: expect.objectContaining({ status: "paid" }),
    }));
    expect(network.balanceOf(agent.id)).toBe(usd(7));
    expect(network.balanceOf(payee.id)).toBe(usd(3));

    const retry = await signedRequest(app, "/pay", "POST", payBody, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(expect.objectContaining({ status: "paid", replayed: true }));
    expect(network.balanceOf(agent.id)).toBe(usd(7));

    const agentStatePath = "/agent/state?limit=100";
    const agentState = await signedRequest(app, agentStatePath, "GET", undefined, agent.id, agentKeys.privateKey, "x-agent-id");
    expect(agentState.status).toBe(200);
    expect(await agentState.json()).toEqual(expect.objectContaining({
      account: expect.objectContaining({ id: agent.id, balanceMicros: usd(7) }),
      approvals: [expect.objectContaining({ id: pending.approval.id, status: "approved" })],
      feed: [expect.objectContaining({ amount: usd(3), to: payee.id })],
    }));
  });

  it("removes public financial reads and scopes provider state to its signer", async () => {
    const { network, app, user } = setup();
    const providerKeys = generateAgentKeypair();
    const provider = network.createProvider("Research Cloud", user.id, providerKeys.publicKey, "research-cloud");
    const service = network.registerService({
      providerId: provider.id,
      slug: "report",
      name: "Report",
      endpointUrl: "https://seller.example/report",
      price: usd(0.05),
      idempotencyKey: "provider-service",
    }).service;

    expect((await app.request(`/balance/${provider.id}`)).status).toBe(404);
    expect((await app.request("/feed")).status).toBe(404);
    expect((await app.request("/agent/state")).status).toBe(401);
    expect((await app.request("/provider/state")).status).toBe(401);

    const response = await signedRequest(app, "/provider/state", "GET", undefined, provider.id, providerKeys.privateKey, "x-provider-id");
    expect(response.status).toBe(200);
    const state = await response.json() as any;
    expect(state.account).toEqual(expect.objectContaining({ id: provider.id, balanceMicros: 0 }));
    expect(state.account.publicKey).toBeUndefined();
    expect(state.services).toEqual([expect.objectContaining({ id: service.id })]);
  });

  it("exposes unredeemed challenge state so restarted agent tooling resumes the original approval", async () => {
    const { network, app, user, agent, ownerKeys, agentKeys } = setup();
    const provider = network.createProvider("Premium API");
    const challenge = network.createChallenge(provider.id, usd(3), "/premium/report");
    const requested = await signedRequest(
      app,
      "/pay-challenge",
      "POST",
      { challengeId: challenge.id },
      agent.id,
      agentKeys.privateKey,
      "x-agent-id"
    );
    expect(requested.status).toBe(202);
    const pending = await requested.json() as any;

    const state = await signedRequest(app, "/agent/state", "GET", undefined, agent.id, agentKeys.privateKey, "x-agent-id");
    expect((await state.json() as any).approvals).toEqual([
      expect.objectContaining({
        id: pending.approval.id,
        idempotencyKey: `chl_${challenge.id}`,
        challenge: { id: challenge.id, redeemed: false },
      }),
    ]);

    const token = await session(app, user.id, ownerKeys.privateKey);
    const approved = await app.request(`/owner/approvals/${pending.approval.id}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(approved.status).toBe(200);
    const payment = (await approved.json() as any).payment;
    expect(network.redeemChallenge(challenge.id, payment.receipt.id).ok).toBe(true);

    const after = await signedRequest(app, "/agent/state", "GET", undefined, agent.id, agentKeys.privateKey, "x-agent-id");
    expect((await after.json() as any).approvals[0].challenge.redeemed).toBe(true);
  });
});
