import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { generateAgentKeypair, signedHeaders } from "../src/core/identity.ts";
import { MoneyNetwork } from "../src/core/network.ts";
import { usd } from "../src/core/types.ts";
import { createMoneySellerClient, moneyPaid } from "../src/seller/middleware.ts";
import { createApi } from "../src/server/api.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can retain a temp handle briefly.
    }
  }
});

function signedPost(
  app: ReturnType<typeof createApi>["app"],
  path: string,
  value: unknown,
  accountId: string,
  privateKey: string,
  idHeader: "x-user-id" | "x-agent-id" | "x-provider-id"
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

function fetchThrough(app: ReturnType<typeof createApi>["app"]): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    return app.request(url.pathname + url.search, init);
  }) as typeof globalThis.fetch;
}

function world(network = new MoneyNetwork()) {
  const ownerKeys = generateAgentKeypair();
  const agentKeys = generateAgentKeypair();
  const providerKeys = generateAgentKeypair();
  const user = network.createUser("Max", ownerKeys.publicKey, "max");
  const agent = network.createAgent("Scout", user.id, agentKeys.publicKey, "scout");
  const provider = network.createProvider("Research Cloud", user.id, providerKeys.publicKey, "research-cloud");
  network.fund(user.id, usd(20), "seed-fund");
  network.allocate(user.id, agent.id, usd(10), "seed-agent");
  network.grantMandate({
    userId: user.id,
    agentId: agent.id,
    budget: usd(10),
    perTxCap: usd(1),
    dailyCap: usd(5),
    escalateAbove: usd(2),
    newPayeeCap: usd(0.1),
    idempotencyKey: "seed-mandate",
  });
  return { network, user, agent, provider, ownerKeys, agentKeys, providerKeys };
}

