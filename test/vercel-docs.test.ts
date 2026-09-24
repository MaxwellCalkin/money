import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SEGREGATED_AUTHORITY } from "../src/deploy/preflight.ts";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

/** The hosted beta's posture line: verbatim in three places, never paraphrased. */
const POSTURE =
  "Single serverless beta (Vercel + Supabase), best-effort uptime, sandbox money only: " +
  "play dollars via dev funding, mock card issuer, invite-only, no KYC, x402 bridge off (routes fail closed). " +
  "Owner-app one-tap writes are session-authenticated for play dollars only. " +
  "Nothing here is a bank, card, or deposit account.";

const vercelReadme = read("deploy/vercel/README.md");
const rootReadme = read("README.md");
const landing = read("site/index.html");
const gotomarket = read("docs/GOTOMARKET.md");
const threatModel = read("docs/THREAT_MODEL.md");
const metricsDoc = read("docs/METRICS.md");
const vmReadme = read("deploy/beta/README.md");
const linter = read("scripts/lint-vocabulary.mjs");

const runtimeSources = [
  "src/deploy/vercel-beta.ts",
  "src/deploy/vercel-shared.ts",
  "src/deploy/vercel-metrics.ts",
  "src/deploy/vercel-entry.ts",
  "src/deploy/vercel-metrics-entry.ts",
  "src/db/postgres.ts",
  "scripts/build-vercel.mjs",
];
const opsSources = [
  "deploy/vercel/setup.sql",
  "deploy/vercel/setup-extensions.sql",
  "deploy/vercel/setup-shim.sql",
  "deploy/vercel/logins.sql",
  "deploy/vercel/data-api.sql",
  "deploy/vercel/schedule.sql",
  "deploy/vercel/verify.sql",
  ".github/workflows/beta-backup.yml",
  ".github/workflows/beta-restore-drill.yml",
];

/** Every configuration name a source file reads: `env.NAME`, `process.env.NAME`,
 * and whole-string literals shaped like one (`open("DATABASE_URL", ...)`,
 * `present(env, "MONEY_DB_SSL_CA")`, the allow/forbid arrays). */
function envNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/\b(?:process\.)?env\.([A-Z][A-Z0-9_]+)\b/g)) names.add(match[1]!);
  for (const match of source.matchAll(/"((?:MONEY_|PG_|BETA_)[A-Z0-9_]+|DATABASE_URL|NODE_ENV)"/g)) names.add(match[1]!);
  return names;
}

/** Names the main composer reads through helpers in other modules. */
const INDIRECT_RUNTIME_NAMES = [
  "MONEY_CARD_REVEAL_MODE",
  "MONEY_CARD_AUTH_TTL_SECONDS",
  "MONEY_CARD_WEBHOOK_TOLERANCE_SECONDS",
  "MONEY_ALLOW_DEV_FUNDING",
  "MONEY_ALLOW_SESSION_OWNER_WRITES",
  "MONEY_SIGNUP_INVITES",
  "MONEY_CARD_PROVIDER",
];

const runtimeNames = new Set<string>(INDIRECT_RUNTIME_NAMES);
for (const file of runtimeSources) for (const name of envNames(read(file))) runtimeNames.add(name);

