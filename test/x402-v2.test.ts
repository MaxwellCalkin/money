import { randomBytes } from "node:crypto";
import { declarePaymentIdentifierExtension, PAYMENT_IDENTIFIER } from "@x402/extensions/payment-identifier";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseSignature,
  verifyTypedData,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  createExternalHeaderKeyring,
  decryptPaymentHeaderWithKeyring,
  encryptPaymentHeader,
  encryptPaymentHeaderWithKeyring,
  singleExternalHeaderKeyring,
  type ExternalAuthorizationBinding,
} from "../src/bridge/cipher.ts";
import {
  EvmRpcSettlementVerifier,
  parseEvmRpcNetworks,
  type EvmSettlementClient,
} from "../src/bridge/evm-settlement.ts";
import { HttpEvmSigner, LocalEvmSigner } from "../src/bridge/evm-wallet.ts";
import {
  X402V2EvmPaymentSigner,
  decodedV2Payment,
  encodeX402V2Header,
  normalizeExternalRequirement,
  stablePaymentIdentifier,
  type X402V2Requirement,
} from "../src/bridge/x402-v2.ts";
import { parseExternalPaymentDemand } from "../src/mcp/x402-demand.ts";

const PRIVATE_KEY = `0x${"11".repeat(32)}`;
const OTHER_PRIVATE_KEY = `0x${"22".repeat(32)}`;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x209693bc6afc0c5328ba36faf03c514ef312287c";
const NETWORK = "eip155:84532" as const;
const TX = `0x${"ab".repeat(32)}` as const;

function requirement(overrides: Partial<X402V2Requirement> = {}): X402V2Requirement {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: "50000",
    asset: ASSET,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
    ...overrides,
  };
}

function binding(): ExternalAuthorizationBinding {
  return {
    externalId: "30eb4600-4ba5-4882-adf9-953262934b9c",
    agentId: "agt_x402v2001",
    idempotencyKey: "fetch-weather-2026-07-19",
    host: "data.example.com",
    payTo: PAY_TO,
    settlementAsset: ASSET,
    settlementNetwork: NETWORK,
    resource: "https://data.example.com/report",
    policyPayee: `x402:data.example.com:${PAY_TO}`,
    amountMicros: 50_000n,
    authorizationExpiresAt: "2026-07-19T20:01:00.000Z",
    reverseAfter: "2026-07-19T20:02:00.000Z",
  };
}

async function signedPayment() {
  const local = new LocalEvmSigner(PRIVATE_KEY);
  const signer = new X402V2EvmPaymentSigner(local);
  const paymentIdentifier = stablePaymentIdentifier("agt_x402v2001", "fetch-weather-2026-07-19");
  const signed = await signer.createPayment({
    requirement: requirement(),
    resource: { url: "https://data.example.com/report" },
    extensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true) },
    paymentIdentifier,
  });
  const decoded = decodedV2Payment(signed.header);
  if (!decoded?.accepted) throw new Error("expected a decodable x402 v2 payment");
  return { local, signed, decoded, paymentIdentifier };
}

