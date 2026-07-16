import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyNetwork } from "../src/core/network.ts";
import { JsonlStore, type NetworkEvent } from "../src/core/store.ts";
import { usd } from "../src/core/types.ts";

const DAY = 24 * 60 * 60 * 1000;
const tempDirs: string[] = [];

function tempLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "money-test-"));
  tempDirs.push(dir);
  return join(dir, "events.jsonl");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold the dir briefly; leaking a temp dir is harmless.
    }
  }
});

/** Standard world: one user, two mandated agents, one provider — durable. */
function durableSetup(path: string, clock: () => number) {
  const network = MoneyNetwork.open(path, clock);
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

describe("persistence (JSONL event sourcing)", () => {
  it("a restarted network rebuilds balances, mandate counters, and receipts exactly", () => {
    const path = tempLog();
    const now = { t: Date.UTC(2026, 6, 15, 12) };
    const clock = () => now.t;
    const { network, user, agent, peer, provider, mandate } = durableSetup(path, clock);

    // Exercise every persisted flow: agent→agent, agent→provider (new payee),
    // a 402 challenge, and an escalated human-approved payment.
    const a2a = network.pay({ from: agent.id, to: peer.id, amount: usd(0.25), memo: "subtask", idempotencyKey: "t1" });
    expect(a2a.status).toBe("paid");
    const toe = network.pay({ from: agent.id, to: provider.id, amount: usd(0.05), memo: "first touch", idempotencyKey: "t2" });
    expect(toe.status).toBe("paid");
    const challenge = network.createChallenge(provider.id, usd(0.02), "/paid/quote");
    expect(network.payChallenge(agent.id, challenge.id).status).toBe("paid");
    const big = network.approveAndPay(mandate.id, { from: agent.id, to: peer.id, amount: usd(3), memo: "big", idempotencyKey: "t3" });
    expect(big.status).toBe("paid");

    const rebuilt = MoneyNetwork.open(path, clock);

    for (const acct of [user, agent, peer, provider]) {
      expect(rebuilt.balanceOf(acct.id)).toBe(network.balanceOf(acct.id));
      expect(rebuilt.account(acct.id)).toEqual(network.account(acct.id));
    }
    expect(rebuilt.ledger.zeroSum()).toBe(true);
    expect(rebuilt.verifyReceipts()).toEqual({ ok: true });
    expect(rebuilt.feed(100)).toEqual(network.feed(100));

    const live = network.policy.activeMandateFor(agent.id)!;
    const restored = rebuilt.policy.activeMandateFor(agent.id)!;
    expect(restored.id).toBe(live.id);
    expect(restored.spent).toBe(live.spent);
    expect(restored.spentToday).toBe(live.spentToday);
    expect(restored.today).toBe(live.today);
    expect([...restored.seenPayees].sort()).toEqual([...live.seenPayees].sort());

    // Idempotency survives the restart: the old key replays the original
    // receipt instead of spending twice.
    const replay = rebuilt.pay({ from: agent.id, to: peer.id, amount: usd(0.25), memo: "subtask", idempotencyKey: "t1" });
    expect(replay.status).toBe("paid");
    if (replay.status === "paid" && a2a.status === "paid") {
      expect(replay.replayed).toBe(true);
      expect(replay.receipt.id).toBe(a2a.receipt.id);
    }
    expect(rebuilt.balanceOf(agent.id)).toBe(network.balanceOf(agent.id));
  });

  it("a same-day restart keeps the daily cap counter", () => {
    const path = tempLog();
    const now = { t: Date.UTC(2026, 6, 15, 12) };
    const { network, agent, peer } = durableSetup(path, () => now.t);
    // Spend $3 of the $5 daily cap in three $1 payments.
    for (let i = 0; i < 3; i++) {
      const r = network.pay({ from: agent.id, to: peer.id, amount: usd(1), memo: "m", idempotencyKey: `d${i}` });
      expect(r.status).toBe("paid");
    }

    now.t += 60_000; // restart a minute later, same UTC day
    const rebuilt = MoneyNetwork.open(path, () => now.t);
    expect(rebuilt.policy.activeMandateFor(agent.id)!.spentToday).toBe(usd(3));
    // $2.50 more would cross the $5 daily cap — must still be denied.
    const over = rebuilt.pay({ from: agent.id, to: peer.id, amount: usd(1), memo: "m", idempotencyKey: "d3" });
    expect(over.status).toBe("paid"); // $4 total — fine
    const crossing = rebuilt.pay({ from: agent.id, to: peer.id, amount: usd(1), memo: "m", idempotencyKey: "d4" });
    expect(crossing.status).toBe("paid"); // exactly $5 — fine
    const denied = rebuilt.pay({ from: agent.id, to: peer.id, amount: usd(0.5), memo: "m", idempotencyKey: "d5" });
    expect(denied.status).toBe("denied");
    if (denied.status === "denied") expect(denied.code).toBe("daily_cap");
  });

  it("a next-day restart resets the daily cap but never the lifetime budget", () => {
    const path = tempLog();
    const now = { t: Date.UTC(2026, 6, 15, 12) };
    const { network, agent, peer } = durableSetup(path, () => now.t);
    for (let i = 0; i < 5; i++) {
      expect(network.pay({ from: agent.id, to: peer.id, amount: usd(1), memo: "m", idempotencyKey: `b${i}` }).status).toBe("paid");
    } // $5 spent: daily cap exhausted, $5 of $10 budget used

    now.t += DAY; // restart tomorrow
    const rebuilt = MoneyNetwork.open(path, () => now.t);
    const m = rebuilt.policy.activeMandateFor(agent.id)!;
    expect(m.spentToday).toBe(0); // fresh day
    expect(m.spent).toBe(usd(5)); // lifetime spend remembered

    for (let i = 5; i < 10; i++) {
      expect(rebuilt.pay({ from: agent.id, to: peer.id, amount: usd(1), memo: "m", idempotencyKey: `b${i}` }).status).toBe("paid");
    } // $10 spent: budget exhausted
    const overBudget = rebuilt.pay({ from: agent.id, to: peer.id, amount: usd(0.05), memo: "m", idempotencyKey: "b10" });
    expect(overBudget.status).toBe("denied");
    if (overBudget.status === "denied") expect(overBudget.code).toBe("budget");
  });

  it("revocation and supersession survive a restart — no mandate resurrection", () => {
    const path = tempLog();
    const clock = () => Date.UTC(2026, 6, 15, 12);
    const { network, user, agent } = durableSetup(path, clock);
    // durableSetup granted mandate A; grant a tighter B, which supersedes A.
    const tight = network.grantMandate({
      userId: user.id,
      agentId: agent.id,
      budget: usd(1),
      perTxCap: usd(0.1),
      dailyCap: usd(0.5),
      escalateAbove: usd(0.5),
      newPayeeCap: usd(0.01),
    });

    const afterGrant = MoneyNetwork.open(path, clock);
    expect(afterGrant.policy.activeMandateFor(agent.id)!.id).toBe(tight.id);

    network.revokeMandate(tight.id);
    const afterRevoke = MoneyNetwork.open(path, clock);
    // Revoking the newest mandate means OFF — the older one must not return.
    expect(afterRevoke.policy.activeMandateFor(agent.id)).toBeUndefined();
  });

  it("a tampered log refuses to load", () => {
    const path = tempLog();
    const clock = () => Date.UTC(2026, 6, 15, 12);
    const { network, agent, peer } = durableSetup(path, clock);
    expect(network.pay({ from: agent.id, to: peer.id, amount: usd(0.25), memo: "m", idempotencyKey: "t1" }).status).toBe("paid");

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    const idx = lines.findIndex((l) => l.includes('"receipt"'));
    expect(idx).toBeGreaterThanOrEqual(0);
    const event = JSON.parse(lines[idx]!) as Extract<NetworkEvent, { type: "transfer" }>;

    // Tamper the amount consistently in transfer AND receipt → hash chain breaks.
    const consistent = structuredClone(event);
    consistent.transfer.amount += 1;
    consistent.receipt!.amount += 1;
    writeFileSync(path, [...lines.slice(0, idx), JSON.stringify(consistent), ...lines.slice(idx + 1)].join("\n") + "\n");
    expect(() => MoneyNetwork.open(path, clock)).toThrow(/tampered|corrupt/);

    // Tamper only the receipt → transfer/receipt cross-check catches it.
    const mismatched = structuredClone(event);
    mismatched.receipt!.amount += 1;
    writeFileSync(path, [...lines.slice(0, idx), JSON.stringify(mismatched), ...lines.slice(idx + 1)].join("\n") + "\n");
    expect(() => MoneyNetwork.open(path, clock)).toThrow(/does not match/);
  });

  it("a torn final line (crash mid-append) is discarded and the log stays loadable forever", () => {
    const path = tempLog();
    const clock = () => Date.UTC(2026, 6, 15, 12);
    const { network, user } = durableSetup(path, clock);
    const balance = network.balanceOf(user.id);

    appendFileSync(path, '{"type":"transfer","transfer":{"id":"tr_torn', "utf8"); // no newline

    const rebuilt = MoneyNetwork.open(path, clock);
    expect(rebuilt.balanceOf(user.id)).toBe(balance); // torn event never happened
    rebuilt.fund(user.id, usd(1), "after-crash"); // append lands after the healed tail

    const again = MoneyNetwork.open(path, clock); // and the log still loads cleanly
    expect(again.balanceOf(user.id)).toBe(balance + usd(1));
  });

  it("corruption anywhere but the tail refuses to load — never replay half a log", () => {
    const path = tempLog();
    const clock = () => Date.UTC(2026, 6, 15, 12);
    durableSetup(path, clock);
    writeFileSync(path, "not json\n" + readFileSync(path, "utf8"));
    expect(() => MoneyNetwork.open(path, clock)).toThrow(/corrupt at line 1/);
  });

  it("a reversed pay's denial replays after restart instead of crashing", () => {
    // The reversal path (transfer applied, permit re-check failed) is
    // unreachable in a single-threaded call today, so craft its log directly:
    // the replay contract is what matters.
    const path = tempLog();
    const t0 = Date.UTC(2026, 6, 15, 12);
    const store = new JsonlStore(path);
    const acct = (id: string, kind: "user" | "agent", ownerId?: string): NetworkEvent => ({
      type: "account_created",
      account: { id, kind, name: id, ownerId, createdAt: t0 },
    });
    store.append(
      acct("usr_1", "user"),
      acct("agt_1", "agent", "usr_1"),
      acct("agt_2", "agent", "usr_1"),
      {
        type: "transfer",
        transfer: { id: "tr_1", ts: t0, from: "agt_1", to: "agt_2", amount: usd(0.5), memo: "m", idempotencyKey: "k1" },
      },
      {
        type: "transfer",
        transfer: { id: "tr_2", ts: t0, from: "agt_2", to: "agt_1", amount: usd(0.5), memo: "reversal: permit expired", idempotencyKey: "rev_tr_1" },
        denial: { forKey: "k1", result: { status: "denied", code: "permit_invalid", reason: "permit expired" } },
      }
    );

    const rebuilt = MoneyNetwork.open(path, () => t0);
    const replayed = rebuilt.pay({ from: "agt_1", to: "agt_2", amount: usd(0.5), memo: "m", idempotencyKey: "k1" });
    expect(replayed.status).toBe("denied");
    if (replayed.status === "denied") expect(replayed.code).toBe("permit_invalid");
    expect(rebuilt.balanceOf("agt_1")).toBe(0); // reversal restored the balance
    expect(rebuilt.ledger.zeroSum()).toBe(true);
  });

  it("idempotent retries of funding and allocation append only one event", () => {
    const path = tempLog();
    const clock = () => Date.UTC(2026, 6, 15, 12);
    const { network, user, agent } = durableSetup(path, clock);
    network.fund(user.id, usd(20), "seed-fund"); // retry of durableSetup's fund
    network.allocate(user.id, agent.id, usd(10), "seed-alloc-1"); // retry too

    const rebuilt = MoneyNetwork.open(path, clock);
    expect(rebuilt.balanceOf(user.id)).toBe(network.balanceOf(user.id));
    expect(rebuilt.balanceOf(agent.id)).toBe(usd(10)); // allocated once, not twice
  });
});
