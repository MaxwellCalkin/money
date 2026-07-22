import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockX402Server } from "../src/bridge/mock-x402.ts";
import { MockWallet } from "../src/bridge/wallet.ts";
import { buildXPayment, canonicalHostOf, decodeXPayment, requirementToMicros, type PaymentRequirements } from "../src/bridge/x402.ts";
import { generateAgentKeypair, signedHeaders } from "../src/core/identity.ts";
import { EXTERNAL_FUNDING, EXTERNAL_X402, MoneyNetwork } from "../src/core/network.ts";
import { createApi } from "../src/server/api.ts";
import { usd } from "../src/core/types.ts";

const MOCK_ASSET = "0x00000000000000000000000000000000000c0ffe";
const PAY_TO = "0x209693bc6afc0c5328ba36faf03c514ef312287c";
// The policy payee binds host AND destination: a fresh payTo is a fresh payee.
const PAYEE = `x402:data.example.com:${PAY_TO}`;

const tempDirs: string[] = [];
function tempLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "money-bridge-"));
  tempDirs.push(dir);
  return join(dir, "events.jsonl");
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold the dir; leaking a temp dir is harmless.
    }
  }
});

function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "mock-local",
    maxAmountRequired: String(usd(0.05)),
    asset: MOCK_ASSET,
    payTo: PAY_TO,
    resource: "https://data.example.com/report",
    description: "report",
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}

/** Standard world with an HTTP app and a keyed, mandated agent. */
function setup(clock?: () => number, path?: string) {
  const network = path ? MoneyNetwork.open(path, clock ?? Date.now) : new MoneyNetwork(clock);
  const { app, wallet } = createApi(network);
  const user = network.createUser("Max");
  network.fund(user.id, usd(20), "seed-fund");
  const agentKeys = generateAgentKeypair();
  const agent = network.createAgent("scout", user.id, agentKeys.publicKey);
  network.allocate(user.id, agent.id, usd(10), "seed-alloc");
  network.grantMandate({
    userId: user.id,
    agentId: agent.id,
    budget: usd(10),
    perTxCap: usd(1),
    dailyCap: usd(5),
    escalateAbove: usd(2),
    newPayeeCap: usd(0.1),
  });
  return { network, app, wallet, user, agent, agentKeys };
}

type App = ReturnType<typeof setup>["app"];

function agentPost(app: App, path: string, bodyObj: unknown, agentId: string, privateKey: string) {
  const body = JSON.stringify(bodyObj);
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signedHeaders(agentId, privateKey, { method: "POST", path, body }),
    },
    body,
  });
}

