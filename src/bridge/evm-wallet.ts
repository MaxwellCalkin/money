import { getAddress, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readBoundedResponse } from "../core/bounded-response.ts";
import { isLoopbackHostname } from "../core/url-security.ts";
import type { EvmTypedDataSigner } from "./x402-v2.ts";

type TypedDataRequest = Parameters<EvmTypedDataSigner["signTypedData"]>[0];
const MAX_SIGNER_RESPONSE_BYTES = 16 * 1024;

function checkedSignature(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-f]{130}$/i.test(value)) {
    throw new Error("EVM signer returned a malformed 65-byte signature");
  }
  return value as `0x${string}`;
}

export class LocalEvmSigner implements EvmTypedDataSigner {
  private readonly account;
  readonly address: `0x${string}`;

  constructor(privateKey: string) {
    if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) throw new Error("EVM private key must be 32-byte hex");
    this.account = privateKeyToAccount(privateKey as `0x${string}`);
    this.address = this.account.address;
  }

  signTypedData(message: TypedDataRequest): Promise<`0x${string}`> {
    return this.account.signTypedData(message as Parameters<typeof this.account.signTypedData>[0]);
  }
}

export interface HttpEvmSignerOptions {
  url: string;
  address: string;
  bearerToken?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  allowInsecureLocalhost?: boolean;
}

/**
 * Thin HSM/key-service adapter. The API process receives only a public address;
 * the remote service signs EIP-712 typed data and never returns key material.
 */
export class HttpEvmSigner implements EvmTypedDataSigner {
  readonly address: `0x${string}`;
  private readonly url: URL;
  private readonly bearerToken?: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: HttpEvmSignerOptions) {
    this.url = new URL(options.url);
    const local = isLoopbackHostname(this.url);
    if (this.url.protocol !== "https:" && !(local && options.allowInsecureLocalhost)) {
      throw new Error("remote EVM signer must use HTTPS (HTTP is allowed only for explicit localhost development)");
    }
    if (local && !options.allowInsecureLocalhost) {
      throw new Error("remote EVM signer localhost access requires explicit development mode");
    }
    if (this.url.username || this.url.password || this.url.search || this.url.hash) {
      throw new Error("remote EVM signer URL must not contain credentials, query, or fragment");
    }
    this.address = getAddress(options.address);
    if (/^0x0{40}$/i.test(this.address)) throw new Error("remote EVM signer address must not be zero");
    if (options.bearerToken !== undefined
      && (!options.bearerToken || options.bearerToken.length > 2_048
        || options.bearerToken.trim() !== options.bearerToken || /[\r\n]/.test(options.bearerToken))) {
      throw new Error("remote EVM signer bearer token is invalid");
    }
    this.bearerToken = options.bearerToken;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new Error("remote EVM signer timeout must be 100-30000ms");
    }
    this.fetcher = options.fetch ?? fetch;
  }

  async signTypedData(message: TypedDataRequest): Promise<`0x${string}`> {
    const response = await this.fetcher(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
      },
      // JSON has no bigint primitive. Decimal strings preserve EIP-712 integer
      // precision and are accepted by standard signing services and viem.
      body: JSON.stringify(
        { ...message, address: this.address },
        (_key, value) => typeof value === "bigint" ? value.toString() : value,
      ),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`remote EVM signer failed with HTTP ${response.status}`);
    }
    const bytes = await readBoundedResponse(
      response,
      MAX_SIGNER_RESPONSE_BYTES,
      "remote EVM signer response is too large",
    );
    let body: { signature?: unknown } | null = null;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as { signature?: unknown } : null;
    } catch {
      body = null;
    }
    const signature = checkedSignature(body?.signature);
    const valid = await verifyTypedData({
      address: this.address,
      domain: message.domain,
      types: message.types as Parameters<typeof verifyTypedData>[0]["types"],
      primaryType: message.primaryType,
      message: message.message,
      signature,
    });
    if (!valid) throw new Error("remote EVM signer returned a signature from the wrong key or over different typed data");
    return signature;
  }
}