describe("x402 v2 payment rail", () => {
  it("parses official PAYMENT-REQUIRED challenges without downgrade and pins hostile economic metadata", () => {
    const required = {
      x402Version: 2 as const,
      resource: { url: "https://data.example.com/report", description: "report" },
      accepts: [requirement()],
      extensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true) },
    };
    const parsed = parseExternalPaymentDemand(encodeX402V2Header(required), {
      x402Version: 1,
      accepts: [{ ...requirement(), network: "attacker-chain" }],
    });
    expect(parsed).toEqual(expect.objectContaining({
      ok: true,
      demand: expect.objectContaining({ protocolVersion: 2, requirement: expect.objectContaining({ amount: "50000" }) }),
    }));
    expect(parseExternalPaymentDemand("not-base64", { x402Version: 1, accepts: [requirement()] }))
      .toEqual({ ok: false, reason: "seller sent a malformed PAYMENT-REQUIRED header" });

    const normalized = normalizeExternalRequirement({
      url: "https://data.example.com/report",
      x402Version: 2,
      requirement: {
        ...requirement(),
        extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009", injected: "ignored" },
      },
      resource: required.resource,
      extensions: { ...required.extensions, hostile: { execute: true } },
    });
    expect(normalized).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        amountMicros: 50_000n,
        requirement: expect.objectContaining({
          extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
        }),
      }),
    }));
    if (normalized.ok) expect(Object.keys(normalized.value.extensions ?? {})).toEqual([PAYMENT_IDENTIFIER]);
    expect(normalizeExternalRequirement({
      url: "https://data.example.com/report",
      x402Version: 2,
      requirement: requirement({ extra: { assetTransferMethod: "permit2", name: "USDC", version: "2" } }),
    })).toEqual(expect.objectContaining({ ok: false }));
  });

  it("creates an official exact/EVM payload with a stable payment identifier and valid EIP-712 signature", async () => {
    const { local, signed, decoded, paymentIdentifier } = await signedPayment();
    expect(signed).toEqual(expect.objectContaining({
      protocolVersion: 2,
      paymentHeaderName: "payment-signature",
      settlementHeaderName: "payment-response",
    }));
    expect(decoded.authorization).toEqual(expect.objectContaining({
      from: local.address,
      value: "50000",
    }));
    expect(decoded.authorization.to.toLowerCase()).toBe(PAY_TO.toLowerCase());
    const payloadExtensions = (decoded.payload as { extensions?: Record<string, unknown> }).extensions;
    expect((payloadExtensions?.[PAYMENT_IDENTIFIER] as any)?.info?.id).toBe(paymentIdentifier);
    expect(await verifyTypedData({
      address: local.address,
      domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: ASSET },
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
        from: decoded.authorization.from as `0x${string}`,
        to: decoded.authorization.to as `0x${string}`,
        value: BigInt(decoded.authorization.value),
        validAfter: BigInt(decoded.authorization.validAfter),
        validBefore: BigInt(decoded.authorization.validBefore),
        nonce: decoded.authorization.nonce as `0x${string}`,
      },
      signature: decoded.signature as `0x${string}`,
    })).toBe(true);
  });

  it("accepts signatures from an HTTPS key service only after verifying the configured public key", async () => {
    const local = new LocalEvmSigner(PRIVATE_KEY);
    const request = {
      domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: ASSET },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" }, { name: "to", type: "address" },
          { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: local.address, to: PAY_TO, value: 50_000n, validAfter: 0n,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 60), nonce: `0x${"33".repeat(32)}`,
      },
    };
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as typeof request & { address: string };
      expect(body.address).toBe(local.address);
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer hsm-token");
      expect(init?.redirect).toBe("error");
      const signature = await local.signTypedData(body);
      return new Response(JSON.stringify({ signature }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const remote = new HttpEvmSigner({
      url: "https://keys.example.com/sign", address: local.address,
      bearerToken: "hsm-token", fetch: fetcher,
    });
    expect(await remote.signTypedData(request)).toMatch(/^0x[0-9a-f]{130}$/i);

    const wrong = new LocalEvmSigner(OTHER_PRIVATE_KEY);
    const wrongFetcher = (async () => new Response(JSON.stringify({
      signature: await wrong.signTypedData(request),
    }), { status: 200 })) as typeof fetch;
    await expect(new HttpEvmSigner({
      url: "https://keys.example.com/sign", address: local.address, fetch: wrongFetcher,
    }).signTypedData(request)).rejects.toThrow(/wrong key|different typed data/);
    expect(() => new HttpEvmSigner({ url: "http://keys.example.com/sign", address: local.address }))
      .toThrow(/HTTPS/);
    expect(() => new HttpEvmSigner({
      url: "https://keys.example.com/sign?token=must-not-live-in-a-url",
      address: local.address,
    })).toThrow(/query/);
    expect(() => new HttpEvmSigner({ url: "https://localhost/sign", address: local.address }))
      .toThrow(/development mode/);
    expect(() => new HttpEvmSigner({
      url: "https://keys.example.com/sign",
      address: "0x0000000000000000000000000000000000000000",
    })).toThrow(/must not be zero/);
    const oversizedFetcher = (async () => new Response("x".repeat(16 * 1_024 + 1), {
      status: 200,
      headers: { "content-length": String(16 * 1_024 + 1) },
    })) as typeof fetch;
    await expect(new HttpEvmSigner({
      url: "https://keys.example.com/sign", address: local.address, fetch: oversizedFetcher,
    }).signTypedData(request)).rejects.toThrow(/too large/);
  });

  it("round-trips legacy and rotatable encrypted headers while binding key id and economic terms", () => {
    const legacyKey = randomBytes(32);
    const old = encryptPaymentHeader("legacy-header", legacyKey, binding());
    expect(decryptPaymentHeaderWithKeyring(old, singleExternalHeaderKeyring(legacyKey), binding(), "legacy"))
      .toEqual({ plaintext: "legacy-header", keyId: "legacy" });

    const keyring = createExternalHeaderKeyring("k2", { k1: randomBytes(32), k2: randomBytes(32) });
    const encrypted = encryptPaymentHeaderWithKeyring("payment-signature-value", keyring, binding());
    expect(encrypted.keyId).toBe("k2");
    expect(decryptPaymentHeaderWithKeyring(encrypted.ciphertext, keyring, binding(), "k2"))
      .toEqual({ plaintext: "payment-signature-value", keyId: "k2" });
    expect(() => decryptPaymentHeaderWithKeyring(encrypted.ciphertext, keyring, binding(), "k1"))
      .toThrow(/key id/);
    expect(() => decryptPaymentHeaderWithKeyring(
      encrypted.ciphertext,
      createExternalHeaderKeyring("k1", { k1: randomBytes(32) }),
      binding(),
    )).toThrow(/unavailable/);
    expect(() => decryptPaymentHeaderWithKeyring(
      encrypted.ciphertext,
      keyring,
      { ...binding(), amountMicros: 50_001n },
    )).toThrow();
  });

  it("verifies the exact signed calldata, transfer log, payer, network, and confirmation depth", async () => {
    const { local, decoded } = await signedPayment();
    const signature = parseSignature(decoded.signature as Hex);
    const v = Number(signature.v ?? BigInt((signature.yParity ?? 0) + 27));
    const abi = [{
      type: "function", name: "transferWithAuthorization", stateMutability: "nonpayable",
      inputs: [
        { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
        { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" },
      ], outputs: [],
    }] as const;
    const call = (nonce = decoded.authorization.nonce as Hex) => encodeFunctionData({
      abi,
      functionName: "transferWithAuthorization",
      args: [
        local.address, PAY_TO, 50_000n, BigInt(decoded.authorization.validAfter),
        BigInt(decoded.authorization.validBefore), nonce, v, signature.r, signature.s,
      ],
    });
    const topics = encodeEventTopics({
      abi: [{
        type: "event", name: "Transfer",
        inputs: [
          { indexed: true, name: "from", type: "address" },
          { indexed: true, name: "to", type: "address" },
          { indexed: false, name: "value", type: "uint256" },
        ],
      }] as const,
      eventName: "Transfer",
      args: { from: local.address, to: PAY_TO },
    });
    let transactionInput = call();
    let head = 101n;
    const client = {
      getTransactionReceipt: async () => ({
        status: "success",
        blockNumber: 100n,
        logs: [{ address: ASSET, topics, data: encodeAbiParameters([{ type: "uint256" }], [50_000n]) }],
      }),
      getTransaction: async () => ({ to: ASSET, input: transactionInput }),
      getBlockNumber: async () => head,
    } as unknown as EvmSettlementClient;
    const verifier = new EvmRpcSettlementVerifier(
      [{ network: NETWORK, rpcUrl: "https://rpc.example.com", confirmations: 2 }],
      () => client,
    );
    const claim = {
      requirement: requirement(),
      authorization: decoded.authorization,
      signature: decoded.signature,
      settlement: { success: true, transaction: TX, network: NETWORK, payer: local.address, amount: "50000" },
    };
    expect(await verifier.verify(claim)).toEqual({ ok: true });

    transactionInput = call(`0x${"44".repeat(32)}`);
    expect(await verifier.verify(claim)).toEqual(expect.objectContaining({
      ok: false, reason: expect.stringMatching(/calldata/),
    }));
    transactionInput = call();
    head = 100n;
    expect(await verifier.verify(claim)).toEqual(expect.objectContaining({
      ok: false, reason: expect.stringMatching(/confirmations/),
    }));
    expect(await verifier.verify({
      ...claim,
      settlement: { ...claim.settlement, payer: new LocalEvmSigner(OTHER_PRIVATE_KEY).address },
    })).toEqual(expect.objectContaining({ ok: false, reason: expect.stringMatching(/payer/) }));
  });

  it("rejects ambiguous or over-broad EVM RPC configuration", () => {
    expect(() => parseEvmRpcNetworks("{}")).toThrow(/one to sixteen/);
    expect(() => parseEvmRpcNetworks(JSON.stringify({
      "eip155:8453": { url: "https://rpc.example", confirmations: 2, fallback: true },
    }))).toThrow(/unsupported field/);
    expect(() => new EvmRpcSettlementVerifier([
      { network: NETWORK, rpcUrl: "https://rpc.example" },
      { network: NETWORK, rpcUrl: "https://rpc-backup.example" },
    ], () => ({}) as EvmSettlementClient)).toThrow(/duplicate/);
    expect(() => new EvmRpcSettlementVerifier([
      { network: NETWORK, rpcUrl: "https://user:secret@rpc.example" },
    ], () => ({}) as EvmSettlementClient)).toThrow(/credentials/);
  });
});
