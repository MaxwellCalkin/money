import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../src/core/policy.ts";
import { usd } from "../src/core/types.ts";

function engineWithClock(startMs = Date.UTC(2026, 6, 15, 12)) {
  const now = { t: startMs };
  const engine = new PolicyEngine(() => now.t);
  return { engine, now };
}

function grant(engine: PolicyEngine, overrides: Partial<Parameters<PolicyEngine["grant"]>[0]> = {}) {
  return engine.grant({
    userId: "usr_1",
    agentId: "agt_1",
    budget: usd(10),
    perTxCap: usd(1),
    dailyCap: usd(5),
    escalateAbove: usd(2),
    newPayeeCap: usd(0.1),
    ...overrides,
  });
}

/** Approve+consume helper: the normal successful spend path. */
function spend(engine: PolicyEngine, payee: string, amount: number) {
  const d = engine.evaluate("agt_1", payee, amount);
  if (!d.ok) return d;
  const c = engine.consume(d.permit.id, "agt_1", payee, amount);
  if (!c.ok) throw new Error(c.reason);
  return d;
}

describe("PolicyEngine", () => {
  it("denies with no mandate", () => {
    const { engine } = engineWithClock();
    const d = engine.evaluate("agt_1", "prv_1", usd(0.05));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("no_mandate");
  });

  it("enforces the per-transaction cap", () => {
    const { engine } = engineWithClock();
    grant(engine);
    spend(engine, "prv_1", usd(0.05)); // payee now seen
    const d = engine.evaluate("agt_1", "prv_1", usd(1.5));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("per_tx_cap");
  });

  it("escalates above the escalation line (checked before per-tx cap)", () => {
    const { engine } = engineWithClock();
    grant(engine);
    const d = engine.evaluate("agt_1", "prv_1", usd(3));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("escalate");
  });

  it("throttles the first payment to an unseen payee", () => {
    const { engine } = engineWithClock();
    grant(engine);
    const big = engine.evaluate("agt_1", "prv_new", usd(0.5));
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.code).toBe("new_payee_cap");
    spend(engine, "prv_new", usd(0.05));
    const after = engine.evaluate("agt_1", "prv_new", usd(0.5));
    expect(after.ok).toBe(true);
  });

  it("enforces the daily cap and resets it on UTC day rollover", () => {
    const { engine, now } = engineWithClock();
    grant(engine, { perTxCap: usd(5), escalateAbove: usd(5), newPayeeCap: usd(5), dailyCap: usd(5), budget: usd(20) });
    spend(engine, "prv_1", usd(3));
    spend(engine, "prv_1", usd(2));
    const over = engine.evaluate("agt_1", "prv_1", usd(0.5));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe("daily_cap");

    now.t += 24 * 60 * 60 * 1000; // next UTC day
    const fresh = engine.evaluate("agt_1", "prv_1", usd(0.5));
    expect(fresh.ok).toBe(true);
  });

  it("enforces the total budget across days", () => {
    const { engine, now } = engineWithClock();
    grant(engine, { perTxCap: usd(5), escalateAbove: usd(5), newPayeeCap: usd(5), dailyCap: usd(5), budget: usd(6) });
    spend(engine, "prv_1", usd(5));
    now.t += 24 * 60 * 60 * 1000;
    const d = engine.evaluate("agt_1", "prv_1", usd(2));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("budget");
  });

  it("enforces expiry and revocation", () => {
    const { engine, now } = engineWithClock();
    const m = grant(engine, { expiresAt: now.t + 1000 });
    now.t += 2000;
    const expired = engine.evaluate("agt_1", "prv_1", usd(0.05));
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.code).toBe("expired");

    now.t -= 2000;
    engine.revoke(m.id);
    const revoked = engine.evaluate("agt_1", "prv_1", usd(0.05));
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.code).toBe("no_mandate"); // revoked mandates are no longer active
  });

  it("enforces the payee allowlist", () => {
    const { engine } = engineWithClock();
    grant(engine, { payeeAllowlist: ["prv_ok"] });
    const d = engine.evaluate("agt_1", "prv_other", usd(0.05));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("payee_not_allowed");
    expect(engine.evaluate("agt_1", "prv_ok", usd(0.05)).ok).toBe(true);
  });

  it("permits are single-use and bound to payee+amount", () => {
    const { engine } = engineWithClock();
    grant(engine);
    const d = engine.evaluate("agt_1", "prv_1", usd(0.05));
    expect(d.ok).toBe(true);
    if (!d.ok) return;

    const wrongAmount = engine.consume(d.permit.id, "agt_1", "prv_1", usd(0.06));
    expect(wrongAmount.ok).toBe(false);
    const wrongPayee = engine.consume(d.permit.id, "agt_1", "prv_2", usd(0.05));
    expect(wrongPayee.ok).toBe(false);

    expect(engine.consume(d.permit.id, "agt_1", "prv_1", usd(0.05)).ok).toBe(true);
    const again = engine.consume(d.permit.id, "agt_1", "prv_1", usd(0.05));
    expect(again.ok).toBe(false); // used
  });

  it("permits expire", () => {
    const { engine, now } = engineWithClock();
    grant(engine);
    const d = engine.evaluate("agt_1", "prv_1", usd(0.05));
    if (!d.ok) throw new Error("expected permit");
    now.t += 61_000;
    const c = engine.consume(d.permit.id, "agt_1", "prv_1", usd(0.05));
    expect(c.ok).toBe(false);
  });

  it("human approval bypasses escalation and per-tx cap but never the budget", () => {
    const { engine } = engineWithClock();
    const m = grant(engine, { budget: usd(4) });
    const approved = engine.humanApprove(m.id, "prv_1", usd(3));
    expect(approved.ok).toBe(true);
    const overBudget = engine.humanApprove(m.id, "prv_1", usd(5));
    expect(overBudget.ok).toBe(false);
    if (!overBudget.ok) expect(overBudget.code).toBe("budget");
  });

  it("a newer mandate supersedes the old one", () => {
    const { engine } = engineWithClock();
    grant(engine, { perTxCap: usd(1) });
    grant(engine, { perTxCap: usd(0.01), newPayeeCap: usd(0.01) });
    const d = engine.evaluate("agt_1", "prv_1", usd(0.5));
    expect(d.ok).toBe(false);
  });

  it("revoking the newest mandate does not resurrect an older one", () => {
    const { engine } = engineWithClock();
    grant(engine, { budget: usd(100), perTxCap: usd(50), dailyCap: usd(100), escalateAbove: usd(50), newPayeeCap: usd(50) });
    const tight = grant(engine, { budget: usd(1) });
    engine.revoke(tight.id);
    const d = engine.evaluate("agt_1", "prv_1", usd(0.05));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("no_mandate"); // kill switch means OFF, not "older rules apply"
  });

  it("humanApprove rejects non-positive and non-integer amounts", () => {
    const { engine } = engineWithClock();
    const m = grant(engine);
    for (const bad of [0, -5_000_000, 0.5]) {
      const d = engine.humanApprove(m.id, "prv_1", bad);
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.code).toBe("invalid_amount");
    }
  });

  it("a backward clock reading cannot reset the daily counter", () => {
    const { engine, now } = engineWithClock();
    grant(engine, { perTxCap: usd(5), escalateAbove: usd(5), newPayeeCap: usd(5), dailyCap: usd(5), budget: usd(20) });
    spend(engine, "prv_1", usd(5)); // day X: cap reached
    now.t += 24 * 60 * 60 * 1000;
    spend(engine, "prv_1", usd(5)); // day X+1: cap reached again
    now.t -= 24 * 60 * 60 * 1000; // clock regresses to day X (NTP correction / skew)
    const d = engine.evaluate("agt_1", "prv_1", usd(0.5));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("daily_cap"); // counter held — fail-safe
  });
});