/** The canonical table's rows, exactly as the spec names them. */
const TABLE_NAMES = [
  "MONEY_POSTURE", "NODE_ENV", "MONEY_VERCEL_ENTRY", "MONEY_METRICS_ORIGIN", "DATABASE_URL",
  "MONEY_WORKER_DATABASE_URL", "MONEY_CARD_INGRESS_DATABASE_URL", "MONEY_OPS_DATABASE_URL",
  "MONEY_METRICS_DATABASE_URL", "MONEY_DB_SSL", "MONEY_DB_SSL_CA", "PG_POOL_MAX",
  "MONEY_ALLOW_DEV_FUNDING", "MONEY_ALLOW_SESSION_OWNER_WRITES", "MONEY_SIGNUP_INVITES",
  "MONEY_CARD_PROVIDER", "MONEY_CARD_REVEAL_MODE", "MONEY_CARD_WEBHOOK_SECRETS",
  "MONEY_CARD_WEBHOOK_ENDPOINT_ID", "MONEY_SWEEP_KEY", "MONEY_METRICS_SANDBOX_LABEL",
  "MONEY_CARD_AUTH_TTL_SECONDS", "MONEY_CARD_WEBHOOK_TOLERANCE_SECONDS",
  "BETA_BACKUP_DATABASE_URL", "BETA_BACKUP_SSL_CA", "BETA_BACKUP_AGE_RECIPIENT", "BETA_BACKUP_AGE_IDENTITY",
];
const WORKFLOW_SECRETS = TABLE_NAMES.filter((name) => name.startsWith("BETA_BACKUP_"));

/** The docs checkpoint of the hosted-beta spec (sections 4.1-4.4): the
 * operator README, the landing page, and the supporting docs are reviewed as
 * text. The load-bearing check is spelling: every configuration name the
 * runtime reads must appear, identically, in the operator README, and every
 * name the ops files and workflows mention must be one the code actually
 * reads. */
describe("hosted beta docs: posture line", () => {
  it("appears verbatim in deploy/vercel/README.md, README.md, and site/index.html", () => {
    for (const text of [vercelReadme, rootReadme, landing]) expect(text).toContain(POSTURE);
  });

  it("is the only place the sandbox negation is spelled out on the landing page banner copy", () => {
    expect(landing).not.toMatch(/Testnet-labeled|free-tier VM|testnet\/beta/);
    expect(landing).toContain("Sandbox money only, hard caps, no KYC.");
    expect(landing).toContain("Single serverless beta — best-effort, honestly.");
  });
});

