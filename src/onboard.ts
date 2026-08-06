/**
 * One-command onboarding: generate the owner's keypair, register it as a
 * user, fund it, create a keyed agent, allocate a balance, sign a mandate
 * (owner-signed requests throughout), and print the MCP config to paste into
 * .mcp.json — so a Claude Code agent has a wallet in under a minute.
 *
 * Private keys are written to the gitignored state directory (default
 * .money/, override with MONEY_STATE_DIR), never printed. The MCP config
 * references the agent key by file path so no secret lands in .mcp.json.
 *
 * Usage (recommended API: the Postgres kernel — see README "Run the
 * production money kernel" — started with MONEY_ALLOW_DEV_FUNDING=true
 * npm run api:db for this local walkthrough; npm run api serves the
 * single-node JSONL showcase):
 *   npx tsx src/onboard.ts [--name scout] [--fund 20] [--budget 10]
 *
 * Against the Postgres kernel the compliance perimeter fails closed, so the
 * first run stops at funding with instructions to run the development-only
 * approval (npm run dev:approve) and resume with --user <id>; the resume run
 * reads the saved owner key from .money/ instead of creating a new account.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  configuredHttpOrigin,
  DEFAULT_CLIENT_TIMEOUT_MS,
  readBoundedJsonResponse,
} from "./core/api-client.ts";
import { generateAgentKeypair, signedHeaders } from "./core/identity.ts";
import { fmt, usd } from "./core/types.ts";

const API = configuredHttpOrigin(process.env.MONEY_API ?? "http://127.0.0.1:4021", "MONEY_API");
const STATE_DIR = process.env.MONEY_STATE_DIR ?? ".money";

/** One key per file, one line per file. 0600 on POSIX; Windows applies its
 * own ACLs. The directory is gitignored, matching the seller CLI's state.
 * Name segments may include server-returned ids, so anything outside a
 * conservative character set is replaced before touching the filesystem. */
