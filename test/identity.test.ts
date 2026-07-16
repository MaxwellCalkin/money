import { describe, expect, it } from "vitest";
import { generateAgentKeypair, signRequest, signedHeaders } from "../src/core/identity.ts";
import { MoneyNetwork } from "../src/core/network.ts";
import { createApi } from "../src/server/api.ts";
import { usd } from "../src/core/types.ts";

/**
 * The HTTP boundary is where identity matters: an agent is its Ed25519
 * keypair, and /pay + /pay-challenge must reject anything unsigned, forged,
 * tampered, stale, or replayed. Tests drive the Hono app in-process via
 * app.request() — same code path as real HTTP, no sockets.
 */
function setup() {
  const network = new MoneyNetwork();
  const { app, provider } = createApi(network);
  const user = network.createUser("Max");
  network.fund(user.id, usd(20), "seed-fund");
  const keys = generateAgentKeypair();
  const agent = network.createAgent("scout", user.id, keys.publicKey);
  network.allocate(user.id, agent.id, usd(10), "seed-alloc");
  const peer = network.createAgent("writer", user.id); // sibling: trusted payee
  network.grantMandate({
    userId: user.id,
    agentId: agent.id,
    budget: usd(10),
    perTxCap: usd(1),
    dailyCap: usd(5),
    escalateAbove: usd(2),
    newPayeeCap: usd(0.1),
  });
  return { network, app, provider, user, agent, peer, keys };
}

function payBody(to: string, key = "t1") {
  return JSON.stringify({ to, amountMicros: usd(0.25), memo: "m", idempotencyKey: key });
}

function signedPay(app: ReturnType<typeof setup>["app"], agentId: string, privateKey: string, body: string, headerOverrides: Record<string, string> = {}) {
  return app.request("/pay", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signedHeaders(agentId, privateKey, { method: "POST", path: "/pay", body }),
      ...headerOverrides,
    },
    body,
  });
}

describe("agent identity (Ed25519 signed requests)", () => {
  it("a correctly signed /pay goes through", async () => {
    const { network, app, agent, peer, keys } = setup();
    const res = await signedPay(app, agent.id, keys.privateKey, payBody(peer.id));
    expect(res.status).toBe(200);
    const result = (await res.json()) as any;
    expect(result.status).toBe("paid");
    expect(network.balanceOf(peer.id)).toBe(usd(0.25));
  });

  it("an unsigned request claiming an agent id is rejected — the header is not identity", async () => {
    const { network, app, agent, peer } = setup();
    const res = await app.request("/pay", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-id": agent.id },
      body: payBody(peer.id),
    });
    expect(res.status).toBe(401);
    expect(network.balanceOf(agent.id)).toBe(usd(10)); // no money moved
  });

  it("a request signed with the wrong key is rejected", async () => {
    const { network, app, agent, peer } = setup();
    const thief = generateAgentKeypair();
    const res = await signedPay(app, agent.id, thief.privateKey, payBody(peer.id));
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.reason).toMatch(/signature verification failed/);
    expect(network.balanceOf(agent.id)).toBe(usd(10));
  });

  it("tampering with the body after signing is rejected", async () => {
    const { network, app, agent, peer, keys } = setup();
    const signedOver = payBody(peer.id); // $0.25
    const sent = JSON.stringify({ to: peer.id, amountMicros: usd(0.9), memo: "m", idempotencyKey: "t1" });
    const res = await app.request("/pay", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signedHeaders(agent.id, keys.privateKey, { method: "POST", path: "/pay", body: signedOver }),
      },
      body: sent,
    });
    expect(res.status).toBe(401);
    expect(network.balanceOf(agent.id)).toBe(usd(10));
  });

  it("a stale signature is rejected", async () => {
    const { app, agent, peer, keys } = setup();
    const body = payBody(peer.id);
    const ts = Date.now() - 10 * 60_000; // signed ten minutes ago
    const nonce = "nonce-stale";
    const res = await app.request("/pay", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-id": agent.id,
        "x-signature-ts": String(ts),
        "x-signature-nonce": nonce,
        "x-signature": signRequest(keys.privateKey, { method: "POST", path: "/pay", body, ts, nonce }),
      },
      body,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.reason).toMatch(/window/);
  });

  it("replaying the exact same signed request is rejected; a re-signed retry replays idempotently", async () => {
    const { network, app, agent, peer, keys } = setup();
    const body = payBody(peer.id, "retry-key");
    const headers = {
      "content-type": "application/json",
      ...signedHeaders(agent.id, keys.privateKey, { method: "POST", path: "/pay", body }),
    };
    const first = await app.request("/pay", { method: "POST", headers, body });
    expect(first.status).toBe(200);

    // Byte-identical replay (captured on the wire) → nonce already used.
    const replayed = await app.request("/pay", { method: "POST", headers, body });
    expect(replayed.status).toBe(401);

    // Legitimate retry: fresh signature, same idempotency key → original outcome.
    const retried = await signedPay(app, agent.id, keys.privateKey, body);
    expect(retried.status).toBe(200);
    const result = (await retried.json()) as any;
    expect(result.replayed).toBe(true);
    expect(network.balanceOf(peer.id)).toBe(usd(0.25)); // charged exactly once
  });

  it("an agent with no registered key cannot spend over HTTP at all", async () => {
    const { app, peer, keys } = setup();
    // peer was created without a public key; sign with a valid key anyway.
    const res = await signedPay(app, peer.id, keys.privateKey, payBody(peer.id));
    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.reason).toMatch(/no registered public key/);
  });

  it("the full 402 flow works signed end-to-end", async () => {
    const { network, app, agent, keys } = setup();
    const first = await app.request("/paid/quote");
    expect(first.status).toBe(402);
    const challenge = (await first.json()) as any;

    const payBodyStr = JSON.stringify({ challengeId: challenge.challengeId });
    const paid = await app.request("/pay-challenge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signedHeaders(agent.id, keys.privateKey, { method: "POST", path: "/pay-challenge", body: payBodyStr }),
      },
      body: payBodyStr,
    });
    expect(paid.status).toBe(200);
    const payment = (await paid.json()) as any;
    expect(payment.status).toBe("paid");

    const served = await app.request("/paid/quote", {
      headers: {
        "x-payment-challenge": challenge.challengeId,
        "x-payment-receipt": payment.receipt.id,
      },
    });
    expect(served.status).toBe(200);
    expect(network.verifyReceipts().ok).toBe(true);
  });
});
