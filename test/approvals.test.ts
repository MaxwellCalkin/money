import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyNetwork } from "../src/core/network.ts";
import { usd } from "../src/core/types.ts";

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

function setup(network = new MoneyNetwork()) {
  const user = network.createUser("Max");
  const agent = network.createAgent("Scout", user.id);
  const payee = network.createAgent("Writer", user.id);
  network.fund(user.id, usd(20), "fund");
  network.allocate(user.id, agent.id, usd(10), "allocate");
  const mandate = network.grantMandate({
    userId: user.id,
    agentId: agent.id,
    budget: usd(10),
    perTxCap: usd(10),
    dailyCap: usd(10),
    escalateAbove: usd(2),
    newPayeeCap: usd(0.1),
    idempotencyKey: "mandate",
  });
  return { network, user, agent, payee, mandate };
}

function largePayment(agentId: string, payeeId: string) {
  return {
    from: agentId,
    to: payeeId,
    amount: usd(3),
    memo: "large research job",
    idempotencyKey: "large-job",
  };
}

describe("durable human approvals", () => {
  it("creates one immutable request and retries it without moving money", () => {
    const { network, agent, payee } = setup();
    const terms = largePayment(agent.id, payee.id);
    const first = network.requestPayment(terms);
    expect(first).toEqual(expect.objectContaining({
      status: "approval_required",
      replayed: false,
      approval: expect.objectContaining({ agentId: agent.id, to: payee.id, amount: usd(3), status: "pending" }),
    }));
    const retry = network.requestPayment(terms);
    expect(retry).toEqual(expect.objectContaining({
      status: "approval_required",
      replayed: true,
      approval: expect.objectContaining({ id: first.status === "approval_required" ? first.approval.id : "" }),
    }));
    expect(network.balanceOf(agent.id)).toBe(usd(10));
    expect(network.balanceOf(payee.id)).toBe(0);

    const duplicateIntent = network.requestPayment({ ...terms, idempotencyKey: "accidental-new-key" });
    expect(duplicateIntent).toEqual(expect.objectContaining({
      status: "approval_required",
      replayed: true,
      approval: expect.objectContaining({ id: first.status === "approval_required" ? first.approval.id : "" }),
    }));
    expect(network.listAgentApprovals(agent.id)).toHaveLength(1);

    expect(network.requestPayment({ ...terms, amount: usd(4) })).toEqual(expect.objectContaining({
      status: "denied",
      code: "idempotency_conflict",
    }));
  });

  it("approves the stored tuple exactly once and agent retries recover the receipt", () => {
    const { network, user, agent, payee, mandate } = setup();
    const requested = network.requestPayment(largePayment(agent.id, payee.id));
    if (requested.status !== "approval_required") throw new Error("expected approval");

    const approved = network.approvePayment(user.id, requested.approval.id);
    expect(approved).toEqual(expect.objectContaining({
      replayed: false,
      approval: expect.objectContaining({ status: "approved" }),
      payment: expect.objectContaining({ status: "paid", replayed: false }),
    }));
    expect(network.balanceOf(agent.id)).toBe(usd(7));
    expect(network.balanceOf(payee.id)).toBe(usd(3));
    expect(network.policy.get(mandate.id)!.spent).toBe(usd(3));

    const ownerRetry = network.approvePayment(user.id, requested.approval.id);
    expect(ownerRetry).toEqual(expect.objectContaining({ replayed: true, payment: expect.objectContaining({ status: "paid", replayed: true }) }));
    const agentRetry = network.requestPayment(largePayment(agent.id, payee.id));
    expect(agentRetry).toEqual(expect.objectContaining({ status: "paid", replayed: true }));
    expect(network.balanceOf(agent.id)).toBe(usd(7));
  });

  it("binds resolution to the granting owner and makes rejection final", () => {
    const { network, user, agent, payee } = setup();
    const stranger = network.createUser("Mallory");
    const requested = network.requestPayment(largePayment(agent.id, payee.id));
    if (requested.status !== "approval_required") throw new Error("expected approval");

    expect(() => network.approvePayment(stranger.id, requested.approval.id)).toThrow(/different user/);
    const rejected = network.rejectApproval(user.id, requested.approval.id, "not in scope");
    expect(rejected.approval).toEqual(expect.objectContaining({ status: "rejected", reason: "not in scope" }));
    expect(network.requestPayment(largePayment(agent.id, payee.id))).toEqual(expect.objectContaining({
      status: "denied",
      code: "approval_rejected",
      reason: "not in scope",
    }));
    expect(network.requestPayment({ ...largePayment(agent.id, payee.id), idempotencyKey: "try-again-too-soon" })).toEqual(
      expect.objectContaining({ status: "denied", code: "approval_rejected", reason: expect.stringContaining("cooled down") })
    );
    expect(network.balanceOf(agent.id)).toBe(usd(10));
  });

  it("caps the approval inbox so a compromised agent cannot spam its owner", () => {
    const { network, agent, payee } = setup();
    for (let i = 0; i < 20; i++) {
      expect(network.requestPayment({
        ...largePayment(agent.id, payee.id),
        memo: `job ${i}`,
        idempotencyKey: `approval-spam-${i}`,
      }).status).toBe("approval_required");
    }
    expect(network.requestPayment({
      ...largePayment(agent.id, payee.id),
      memo: "one too many",
      idempotencyKey: "approval-spam-21",
    })).toEqual(expect.objectContaining({ status: "denied", code: "approval_limit" }));
    expect(network.listAgentApprovals(agent.id)).toHaveLength(20);
  });

  it("expires unattended requests without granting authority", () => {
    const now = { value: Date.UTC(2026, 6, 18) };
    const clock = () => now.value;
    const { network, agent, payee } = setup(new MoneyNetwork(clock));
    const requested = network.requestPayment(largePayment(agent.id, payee.id));
    if (requested.status !== "approval_required") throw new Error("expected approval");
    now.value = requested.approval.expiresAt;

    expect(network.requestPayment(largePayment(agent.id, payee.id))).toEqual(expect.objectContaining({
      status: "denied",
      code: "approval_expired",
    }));
    expect(network.balanceOf(agent.id)).toBe(usd(10));
  });

  it("can approve a high-value 402 challenge and redeem it without repaying", () => {
    const { network, user, agent } = setup();
    const provider = network.createProvider("Premium API");
    const challenge = network.createChallenge(provider.id, usd(3), "/premium/report");
    const requested = network.payChallenge(agent.id, challenge.id);
    expect(requested.status).toBe("approval_required");
    if (requested.status !== "approval_required") throw new Error("expected approval");

    const approved = network.approvePayment(user.id, requested.approval.id);
    expect(approved.payment).toEqual(expect.objectContaining({ status: "paid" }));
    if (approved.payment?.status !== "paid") throw new Error("expected payment");
    expect(network.redeemChallenge(challenge.id, approved.payment.receipt.id, {
      resource: "/premium/report",
      amount: usd(3),
    }).ok).toBe(true);
    expect(network.payChallenge(agent.id, challenge.id)).toEqual(expect.objectContaining({ status: "paid", replayed: true }));
    expect(network.balanceOf(provider.id)).toBe(usd(3));
  });

  it("recovers an approved payment when the process crashes before the resolution event", () => {
    const dir = mkdtempSync(join(tmpdir(), "money-approval-"));
    tempDirs.push(dir);
    const path = join(dir, "events.jsonl");
    const { network, user, agent, payee } = setup(MoneyNetwork.open(path));
    const terms = largePayment(agent.id, payee.id);
    const requested = network.requestPayment(terms);
    if (requested.status !== "approval_required") throw new Error("expected approval");
    const approved = network.approvePayment(user.id, requested.approval.id);
    expect(approved.payment).toEqual(expect.objectContaining({ status: "paid" }));

    // Simulate a crash after the transfer's atomic log append but before the
    // following approval_resolved append. Replay must derive approval from the
    // receipt instead of charging again or showing it as pending.
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    writeFileSync(path, lines.slice(0, -1).join("\n") + "\n", "utf8");

    const rebuilt = MoneyNetwork.open(path);
    expect(rebuilt.approval(requested.approval.id)).toEqual(expect.objectContaining({
      status: "approved",
      receiptId: approved.approval.receiptId,
    }));
    expect(rebuilt.requestPayment(terms)).toEqual(expect.objectContaining({ status: "paid", replayed: true }));
    expect(rebuilt.approvePayment(user.id, requested.approval.id)).toEqual(expect.objectContaining({ replayed: true }));
    expect(rebuilt.balanceOf(agent.id)).toBe(usd(7));
    expect(rebuilt.receipts.verify()).toEqual({ ok: true });
  });
});
