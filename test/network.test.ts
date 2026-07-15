import { describe, expect, it } from "vitest";
import { MoneyNetwork } from "../src/core/network.ts";
import { verifyChain } from "../src/core/receipts.ts";
import { usd } from "../src/core/types.ts";

function setup(clock?: () => number) {
  const network = new MoneyNetwork(clock);
  const user = network.createUser("Max");
  network.fund(user.id, usd(20), "seed-fund");
  const agent = network.createAgent("scout", user.id);
  network.allocate(user.id, agent.id, usd(10), "seed-alloc-1");
  const peer = network.createAgent("writer", user.id);
  network.allocate(user.id, peer.id, usd(5), "seed-alloc-2");
  const provider = network.createProvider("quote-api");
  const mandate = network.grantMandate({
    userId: user.id,
    agentId: agent.id,
    budget: usd(10),
    perTxCap: usd(1),
    dailyCap: usd(5),
    escalateAbove: usd(2),
    newPayeeCap: usd(0.1),
  });
  return { network, user, agent, peer, provider, mandate };
}

describe("MoneyNetwork", () => {
  it("agent pays agent, receipts chain, ledger stays zero-sum", () => {
    const { network, agent, peer } = setup();
    const r = network.pay({ from: agent.id, to: peer.id, amount: usd(0.25), memo: "subtask", idempotencyKey: "t1" });
    expect(r.status).toBe("paid");
    expect(network.balanceOf(agent.id)).toBe(usd(9.75));
    expect(network.balanceOf(peer.id)).toBe(usd(5.25));
    expect(network.ledger.zeroSum()).toBe(true);
    expect(network.verifyReceipts().ok).toBe(true);
  });

  it("replayed idempotency key returns the original receipt without re-spending", () => {
    const { network, agent, peer } = setup();
    const first = network.pay({ from: agent.id, to: peer.id, amount: usd(0.25), memo: "m", idempotencyKey: "t1" });
    const again = network.pay({ from: agent.id, to: peer.id, amount: usd(0.25), memo: "m", idempotencyKey: "t1" });
    expect(again.status).toBe("paid");
    if (again.status === "paid" && first.status === "paid") {
      expect(again.replayed).toBe(true);
      expect(again.receipt.id).toBe(first.receipt.id);
    }
    expect(network.balanceOf(agent.id)).toBe(usd(9.75));
    expect(network.receipts.length).toBe(1);
  });

  it("denies over-envelope spends and never touches the balance", () => {
    const { network, agent, peer } = setup();
    const r = network.pay({ from: agent.id, to: peer.id, amount: usd(1.5), memo: "m", idempotencyKey: "t2" });
    expect(r.status).toBe("denied");
    expect(network.balanceOf(agent.id)).toBe(usd(10));
    expect(network.receipts.length).toBe(0);
  });

  it("denies when the agent's allocated balance is short, even inside the mandate", () => {
    const { network, user, agent, peer } = setup();
    // Drain scout to $0.10 via owner reallocation? Owner can't pull from agent in v0 —
    // instead grant a fresh agent a big mandate but tiny allocation.
    const broke = network.createAgent("broke", user.id);
    network.allocate(user.id, broke.id, usd(0.05), "alloc-broke");
    network.grantMandate({
      userId: user.id,
      agentId: broke.id,
      budget: usd(10),
      perTxCap: usd(1),
      dailyCap: usd(5),
      escalateAbove: usd(2),
      newPayeeCap: usd(1),
    });
    const r = network.pay({ from: broke.id, to: peer.id, amount: usd(0.5), memo: "m", idempotencyKey: "t3" });
    expect(r.status).toBe("denied");
    if (r.status === "denied") expect(r.code).toBe("insufficient_funds");
    expect(network.balanceOf(broke.id)).toBe(usd(0.05));
    expect(agent.id).toBeTruthy();
  });

  it("escalation → human approval pays exactly what the human saw", () => {
    const { network, agent, peer, mandate } = setup();
    const r = network.pay({ from: agent.id, to: peer.id, amount: usd(3), memo: "big", idempotencyKey: "t4" });
    expect(r.status).toBe("escalate");
    const approved = network.approveAndPay(mandate.id, {
      from: agent.id,
      to: peer.id,
      amount: usd(3),
      memo: "big",
      idempotencyKey: "t4",
    });
    expect(approved.status).toBe("paid");
    expect(network.balanceOf(agent.id)).toBe(usd(7));
  });

  it("402 challenges are payable exactly once and redeemable exactly once", () => {
    const { network, agent, provider } = setup();
    const challenge = network.createChallenge(provider.id, usd(0.02), "/paid/quote");

    const paid = network.payChallenge(agent.id, challenge.id);
    expect(paid.status).toBe("paid");
    if (paid.status !== "paid") return;

    // Paying the same challenge again replays the same transfer (idempotent).
    const rePaid = network.payChallenge(agent.id, challenge.id);
    expect(rePaid.status).toBe("paid");
    if (rePaid.status === "paid") expect(rePaid.replayed).toBe(true);
    expect(network.balanceOf(agent.id)).toBe(usd(10) - usd(0.02));

    const redeemed = network.redeemChallenge(challenge.id, paid.receipt.id);
    expect(redeemed.ok).toBe(true);
    const again = network.redeemChallenge(challenge.id, paid.receipt.id);
    expect(again.ok).toBe(false); // single-use

    const forged = network.redeemChallenge(challenge.id, "rcp_forged");
    expect(forged.ok).toBe(false);
  });

  it("mandate governs the agent, not the owner: users allocate freely", () => {
    const { network, user } = setup();
    const fresh = network.createAgent("fresh", user.id);
    network.allocate(user.id, fresh.id, usd(2), "alloc-fresh");
    expect(network.balanceOf(fresh.id)).toBe(usd(2));
  });

  it("approveAndPay rejects a mandate not bound to the paying agent, without poisoning the key", () => {
    const { network, user, agent, peer, mandate } = setup();
    // peer tries to spend under scout's mandate — denied cleanly, no ledger movement.
    const wrong = network.approveAndPay(mandate.id, {
      from: peer.id,
      to: agent.id,
      amount: usd(0.5),
      memo: "m",
      idempotencyKey: "kx",
    });
    expect(wrong.status).toBe("denied");
    expect(network.balanceOf(peer.id)).toBe(usd(5));
    // The key is still usable for a legitimate payment afterwards.
    const peerMandate = network.grantMandate({
      userId: user.id,
      agentId: peer.id,
      budget: usd(5),
      perTxCap: usd(1),
      dailyCap: usd(5),
      escalateAbove: usd(2),
      newPayeeCap: usd(0.1),
    });
    expect(peerMandate.id).toBeTruthy();
    const legit = network.pay({ from: peer.id, to: agent.id, amount: usd(0.5), memo: "m", idempotencyKey: "kx" });
    expect(legit.status).toBe("paid");
  });

  it("self-payment is a structured denial, not a crash", () => {
    const { network, agent } = setup();
    const r = network.pay({ from: agent.id, to: agent.id, amount: usd(0.05), memo: "m", idempotencyKey: "self" });
    expect(r.status).toBe("denied");
    if (r.status === "denied") expect(r.code).toBe("payee_not_allowed");
  });

  it("humanApprove with a non-positive amount is denied, not crashed", () => {
    const { network, agent, peer, mandate } = setup();
    const r = network.approveAndPay(mandate.id, { from: agent.id, to: peer.id, amount: usd(-5), memo: "m", idempotencyKey: "neg" });
    expect(r.status).toBe("denied");
    if (r.status === "denied") expect(r.code).toBe("invalid_amount");
  });

  it("a paid challenge is replayable after expiry — money taken means receipt recoverable", () => {
    const now = { t: Date.UTC(2026, 6, 15, 12) };
    const { network, agent, provider } = setup(() => now.t);
    const challenge = network.createChallenge(provider.id, usd(0.02), "/paid/quote");
    const paid = network.payChallenge(agent.id, challenge.id);
    expect(paid.status).toBe("paid");
    now.t += 11 * 60_000; // past the 10-minute TTL
    const replay = network.payChallenge(agent.id, challenge.id);
    expect(replay.status).toBe("paid");
    if (replay.status === "paid" && paid.status === "paid") {
      expect(replay.replayed).toBe(true);
      expect(replay.receipt.id).toBe(paid.receipt.id);
    }
  });

  it("redemption is bound to the endpoint's resource and price", () => {
    const { network, agent, provider } = setup();
    const cheap = network.createChallenge(provider.id, usd(0.02), "/paid/quote");
    const paid = network.payChallenge(agent.id, cheap.id);
    if (paid.status !== "paid") throw new Error("expected paid");
    // A $0.02 quote challenge must not unlock the $0.05 search resource.
    const cross = network.redeemChallenge(cheap.id, paid.receipt.id, { resource: "/paid/search", amount: usd(0.05) });
    expect(cross.ok).toBe(false);
    // And the mismatch must not have burned the challenge:
    const proper = network.redeemChallenge(cheap.id, paid.receipt.id, { resource: "/paid/quote", amount: usd(0.02) });
    expect(proper.ok).toBe(true);
  });

  it("new-payee throttle: same-owner siblings are trusted, foreign payees are not", () => {
    const { network, user, agent } = setup();
    // Sibling agent (same owner): first payment above the new-payee cap is fine.
    const sibling = network.createAgent("sibling", user.id);
    const toSibling = network.pay({ from: agent.id, to: sibling.id, amount: usd(0.5), memo: "m", idempotencyKey: "s1" });
    expect(toSibling.status).toBe("paid");

    // Another user's agent: throttled on first touch.
    const stranger = network.createUser("Stranger");
    const strangerAgent = network.createAgent("their-agent", stranger.id);
    const toStranger = network.pay({ from: agent.id, to: strangerAgent.id, amount: usd(0.5), memo: "m", idempotencyKey: "s2" });
    expect(toStranger.status).toBe("denied");
    if (toStranger.status === "denied") expect(toStranger.code).toBe("new_payee_cap");

    // Paying the owner back is also inside the trust domain.
    const toOwner = network.pay({ from: agent.id, to: user.id, amount: usd(0.5), memo: "refund", idempotencyKey: "s3" });
    expect(toOwner.status).toBe("paid");
  });

  it("receipt chain detects tampering", () => {
    const { network, agent, peer } = setup();
    network.pay({ from: agent.id, to: peer.id, amount: usd(0.25), memo: "a", idempotencyKey: "r1" });
    network.pay({ from: agent.id, to: peer.id, amount: usd(0.3), memo: "b", idempotencyKey: "r2" });
    expect(network.verifyReceipts().ok).toBe(true);

    const copy = network.feed(10).map((r) => ({ ...r }));
    copy[0]!.amount += 1;
    const v = verifyChain(copy);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.brokenAt).toBe(0);
  });
});
