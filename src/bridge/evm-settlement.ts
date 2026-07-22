import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  http,
  verifyTypedData,
  type PublicClient,
} from "viem";
import { isLoopbackHostname } from "../core/url-security.ts";
import type { Eip3009Authorization, SettlementResponse } from "./x402.ts";
import type { X402V2Requirement } from "./x402-v2.ts";

const transferEvent = [{
  type: "event",
  name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
}] as const;

const transferWithAuthorizationAbi = [{
  type: "function",
  name: "transferWithAuthorization",
  stateMutability: "nonpayable",
  inputs: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "v", type: "uint8" },
    { name: "r", type: "bytes32" },
    { name: "s", type: "bytes32" },
  ],
  outputs: [],
}] as const;

export interface EvmSettlementClaim {
  requirement: X402V2Requirement;
  authorization: Eip3009Authorization;
  signature: string;
  settlement: SettlementResponse;
}

export interface EvmRpcNetwork {
  network: `eip155:${number}`;
  rpcUrl: string;
  confirmations?: number;
}

export type EvmSettlementClient = Pick<PublicClient, "getTransactionReceipt" | "getTransaction" | "getBlockNumber">;
export type EvmSettlementClientFactory = (config: EvmRpcNetwork) => EvmSettlementClient;

function chainIdOf(network: string): number {
  const match = /^eip155:([1-9][0-9]*)$/.exec(network);
  const value = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`unsupported EVM CAIP-2 network ${network}`);
  return value;
}

/** Independent receipt/log verifier; it never trusts seller claim fields alone. */
export class EvmRpcSettlementVerifier {
  private readonly networks = new Map<string, { client: EvmSettlementClient; confirmations: number }>();

