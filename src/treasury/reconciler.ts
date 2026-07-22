import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readBoundedResponseText } from "../core/bounded-response.ts";
import { isLoopbackHostname } from "../core/url-security.ts";
import { enforceProductionPreflight } from "../deploy/preflight.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import { PostgresTreasury } from "../db/treasury.ts";
import { ColumnClient, columnBankSnapshot } from "./column.ts";
import { readBoundedInteger } from "./runtime.ts";

const MAX_EVM_RPC_BODY_BYTES = 128 * 1024;

export interface TreasuryAssetObservation {
  provider: string;
  providerAccountRef: string;
  asset: string;
  bookMicros: bigint;
  availableMicros: bigint;
  holdingMicros: bigint;
  lockedMicros: bigint;
  pendingMicros: bigint;
  providerObservationId: string;
  observedAt: Date;
}

export interface TreasuryAssetSource {
  observe(): Promise<TreasuryAssetObservation>;
}

export class ColumnBankAssetSource implements TreasuryAssetSource {
  constructor(readonly column: ColumnClient, readonly bankAccountId: string) {}

  async observe(): Promise<TreasuryAssetObservation> {
    const observedAt = new Date();
    return columnBankSnapshot(await this.column.getBankAccount(this.bankAccountId), observedAt);
  }
}

interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface EvmUsdcSourceOptions {
  provider: string;
  rpcUrl: string;
  walletAddress: string;
  tokenAddress: string;
  fetch?: typeof fetch;
  allowInsecureLocalhost?: boolean;
}

function evmAddress(value: string, name: string): string {
  if (!/^0x[0-9a-f]{40}$/i.test(value)) throw new Error(`${name} must be a 20-byte EVM address`);
  return value.toLowerCase();
}

/** Read-only ERC-20 source for six-decimal USD stablecoins. No signing key is
 * present in the reconciler process. */
