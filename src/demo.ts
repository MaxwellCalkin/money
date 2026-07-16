/**
 * End-to-end demo of the money network: fund a user, mandate two agents,
 * agent-to-agent payment, retry-safe idempotency, HTTP 402 pay-per-call over
 * real localhost HTTP, the new-payee injection throttle, human escalation,
 * cap enforcement, and receipt-chain verification (including tamper detection).
 *
 * Run: npm run demo
 */
import { rmSync } from "node:fs";
import { generateAgentKeypair, signedHeaders } from "./core/identity.ts";
import { MoneyNetwork } from "./core/network.ts";
import { verifyChain } from "./core/receipts.ts";
import { fmt, usd } from "./core/types.ts";
import { startServer } from "./server/api.ts";

/** The demo runs on its own event log, wiped at start for a clean story. */
const DEMO_LOG = "data/demo-events.jsonl";

const line = (s = "") => console.log(s);
const section = (title: string) => {
  line();
  line(`━━ ${title} ${"━".repeat(Math.max(4, 64 - title.length))}`);
};
const ok = (s: string) => line(`  ✓ ${s}`);
const no = (s: string) => line(`  ✗ ${s}`);

async function waitForServer(url: string, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server at ${url} did not come up`);
}

async function main() {
  rmSync(DEMO_LOG, { force: true });
  const network = MoneyNetwork.open(DEMO_LOG);
  const { server, provider, port } = startServer(network, 4021);
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/verify`);

  try {
    section("Setup: one human, two agents, one paid API");
    const max = network.createUser("Max");
    network.fund(max.id, usd(20), "seed-fund");
    ok(`funded ${max.name} (${max.id}) with ${fmt(network.balanceOf(max.id))}`);

    const scoutKeys = generateAgentKeypair();
    const scout = network.createAgent("scout", max.id, scoutKeys.publicKey);
    const writer = network.createAgent("writer", max.id);
    network.allocate(max.id, scout.id, usd(10), "seed-alloc-scout");
    network.allocate(max.id, writer.id, usd(5), "seed-alloc-writer");
    ok(`allocated ${fmt(usd(10))} to scout (${scout.id}), ${fmt(usd(5))} to writer (${writer.id})`);

    const scoutMandate = network.grantMandate({
      userId: max.id,
      agentId: scout.id,
      budget: usd(10),
      perTxCap: usd(1),
      dailyCap: usd(5),
      escalateAbove: usd(2),
      newPayeeCap: usd(0.1),
    });
    network.grantMandate({
      userId: max.id,
      agentId: writer.id,
      budget: usd(5),
      perTxCap: usd(1),
      dailyCap: usd(2),
      escalateAbove: usd(2),
      newPayeeCap: usd(0.1),
    });
    ok(`mandates signed: scout "$10 budget, $1/tx, $5/day, ask above $2", writer "$5, $1/tx, $2/day"`);

    section("1 · Venmo moment: agent pays agent");
    const a2a = network.pay({
      from: scout.id,
      to: writer.id,
      amount: usd(0.25),
      memo: "subtask: summarize sources for the pricing report",
      idempotencyKey: "task-1441-summarize",
    });
    if (a2a.status === "paid") {
      ok(`scout → writer ${fmt(a2a.transfer.amount)} — receipt ${a2a.receipt.id}`);
      ok(`instant ledger row, zero fees, memo: "${a2a.transfer.memo}"`);
    }

    section("2 · Exactly-once: the agent retries, the network shrugs");
    const replay = network.pay({
      from: scout.id,
      to: writer.id,
      amount: usd(0.25),
      memo: "subtask: summarize sources for the pricing report",
      idempotencyKey: "task-1441-summarize",
    });
    if (replay.status === "paid" && replay.replayed) {
      ok(`same idempotency key → same transfer ${replay.transfer.id}, no double spend`);
      ok(`scout balance: ${fmt(network.balanceOf(scout.id))} (charged once)`);
    }

    section("3 · Machine economy: HTTP 402 pay-per-call, over real HTTP");
    const signedPayChallenge = (challengeId: string, privateKey: string) => {
      const body = JSON.stringify({ challengeId });
      return fetch(`${base}/pay-challenge`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...signedHeaders(scout.id, privateKey, { method: "POST", path: "/pay-challenge", body }),
        },
        body,
      });
    };
    for (let i = 1; i <= 3; i++) {
      const first = await fetch(`${base}/paid/quote`);
      if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
      const challenge = (await first.json()) as { challengeId: string; amountMicros: number };
      const payRes = await signedPayChallenge(challenge.challengeId, scoutKeys.privateKey);
      const payment = (await payRes.json()) as any;
      if (payment.status !== "paid") throw new Error(`payment denied: ${JSON.stringify(payment)}`);
      const retry = await fetch(`${base}/paid/quote`, {
        headers: {
          "x-payment-challenge": challenge.challengeId,
          "x-payment-receipt": payment.receipt.id,
        },
      });
      const bodyJson = (await retry.json()) as { quote: string };
      ok(`call ${i}: 402 → paid ${fmt(challenge.amountMicros)} → 200 "${bodyJson.quote}"`);
    }
    ok(`scout balance after three paid calls: ${fmt(network.balanceOf(scout.id))}`);

    const reuse = await fetch(`${base}/paid/quote`, {
      headers: {
        "x-payment-challenge": "chl_forged",
        "x-payment-receipt": "rcp_forged",
      },
    });
    no(`forged/reused receipt → ${reuse.status} (challenges are single-use, receipts verified)`);

    const unsigned = await fetch(`${base}/pay-challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-id": scout.id },
      body: JSON.stringify({ challengeId: "chl_whatever" }),
    });
    no(`unsigned spend claiming scout's id → ${unsigned.status} (identity is the keypair, not a header)`);
    const stolenId = await signedPayChallenge("chl_whatever", generateAgentKeypair().privateKey);
    no(`spend signed with the WRONG key → ${stolenId.status} (Ed25519 verify against the registered key)`);
    const unsignedGrant = await fetch(`${base}/mandates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: max.id, agentId: scout.id, budgetMicros: usd(1000), perTxCapMicros: usd(1000), dailyCapMicros: usd(1000), escalateAboveMicros: usd(1000), newPayeeCapMicros: usd(1000) }),
    });
    no(`unsigned attempt to widen scout's mandate to $1000 → ${unsignedGrant.status} (only the owner's key signs mandates)`);

    section("4 · Injection throttle: first payment to an unseen payee");
    const sketchy = network.createProvider("sketchy-api");
    const lured = network.pay({
      from: scout.id,
      to: sketchy.id,
      amount: usd(0.5),
      memo: "totally legitimate donation",
      idempotencyKey: "sketchy-1",
    });
    if (lured.status === "denied") no(`${fmt(usd(0.5))} to unseen payee denied: ${lured.reason}`);
    const toe = network.pay({
      from: scout.id,
      to: sketchy.id,
      amount: usd(0.05),
      memo: "small first purchase",
      idempotencyKey: "sketchy-2",
    });
    if (toe.status === "paid") ok(`${fmt(usd(0.05))} to the same payee allowed — blast radius is cents, not the envelope`);

    section("5 · Escalation: above the line, a human must sign");
    const big = network.pay({
      from: scout.id,
      to: writer.id,
      amount: usd(3),
      memo: "bulk research purchase",
      idempotencyKey: "big-1",
    });
    if (big.status === "escalate") {
      no(`${fmt(usd(3))} → escalate: ${big.reason}`);
      const approved = network.approveAndPay(scoutMandate.id, {
        from: scout.id,
        to: writer.id,
        amount: usd(3),
        memo: "bulk research purchase",
        idempotencyKey: "big-1",
      });
      if (approved.status === "paid") {
        ok(`human tapped approve (permit bound to exact payee+amount) → paid, receipt ${approved.receipt.id}`);
      }
    }

    section("6 · Caps hold even for well-funded agents");
    const overCap = network.pay({
      from: writer.id,
      to: scout.id,
      amount: usd(1.5),
      memo: "oversized",
      idempotencyKey: "over-1",
    });
    if (overCap.status === "denied") no(`writer ${fmt(usd(1.5))} → denied: ${overCap.reason}`);

    section("7 · The books");
    for (const acct of [max, scout, writer, provider]) {
      line(`  ${acct.name.padEnd(10)} ${acct.id.padEnd(14)} ${fmt(network.balanceOf(acct.id)).padStart(10)}`);
    }
    ok(`ledger zero-sum invariant: ${network.ledger.zeroSum()}`);

    const verification = network.verifyReceipts();
    ok(`receipt chain (${network.receipts.length} receipts): ${verification.ok ? "intact" : "BROKEN"}`);

    const tampered = network.feed(100).map((r) => ({ ...r }));
    if (tampered[0]) tampered[0].amount += 1;
    const detect = verifyChain(tampered);
    no(`tamper one historic amount by a single micro → chain breaks at seq ${detect.ok ? "?" : detect.brokenAt}`);

    section("8 · Durability: kill the process, keep the money");
    const rebuilt = MoneyNetwork.open(DEMO_LOG);
    const balancesMatch = [max, scout, writer, provider].every(
      (a) => rebuilt.balanceOf(a.id) === network.balanceOf(a.id)
    );
    ok(`rebuilt a fresh network from ${DEMO_LOG}: balances ${balancesMatch ? "identical" : "DIFFER (bug!)"}`);
    ok(`rebuilt receipt chain (${rebuilt.receipts.length} receipts): ${rebuilt.verifyReceipts().ok ? "intact" : "BROKEN"}`);
    ok(`rebuilt ledger zero-sum: ${rebuilt.ledger.zeroSum()}`);
    const survivedReplay = rebuilt.pay({
      from: scout.id,
      to: writer.id,
      amount: usd(0.25),
      memo: "subtask: summarize sources for the pricing report",
      idempotencyKey: "task-1441-summarize",
    });
    if (survivedReplay.status === "paid" && survivedReplay.replayed) {
      ok("idempotency survives restart: the old key returns the original receipt, no double spend");
    }

    section("Done");
    line("  One balance. Agents paying agents and paying APIs, at will,");
    line("  inside a signed envelope the model can't reach. That's the network.");
    line();
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
