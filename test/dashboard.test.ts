import { describe, expect, it } from "vitest";
import { generateAgentKeypair, signedHeaders } from "../src/core/identity.ts";
import { MoneyNetwork } from "../src/core/network.ts";
import { createApi } from "../src/server/api.ts";
import { usd } from "../src/core/types.ts";

function setup() {
  const network = new MoneyNetwork();
  const { app } = createApi(network);
  const ownerKeys = generateAgentKeypair();
  const agentKeys = generateAgentKeypair();
  const user = network.createUser("Max", ownerKeys.publicKey, "max");
  network.fund(user.id, usd(20), "seed-fund");
  const agent = network.createAgent("scout", user.id, agentKeys.publicKey, "scout");
  network.allocate(user.id, agent.id, usd(10), "seed-alloc");
  const peer = network.createAgent("writer", user.id);
  network.grantMandate({
    userId: user.id,
    agentId: agent.id,
    budget: usd(10),
    perTxCap: usd(10),
    dailyCap: usd(10),
    escalateAbove: usd(2),
    newPayeeCap: usd(0.1),
  });
  return { network, app, user, agent, peer, ownerKeys, agentKeys };
}

async function ownerSession(
  app: ReturnType<typeof createApi>["app"],
  userId: string,
  privateKey: string
): Promise<string> {
  const path = "/owner/sessions";
  const body = "{}";
  const response = await app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signedHeaders(userId, privateKey, { method: "POST", path, body }, "x-user-id"),
    },
    body,
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

describe("private owner control plane", () => {
  it("serves a self-contained login and approval UI with no external resources", async () => {
    const { app } = setup();
    const res = await app.request("/dashboard");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain("closed-loop agent payment network");
    expect(html).toContain("Approval inbox");
    expect(html).toContain("Approve exact payment");
    expect(html).toContain("a.agentId");
    expect(html).toContain("a.to");
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it("requires a short-lived owner session and returns only that owner's world", async () => {
    const { network, app, user, agent, peer, ownerKeys } = setup();
    const other = network.createUser("Ada", generateAgentKeypair().publicKey, "ada");
    const provider = network.createProvider("Research Cloud", user.id, generateAgentKeypair().publicKey, "research-cloud");
    const service = network.registerService({
      providerId: provider.id,
      slug: "report",
      name: "Report",
      endpointUrl: "https://seller.example/report",
      price: usd(0.05),
      idempotencyKey: "dashboard-service",
    }).service;
    expect(network.pay({ from: agent.id, to: peer.id, amount: usd(0.25), memo: "subtask", idempotencyKey: "t1" }).status).toBe("paid");

    expect((await app.request("/dashboard/state")).status).toBe(401);
    const token = await ownerSession(app, user.id, ownerKeys.privateKey);
    const response = await app.request("/dashboard/state", { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const state = await response.json() as any;
    expect(state.zeroSum).toBe(true);
    expect(state.receiptsOk).toBe(true);
    expect(state.accounts.map((account: any) => account.id)).toEqual(expect.arrayContaining([user.id, agent.id, peer.id, provider.id]));
    expect(state.accounts.map((account: any) => account.id)).not.toContain(other.id);
    expect(state.accounts.every((account: any) => account.publicKey === undefined)).toBe(true);
    expect(state.accounts.find((account: any) => account.id === agent.id).balanceMicros).toBe(usd(9.75));
    expect(state.feed).toHaveLength(1);
    expect(state.services).toEqual([expect.objectContaining({ id: service.id, address: "@research-cloud/report" })]);

    const logout = await app.request("/owner/sessions/current", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logout.status).toBe(200);
    expect((await app.request("/dashboard/state", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("network.onEvent notifies observers and unsubscribe stops it", () => {
    const { network, agent, peer } = setup();
    const seen: string[] = [];
    const unsubscribe = network.onEvent((event) => seen.push(event.type));
    network.pay({ from: agent.id, to: peer.id, amount: usd(0.1), memo: "m", idempotencyKey: "o1" });
    expect(seen).toEqual(["transfer"]);
    unsubscribe();
    network.pay({ from: agent.id, to: peer.id, amount: usd(0.1), memo: "m", idempotencyKey: "o2" });
    expect(seen).toEqual(["transfer"]);
  });

  it("a throwing observer cannot break a payment", () => {
    const { network, agent, peer } = setup();
    network.onEvent(() => { throw new Error("bad observer"); });
    expect(network.pay({ from: agent.id, to: peer.id, amount: usd(0.1), memo: "m", idempotencyKey: "x1" }).status).toBe("paid");
  });
});