export class EvmUsdcAssetSource implements TreasuryAssetSource {
  private readonly rpcUrl: URL;
  private readonly wallet: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(readonly options: EvmUsdcSourceOptions) {
    this.rpcUrl = new URL(options.rpcUrl);
    const loopback = isLoopbackHostname(this.rpcUrl);
    if (this.rpcUrl.protocol !== "https:" && !(options.allowInsecureLocalhost && loopback)) {
      throw new Error("treasury EVM RPC must use HTTPS");
    }
    if (loopback && !options.allowInsecureLocalhost) {
      throw new Error("treasury EVM RPC localhost access requires explicit development mode");
    }
    if (this.rpcUrl.username || this.rpcUrl.password || this.rpcUrl.hash) {
      throw new Error("treasury EVM RPC URL must not contain credentials or a fragment");
    }
    this.wallet = evmAddress(options.walletAddress, "walletAddress");
    this.token = evmAddress(options.tokenAddress, "tokenAddress");
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await this.fetcher(this.rpcUrl, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await readBoundedResponseText(
      response,
      MAX_EVM_RPC_BODY_BYTES,
      "treasury EVM RPC response is too large",
    );
    if (!response.ok) throw new Error(`treasury EVM RPC returned HTTP ${response.status}`);
    let result: JsonRpcEnvelope;
    try {
      result = JSON.parse(body) as JsonRpcEnvelope;
    } catch {
      throw new Error("treasury EVM RPC returned invalid JSON");
    }
    if (result.error || typeof result.result !== "string") {
      throw new Error(`treasury EVM RPC failed${result.error?.message ? `: ${result.error.message}` : ""}`);
    }
    return result.result;
  }

  async observe(): Promise<TreasuryAssetObservation> {
    const callData = `0x70a08231${this.wallet.slice(2).padStart(64, "0")}`;
    const blockHex = await this.rpc("eth_blockNumber", []);
    if (typeof blockHex !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(blockHex)) {
      throw new Error("treasury EVM RPC returned a malformed block number");
    }
    // Bind the balance to that exact block. Fetching `latest` and the head in
    // parallel can label a pre/post-transfer balance with the wrong block.
    const [balanceHex, decimalsHex] = await Promise.all([
      this.rpc("eth_call", [{ to: this.token, data: callData }, blockHex]),
      this.rpc("eth_call", [{ to: this.token, data: "0x313ce567" }, blockHex]),
    ]);
    if (typeof balanceHex !== "string" || !/^0x[0-9a-f]{64}$/i.test(balanceHex)
      || typeof decimalsHex !== "string" || !/^0x[0-9a-f]{64}$/i.test(decimalsHex)) {
      throw new Error("treasury EVM RPC returned malformed balance evidence");
    }
    if (BigInt(decimalsHex) !== 6n) throw new Error("treasury USD stablecoin must use exactly six decimals");
    const balance = BigInt(balanceHex);
    const observedAt = new Date();
    return {
      provider: this.options.provider,
      providerAccountRef: this.wallet,
      asset: "USD",
      bookMicros: balance,
      availableMicros: balance,
      holdingMicros: 0n,
      lockedMicros: 0n,
      pendingMicros: 0n,
      providerObservationId: `${blockHex}:${createHash("sha256").update(`${this.wallet}:${this.token}:${balance}`).digest("hex").slice(0, 24)}`,
      observedAt,
    };
  }
}

export async function runTreasuryReconciliation(treasury: PostgresTreasury, sources: TreasuryAssetSource[]) {
  try {
    const observations = await Promise.all(sources.map((source) => source.observe()));
    for (const observation of observations) {
      await treasury.recordAssetSnapshot(observation);
    }
    const health = await treasury.health();
    const ok = health.length > 0 && health.every((row) => row.withinTolerance);
    if (!ok) {
      const detail = health.length === 0
        ? "no reconciled asset"
        : health.map((row) => `${row.asset}:${row.snapshotComplete ? "variance-or-stale" : "incomplete"}`).join(",");
      await treasury.tripBreaker(`treasury reconciliation is not healthy: ${detail}`.slice(0, 500));
    }
    return { observations, health, ok };
  } catch (error) {
    await treasury.tripBreaker(`treasury reconciliation failed: ${(error instanceof Error ? error.message : "unknown error").slice(0, 440)}`);
    throw error;
  }
}

interface EvmConfig {
  provider: string;
  rpcUrl: string;
  walletAddress: string;
  tokenAddress: string;
}

function evmSources(value: string | undefined): EvmConfig[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("MONEY_TREASURY_EVM_ASSETS must be a JSON array");
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("invalid treasury EVM asset source");
    const row = entry as Record<string, unknown>;
    for (const key of ["provider", "rpcUrl", "walletAddress", "tokenAddress"] as const) {
      if (typeof row[key] !== "string" || !row[key]) throw new Error(`treasury EVM source requires ${key}`);
    }
    return row as unknown as EvmConfig;
  });
}

export async function startTreasuryReconciler() {
  enforceProductionPreflight("treasury-reconciler");
  const connectionString = process.env.MONEY_RECONCILER_DATABASE_URL;
  if (!connectionString) throw new Error("MONEY_RECONCILER_DATABASE_URL is required");
  const db = new PostgresDatabase({ connectionString, applicationName: "money-treasury-reconciler", maxConnections: 2 });
  const treasury = new PostgresTreasury(db);
  const sources: TreasuryAssetSource[] = [];
  if (process.env.MONEY_COLUMN_RECONCILER_BANK_ACCOUNT_ID) {
    if (!process.env.MONEY_COLUMN_RECONCILER_API_KEY) throw new Error("MONEY_COLUMN_RECONCILER_API_KEY is required for Column reconciliation");
    sources.push(new ColumnBankAssetSource(
      new ColumnClient({ apiKey: process.env.MONEY_COLUMN_RECONCILER_API_KEY }),
      process.env.MONEY_COLUMN_RECONCILER_BANK_ACCOUNT_ID
    ));
  }
  for (const config of evmSources(process.env.MONEY_TREASURY_EVM_ASSETS)) {
    sources.push(new EvmUsdcAssetSource(config));
  }
  if (sources.length === 0) throw new Error("at least one treasury asset source is required");
  const intervalMs = readBoundedInteger(process.env.MONEY_RECONCILE_INTERVAL_MS, 60_000, 10_000, 2_147_483_647, "MONEY_RECONCILE_INTERVAL_MS");
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      const result = await runTreasuryReconciliation(treasury, sources);
      console.log(`treasury reconciliation ${result.ok ? "clean" : "outside tolerance"} across ${result.health.length} asset(s)`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    await db.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startTreasuryReconciler().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
