import { pathToFileURL } from "node:url";
import { parseExternalHeaderKeyring } from "../bridge/cipher.ts";
import { parseEvmRpcNetworks } from "../bridge/evm-settlement.ts";
import { parseComplianceSessionKeyring } from "../compliance/session-cipher.ts";
import { isLocalEndpointHostname } from "../core/url-security.ts";
import {
  createComplianceProviderFromEnv,
  createComplianceWebhookCodecFromEnv,
} from "../compliance/runtime.ts";

const SERVICES = [
  "api",
  "database-ops",
  "external-worker",
  "treasury-webhook",
  "treasury-events",
  "treasury-payouts",
  "treasury-reconciler",
  "compliance-webhook",
  "compliance-events",
  "compliance-onboarding",
  "compliance-reviews",
  "compliance-ops",
  "compliance-console",
  "migrate",
] as const;

export type ProductionService = typeof SERVICES[number];
type Environment = Readonly<Record<string, string | undefined>>;

const SEGREGATED_AUTHORITY = [
  "DATABASE_URL",
  "MONEY_WORKER_DATABASE_URL",
  "MONEY_KEY_ROTATION_DATABASE_URL",
  "MONEY_TREASURY_ADMIN_DATABASE_URL",
  "MONEY_TREASURY_INGRESS_DATABASE_URL",
  "MONEY_TREASURY_WORKER_DATABASE_URL",
  "MONEY_PAYOUT_DATABASE_URL",
  "MONEY_RECONCILER_DATABASE_URL",
  "MONEY_COMPLIANCE_ADMIN_DATABASE_URL",
  "MONEY_COMPLIANCE_INGRESS_DATABASE_URL",
  "MONEY_COMPLIANCE_WORKER_DATABASE_URL",
  "MONEY_COMPLIANCE_ONBOARDING_DATABASE_URL",
  "MONEY_RISK_WORKER_DATABASE_URL",
  "MONEY_COMPLIANCE_OPS_DATABASE_URL",
  "MONEY_COMPLIANCE_CONSOLE_DATABASE_URL",
  "MONEY_EXTERNAL_HEADER_KEYS",
  "MONEY_EXTERNAL_HEADER_KEY",
  "MONEY_COMPLIANCE_SESSION_KEYS",
  "MONEY_COMPLIANCE_PROVIDER_API_KEY",
  "MONEY_COMPLIANCE_WEBHOOK_SECRET",
  "MONEY_COMPLIANCE_WEBHOOK_SECRETS",
  "MONEY_COLUMN_EVENT_API_KEY",
  "MONEY_COLUMN_PAYOUT_API_KEY",
  "MONEY_COLUMN_RECONCILER_API_KEY",
  "MONEY_COLUMN_WEBHOOK_SECRET",
  "MONEY_EVM_PRIVATE_KEY",
  "MONEY_EVM_RPC_URLS",
  "MONEY_EVM_SIGNER_TOKEN",
  "MONEY_TREASURY_EVM_ASSETS",
  "MONEY_OPS_TOKEN",
  "MONEY_COMPLIANCE_OPS_TOKEN",
  "MONEY_COMPLIANCE_OPERATOR_KEY",
  "MONEY_OWNER_KEY",
  "MONEY_OWNER_KEY_FILE",
  "MONEY_AGENT_KEY",
  "MONEY_AGENT_KEY_FILE",
] as const;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value || /replace-me|example\.com/i.test(value)) throw new Error(`${name} is not configured`);
  return value;
}

function secret(env: Environment, name: string, min = 16): string {
  const value = required(env, name);
  if (value.length < min) throw new Error(`${name} must contain at least ${min} characters`);
  return value;
}

function forbidden(env: Environment, ...names: string[]): void {
  const present = names.filter((name) => Boolean(env[name]?.trim()));
  if (present.length) throw new Error(`${present.join(", ")} must not be present in this service`);
}

function exactlyOne(env: Environment, ...names: string[]): void {
  const present = names.filter((name) => Boolean(env[name]?.trim()));
  if (present.length !== 1) {
    throw new Error(`configure exactly one of ${names.join(", ")}`);
  }
  required(env, present[0]!);
}

