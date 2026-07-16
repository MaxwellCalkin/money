import { describe, expect, it } from "vitest";
import { generateAgentKeypair, signRequest, signedHeaders } from "../src/core/identity.ts";
import { MoneyNetwork } from "../src/core/network.ts";
import { createApi } from "../src/server/api.ts";
import { usd } from "../src/core/types.ts";

/**
 * Admin routes are the envelope's control plane: whoever can call /mandates
 * can widen every limit, so they must be owner-signed. Same Ed25519 scheme
 * as agent spends, but bound to a user account via x-user-id, and every
 * handler additionally binds the signed user to the resource being touched.
 */
function setup() {
  const network = new MoneyNetwork();
  const { app } = createApi(network);
  return { network, app };
}

type App = ReturnType<typeof setup>["app"];

function ownerPost(app: App, path: string, bodyObj: unknown, userId: string, privateKey: string, overrides: Record<string, string> = {}) {
  const body = JSON.stringify(bodyObj);
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signedHeaders(userId, privateKey, { method: "POST", path, body }, "x-user-id"),
      ...overrides,
    },
    body,
  });
}

function unsignedPost(app: App, path: string, bodyObj: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
}

async function signup(app: App, name: string) {
  const keys = generateAgentKeypair();
  const res = await app.request("/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, publicKey: keys.publicKey }),
  });
  expect(res.status).toBe(200);
  const user = (await res.json()) as { id: string };
  return { user, keys };
}

