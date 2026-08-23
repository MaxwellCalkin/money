import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const preflight = join(root, "dist", "deploy", "preflight.js");
const key = Buffer.alloc(32, 11).toString("base64");
const database = (role) =>
  `postgres://${role}_login:release-test-password@db.internal:5432/money?sslmode=verify-full`;
const persona = {
  MONEY_COMPLIANCE_PROVIDER: "persona",
  MONEY_COMPLIANCE_PROVIDER_API_KEY: "persona-release-read-key",
  MONEY_PERSONA_API_VERSION: "2025-12-08",
  MONEY_PERSONA_INDIVIDUAL_TEMPLATE_ID: "itmpl_IndividualRelease123",
  MONEY_PERSONA_BUSINESS_TEMPLATE_ID: "itmpl_BusinessRelease1234",
  MONEY_PERSONA_INDIVIDUAL_WATCHLIST_REPORT_TEMPLATE_ID:
    "rptp_IndividualWatchlistRelease123",
  MONEY_PERSONA_BUSINESS_WATCHLIST_REPORT_TEMPLATE_ID:
    "rptp_BusinessWatchlistRelease12345",
  MONEY_PERSONA_BUSINESS_ASSOCIATED_PERSONS_REPORT_TEMPLATE_ID:
    "rptp_BusinessOwnersRelease12345678",
};
const webhook = {
  MONEY_COMPLIANCE_PROVIDER: "persona",
  MONEY_COMPLIANCE_WEBHOOK_ENDPOINT_ID: "wbh_ReleaseEndpoint123",
  MONEY_COMPLIANCE_WEBHOOK_SECRETS: JSON.stringify([
    "wbhsec_current-release-secret",
    "wbhsec_previous-release-secret",
  ]),
};

const services = {
  migrate: {
    command: "dist/db/migrate.js",
    env: { DATABASE_URL: database("money_migrator") },
    foreign: { MONEY_COMPLIANCE_PROVIDER_API_KEY: "must-not-cross" },
  },
  api: {
    command: "dist/server/postgres-api.js",
    env: {
      MONEY_BIND_HOST: "0.0.0.0",
      DATABASE_URL: database("money_app"),
      MONEY_EXTERNAL_HEADER_KEYS: JSON.stringify({ "external-release": key }),
      MONEY_EXTERNAL_HEADER_ACTIVE_KEY_ID: "external-release",
      MONEY_COMPLIANCE_SESSION_KEYS: JSON.stringify({ "compliance-release": key }),
      MONEY_COMPLIANCE_SESSION_ACTIVE_KEY_ID: "compliance-release",
      MONEY_COMPLIANCE_PROVIDER: "persona",
      MONEY_EVM_SIGNER_URL: "https://signer.internal/x402",
      MONEY_EVM_SIGNER_ADDRESS: "0x1111111111111111111111111111111111111111",
      MONEY_EVM_SIGNER_TOKEN: "remote-signer-release-token-at-least-32-characters",
      MONEY_EVM_RPC_URLS: JSON.stringify({
        "eip155:8453": { url: "https://rpc.internal/base", confirmations: 2 },
      }),
    },
    foreign: { MONEY_COLUMN_PAYOUT_API_KEY: "must-not-cross" },
  },
  "database-ops": {
    command: "dist/server/database-ops.js",
    env: {
      MONEY_BIND_HOST: "0.0.0.0",
      DATABASE_URL: database("money_ops"),
      MONEY_OPS_TOKEN: "database-ops-release-token-at-least-32-characters",
    },
    foreign: { MONEY_EXTERNAL_HEADER_KEYS: JSON.stringify({ foreign: key }) },
  },
  "external-worker": {
    command: "dist/db/external-worker.js",
    env: { MONEY_WORKER_DATABASE_URL: database("money_worker") },
    foreign: { DATABASE_URL: database("money_app") },
  },
  "treasury-webhook": {
    command: "dist/treasury/webhook-server.js",
    env: {
      MONEY_BIND_HOST: "0.0.0.0",
      MONEY_TREASURY_INGRESS_DATABASE_URL: database("money_treasury_ingress"),
      MONEY_COLUMN_WEBHOOK_SECRET: "column-webhook-release-secret",
      MONEY_COLUMN_WEBHOOK_ENDPOINT_ID: "column-webhook-release-endpoint",
    },
    foreign: { MONEY_COLUMN_PAYOUT_API_KEY: "must-not-cross" },
  },
  "treasury-events": {
    command: "dist/treasury/event-worker.js",
    env: {
      MONEY_TREASURY_WORKER_DATABASE_URL: database("money_treasury_worker"),
      MONEY_COLUMN_EVENT_API_KEY: "column-event-release-key",
    },
    foreign: { MONEY_COLUMN_WEBHOOK_SECRET: "must-not-cross" },
  },
  "treasury-payouts": {
    command: "dist/treasury/payout-worker.js",
    env: {
      MONEY_PAYOUT_DATABASE_URL: database("money_payout_worker"),
      MONEY_COLUMN_PAYOUT_API_KEY: "column-payout-release-key",
      MONEY_COLUMN_PAYOUT_BANK_ACCOUNT_ID: "bank-release-account",
    },
    foreign: { MONEY_COLUMN_EVENT_API_KEY: "must-not-cross" },
  },
  "treasury-reconciler": {
    command: "dist/treasury/reconciler.js",
    env: {
      MONEY_RECONCILER_DATABASE_URL: database("money_reconciler"),
      MONEY_COLUMN_RECONCILER_BANK_ACCOUNT_ID: "bank-release-account",
      MONEY_COLUMN_RECONCILER_API_KEY: "column-reconciler-release-key",
    },
    foreign: { MONEY_COLUMN_PAYOUT_API_KEY: "must-not-cross" },
  },
  "compliance-webhook": {
    command: "dist/compliance/webhook-server.js",
    env: {
      MONEY_BIND_HOST: "0.0.0.0",
      MONEY_COMPLIANCE_INGRESS_DATABASE_URL: database("money_compliance_ingress"),
      ...webhook,
    },
    foreign: { MONEY_COMPLIANCE_PROVIDER_API_KEY: "must-not-cross" },
  },
  "compliance-events": {
    command: "dist/compliance/event-worker.js",
    env: {
      MONEY_COMPLIANCE_WORKER_DATABASE_URL: database("money_compliance_worker"),
      ...persona,
    },
    foreign: { MONEY_COMPLIANCE_WEBHOOK_SECRET: "must-not-cross" },
  },
  "compliance-onboarding": {
    command: "dist/compliance/onboarding-worker.js",
    env: {
      MONEY_COMPLIANCE_ONBOARDING_DATABASE_URL: database("money_compliance_onboarding"),
      ...persona,
      MONEY_COMPLIANCE_SESSION_KEYS: JSON.stringify({ "compliance-release": key }),
      MONEY_COMPLIANCE_SESSION_ACTIVE_KEY_ID: "compliance-release",
    },
    foreign: { MONEY_COMPLIANCE_WEBHOOK_SECRET: "must-not-cross" },
  },
  "compliance-reviews": {
    command: "dist/compliance/review-worker.js",
    env: { MONEY_RISK_WORKER_DATABASE_URL: database("money_risk_worker") },
    foreign: { MONEY_COMPLIANCE_PROVIDER_API_KEY: "must-not-cross" },
  },
  "compliance-ops": {
    command: "dist/compliance/ops-server.js",
    env: {
      MONEY_BIND_HOST: "0.0.0.0",
      MONEY_COMPLIANCE_OPS_DATABASE_URL: database("money_compliance_ops"),
      MONEY_COMPLIANCE_OPS_TOKEN: "compliance-ops-release-token-at-least-32-characters",
    },
    foreign: { MONEY_COMPLIANCE_PROVIDER_API_KEY: "must-not-cross" },
  },
  "compliance-console": {
    command: "dist/compliance/console-server.js",
    env: {
      MONEY_BIND_HOST: "0.0.0.0",
      MONEY_COMPLIANCE_CONSOLE_DATABASE_URL: database("money_compliance_console"),
    },
    foreign: { MONEY_COMPLIANCE_PROVIDER_API_KEY: "must-not-cross" },
  },
  "card-authorization": {
    command: "dist/cards/authorization-server.js",
    env: {
      MONEY_BIND_HOST: "0.0.0.0",
      MONEY_CARD_INGRESS_DATABASE_URL: database("money_card_ingress"),
      MONEY_CARD_PROVIDER: "stripe-issuing",
      MONEY_CARD_WEBHOOK_ENDPOINT_ID: "we_ReleaseCardEndpoint123",
      MONEY_CARD_WEBHOOK_SECRETS: JSON.stringify([
        "whsec_current-card-release-secret",
        "whsec_previous-card-release-secret",
      ]),
    },
    foreign: { MONEY_CARD_ISSUER_API_KEY: "must-not-cross" },
  },
  "card-events": {
    command: "dist/cards/event-worker.js",
    env: {
      MONEY_CARD_WORKER_DATABASE_URL: database("money_card_worker"),
      MONEY_CARD_PROVIDER: "stripe-issuing",
      MONEY_CARD_EVENT_API_KEY: "card-event-release-read-key",
      MONEY_CARD_ISSUER_BASE_URL: "https://issuer.internal/stripe",
    },
    foreign: { MONEY_CARD_WEBHOOK_SECRETS: JSON.stringify(["cross-service-card-webhook-secret"]) },
  },
};