describe("two-sided marketplace", () => {
  it("owner onboards a provider; its key registers a discoverable service idempotently", async () => {
    const network = new MoneyNetwork();
    const { app } = createApi(network);
    const ownerKeys = generateAgentKeypair();
    const providerKeys = generateAgentKeypair();

    const signup = await app.request("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Max", handle: "max", publicKey: ownerKeys.publicKey }),
    });
    expect(signup.status).toBe(200);
    const user = (await signup.json()) as { id: string };

    const created = await signedPost(
      app,
      "/providers",
      { name: "Research Cloud", ownerId: user.id, handle: "research-cloud", publicKey: providerKeys.publicKey },
      user.id,
      ownerKeys.privateKey,
      "x-user-id"
    );
    expect(created.status).toBe(200);
    const provider = (await created.json()) as { id: string; handle: string };
    expect(provider.handle).toBe("research-cloud");

    const terms = {
      slug: "market-report",
      name: "Market report",
      description: "Fresh agent-economy data",
      endpointUrl: "https://seller.example/report",
      priceMicros: usd(0.05),
      idempotencyKey: "register-market-report",
    };
    const registered = await signedPost(app, "/services", terms, provider.id, providerKeys.privateKey, "x-provider-id");
    expect(registered.status).toBe(200);
    const service = (await registered.json()) as { id: string; replayed: boolean };
    expect(service.id).toMatch(/^svc_/);
    expect(service.replayed).toBe(false);

    const replay = await signedPost(app, "/services", terms, provider.id, providerKeys.privateKey, "x-provider-id");
    expect(replay.status).toBe(200);
    expect((await replay.json() as { id: string; replayed: boolean })).toEqual(expect.objectContaining({ id: service.id, replayed: true }));

    const catalog = await app.request("/services");
    expect(await catalog.json()).toEqual([
      expect.objectContaining({ id: service.id, address: "@research-cloud/market-report", priceMicros: usd(0.05) }),
    ]);

    const forged = await signedPost(app, "/services", { ...terms, idempotencyKey: "forged" }, provider.id, ownerKeys.privateKey, "x-provider-id");
    expect(forged.status).toBe(401);

    const replacement = generateAgentKeypair();
    const rotated = await signedPost(
      app,
      `/accounts/${provider.id}/rotate-key`,
      { publicKey: replacement.publicKey },
      user.id,
      ownerKeys.privateKey,
      "x-user-id"
    );
    expect(rotated.status).toBe(200);
    const oldKey = await signedPost(app, "/services", { ...terms, slug: "old-key", idempotencyKey: "old-key" }, provider.id, providerKeys.privateKey, "x-provider-id");
    expect(oldKey.status).toBe(401);
    const newKey = await signedPost(app, "/services", {
      ...terms,
      slug: "fresh-report",
      endpointUrl: "https://seller.example/fresh",
      idempotencyKey: "fresh-key",
    }, provider.id, replacement.privateKey, "x-provider-id");
    expect(newKey.status).toBe(200);
  });

  it("an agent pays an independently operated seller through reusable middleware", async () => {
    const { network, agent, provider, agentKeys, providerKeys } = world();
    const service = network.registerService({
      providerId: provider.id,
      slug: "market-report",
      name: "Market report",
      endpointUrl: "https://seller.example/report",
      price: usd(0.05),
      idempotencyKey: "register-report",
    }).service;
    const networkApi = createApi(network).app;
    const networkFetch = fetchThrough(networkApi);
    let networkAvailable = true;
    const sellerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!networkAvailable) throw new Error("temporary network outage");
      return networkFetch(input, init);
    }) as typeof globalThis.fetch;
    const seller = new Hono();
    seller.get(
      "/report",
      moneyPaid({
        networkUrl: "https://network.example",
        providerId: provider.id,
        providerKey: providerKeys.privateKey,
        serviceId: service.id,
        fetch: sellerFetch,
      }),
      (c) => c.json({ report: "Agents settle in micros." })
    );

    const first = await seller.request("/report");
    expect(first.status).toBe(402);
    const challenge = (await first.json()) as { challengeId: string; amountMicros: number; payTo: string };
    expect(challenge).toEqual(expect.objectContaining({ amountMicros: usd(0.05), payTo: provider.id }));

    const paid = await signedPost(
      networkApi,
      "/pay-challenge",
      { challengeId: challenge.challengeId },
      agent.id,
      agentKeys.privateKey,
      "x-agent-id"
    );
    expect(paid.status).toBe(200);
    const payment = (await paid.json()) as { receipt: { id: string; amount: number } };

    const credential = {
      "x-payment-challenge": challenge.challengeId,
      "x-payment-receipt": payment.receipt.id,
    };
    networkAvailable = false;
    const interrupted = await seller.request("/report", { headers: credential });
    expect(interrupted.status).toBe(503); // never mislabel an outage as an invalid payment

    networkAvailable = true;
    const delivered = await seller.request("/report", { headers: credential });
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toEqual({ report: "Agents settle in micros." });
    expect(network.balanceOf(provider.id)).toBe(usd(0.05));

    const replayedCredential = await seller.request("/report", { headers: credential });
    expect(replayedCredential.status).toBe(402); // resource redemption is single-use
  });

  it("keeps seller signatures on a bounded, non-redirecting network origin", async () => {
    const { provider, providerKeys } = world();
    expect(() => createMoneySellerClient({
      networkUrl: "http://network.example",
      providerId: provider.id,
      providerKey: providerKeys.privateKey,
    })).toThrow(/HTTPS/);
    expect(() => createMoneySellerClient({
      networkUrl: "https://user:secret@network.example",
      providerId: provider.id,
      providerKey: providerKeys.privateKey,
    })).toThrow(/bare origin/);

    let requestInit: RequestInit | undefined;
    const client = createMoneySellerClient({
      networkUrl: "https://network.example",
      providerId: provider.id,
      providerKey: providerKeys.privateKey,
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        requestInit = init;
        return new Response(JSON.stringify({ challengeId: "chl_fixture" }), { status: 402 });
      }) as typeof fetch,
    });
    await client.challenge("svc_fixture");
    expect(requestInit?.redirect).toBe("error");
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("handles resolve for payments and remain globally unique", async () => {
    const { network, agent, provider, agentKeys } = world();
    const { app } = createApi(network);
    const payment = await signedPost(
      app,
      "/pay",
      { to: "@research-cloud", amountMicros: usd(0.05), memo: "by handle", idempotencyKey: "handle-pay" },
      agent.id,
      agentKeys.privateKey,
      "x-agent-id"
    );
    expect(payment.status).toBe(200);
    expect(network.balanceOf(provider.id)).toBe(usd(0.05));
    expect(() => network.createAgent("Impostor", network.account(agent.ownerId!)!.id, undefined, "RESEARCH-CLOUD")).toThrow(/already taken/);
  });

  it("settles the Venmo moment between agents owned by different users", async () => {
    const { network, user, agent, agentKeys } = world();
    const otherOwnerKeys = generateAgentKeypair();
    const otherAgentKeys = generateAgentKeypair();
    const otherUser = network.createUser("Ada", otherOwnerKeys.publicKey, "ada");
    const otherAgent = network.createAgent("Analyst", otherUser.id, otherAgentKeys.publicKey, "ada-analyst");
    const { app } = createApi(network);

    const payment = await signedPost(
      app,
      "/pay",
      { to: "@ada-analyst", amountMicros: usd(0.05), memo: "research subtask", idempotencyKey: "cross-owner-pay" },
      agent.id,
      agentKeys.privateKey,
      "x-agent-id"
    );
    expect(payment.status).toBe(200);
    expect(user.id).not.toBe(otherUser.id);
    expect(network.balanceOf(otherAgent.id)).toBe(usd(0.05));
    expect(await payment.json()).toEqual(expect.objectContaining({
      status: "paid",
      receipt: expect.objectContaining({ from: agent.id, to: otherAgent.id }),
    }));
  });

  it("providers issue partial refunds exactly once without recycling agent budget", async () => {
    const { network, user, agent, provider, agentKeys, providerKeys } = world();
    const { app } = createApi(network);
    const purchase = await signedPost(
      app,
      "/pay",
      { to: provider.id, amountMicros: usd(0.05), memo: "report", idempotencyKey: "buy-report" },
      agent.id,
      agentKeys.privateKey,
      "x-agent-id"
    );
    expect(purchase.status).toBe(200);
    const paid = (await purchase.json()) as { receipt: { id: string } };
    const spent = network.policy.activeMandateFor(agent.id)!.spent;
    const sellerClient = createMoneySellerClient({
      networkUrl: "https://network.example",
      providerId: provider.id,
      providerKey: providerKeys.privateKey,
      fetch: fetchThrough(app),
    });

    const terms = {
      receiptId: paid.receipt.id,
      amountMicros: usd(0.02),
      memo: "partial refund",
      idempotencyKey: "refund-report-1",
    };
    const refunded = await sellerClient.refund(terms);
    expect(refunded.status).toBe(200);
    expect(refunded.body).toEqual(expect.objectContaining({
      status: "refunded",
      replayed: false,
      remaining: usd(0.03),
      receipt: expect.objectContaining({ refundOf: paid.receipt.id, amount: usd(0.02) }),
    }));
    expect(network.balanceOf(provider.id)).toBe(usd(0.03));
    expect(network.balanceOf(agent.id)).toBe(usd(9.97));
    expect(network.policy.activeMandateFor(agent.id)!.spent).toBe(spent);

    const replay = await sellerClient.refund(terms);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(expect.objectContaining({ status: "refunded", replayed: true, remaining: usd(0.03) }));
    expect(network.balanceOf(provider.id)).toBe(usd(0.03));

    const conflict = await sellerClient.refund({ ...terms, amountMicros: usd(0.01) });
    expect(conflict.status).toBe(409);

    const tooMuch = await sellerClient.refund({ ...terms, amountMicros: usd(0.04), idempotencyKey: "refund-too-much" });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body).toEqual(expect.objectContaining({ code: "refund_invalid" }));

    const impostorKeys = generateAgentKeypair();
    const impostor = network.createProvider("Impostor", user.id, impostorKeys.publicKey, "impostor");
    const wrongSeller = await signedPost(
      app,
      "/refunds",
      { ...terms, idempotencyKey: "refund-wrong-seller" },
      impostor.id,
      impostorKeys.privateKey,
      "x-provider-id"
    );
    expect(wrongSeller.status).toBe(400);

    const remainder = await sellerClient.refund({ ...terms, amountMicros: usd(0.03), idempotencyKey: "refund-report-2" });
    expect(remainder.status).toBe(200);
    expect(remainder.body).toEqual(expect.objectContaining({ remaining: 0 }));
    expect(network.balanceOf(provider.id)).toBe(0);
    expect(network.balanceOf(agent.id)).toBe(usd(10));
    expect(network.policy.activeMandateFor(agent.id)!.spent).toBe(spent);
    expect(network.receipts.verify()).toEqual({ ok: true });
  });

  it("service terms and a paid challenge survive restart and redeem without another charge", () => {
    const dir = mkdtempSync(join(tmpdir(), "money-marketplace-"));
    tempDirs.push(dir);
    const path = join(dir, "events.jsonl");
    const { network, agent, provider } = world(MoneyNetwork.open(path));
    const service = network.registerService({
      providerId: provider.id,
      slug: "durable-report",
      name: "Durable report",
      endpointUrl: "https://seller.example/durable",
      price: usd(0.05),
      idempotencyKey: "register-durable",
    }).service;
    const challenge = network.createServiceChallenge(provider.id, service.id);
    const paid = network.payChallenge(agent.id, challenge.id);
    expect(paid.status).toBe("paid");
    if (paid.status !== "paid") throw new Error("expected payment");
    const before = network.balanceOf(agent.id);

    const rebuilt = MoneyNetwork.open(path);
    expect(rebuilt.accountByHandle("@research-cloud")?.id).toBe(provider.id);
    expect(rebuilt.serviceByAddress("research-cloud", "durable-report")?.id).toBe(service.id);
    expect(rebuilt.redeemServiceChallenge(provider.id, service.id, challenge.id, paid.receipt.id).ok).toBe(true);
    expect(rebuilt.balanceOf(agent.id)).toBe(before);
    expect(rebuilt.payChallenge(agent.id, challenge.id)).toEqual(expect.objectContaining({ status: "paid", replayed: true }));

    const refund = rebuilt.refund({
      providerId: provider.id,
      receiptId: paid.receipt.id,
      amount: usd(0.02),
      memo: "durable partial refund",
      idempotencyKey: "durable-refund",
    });
    expect(refund).toEqual(expect.objectContaining({ status: "refunded", replayed: false, remaining: usd(0.03) }));
    expect(rebuilt.balanceOf(agent.id)).toBe(before + usd(0.02));

    const again = MoneyNetwork.open(path);
    expect(again.redeemServiceChallenge(provider.id, service.id, challenge.id, paid.receipt.id)).toEqual(
      expect.objectContaining({ ok: false, reason: expect.stringContaining("already redeemed") })
    );
    expect(again.refundedAmount(paid.receipt.id)).toBe(usd(0.02));
    expect(again.refund({
      providerId: provider.id,
      receiptId: paid.receipt.id,
      amount: usd(0.02),
      memo: "durable partial refund",
      idempotencyKey: "durable-refund",
    })).toEqual(expect.objectContaining({ status: "refunded", replayed: true, remaining: usd(0.03) }));
    expect(again.receipts.verify()).toEqual({ ok: true });
  });
});