  constructor(
    configs: EvmRpcNetwork[],
    clientFactory: EvmSettlementClientFactory = (config) => createPublicClient({
      transport: http(config.rpcUrl, { timeout: 7_500, retryCount: 1 }),
    }),
  ) {
    if (configs.length < 1 || configs.length > 16) {
      throw new Error("one to sixteen EVM RPC networks are required");
    }
    for (const config of configs) {
      chainIdOf(config.network);
      if (this.networks.has(config.network)) {
        throw new Error(`duplicate EVM RPC network ${config.network}`);
      }
      const url = new URL(config.rpcUrl);
      if (url.protocol !== "https:" && !isLoopbackHostname(url)) {
        throw new Error("EVM RPC endpoints must use HTTPS outside localhost");
      }
      if (url.username || url.password || url.hash) {
        throw new Error("EVM RPC endpoints must not contain credentials or a fragment");
      }
      const confirmations = config.confirmations ?? 1;
      if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 100) {
        throw new Error("EVM confirmation count must be 1-100");
      }
      this.networks.set(config.network, {
        client: clientFactory(config),
        confirmations,
      });
    }
  }

  async verify(claim: EvmSettlementClaim): Promise<{ ok: boolean; reason?: string }> {
    try {
      const configured = this.networks.get(claim.requirement.network);
      if (!configured) return { ok: false, reason: "settlement network has no configured independent RPC" };
      if (!/^0x[0-9a-f]{64}$/i.test(claim.settlement.transaction)) {
        return { ok: false, reason: "settlement transaction is not a canonical EVM hash" };
      }
      if (claim.settlement.success !== true || claim.settlement.network !== claim.requirement.network
        || claim.settlement.payer?.toLowerCase() !== claim.authorization.from.toLowerCase()) {
        return { ok: false, reason: "settlement claim does not match the signed payer and network" };
      }
      if (claim.settlement.amount !== undefined && claim.settlement.amount !== claim.requirement.amount) {
        return { ok: false, reason: "settled amount does not match the exact payment requirement" };
      }
      const chainId = chainIdOf(claim.requirement.network);
      const extra = claim.requirement.extra;
      const name = extra.name;
      const version = extra.version;
      if (typeof name !== "string" || typeof version !== "string") {
        return { ok: false, reason: "payment requirement is missing its pinned EIP-712 domain" };
      }
      if (getAddress(claim.authorization.to) !== getAddress(claim.requirement.payTo)
        || BigInt(claim.authorization.value) !== BigInt(claim.requirement.amount)) {
        return { ok: false, reason: "authorization does not match the exact recipient and amount" };
      }
      const signatureValid = await verifyTypedData({
        address: getAddress(claim.authorization.from),
        domain: {
          name,
          version,
          chainId,
          verifyingContract: getAddress(claim.requirement.asset),
        },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: {
          from: getAddress(claim.authorization.from),
          to: getAddress(claim.authorization.to),
          value: BigInt(claim.authorization.value),
          validAfter: BigInt(claim.authorization.validAfter),
          validBefore: BigInt(claim.authorization.validBefore),
          nonce: claim.authorization.nonce as `0x${string}`,
        },
        signature: claim.signature as `0x${string}`,
      });
      if (!signatureValid) return { ok: false, reason: "stored payment signature is not valid for the treasury wallet" };

      const receipt = await configured.client.getTransactionReceipt({
        hash: claim.settlement.transaction as `0x${string}`,
      });
      if (receipt.status !== "success") return { ok: false, reason: "settlement transaction reverted" };
      const expectedAsset = getAddress(claim.requirement.asset);
      const expectedFrom = getAddress(claim.authorization.from);
      const expectedTo = getAddress(claim.requirement.payTo);
      const expectedValue = BigInt(claim.requirement.amount);
      const transaction = await configured.client.getTransaction({
        hash: claim.settlement.transaction as `0x${string}`,
      });
      if (!transaction.to || getAddress(transaction.to) !== expectedAsset) {
        return { ok: false, reason: "settlement transaction did not call the allowlisted token contract" };
      }
      let decodedCall: ReturnType<typeof decodeFunctionData<typeof transferWithAuthorizationAbi>>;
      try {
        decodedCall = decodeFunctionData({ abi: transferWithAuthorizationAbi, data: transaction.input });
      } catch {
        return { ok: false, reason: "settlement transaction is not an EIP-3009 transferWithAuthorization call" };
      }
      const [callFrom, callTo, callValue, callValidAfter, callValidBefore, callNonce] = decodedCall.args;
      if (decodedCall.functionName !== "transferWithAuthorization"
        || getAddress(callFrom) !== expectedFrom || getAddress(callTo) !== expectedTo
        || callValue !== expectedValue
        || callValidAfter !== BigInt(claim.authorization.validAfter)
        || callValidBefore !== BigInt(claim.authorization.validBefore)
        || callNonce.toLowerCase() !== claim.authorization.nonce.toLowerCase()) {
        return { ok: false, reason: "settlement calldata does not match the signed authorization" };
      }
      const matched = receipt.logs.some((log) => {
        if (getAddress(log.address) !== expectedAsset) return false;
        try {
          const decoded = decodeEventLog({ abi: transferEvent, data: log.data, topics: log.topics });
          return decoded.eventName === "Transfer"
            && getAddress(decoded.args.from) === expectedFrom
            && getAddress(decoded.args.to) === expectedTo
            && decoded.args.value === expectedValue;
        } catch {
          return false;
        }
      });
      if (!matched) return { ok: false, reason: "transaction contains no exact USDC transfer matching the authorization" };
      if (configured.confirmations > 1) {
        const head = await configured.client.getBlockNumber();
        const depth = head - receipt.blockNumber + 1n;
        if (depth < BigInt(configured.confirmations)) {
          return { ok: false, reason: `settlement has ${depth} confirmations; ${configured.confirmations} required` };
        }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "EVM settlement verification failed" };
    }
  }
}

export function parseEvmRpcNetworks(value: string): EvmRpcNetwork[] {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MONEY_EVM_RPC_URLS must be a JSON object keyed by CAIP-2 network");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 16) {
    throw new Error("MONEY_EVM_RPC_URLS must contain one to sixteen networks");
  }
  return entries.map(([network, raw]) => {
    if (!/^eip155:[1-9][0-9]*$/.test(network)) throw new Error(`invalid EVM RPC network ${network}`);
    if (typeof raw === "string") {
      if (!raw || raw.trim() !== raw) throw new Error(`invalid EVM RPC URL for ${network}`);
      return { network: network as `eip155:${number}`, rpcUrl: raw };
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || typeof (raw as { url?: unknown }).url !== "string") {
      throw new Error(`EVM RPC config for ${network} must be a URL or {url, confirmations}`);
    }
    const entry = raw as { url: string; confirmations?: unknown };
    if (Object.keys(raw).some((key) => !["url", "confirmations"].includes(key))) {
      throw new Error(`EVM RPC config for ${network} contains an unsupported field`);
    }
    if (!entry.url || entry.url.trim() !== entry.url) {
      throw new Error(`invalid EVM RPC URL for ${network}`);
    }
    if (entry.confirmations !== undefined && (!Number.isSafeInteger(entry.confirmations)
      || Number(entry.confirmations) < 1 || Number(entry.confirmations) > 100)) {
      throw new Error(`invalid confirmation count for ${network}`);
    }
    return {
      network: network as `eip155:${number}`,
      rpcUrl: entry.url,
      ...(entry.confirmations !== undefined ? { confirmations: Number(entry.confirmations) } : {}),
    };
  });
}
