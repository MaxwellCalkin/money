import { describe, expect, it } from "vitest";
import { MoneyNetwork } from "../src/core/network.ts";
import { createApi } from "../src/server/api.ts";
import { usd } from "../src/core/types.ts";

function setup() {
  const network = new MoneyNetwork();
  const { app } = createApi(network);
  const user = network.createUser("Max");
  network.fund(user.id, usd(20), "seed-fund");
  const agent = network.createAgent("scout", user.id);
  network.allocate(user.id, agent.id, usd(10), "seed-alloc");
  const peer = network.createAgent("writer", user.id);
  network.grantMandate({
    userId: user.id,
    agentId: agent.id,
    budget: usd(10),
    perTxCap: usd(1),
    dailyCap: usd(5),
    escalateAbove: usd(2),
    newPayeeCap: usd(0.1),
  });
  return { network, app, user, agent, peer };
}

/** Read from an SSE stream until `predicate` matches or the deadline hits. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (buf: string) => boolean,
  deadlineMs = 3000
): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + deadlineMs;
  let buf = "";
  while (!predicate(buf)) {
    const timeLeft = deadline - Date.now();
    if (timeLeft <= 0) throw new Error(`timed out waiting for SSE data; got: ${buf.slice(0, 400)}`);
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE read timeout")), timeLeft)),
    ]);
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
  }
  return buf;
}

describe("live dashboard", () => {
  it("serves a self-contained page — no external resources", async () => {
    const { app } = setup();
    const res = await app.request("/dashboard");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("closed-loop agent payment network");
    // Self-contained: nothing loaded from another origin.
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
  });

  it("/dashboard/state reports balances, mandate counters, and the feed", async () => {
    const { network, app, agent, peer } = setup();
    const paid = network.pay({ from: agent.id, to: peer.id, amount: usd(0.25), memo: "subtask", idempotencyKey: "t1" });
    expect(paid.status).toBe("paid");

    const state = (await (await app.request("/dashboard/state")).json()) as any;
    expect(state.zeroSum).toBe(true);
    expect(state.receiptsOk).toBe(true);
    expect(state.receiptCount).toBe(1);
    expect(state.accounts.find((a: any) => a.id === agent.id).balanceMicros).toBe(usd(9.75));
    expect(state.mandates).toHaveLength(1);
    expect(state.mandates[0].spent).toBe(usd(0.25));
    expect(state.mandates[0].seenPayees).toEqual([peer.id]);
    expect(state.feed).toHaveLength(1);
    expect(state.feed[0].memo).toBe("subtask");
  });

  it("SSE sends the state on connect and pushes a fresh one when money moves", async () => {
    const { network, app, agent, peer } = setup();
    const res = await app.request("/dashboard/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    try {
      const initial = await readUntil(reader, (b) => b.includes("event: state") && b.includes("\n\n"));
      expect(initial).toContain('"receiptCount":0');

      const paid = network.pay({ from: agent.id, to: peer.id, amount: usd(0.25), memo: "live", idempotencyKey: "sse-1" });
      expect(paid.status).toBe("paid");
      if (paid.status !== "paid") return;

      // The next push (≤250ms coalescing) must carry the new receipt.
      const updated = await readUntil(reader, (b) => b.includes(paid.receipt.id));
      expect(updated).toContain('"receiptCount":1');
    } finally {
      await reader.cancel();
    }
  });

  it("network.onEvent notifies observers and unsubscribe stops it", () => {
    const { network, agent, peer } = setup();
    const seen: string[] = [];
    const unsubscribe = network.onEvent((e) => seen.push(e.type));
    network.pay({ from: agent.id, to: peer.id, amount: usd(0.1), memo: "m", idempotencyKey: "o1" });
    expect(seen).toEqual(["transfer"]);
    unsubscribe();
    network.pay({ from: agent.id, to: peer.id, amount: usd(0.1), memo: "m", idempotencyKey: "o2" });
    expect(seen).toEqual(["transfer"]);
  });

  it("a throwing observer cannot break a payment", () => {
    const { network, agent, peer } = setup();
    network.onEvent(() => {
      throw new Error("bad observer");
    });
    const paid = network.pay({ from: agent.id, to: peer.id, amount: usd(0.1), memo: "m", idempotencyKey: "x1" });
    expect(paid.status).toBe("paid");
  });
});