const inherited = Object.fromEntries([
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP",
].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));

function execute(service, environment) {
  return spawnSync(process.execPath, [preflight, service], {
    cwd: root,
    env: { ...inherited, NODE_ENV: "production", ...environment },
    encoding: "utf8",
    windowsHide: true,
  });
}

if (!existsSync(preflight)) throw new Error("run npm run build before verify:deployment");
const compose = readFileSync(join(root, "deploy", "compose.production.yaml"), "utf8");
const serviceBlock = compose.slice(compose.indexOf("services:"), compose.indexOf("\nnetworks:"));
const composedServices = [...serviceBlock.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)]
  .map((match) => match[1]).sort();
const expectedServices = Object.keys(services).sort();
if (JSON.stringify(composedServices) !== JSON.stringify(expectedServices)) {
  throw new Error(`Compose/preflight service mismatch: ${JSON.stringify(composedServices)}`);
}

for (const [service, definition] of Object.entries(services)) {
  const artifact = join(root, ...definition.command.split("/"));
  if (!existsSync(artifact)) throw new Error(`${service} compiled command is missing`);
  if (!serviceBlock.includes(`command: [${definition.command}]`)) {
    throw new Error(`${service} Compose command does not match ${definition.command}`);
  }
  const accepted = execute(service, definition.env);
  if (accepted.error || accepted.status !== 0) {
    throw new Error(`${service} preflight failed: ${accepted.error?.message ?? accepted.stderr}`);
  }
  const output = JSON.parse(accepted.stdout.trim());
  if (output.service !== service || output.ok !== true) {
    throw new Error(`${service} preflight returned an invalid result`);
  }
  const rejected = execute(service, { ...definition.env, ...definition.foreign });
  if (rejected.status === 0 || !/must not be present/.test(rejected.stderr)) {
    throw new Error(`${service} accepted a foreign service authority`);
  }
}

console.log(JSON.stringify({ services: expectedServices.length, positive: 16, negative: 16 }));
