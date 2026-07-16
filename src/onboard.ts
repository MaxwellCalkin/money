/**
 * One-command onboarding: create a user, fund it, create an agent, allocate
 * a balance, sign a mandate, and print the MCP config to paste into
 * .mcp.json — so a Claude Code agent has a wallet in under a minute.
 *
 * Usage (API must be running: npm run api):
 *   npx tsx src/onboard.ts [--name scout] [--fund 20] [--budget 10]
 */
import { randomUUID } from "node:crypto";
import { generateAgentKeypair } from "./core/identity.ts";
import { fmt, usd } from "./core/types.ts";

const API = process.env.MONEY_API ?? "http://127.0.0.1:4021";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(`--${flag}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value ?? fallback;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  const agentName = arg("name", "scout");
  const fund = usd(Number(arg("fund", "20")));
  const budget = usd(Number(arg("budget", "10")));

  const user = await post<{ id: string }>("/users", { name: "owner" });
  await post("/fund", { userId: user.id, amountMicros: fund, idempotencyKey: `onboard-fund-${randomUUID()}` });
  // The agent's identity: keypair generated here, public half registered with
  // the network, private half handed to the agent's MCP config below.
  const keys = generateAgentKeypair();
  const agent = await post<{ id: string }>("/agents", { name: agentName, ownerId: user.id, publicKey: keys.publicKey });
  await post("/allocate", { userId: user.id, agentId: agent.id, amountMicros: budget, idempotencyKey: `onboard-alloc-${randomUUID()}` });
  await post("/mandates", {
    userId: user.id,
    agentId: agent.id,
    budgetMicros: budget,
    perTxCapMicros: usd(1),
    dailyCapMicros: usd(5),
    escalateAboveMicros: usd(2),
    newPayeeCapMicros: usd(0.1),
  });

  console.log(`user    ${user.id}`);
  console.log(`agent   ${agent.id} ("${agentName}") — allocated ${fmt(budget)}, Ed25519 key registered`);
  console.log(`mandate ${fmt(budget)} budget · $1/tx · $5/day · ask above $2 · new-payee 10¢`);
  console.log();
  console.log("Paste into .mcp.json (MONEY_AGENT_KEY is the agent's private key — keep it out of git):");
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          money: {
            command: "npx",
            args: ["tsx", `${process.cwd().replace(/\\/g, "/")}/src/mcp/server.ts`],
            env: { MONEY_API: API, MONEY_AGENT_ID: agent.id, MONEY_AGENT_KEY: keys.privateKey },
          },
        },
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
