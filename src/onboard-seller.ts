/**
 * One-command, crash-safe seller onboarding.
 *
 * Required environment (printed by `npm run onboard`):
 *   MONEY_USER_ID, MONEY_OWNER_KEY
 *
 * Example:
 *   npm run onboard:seller -- --handle research-cloud --slug market-report \
 *     --endpoint https://seller.example/report --price 0.05
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  configuredHttpOrigin,
  DEFAULT_CLIENT_TIMEOUT_MS,
  readBoundedJsonResponse,
} from "./core/api-client.ts";
import { generateAgentKeypair, signedHeaders } from "./core/identity.ts";
import { isValidHandle, isValidServiceSlug, normalizeHandle, normalizeServiceSlug } from "./core/network.ts";
import { fmt, usd } from "./core/types.ts";

const API = configuredHttpOrigin(process.env.MONEY_API ?? "http://127.0.0.1:4021", "MONEY_API");
const USER_ID = process.env.MONEY_USER_ID;
const OWNER_KEY = process.env.MONEY_OWNER_KEY;

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(`--${flag}`);
  return (i >= 0 ? process.argv[i + 1] : undefined) ?? fallback;
}

interface SellerServiceState {
  idempotencyKey: string;
  endpointUrl: string;
  priceMicros: number;
  name: string;
  description: string;
  serviceId?: string;
}

interface SellerState {
  version: 1;
  api: string;
  userId: string;
  handle: string;
  providerName: string;
  providerKeys: { publicKey: string; privateKey: string };
  providerId?: string;
  services: Record<string, SellerServiceState>;
}

function saveState(path: string, state: SellerState): void {
  mkdirSync(dirname(path), { recursive: true });
  // 0600 on POSIX; Windows applies its own ACLs. The directory is gitignored.
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

function readState(path: string): SellerState | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as SellerState;
  if (parsed.version !== 1 || !parsed.providerKeys?.privateKey || !parsed.providerKeys?.publicKey) {
    throw new Error(`seller state ${path} is invalid`);
  }
  return parsed;
}

async function post<T>(
  path: string,
  body: unknown,
  accountId: string,
  privateKey: string,
  idHeader: "x-user-id" | "x-provider-id"
): Promise<T> {
  const payload = JSON.stringify(body);
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signedHeaders(accountId, privateKey, { method: "POST", path, body: payload }, idHeader),
    },
    body: payload,
    redirect: "error",
    signal: AbortSignal.timeout(DEFAULT_CLIENT_TIMEOUT_MS),
  });
  const json = await readBoundedJsonResponse<T & { error?: string; reason?: string }>(
    response,
    undefined,
    "money API response",
  );
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  if (!USER_ID || !OWNER_KEY) {
    throw new Error("MONEY_USER_ID and MONEY_OWNER_KEY are required (run npm run onboard first)");
  }
  const handle = normalizeHandle(arg("handle", "research-cloud"));
  const slug = normalizeServiceSlug(arg("slug", "market-report"));
  if (!isValidHandle(handle)) throw new Error("--handle must be a valid 3-32 character network handle");
  if (!isValidServiceSlug(slug)) throw new Error("--slug must be a valid 2-48 character service slug");

  const providerName = arg("name", handle);
  const serviceName = arg("service-name", slug);
  const description = arg("description", "");
  const endpointUrl = arg("endpoint", "http://127.0.0.1:4030/report");
  const price = usd(Number(arg("price", "0.05")));
  if (price <= 0) throw new Error("--price must be positive");

  const statePath = join(process.env.MONEY_STATE_DIR ?? ".money", `seller-${handle}.json`);
  let state = readState(statePath);
  if (state) {
    if (state.api !== API || state.userId !== USER_ID || state.handle !== handle || state.providerName !== providerName) {
      throw new Error(`seller state ${statePath} belongs to different provider terms; choose another handle or state directory`);
    }
  } else {
    state = {
      version: 1,
      api: API,
      userId: USER_ID,
      handle,
      providerName,
      providerKeys: generateAgentKeypair(),
      services: {},
    };
  }

  const priorService = state.services[slug];
  if (
    priorService &&
    (priorService.endpointUrl !== endpointUrl ||
      priorService.priceMicros !== price ||
      priorService.name !== serviceName ||
      priorService.description !== description)
  ) {
    throw new Error(`service @${handle}/${slug} already has different saved terms; use a new version or slug`);
  }
  const serviceState: SellerServiceState = priorService ?? {
    idempotencyKey: `seller-service-${randomUUID()}`,
    endpointUrl,
    priceMicros: price,
    name: serviceName,
    description,
  };
  state.services[slug] = serviceState;

  // Persist keys and idempotency BEFORE either network request. A crash at
  // any later point can safely rerun the exact same provider/service writes.
  saveState(statePath, state);

  const provider = await post<{ id: string; handle: string }>(
    "/providers",
    { name: providerName, ownerId: USER_ID, handle, publicKey: state.providerKeys.publicKey },
    USER_ID,
    OWNER_KEY,
    "x-user-id"
  );
  if (state.providerId && state.providerId !== provider.id) throw new Error("provider id changed across an idempotent replay");
  state.providerId = provider.id;
  saveState(statePath, state);

  const service = await post<{ id: string; address: string }>(
    "/services",
    {
      slug,
      name: serviceName,
      description,
      endpointUrl,
      priceMicros: price,
      idempotencyKey: serviceState.idempotencyKey,
    },
    provider.id,
    state.providerKeys.privateKey,
    "x-provider-id"
  );
  if (serviceState.serviceId && serviceState.serviceId !== service.id) throw new Error("service id changed across an idempotent replay");
  serviceState.serviceId = service.id;
  saveState(statePath, state);

  console.log(`provider ${provider.id} (@${provider.handle})`);
  console.log(`service  ${service.id} (${service.address}) -> ${endpointUrl} at ${fmt(price)}`);
  console.log(`resumable seller state saved to ${statePath}`);
  console.log();
  console.log("Seller environment — keep MONEY_PROVIDER_KEY out of git:");
  console.log(JSON.stringify({
    MONEY_API: API,
    MONEY_PROVIDER_ID: provider.id,
    MONEY_PROVIDER_KEY: state.providerKeys.privateKey,
    MONEY_SERVICE_ID: service.id,
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