describe("owner auth (admin routes)", () => {
  it("signup requires a public key — an account nobody can administer must not exist", async () => {
    const { app } = setup();
    const res = await unsignedPost(app, "/users", { name: "keyless" });
    expect(res.status).toBe(400);
    const { user } = await signup(app, "Max");
    expect(user.id).toMatch(/^usr_/);
  });

  it("every admin mutation rejects unsigned requests", async () => {
    const { app, network } = setup();
    const user = network.createUser("Max"); // in-process, keyless — fine internally
    const agent = network.createAgent("scout", user.id);
    const mandate = network.grantMandate({
      userId: user.id, agentId: agent.id,
      budget: usd(1), perTxCap: usd(1), dailyCap: usd(1), escalateAbove: usd(1), newPayeeCap: usd(1),
    });
    const attempts = [
      unsignedPost(app, "/fund", { userId: user.id, amountMicros: usd(5), idempotencyKey: "f" }),
      unsignedPost(app, "/agents", { name: "evil", ownerId: user.id }),
      unsignedPost(app, "/allocate", { userId: user.id, agentId: agent.id, amountMicros: usd(1), idempotencyKey: "a" }),
      unsignedPost(app, "/mandates", { userId: user.id, agentId: agent.id, budgetMicros: usd(1000), perTxCapMicros: usd(1000), dailyCapMicros: usd(1000), escalateAboveMicros: usd(1000), newPayeeCapMicros: usd(1000), idempotencyKey: "evil-grant" }),
      unsignedPost(app, `/mandates/${mandate.id}/revoke`, {}),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(401);
    }
    expect(network.balanceOf(user.id)).toBe(0); // nothing happened
    expect(network.policy.activeMandateFor(agent.id)!.budget).toBe(usd(1)); // not widened
  });

  it("a signed owner can run the whole onboard flow over HTTP", async () => {
    const { app, network } = setup();
    const { user, keys } = await signup(app, "Max");

    const funded = await ownerPost(app, "/fund", { userId: user.id, amountMicros: usd(20), idempotencyKey: "f1" }, user.id, keys.privateKey);
    expect(funded.status).toBe(200);
    expect(network.balanceOf(user.id)).toBe(usd(20));

    const agentKeys = generateAgentKeypair();
    const agentRes = await ownerPost(app, "/agents", { name: "scout", ownerId: user.id, publicKey: agentKeys.publicKey }, user.id, keys.privateKey);
    expect(agentRes.status).toBe(200);
    const agent = (await agentRes.json()) as { id: string };

    const alloc = await ownerPost(app, "/allocate", { userId: user.id, agentId: agent.id, amountMicros: usd(10), idempotencyKey: "a1" }, user.id, keys.privateKey);
    expect(alloc.status).toBe(200);
    expect(network.balanceOf(agent.id)).toBe(usd(10));

    const granted = await ownerPost(app, "/mandates", {
      userId: user.id, agentId: agent.id,
      budgetMicros: usd(10), perTxCapMicros: usd(1), dailyCapMicros: usd(5), escalateAboveMicros: usd(2), newPayeeCapMicros: usd(0.1),
      idempotencyKey: "grant-1",
    }, user.id, keys.privateKey);
    expect(granted.status).toBe(200);
    const mandate = (await granted.json()) as { id: string };

    // The agent can now spend under it (agent-signed).
    const payBody = JSON.stringify({ to: user.id, amountMicros: usd(0.25), memo: "refund", idempotencyKey: "p1" });
    const paid = await app.request("/pay", {
      method: "POST",
      headers: { "content-type": "application/json", ...signedHeaders(agent.id, agentKeys.privateKey, { method: "POST", path: "/pay", body: payBody }) },
      body: payBody,
    });
    expect(paid.status).toBe(200);

    // And the owner can revoke it.
    const revoked = await ownerPost(app, `/mandates/${mandate.id}/revoke`, {}, user.id, keys.privateKey);
    expect(revoked.status).toBe(200);
    expect(network.policy.activeMandateFor(agent.id)).toBeUndefined();
  });

  it("the signed user is bound to the resource — no acting on someone else's account", async () => {
    const { app, network } = setup();
    const { user: alice, keys: aliceKeys } = await signup(app, "Alice");
    const { user: bob, keys: bobKeys } = await signup(app, "Bob");
    await ownerPost(app, "/fund", { userId: alice.id, amountMicros: usd(20), idempotencyKey: "f1" }, alice.id, aliceKeys.privateKey);
    const agentRes = await ownerPost(app, "/agents", { name: "scout", ownerId: alice.id, publicKey: generateAgentKeypair().publicKey }, alice.id, aliceKeys.privateKey);
    const aliceAgent = (await agentRes.json()) as { id: string };
    const grant = await ownerPost(app, "/mandates", {
      userId: alice.id, agentId: aliceAgent.id,
      budgetMicros: usd(5), perTxCapMicros: usd(1), dailyCapMicros: usd(5), escalateAboveMicros: usd(2), newPayeeCapMicros: usd(0.1),
      idempotencyKey: "alice-grant-1",
    }, alice.id, aliceKeys.privateKey);
    const mandate = (await grant.json()) as { id: string };

    // Bob signs correctly as Bob, but touches Alice's resources → 403.
    const fundAlice = await ownerPost(app, "/fund", { userId: alice.id, amountMicros: usd(5), idempotencyKey: "fx" }, bob.id, bobKeys.privateKey);
    expect(fundAlice.status).toBe(403);
    const agentForAlice = await ownerPost(app, "/agents", { name: "mole", ownerId: alice.id }, bob.id, bobKeys.privateKey);
    expect(agentForAlice.status).toBe(403);
    const allocAlice = await ownerPost(app, "/allocate", { userId: alice.id, agentId: aliceAgent.id, amountMicros: usd(1), idempotencyKey: "ax" }, bob.id, bobKeys.privateKey);
    expect(allocAlice.status).toBe(403);
    const grantAlice = await ownerPost(app, "/mandates", {
      userId: alice.id, agentId: aliceAgent.id,
      budgetMicros: usd(1000), perTxCapMicros: usd(1000), dailyCapMicros: usd(1000), escalateAboveMicros: usd(1000), newPayeeCapMicros: usd(1000),
      idempotencyKey: "bob-widens-alice",
    }, bob.id, bobKeys.privateKey);
    expect(grantAlice.status).toBe(403);
    const revokeAlice = await ownerPost(app, `/mandates/${mandate.id}/revoke`, {}, bob.id, bobKeys.privateKey);
    expect(revokeAlice.status).toBe(403);

    // Alice's world is untouched.
    expect(network.balanceOf(alice.id)).toBe(usd(20));
    expect(network.policy.activeMandateFor(aliceAgent.id)!.id).toBe(mandate.id);
    expect(network.policy.activeMandateFor(aliceAgent.id)!.budget).toBe(usd(5));
  });

  it("an agent key cannot sign admin requests, and an owner key cannot sign spends", async () => {
    const { app, network } = setup();
    const { user, keys: ownerKeys } = await signup(app, "Max");
    await ownerPost(app, "/fund", { userId: user.id, amountMicros: usd(20), idempotencyKey: "f1" }, user.id, ownerKeys.privateKey);
    const agentKeys = generateAgentKeypair();
    const agentRes = await ownerPost(app, "/agents", { name: "scout", ownerId: user.id, publicKey: agentKeys.publicKey }, user.id, ownerKeys.privateKey);
    const agent = (await agentRes.json()) as { id: string };

    // Agent id under x-user-id: kind check rejects it — agents are not owners.
    const escalation = await ownerPost(app, "/fund", { userId: agent.id, amountMicros: usd(5), idempotencyKey: "fx" }, agent.id, agentKeys.privateKey);
    expect(escalation.status).toBe(401);

    // Owner id under x-agent-id: kind check rejects it — owners spend via allocate, not pay.
    const payBody = JSON.stringify({ to: agent.id, amountMicros: usd(1), memo: "m", idempotencyKey: "px" });
    const ownerPay = await app.request("/pay", {
      method: "POST",
      headers: { "content-type": "application/json", ...signedHeaders(user.id, ownerKeys.privateKey, { method: "POST", path: "/pay", body: payBody }) },
      body: payBody,
    });
    expect(ownerPay.status).toBe(401);
    expect(network.balanceOf(user.id)).toBe(usd(20));
  });

  it("a forged owner signature is rejected", async () => {
    const { app } = setup();
    const { user } = await signup(app, "Max");
    const thief = generateAgentKeypair();
    const res = await ownerPost(app, "/fund", { userId: user.id, amountMicros: usd(1000), idempotencyKey: "f1" }, user.id, thief.privateKey);
    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.reason).toMatch(/signature verification failed/);
  });

  it("a replayed grant returns the original mandate — spent counters are never reset", async () => {
    const { app, network } = setup();
    const { user, keys } = await signup(app, "Max");
    await ownerPost(app, "/fund", { userId: user.id, amountMicros: usd(20), idempotencyKey: "f1" }, user.id, keys.privateKey);
    const agentRes = await ownerPost(app, "/agents", { name: "scout", ownerId: user.id }, user.id, keys.privateKey);
    const agent = (await agentRes.json()) as { id: string };
    await ownerPost(app, "/allocate", { userId: user.id, agentId: agent.id, amountMicros: usd(10), idempotencyKey: "a1" }, user.id, keys.privateKey);
    const grantBody = {
      userId: user.id, agentId: agent.id,
      budgetMicros: usd(10), perTxCapMicros: usd(1), dailyCapMicros: usd(5), escalateAboveMicros: usd(2), newPayeeCapMicros: usd(0.1),
      idempotencyKey: "grant-replay",
    };
    const first = (await (await ownerPost(app, "/mandates", grantBody, user.id, keys.privateKey)).json()) as { id: string };
    // Spend, then replay the grant: the mandate must be the same one, spent intact.
    expect(network.pay({ from: agent.id, to: user.id, amount: usd(1), memo: "m", idempotencyKey: "p1" }).status).toBe("paid");
    const again = (await (await ownerPost(app, "/mandates", grantBody, user.id, keys.privateKey)).json()) as { id: string };
    expect(again.id).toBe(first.id);
    expect(network.policy.activeMandateFor(agent.id)!.spent).toBe(usd(1));
    // A grant without an idempotency key is rejected outright.
    const { idempotencyKey: _dropped, ...keyless } = grantBody;
    const noKey = await ownerPost(app, "/mandates", keyless, user.id, keys.privateKey);
    expect(noKey.status).toBe(400);
  });

  it("key rotation: the owner re-keys themself and their agents; old keys stop working", async () => {
    const { app, network } = setup();
    const { user, keys: oldOwner } = await signup(app, "Max");
    await ownerPost(app, "/fund", { userId: user.id, amountMicros: usd(20), idempotencyKey: "f1" }, user.id, oldOwner.privateKey);
    const oldAgentKeys = generateAgentKeypair();
    const agentRes = await ownerPost(app, "/agents", { name: "scout", ownerId: user.id, publicKey: oldAgentKeys.publicKey }, user.id, oldOwner.privateKey);
    const agent = (await agentRes.json()) as { id: string };
    await ownerPost(app, "/allocate", { userId: user.id, agentId: agent.id, amountMicros: usd(5), idempotencyKey: "a1" }, user.id, oldOwner.privateKey);
    await ownerPost(app, "/mandates", {
      userId: user.id, agentId: agent.id,
      budgetMicros: usd(5), perTxCapMicros: usd(1), dailyCapMicros: usd(5), escalateAboveMicros: usd(2), newPayeeCapMicros: usd(1),
      idempotencyKey: "g1",
    }, user.id, oldOwner.privateKey);

    // Rotate the agent's key (compromise remediation) — owner-signed.
    const newAgentKeys = generateAgentKeypair();
    const rotated = await ownerPost(app, `/accounts/${agent.id}/rotate-key`, { publicKey: newAgentKeys.publicKey }, user.id, oldOwner.privateKey);
    expect(rotated.status).toBe(200);
    const payBody = JSON.stringify({ to: user.id, amountMicros: usd(0.5), memo: "m", idempotencyKey: "p1" });
    const oldKeyPay = await app.request("/pay", {
      method: "POST",
      headers: { "content-type": "application/json", ...signedHeaders(agent.id, oldAgentKeys.privateKey, { method: "POST", path: "/pay", body: payBody }) },
      body: payBody,
    });
    expect(oldKeyPay.status).toBe(401); // leaked key is dead immediately
    const newKeyPay = await app.request("/pay", {
      method: "POST",
      headers: { "content-type": "application/json", ...signedHeaders(agent.id, newAgentKeys.privateKey, { method: "POST", path: "/pay", body: payBody }) },
      body: payBody,
    });
    expect(newKeyPay.status).toBe(200);

    // A compromised agent cannot re-key itself: agent key on an owner route → 401.
    const selfRekey = await ownerPost(app, `/accounts/${agent.id}/rotate-key`, { publicKey: generateAgentKeypair().publicKey }, agent.id, newAgentKeys.privateKey);
    expect(selfRekey.status).toBe(401);

    // The owner rotates their own key; old owner key stops signing admin ops.
    const newOwner = generateAgentKeypair();
    const ownRotate = await ownerPost(app, `/accounts/${user.id}/rotate-key`, { publicKey: newOwner.publicKey }, user.id, oldOwner.privateKey);
    expect(ownRotate.status).toBe(200);
    const oldOwnerFund = await ownerPost(app, "/fund", { userId: user.id, amountMicros: usd(1), idempotencyKey: "f2" }, user.id, oldOwner.privateKey);
    expect(oldOwnerFund.status).toBe(401);
    const newOwnerFund = await ownerPost(app, "/fund", { userId: user.id, amountMicros: usd(1), idempotencyKey: "f2" }, user.id, newOwner.privateKey);
    expect(newOwnerFund.status).toBe(200);

    // A stranger cannot rotate someone else's keys.
    const { user: mallory, keys: malloryKeys } = await signup(app, "Mallory");
    const steal = await ownerPost(app, `/accounts/${agent.id}/rotate-key`, { publicKey: malloryKeys.publicKey }, mallory.id, malloryKeys.privateKey);
    expect(steal.status).toBe(403);
    expect(network.account(agent.id)!.publicKey).toBe(newAgentKeys.publicKey);
  });

  it("future-dated signatures are rejected beyond a small clock skew", async () => {
    const { app } = setup();
    const { user, keys } = await signup(app, "Max");
    const body = JSON.stringify({ userId: user.id, amountMicros: usd(1), idempotencyKey: "f1" });
    const ts = Date.now() + 10 * 60_000; // ten minutes in the future
    const nonce = "nonce-future";
    const res = await app.request("/fund", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-user-id": user.id,
        "x-signature-ts": String(ts),
        "x-signature-nonce": nonce,
        "x-signature": signRequest(keys.privateKey, { method: "POST", path: "/fund", body, ts, nonce }),
      },
      body,
    });
    expect(res.status).toBe(401);
  });
});