describe("hosted beta docs: environment-name consistency", () => {
  it("extracts the names the runtime actually reads", () => {
    for (const name of [
      "MONEY_POSTURE", "MONEY_DB_SSL", "MONEY_DB_SSL_CA", "PG_POOL_MAX", "MONEY_OPS_DATABASE_URL",
      "MONEY_SWEEP_KEY", "MONEY_CARD_WEBHOOK_ENDPOINT_ID", "MONEY_METRICS_SANDBOX_LABEL",
      "MONEY_METRICS_ORIGIN", "MONEY_VERCEL_ENTRY", "MONEY_VERCEL_OUTPUT_DIR", "PG_STATEMENT_TIMEOUT_MS",
    ]) {
      expect(runtimeNames.has(name), name).toBe(true);
    }
    // Composite literals such as error messages never masquerade as names.
    expect([...runtimeNames].every((name) => /^[A-Z][A-Z0-9_]+$/.test(name))).toBe(true);
  });

  it("names every variable the runtime reads, with the same spelling, in deploy/vercel/README.md", () => {
    const missing = [...runtimeNames].filter((name) => !vercelReadme.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });

  it("carries the canonical table with every row and every forbidden segregated-authority name", () => {
    for (const name of TABLE_NAMES) {
      expect(vercelReadme.includes(`| \`${name}\``) || vercelReadme.includes(`, \`${name}\` |`), name).toBe(true);
    }
    for (const name of SEGREGATED_AUTHORITY) expect(vercelReadme, name).toContain(`\`${name}\``);
    for (const name of ["MONEY_EXTERNAL_MOCK", "MONEY_AUTO_MIGRATE", "MONEY_CARD_WORKER_DATABASE_URL"]) {
      expect(vercelReadme).toContain(`\`${name}\``);
    }
  });

  it("only ever mentions runtime names the code reads in the ops SQL and workflows", () => {
    for (const file of opsSources) {
      const text = read(file);
      for (const match of text.matchAll(/\bMONEY_[A-Z0-9_]+\b/g)) {
        expect(runtimeNames.has(match[0]), `${file}: ${match[0]}`).toBe(true);
      }
      for (const match of text.matchAll(/\bBETA_BACKUP_[A-Z0-9_]+\b/g)) {
        expect(WORKFLOW_SECRETS, `${file}: ${match[0]}`).toContain(match[0]);
      }
    }
    const workflows = opsSources.filter((file) => file.endsWith(".yml")).map(read).join("\n");
    for (const name of WORKFLOW_SECRETS) expect(workflows, name).toContain(`secrets.${name}`);
    for (const name of ["PGSSLMODE", "PGSSLROOTCERT"]) {
      expect(workflows).toContain(name);
      expect(vercelReadme).toContain(`\`${name}`);
    }
  });

  it("documents the psql placeholders of logins.sql and schedule.sql by the names the files use", () => {
    const logins = read("deploy/vercel/logins.sql");
    const schedule = read("deploy/vercel/schedule.sql");
    for (const variable of ["app_pw", "worker_pw", "ingress_pw", "ops_pw", "metrics_pw", "backup_pw"]) {
      expect(logins).toContain(`:'${variable}'`);
      expect(vercelReadme).toContain(`-v ${variable}=`);
    }
    for (const variable of ["sweep_key", "beta_origin"]) {
      expect(schedule).toContain(`:'${variable}'`);
      expect(vercelReadme).toContain(`-v ${variable}=`);
    }
    expect(schedule).toContain("https://<beta host>");
    expect(vercelReadme).toContain("https://<beta host>");
    expect(vercelReadme).toContain("money_sweep_key");
    expect(vercelReadme).toContain("vault.update_secret");
  });

  it("tells the truth about which tools honour MONEY_DB_SSL", () => {
    // The CLI tools construct PostgresDatabase without an ssl option, so the
    // admin steps pin TLS in the URL rather than through the two variables.
    for (const file of ["src/db/migrate.ts", "src/db/reconcile.ts", "src/dev-approve.ts"]) {
      expect(read(file)).not.toContain("resolvePostgresSsl");
    }
    expect(vercelReadme).toContain("sslmode=verify-full&sslrootcert=");
    expect(vercelReadme).toContain('DATABASE_URL="$ADMIN_URL" npm run db:migrate');
  });
});

describe("hosted beta docs: README.md", () => {
  it("adds the Hosted beta section under Run it with the placeholder host and the wallet steps", () => {
    const runIt = rootReadme.indexOf("## Run it");
    const hosted = rootReadme.indexOf("### Hosted beta");
    const kernel = rootReadme.indexOf("### Run the production money kernel");
    expect(runIt).toBeGreaterThan(0);
    expect(hosted).toBeGreaterThan(runIt);
    expect(kernel).toBeGreaterThan(hosted);
    const section = rootReadme.slice(hosted, kernel);
    expect(section).toContain("https://<beta host>");
    expect(section).toContain("npm run onboard -- --invite <code>");
    expect(section).toContain("npm run onboard -- --user usr_");
    expect(section).toContain("npx -y @agentmoney/wallet-mcp");
    expect(section).toContain("deploy/vercel/README.md");
    expect(section).toContain("dev:approve");
  });
});

describe("hosted beta docs: landing page contract with the runtime", () => {
  it("posts the waitlist form to /waitlist with the runtime's field names and limits", () => {
    expect(landing).toContain('<form id="waitlist-form" action="/waitlist" method="post">');
    expect(landing).toMatch(/<input[^>]*type="email"[^>]*name="email"[^>]*required[^>]*maxlength="254"/);
    expect(landing).toMatch(/<textarea[^>]*name="note"[^>]*maxlength="500"/);
    expect(landing).toMatch(/<button[^>]*type="submit"/);
  });

  it("intercepts submit as JSON and reads the 303 states without JavaScript", () => {
    expect(landing).toContain('fetch("/waitlist"');
    expect(landing).toContain('"content-type": "application/json"');
    expect(landing).toMatch(/JSON\.stringify\(\{ email: [^}]*note: [^}]*\}\)/);
    expect(landing).toContain('.get("waitlist")');
    for (const state of ["ok", "invalid", "busy", "unavailable"]) {
      expect(landing).toContain(`data-waitlist-state="${state}"`);
    }
    expect(landing).toMatch(/res\.status === 202/);
    expect(landing).toContain('id="waitlist-fallback"');
    expect(landing).toContain("mailto:");
  });

  it("carries the hosted-beta block with the wallet steps and the origin-filled MONEY_API", () => {
    expect(landing).toContain('<section id="hosted">');
    expect(landing).toContain("npx -y @agentmoney/wallet-mcp");
    expect(landing).toContain("npm run onboard -- --invite &lt;code&gt;");
    expect(landing).toContain("https://&lt;beta host&gt;");
    expect(landing).toContain('"https://<beta host>"');
    expect(landing).toContain("location.origin");
    expect(landing).toContain('class="beta-host"');
  });

  it("makes no external request and states the waitlist data policy", () => {
    expect(landing).not.toMatch(/<script[^>]*\ssrc=/);
    expect(landing).not.toMatch(/<link[^>]*\shref=/);
    expect(landing).not.toMatch(/<img\b/);
    expect(landing).not.toMatch(/url\(\s*["']?https?:/);
    const finePrint = landing.replace(/\s+/g, " ");
    expect(finePrint).toContain("no analytics, no cookies, no external requests");
    expect(finePrint).toContain("waitlist stores your email and note only");
    expect(landing).toContain("30 days");
  });
});

describe("hosted beta docs: supporting documents", () => {
  it("records the M1 status in docs/GOTOMARKET.md dated 2026-09-11", () => {
    const status = gotomarket.indexOf("**Status (2026-09-11)");
    expect(status).toBeGreaterThan(gotomarket.indexOf("### M1"));
    expect(status).toBeLessThan(gotomarket.indexOf("### M2"));
    const paragraph = gotomarket.slice(status, gotomarket.indexOf("The funnel ships here"));
    expect(paragraph).toContain("Vercel + Supabase");
    expect(paragraph).toContain("superseded");
    expect(paragraph).toContain("beta-restore-drill");
    expect(paragraph).toContain("unmeasured");
    expect(paragraph).toContain("founder float");
  });

  it("points the VM profile at the live one and names the Postgres major mismatch", () => {
    const head = vmReadme.slice(0, 800);
    expect(head).toContain("deploy/vercel/");
    expect(head).toContain("postgres:18");
    expect(head).toContain("17");
  });

  it("extends the metrics deployment contract with the Vercel profile", () => {
    expect(metricsDoc).toContain("agentmoney-metrics");
    expect(metricsDoc).toContain("MONEY_METRICS_DATABASE_URL");
    expect(metricsDoc).toContain("s-maxage=60");
    expect(metricsDoc.replace(/\s+/g, " ")).toContain("frame-ancestors 'none'");
    expect(metricsDoc).toContain("not sybil-proof");
  });

  it("adds the hosted-beta rows to the threat model and names the custodians", () => {
    for (const marker of [
      "vault.update_secret", "vault.decrypted_secrets", "agentmoney-metrics", "join_waitlist",
      "consume_signed_request", "branch protection", "GitHub Actions", "Supabase MCP connector",
    ]) {
      expect(threatModel, marker).toContain(marker);
    }
    expect(threatModel).toMatch(/custodians are named: Vercel/);
    expect(threatModel).toContain("(`0014`)");
    expect(threatModel).not.toContain("(`0013`)");
  });

  it("scans deploy/vercel/README.md with the vocabulary linter", () => {
    expect(linter).toContain('join(root, "deploy", "vercel", "README.md")');
  });
});