describe("external x402 bridge", () => {
  it("pays a real-shaped external 402 end-to-end: header issued, seller verifies, confirm finalizes", async () => {
    const { network, app, wallet, agent, agentKeys } = setup();
    const mock = createMockX402Server({
      payTo: PAY_TO,
      asset: MOCK_ASSET,
      network: "mock-local",
      priceAtomic: String(usd(0.05)),
      resourcePath: "/external/report",
      verify: (auth, domain, sig) => (wallet as MockWallet).verifyAuthorization(auth, domain, sig),
    });

    const url = "https://data.example.com/external/report";
    const demand = await mock.app.request("/external/report");
    expect(demand.status).toBe(402);
    const body402 = (await demand.json()) as any;
    expect(body402.x402Version).toBe(1);

    const paid = await agentPost(app, "/pay-external", { url, requirement: body402.accepts[0], idempotencyKey: "x1" }, agent.id, agentKeys.privateKey);
    expect(paid.status).toBe(200);
    const payment = (await paid.json()) as any;
    expect(payment.state).toBe("pending");
    expect(payment.receipt.externalPayee).toBe(PAYEE);
    expect(network.balanceOf(agent.id)).toBe(usd(10) - usd(0.05));
    expect(network.balanceOf(EXTERNAL_X402)).toBe(usd(0.05));
    expect(network.ledger.zeroSum()).toBe(true);

    // The seller accepts the issued header exactly once.
    const served = await mock.app.request("/external/report", { headers: { "x-payment": payment.paymentHeader } });
    expect(served.status).toBe(200);
    const settlement = served.headers.get("x-payment-response");
    expect(settlement).toBeTruthy();
    const replayedHeader = await mock.app.request("/external/report", { headers: { "x-payment": payment.paymentHeader } });
    expect(replayedHeader.status).toBe(402); // nonce single-use, like the chain

    const confirmed = await agentPost(app, `/pay-external/${payment.externalId}/confirm`, { transaction: "0xmocktx" }, agent.id, agentKeys.privateKey);
    expect(confirmed.status).toBe(200);
    expect(network.externalPayment(payment.externalId)!.state).toBe("confirmed");
    expect(network.verifyReceipts().ok).toBe(true);
  });

  it("replaying the create key returns the SAME payment and header — one purchase, one authorization", async () => {
    const { network, app, agent, agentKeys } = setup();
    const url = "https://data.example.com/external/report";
    const first = (await (await agentPost(app, "/pay-external", { url, requirement: requirement(), idempotencyKey: "x1" }, agent.id, agentKeys.privateKey)).json()) as any;
    const again = (await (await agentPost(app, "/pay-external", { url, requirement: requirement(), idempotencyKey: "x1" }, agent.id, agentKeys.privateKey)).json()) as any;
    expect(again.replayed).toBe(true);
    expect(again.externalId).toBe(first.externalId);
    expect(again.paymentHeader).toBe(first.paymentHeader); // never a second signed authorization
    expect(network.balanceOf(agent.id)).toBe(usd(10) - usd(0.05)); // debited once
  });

  it("an unconfirmed payment auto-reverses after its deadline; a reversed payment can never confirm", () => {
    const now = { t: Date.UTC(2026, 6, 15, 12) };
    const { network, agent } = setup(() => now.t);
    const { header, authorization } = buildXPayment(new MockWallet(), requirement(), now.t);
    const paid = network.payExternal({
      agentId: agent.id,
      host: "data.example.com",
      payTo: PAY_TO,
      asset: MOCK_ASSET,
      network: "mock-local",
      resource: "/external/report",
      amount: usd(0.05),
      idempotencyKey: "x1",
      paymentHeader: header,
      reverseAfter: Number(authorization.validBefore) * 1000 + 60_000,
    });
    expect(paid.status).toBe("paid");
    if (paid.status !== "paid") return;
    const spentBefore = network.policy.activeMandateFor(agent.id)!.spent;

    now.t = paid.payment.reverseAfter + 1;
    const reversed = network.sweepExternal();
    expect(reversed.map((p) => p.id)).toEqual([paid.payment.id]);
    expect(network.balanceOf(agent.id)).toBe(usd(10)); // refunded
    expect(network.balanceOf(EXTERNAL_X402)).toBe(0);
    expect(network.ledger.zeroSum()).toBe(true);
    // Conservative: the reversal does NOT hand budget back to the agent.
    expect(network.policy.activeMandateFor(agent.id)!.spent).toBe(spentBefore);

    const late = network.confirmExternal(paid.payment.id);
    expect(late.ok).toBe(false);
    expect(network.externalPayment(paid.payment.id)!.state).toBe("reversed");

    // Replaying the create key after the auto-reversal must NOT report "paid"
    // (and hand back a now-worthless header) — the purchase is refunded, dead.
    const replayAfterReversal = network.payExternal({
      agentId: agent.id, host: "data.example.com", payTo: PAY_TO, asset: MOCK_ASSET, network: "mock-local",
      resource: "/external/report", amount: usd(0.05), idempotencyKey: "x1",
      paymentHeader: header, reverseAfter: Number(authorization.validBefore) * 1000 + 60_000,
    });
    expect(replayAfterReversal.status).toBe("denied");
    expect(network.balanceOf(agent.id)).toBe(usd(10)); // still refunded, no re-debit
  });

  it("the vendor host is the policy payee: throttled on first touch, canonicalized against case/port/dot variants", async () => {
    const { network, app, agent, agentKeys } = setup();
    // First touch above the 10¢ new-payee cap → denied.
    const big = await agentPost(app, "/pay-external", {
      url: "https://data.example.com/x",
      requirement: requirement({ maxAmountRequired: String(usd(0.5)) }),
      idempotencyKey: "x1",
    }, agent.id, agentKeys.privateKey);
    expect(big.status).toBe(402);
    const bigBody = (await big.json()) as any;
    expect(bigBody.code).toBe("new_payee_cap");

    // Small first touch passes; the host graduates.
    const toe = await agentPost(app, "/pay-external", { url: "https://data.example.com/x", requirement: requirement(), idempotencyKey: "x2" }, agent.id, agentKeys.privateKey);
    expect(toe.status).toBe(200);

    // Case/port/trailing-dot variants are the SAME payee — no fresh allowance needed, and the throttle can't be dodged.
    expect(canonicalHostOf("https://DATA.EXAMPLE.COM.:8443/y")).toEqual({ ok: true, host: "data.example.com" });
    expect(canonicalHostOf("http://data.example.com/y")).toEqual(expect.objectContaining({ ok: false }));
    expect(canonicalHostOf("https://user:secret@data.example.com/y")).toEqual(expect.objectContaining({ ok: false }));
    expect(canonicalHostOf("https://data.example.com/y#duplicate-alias")).toEqual(expect.objectContaining({ ok: false }));
    const variant = await agentPost(app, "/pay-external", {
      url: "https://DATA.EXAMPLE.COM.:8443/y",
      requirement: requirement({ maxAmountRequired: String(usd(0.5)) }),
      idempotencyKey: "x3",
    }, agent.id, agentKeys.privateKey);
    expect(variant.status).toBe(200); // graduated host+payTo: above the new-payee cap is fine (within per-tx cap)
    expect([...network.policy.activeMandateFor(agent.id)!.seenPayees]).toEqual([PAYEE]);
  });

  it("a fresh destination on a seen host is a NEW payee — payTo redirection is throttled", async () => {
    const { app, agent, agentKeys } = setup();
    // Graduate the vendor host with a small legit payment to PAY_TO.
    const legit = await agentPost(app, "/pay-external", { url: "https://data.example.com/x", requirement: requirement(), idempotencyKey: "x1" }, agent.id, agentKeys.privateKey);
    expect(legit.status).toBe(200);
    // Same host, but redirect the money to an attacker address above the
    // new-payee cap: the throttle must treat it as an unseen payee.
    const redirect = await agentPost(app, "/pay-external", {
      url: "https://data.example.com/x",
      requirement: requirement({ payTo: "0xattacker00000000000000000000000000000bad", maxAmountRequired: String(usd(0.5)) }),
      idempotencyKey: "x2",
    }, agent.id, agentKeys.privateKey);
    expect(redirect.status).toBe(402);
    expect((await redirect.json() as any).code).toBe("new_payee_cap");
  });

  it("economic fields are pinned server-side: bad asset, bad network, huge or garbage amounts all rejected", async () => {
    const { app, agent, agentKeys } = setup();
    const cases: Array<[string, Partial<PaymentRequirements>]> = [
      ["unlisted asset", { asset: "0xEvilToken00000000000000000000000000000000" }],
      ["unlisted network", { network: "evil-chain" }],
      ["non-digit amount", { maxAmountRequired: "1e6" }],
      ["negative amount", { maxAmountRequired: "-5" }],
      ["above hard cap", { maxAmountRequired: String(usd(11)) }],
      ["wrong scheme", { scheme: "upto" }],
    ];
    for (const [label, override] of cases) {
      const res = await agentPost(app, "/pay-external", {
        url: "https://data.example.com/x",
        requirement: requirement(override),
        idempotencyKey: `bad-${label}`,
      }, agent.id, agentKeys.privateKey);
      expect(res.status, label).toBe(400);
    }
    expect(requirementToMicros(requirement()).ok).toBe(true);
  });

  it("agents cannot pay boundary accounts directly — fabricated external outflows are structurally dead", () => {
    const { network, agent, user } = setup();
    for (const boundary of [EXTERNAL_X402, EXTERNAL_FUNDING]) {
      const r = network.pay({ from: agent.id, to: boundary, amount: usd(0.05), memo: "m", idempotencyKey: `b-${boundary}` });
      expect(r.status).toBe("denied");
      if (r.status === "denied") expect(r.code).toBe("payee_not_allowed");
    }
    // The human-approval path is equally closed.
    const mandate = network.policy.activeMandateFor(agent.id)!;
    const approved = network.approveAndPay(mandate.id, { from: agent.id, to: EXTERNAL_X402, amount: usd(0.05), memo: "m", idempotencyKey: "b2" });
    expect(approved.status).toBe("denied");
    expect(network.balanceOf(EXTERNAL_X402)).toBe(0);
    expect(user.id).toBeTruthy();
  });

  it("external payments survive a restart: state, throttle graduation, and pending auto-reversal", () => {
    const path = tempLog();
    const now = { t: Date.UTC(2026, 6, 15, 12) };
    const clock = () => now.t;
    const { network, agent } = setup(clock, path);
    const wallet = new MockWallet();

    const pay = (key: string, amountUsd: number) => {
      const req = requirement({ maxAmountRequired: String(usd(amountUsd)) });
      const { header, authorization } = buildXPayment(wallet, req, now.t);
      return network.payExternal({
        agentId: agent.id,
        host: "data.example.com",
        payTo: PAY_TO,
        asset: MOCK_ASSET,
        network: "mock-local",
        resource: "/external/report",
        amount: usd(amountUsd),
        idempotencyKey: key,
        paymentHeader: header,
        reverseAfter: Number(authorization.validBefore) * 1000 + 60_000,
      });
    };

    const first = pay("k1", 0.05); // graduates the host
    expect(first.status).toBe("paid");
    if (first.status !== "paid") return;
    expect(network.confirmExternal(first.payment.id, "0xtx1").ok).toBe(true);
    const second = pay("k2", 0.05); // left pending → must auto-reverse after restart
    expect(second.status).toBe("paid");
    if (second.status !== "paid") return;

    const rebuilt = MoneyNetwork.open(path, clock);
    expect(rebuilt.externalPayment(first.payment.id)!.state).toBe("confirmed");
    expect(rebuilt.externalPayment(second.payment.id)!.state).toBe("pending");
    expect(rebuilt.externalPayment(second.payment.id)!.paymentHeader).toBe(second.payment.paymentHeader);
    // Throttle graduation survives: the host is already seen, so a payment
    // above the new-payee cap is NOT re-throttled.
    expect([...rebuilt.policy.activeMandateFor(agent.id)!.seenPayees]).toEqual([PAYEE]);
    const afterRestart = (() => {
      const req = requirement({ maxAmountRequired: String(usd(0.5)) });
      const { header, authorization } = buildXPayment(wallet, req, now.t);
      return rebuilt.payExternal({
        agentId: agent.id, host: "data.example.com", payTo: PAY_TO, asset: MOCK_ASSET, network: "mock-local",
        resource: "/external/report", amount: usd(0.5), idempotencyKey: "k3", paymentHeader: header,
        reverseAfter: Number(authorization.validBefore) * 1000 + 60_000,
      });
    })();
    expect(afterRestart.status).toBe("paid");
    if (afterRestart.status === "paid") {
      expect(rebuilt.confirmExternal(afterRestart.payment.id, "0xtx3").ok).toBe(true);
    }
    // A replayed create key still returns the original payment after restart.
    const rebuiltReplay = (() => {
      const req = requirement({ maxAmountRequired: String(usd(0.05)) });
      const { header, authorization } = buildXPayment(wallet, req, now.t);
      return rebuilt.payExternal({
        agentId: agent.id, host: "data.example.com", payTo: PAY_TO, asset: MOCK_ASSET, network: "mock-local",
        resource: "/external/report", amount: usd(0.05), idempotencyKey: "k2", paymentHeader: header,
        reverseAfter: Number(authorization.validBefore) * 1000 + 60_000,
      });
    })();
    expect(rebuiltReplay.status).toBe("paid");
    if (rebuiltReplay.status === "paid") {
      expect(rebuiltReplay.replayed).toBe(true);
      expect(rebuiltReplay.payment.paymentHeader).toBe(second.payment.paymentHeader);
    }

    // The pending payment auto-reverses on the rebuilt network once its deadline passes.
    now.t = rebuilt.externalPayment(second.payment.id)!.reverseAfter + 1;
    const reversed = rebuilt.sweepExternal();
    expect(reversed.map((p) => p.id)).toEqual([second.payment.id]);
    expect(rebuilt.ledger.zeroSum()).toBe(true);
    expect(rebuilt.verifyReceipts().ok).toBe(true);
  });

  it("tampering with externalPayee in the log refuses to load — the vendor identity is hashed", () => {
    const path = tempLog();
    const clock = () => Date.UTC(2026, 6, 15, 12);
    const { network, agent } = setup(clock, path);
    const wallet = new MockWallet();
    const req = requirement();
    const { header, authorization } = buildXPayment(wallet, req, clock());
    const paid = network.payExternal({
      agentId: agent.id, host: "evil.example.com", payTo: PAY_TO, asset: MOCK_ASSET, network: "mock-local",
      resource: "/x", amount: usd(0.05), idempotencyKey: "k1", paymentHeader: header,
      reverseAfter: Number(authorization.validBefore) * 1000 + 60_000,
    });
    expect(paid.status).toBe("paid");

    // Repoint the vendor from evil.example.com to trusted.example.com in BOTH
    // the transfer and receipt (evading the cross-check) — the receipt hash
    // must still catch it.
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    const idx = lines.findIndex((l) => l.includes('"externalPayee":"x402:evil.example.com:') && l.includes('"receipt"'));
    expect(idx).toBeGreaterThanOrEqual(0);
    const doctored = lines[idx]!.replaceAll("x402:evil.example.com", "x402:trusted.example.com");
    writeFileSync(path, [...lines.slice(0, idx), doctored, ...lines.slice(idx + 1)].join("\n") + "\n");
    expect(() => MoneyNetwork.open(path, clock)).toThrow(/tampered|corrupt/);
  });

  it("the mock seller rejects forged signatures and expired authorizations", async () => {
    const walletA = new MockWallet();
    const walletB = new MockWallet(); // different key — signatures must not cross-verify
    const mock = createMockX402Server({
      payTo: PAY_TO,
      asset: MOCK_ASSET,
      network: "mock-local",
      priceAtomic: String(usd(0.05)),
      resourcePath: "/external/report",
      verify: (auth, domain, sig) => walletA.verifyAuthorization(auth, domain, sig),
    });
    const forged = buildXPayment(walletB, requirement(), Date.now());
    const rejected = await mock.app.request("/external/report", { headers: { "x-payment": forged.header } });
    expect(rejected.status).toBe(402);

    const expired = buildXPayment(walletA, requirement({ maxTimeoutSeconds: 10 }), Date.now() - 60_000);
    const stale = await mock.app.request("/external/report", { headers: { "x-payment": expired.header } });
    expect(stale.status).toBe(402);

    const good = buildXPayment(walletA, requirement(), Date.now());
    const ok = await mock.app.request("/external/report", { headers: { "x-payment": good.header } });
    expect(ok.status).toBe(200);
    expect(decodeXPayment(good.header)!.payload.authorization.to).toBe(PAY_TO);
  });
});