function restrictAuthority(env: Environment, ...allowed: string[]): void {
  const allowlist = new Set(allowed);
  forbidden(env, ...SEGREGATED_AUTHORITY.filter((name) => !allowlist.has(name)));
}

function database(env: Environment, name: string): URL {
  const value = required(env, name);
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }
  const username = decodeURIComponent(url.username).toLowerCase();
  if (!url.username || !url.password || ["postgres", "money"].includes(username)) {
    throw new Error(`${name} must use a passworded, non-owner service login`);
  }
  if (isLocalEndpointHostname(url)) {
    throw new Error(`${name} must not use loopback in a production container`);
  }
  const sslModes = url.searchParams.getAll("sslmode");
  if (sslModes.length !== 1 || sslModes[0] !== "verify-full") {
    throw new Error(`${name} must set sslmode=verify-full`);
  }
  return url;
}

function httpsUrl(env: Environment, name: string): URL {
  const url = new URL(required(env, name));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${name} must be an HTTPS URL without embedded credentials, query, or fragment`,
    );
  }
  if (isLocalEndpointHostname(url)) {
    throw new Error(`${name} must not use loopback in production`);
  }
  return url;
}

function evmRpcNetworks(env: Environment): void {
  const networks = parseEvmRpcNetworks(required(env, "MONEY_EVM_RPC_URLS"));
  if (networks.length < 1) throw new Error("at least one production EVM RPC network is required");
  for (const network of networks) {
    const url = new URL(network.rpcUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error(
        `EVM RPC for ${network.network} must use HTTPS without embedded credentials or a fragment`,
      );
    }
    if (isLocalEndpointHostname(url)) {
      throw new Error(`EVM RPC for ${network.network} must not use loopback in production`);
    }
    if ((network.confirmations ?? 1) > 100) {
      throw new Error(`EVM RPC confirmation count for ${network.network} must be 1-100`);
    }
  }
}

function serverBinding(env: Environment): void {
  if (!["0.0.0.0", "::"].includes(required(env, "MONEY_BIND_HOST"))) {
    throw new Error("production HTTP services must bind the container interface");
  }
}

function certifiedComplianceProvider(env: Environment): void {
  if (required(env, "MONEY_COMPLIANCE_PROVIDER") !== "persona") {
    throw new Error("the v0.13 production profile is certified only for Persona");
  }
}

function validateApi(env: Environment): void {
  database(env, "DATABASE_URL");
  const keys = required(env, "MONEY_EXTERNAL_HEADER_KEYS");
  const activeKey = required(env, "MONEY_EXTERNAL_HEADER_ACTIVE_KEY_ID");
  parseExternalHeaderKeyring(keys, activeKey);
  parseComplianceSessionKeyring(
    required(env, "MONEY_COMPLIANCE_SESSION_KEYS"),
    required(env, "MONEY_COMPLIANCE_SESSION_ACTIVE_KEY_ID"),
  );
  certifiedComplianceProvider(env);
  httpsUrl(env, "MONEY_EVM_SIGNER_URL");
  secret(env, "MONEY_EVM_SIGNER_TOKEN", 32);
  const signerAddress = required(env, "MONEY_EVM_SIGNER_ADDRESS");
  if (!/^0x[0-9a-f]{40}$/i.test(signerAddress)
    || /^0x0{40}$/i.test(signerAddress)) {
    throw new Error("MONEY_EVM_SIGNER_ADDRESS must be a nonzero 20-byte EVM address");
  }
  evmRpcNetworks(env);
  if (env.MONEY_ALLOW_DEV_FUNDING === "true" || env.MONEY_EXTERNAL_MOCK === "true"
    || env.MONEY_EVM_PRIVATE_KEY) {
    throw new Error("development funding, mock settlement, and local EVM keys are forbidden in production");
  }
  forbidden(
    env,
    "MONEY_COMPLIANCE_PROVIDER_API_KEY",
    "MONEY_COMPLIANCE_WEBHOOK_SECRET",
    "MONEY_COMPLIANCE_WEBHOOK_SECRETS",
    "MONEY_COLUMN_WEBHOOK_SECRET",
  );
  serverBinding(env);
  restrictAuthority(
    env,
    "DATABASE_URL",
    "MONEY_EXTERNAL_HEADER_KEYS",
    "MONEY_COMPLIANCE_SESSION_KEYS",
    "MONEY_EVM_RPC_URLS",
    "MONEY_EVM_SIGNER_TOKEN",
  );
}

export function preflightProductionService(
  service: ProductionService,
  env: Environment = process.env,
): { service: ProductionService; ok: true } {
  if (env.NODE_ENV !== "production") throw new Error("NODE_ENV must be production");
  if (env.MONEY_AUTO_MIGRATE === "true" || env.MONEY_MIGRATIONS?.trim()) {
    throw new Error(
      "production services must use the reviewed standalone migration job and built-in migration directory",
    );
  }
  switch (service) {
    case "api":
      validateApi(env);
      break;
    case "database-ops":
      database(env, "DATABASE_URL");
      secret(env, "MONEY_OPS_TOKEN", 32);
      serverBinding(env);
      restrictAuthority(env, "DATABASE_URL", "MONEY_OPS_TOKEN");
      break;
    case "external-worker":
      database(env, "MONEY_WORKER_DATABASE_URL");
      forbidden(env, "DATABASE_URL", "MONEY_EXTERNAL_HEADER_KEYS");
      restrictAuthority(env, "MONEY_WORKER_DATABASE_URL");
      break;
    case "treasury-webhook":
      database(env, "MONEY_TREASURY_INGRESS_DATABASE_URL");
      secret(env, "MONEY_COLUMN_WEBHOOK_SECRET", 24);
      required(env, "MONEY_COLUMN_WEBHOOK_ENDPOINT_ID");
      forbidden(env, "MONEY_COLUMN_EVENT_API_KEY", "MONEY_COLUMN_PAYOUT_API_KEY");
      serverBinding(env);
      restrictAuthority(
        env, "MONEY_TREASURY_INGRESS_DATABASE_URL", "MONEY_COLUMN_WEBHOOK_SECRET",
      );
      break;
    case "treasury-events":
      database(env, "MONEY_TREASURY_WORKER_DATABASE_URL");
      secret(env, "MONEY_COLUMN_EVENT_API_KEY", 16);
      forbidden(env, "MONEY_COLUMN_WEBHOOK_SECRET", "MONEY_COLUMN_PAYOUT_API_KEY");
      restrictAuthority(env, "MONEY_TREASURY_WORKER_DATABASE_URL", "MONEY_COLUMN_EVENT_API_KEY");
      break;
    case "treasury-payouts":
      database(env, "MONEY_PAYOUT_DATABASE_URL");
      secret(env, "MONEY_COLUMN_PAYOUT_API_KEY", 16);
      exactlyOne(env, "MONEY_COLUMN_PAYOUT_BANK_ACCOUNT_ID", "MONEY_COLUMN_PAYOUT_ACCOUNT_NUMBER_ID");
      forbidden(env, "MONEY_COLUMN_WEBHOOK_SECRET", "MONEY_COLUMN_EVENT_API_KEY");
      restrictAuthority(env, "MONEY_PAYOUT_DATABASE_URL", "MONEY_COLUMN_PAYOUT_API_KEY");
      break;
    case "treasury-reconciler":
      database(env, "MONEY_RECONCILER_DATABASE_URL");
      if (!env.MONEY_COLUMN_RECONCILER_BANK_ACCOUNT_ID?.trim()
        && !env.MONEY_TREASURY_EVM_ASSETS?.trim()) {
        throw new Error("at least one independent treasury reconciliation source is required");
      }
      if (env.MONEY_COLUMN_RECONCILER_BANK_ACCOUNT_ID) {
        secret(env, "MONEY_COLUMN_RECONCILER_API_KEY", 16);
      }
      forbidden(env, "MONEY_COLUMN_PAYOUT_API_KEY", "MONEY_COLUMN_EVENT_API_KEY");
      restrictAuthority(
        env,
        "MONEY_RECONCILER_DATABASE_URL",
        "MONEY_COLUMN_RECONCILER_API_KEY",
        "MONEY_TREASURY_EVM_ASSETS",
      );
      break;
    case "compliance-webhook":
      database(env, "MONEY_COMPLIANCE_INGRESS_DATABASE_URL");
      certifiedComplianceProvider(env);
      createComplianceWebhookCodecFromEnv(env);
      forbidden(env, "MONEY_COMPLIANCE_PROVIDER_API_KEY", "MONEY_COMPLIANCE_SESSION_KEYS");
      serverBinding(env);
      restrictAuthority(
        env,
        "MONEY_COMPLIANCE_INGRESS_DATABASE_URL",
        "MONEY_COMPLIANCE_WEBHOOK_SECRET",
        "MONEY_COMPLIANCE_WEBHOOK_SECRETS",
      );
      break;
    case "compliance-events":
      database(env, "MONEY_COMPLIANCE_WORKER_DATABASE_URL");
      certifiedComplianceProvider(env);
      createComplianceProviderFromEnv(env);
      forbidden(env, "MONEY_COMPLIANCE_WEBHOOK_SECRET", "MONEY_COMPLIANCE_WEBHOOK_SECRETS");
      restrictAuthority(env, "MONEY_COMPLIANCE_WORKER_DATABASE_URL", "MONEY_COMPLIANCE_PROVIDER_API_KEY");
      break;
    case "compliance-onboarding":
      database(env, "MONEY_COMPLIANCE_ONBOARDING_DATABASE_URL");
      certifiedComplianceProvider(env);
      createComplianceProviderFromEnv(env);
      parseComplianceSessionKeyring(
        required(env, "MONEY_COMPLIANCE_SESSION_KEYS"),
        required(env, "MONEY_COMPLIANCE_SESSION_ACTIVE_KEY_ID"),
      );
      forbidden(env, "MONEY_COMPLIANCE_WEBHOOK_SECRET", "MONEY_COMPLIANCE_WEBHOOK_SECRETS");
      restrictAuthority(
        env,
        "MONEY_COMPLIANCE_ONBOARDING_DATABASE_URL",
        "MONEY_COMPLIANCE_PROVIDER_API_KEY",
        "MONEY_COMPLIANCE_SESSION_KEYS",
      );
      break;
    case "compliance-reviews":
      database(env, "MONEY_RISK_WORKER_DATABASE_URL");
      forbidden(env, "MONEY_COMPLIANCE_PROVIDER_API_KEY", "MONEY_COMPLIANCE_SESSION_KEYS");
      restrictAuthority(env, "MONEY_RISK_WORKER_DATABASE_URL");
      break;
    case "compliance-ops":
      database(env, "MONEY_COMPLIANCE_OPS_DATABASE_URL");
      secret(env, "MONEY_COMPLIANCE_OPS_TOKEN", 32);
      forbidden(env, "MONEY_COMPLIANCE_PROVIDER_API_KEY", "MONEY_COMPLIANCE_SESSION_KEYS");
      serverBinding(env);
      restrictAuthority(env, "MONEY_COMPLIANCE_OPS_DATABASE_URL", "MONEY_COMPLIANCE_OPS_TOKEN");
      break;
    case "compliance-console":
      database(env, "MONEY_COMPLIANCE_CONSOLE_DATABASE_URL");
      forbidden(env, "MONEY_COMPLIANCE_PROVIDER_API_KEY", "MONEY_COMPLIANCE_SESSION_KEYS");
      serverBinding(env);
      restrictAuthority(env, "MONEY_COMPLIANCE_CONSOLE_DATABASE_URL");
      break;
    case "migrate":
      database(env, "DATABASE_URL");
      forbidden(
        env,
        "MONEY_COMPLIANCE_PROVIDER_API_KEY",
        "MONEY_COLUMN_WEBHOOK_SECRET",
        "MONEY_EVM_PRIVATE_KEY",
      );
      restrictAuthority(env, "DATABASE_URL");
      break;
  }
  return { service, ok: true };
}

/** Production entry points call this before opening sockets, database pools,
 * or provider clients. Development and tests retain their narrow local
 * defaults, while a production process cannot bypass the deployment contract
 * merely because an operator skipped the separate preflight command. */
export function enforceProductionPreflight(
  service: ProductionService,
  env: Environment = process.env,
): void {
  if (env.NODE_ENV === "production") preflightProductionService(service, env);
}

async function main() {
  const service = process.argv[2] as ProductionService | undefined;
  if (!service || !SERVICES.includes(service)) {
    throw new Error(`service must be one of: ${SERVICES.join(", ")}`);
  }
  console.log(JSON.stringify(preflightProductionService(service)));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