function writeKeyFile(fileName: string, privateKey: string): string {
  mkdirSync(STATE_DIR, { recursive: true });
  const path = join(STATE_DIR, fileName.replace(/[^A-Za-z0-9._-]/g, "_"));
  writeFileSync(path, privateKey + "\n", { encoding: "utf8", mode: 0o600 });
  return isAbsolute(path) ? path : resolve(path);
}

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(`--${flag}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value ?? fallback;
}

/** Resume intent must be explicit and well-formed: `--user` with a missing or
 * flag-shaped value must not silently fall through to creating a new owner. */
function resumeUserArg(): string | undefined {
  const equalsForm = process.argv.find((entry) => entry.startsWith("--user="));
  if (equalsForm) return assertAccountId(equalsForm.slice("--user=".length));
  const i = process.argv.indexOf("--user");
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--user requires the account id printed by the first run");
  }
  return assertAccountId(value);
}

/** Account ids flow into filenames and copy-pasteable shell guidance, so an
 * unexpected shape (from a hostile or misconfigured server) is refused rather
 * than sanitized into something that looks legitimate. */
function assertAccountId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error(`unexpected account id format: ${JSON.stringify(value.slice(0, 80))}`);
  }
  return value;
}

function readKeyFile(path: string): string {
  const line = readFileSync(path, "utf8").split(/\r?\n/).find((entry) => entry.trim());
  if (!line) throw new Error(`key file ${path} is empty`);
  return line.trim();
}

/** payload is the exact body string sent — signed headers must cover the same bytes. */
async function post<T>(path: string, payload: string, extraHeaders: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: payload,
    redirect: "error",
    signal: AbortSignal.timeout(DEFAULT_CLIENT_TIMEOUT_MS),
  });
  const json = await readBoundedJsonResponse<T & { error?: string }>(
    res,
    undefined,
    "money API response",
  );
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  const agentName = arg("name", "scout");
  const fund = usd(Number(arg("fund", "20")));
  const budget = usd(Number(arg("budget", "10")));

  // The owner's identity: this key signs funding, agent creation, and
  // mandates from now on. Registering it IS the signup. With --user <id>,
  // resume an existing account using the key saved by the first run.
  const resumeUserId = resumeUserArg();
  let user: { id: string };
  let ownerPrivateKey: string;
  let ownerKeyPath: string;
  if (resumeUserId) {
    user = { id: resumeUserId };
    ownerKeyPath = resolve(join(STATE_DIR, `owner-${resumeUserId}.key`));
    ownerPrivateKey = readKeyFile(ownerKeyPath);
  } else {
    const ownerKeys = generateAgentKeypair();
    const created = await post<{ id: string }>("/users", JSON.stringify({ name: "owner", publicKey: ownerKeys.publicKey }));
    user = { id: assertAccountId(created.id) };
    // Saved before any money moves: a crash after funding must not orphan the
    // only key that can administer the funded account.
    ownerKeyPath = writeKeyFile(`owner-${user.id}.key`, ownerKeys.privateKey);
    ownerPrivateKey = ownerKeys.privateKey;
  }
  const ownerPost = <T>(path: string, body: unknown): Promise<T> => {
    const payload = JSON.stringify(body);
    const headers = signedHeaders(user.id, ownerPrivateKey, { method: "POST", path, body: payload }, "x-user-id");
    return post<T>(path, payload, headers);
  };

  try {
    // Fresh key per run: the kernel replays denials as durably as payments,
    // so a deterministic key would pin a pre-approval denial forever.
    await ownerPost("/fund", { userId: user.id, amountMicros: fund, idempotencyKey: `onboard-fund-${randomUUID()}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("treasury_required")) {
      throw new Error(
        "the Postgres API accepts top-ups only from the treasury integration. " +
        "For a local walkthrough, restart it with MONEY_ALLOW_DEV_FUNDING=true npm run api:db " +
        "(never set that in a deployed environment).\n" +
        `Your owner key is already saved at ${ownerKeyPath}; resume with: npm run onboard -- --user ${user.id}`,
      );
    }
    if (message.includes("compliance_required")) {
      throw new Error(
        "the compliance perimeter fails closed: this owner has no reviewed identity/sanctions evidence yet.\n" +
        `Your owner key is saved at ${ownerKeyPath}. For a local walkthrough:\n` +
        `  1. DATABASE_URL=<your dev database> npm run dev:approve -- --user ${user.id}\n` +
        `  2. npm run onboard -- --user ${user.id}\n` +
        "(production eligibility comes from the hosted Persona flow and named reviewers, never this tool)",
      );
    }
    throw error;
  }
  // The agent's identity: keypair generated here, public half registered with
  // the network, private half written to its own file (the MCP process reads
  // only this file — never the owner key). The filename uses the unique agent
  // id so a rerun can never overwrite an earlier agent's only key.
  const keys = generateAgentKeypair();
  const created = await ownerPost<{ id: string }>("/agents", { name: agentName, ownerId: user.id, publicKey: keys.publicKey });
  const agent = { id: assertAccountId(created.id) };
  const agentKeyPath = writeKeyFile(`agent-${agent.id}.key`, keys.privateKey);
  await ownerPost("/allocate", { userId: user.id, agentId: agent.id, amountMicros: budget, idempotencyKey: `onboard-alloc-${randomUUID()}` });
  await ownerPost("/mandates", {
    userId: user.id,
    agentId: agent.id,
    budgetMicros: budget,
    perTxCapMicros: usd(1),
    dailyCapMicros: usd(5),
    escalateAboveMicros: usd(2),
    newPayeeCapMicros: usd(0.1),
    idempotencyKey: `onboard-mandate-${randomUUID()}`,
  });
  const dashboardSession = await ownerPost<{ dashboardPath: string; expiresAt: number }>("/owner/sessions", {});

  console.log(`user    ${user.id}`);
  console.log(`agent   ${agent.id} ("${agentName}") — allocated ${fmt(budget)}, Ed25519 key registered`);
  console.log(`mandate ${fmt(budget)} budget · $1/tx · $5/day · ask above $2 · new-payee 10¢`);
  console.log();
  console.log("Owner key (signs future funding, mandates, and revokes) was written to:");
  console.log(`  ${ownerKeyPath}`);
  console.log("Owner CLIs read it by path — no key in your shell history:");
  console.log(`  MONEY_USER_ID=${user.id} MONEY_OWNER_KEY_FILE="${ownerKeyPath.replace(/\\/g, "/")}" npm run dashboard:login`);
  console.log();
  console.log("Private owner dashboard (8-hour session; the owner key stays out of the browser):");
  console.log(`${API}${dashboardSession.dashboardPath}`);
  console.log();
  console.log(`Paste into .mcp.json (the agent key stays in ${agentKeyPath}):`);
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          money: {
            command: "npx",
            args: ["-y", "@agentmoney/wallet-mcp"],
            env: {
              MONEY_API: API,
              MONEY_AGENT_ID: agent.id,
              MONEY_AGENT_KEY_FILE: agentKeyPath.replace(/\\/g, "/"),
            },
          },
        },
      },
      null,
      2
    )
  );
  console.log();
  console.log("(repo developers can swap args for [\"tsx\", \"src/mcp/server.ts\"] to run the wallet from source)");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
