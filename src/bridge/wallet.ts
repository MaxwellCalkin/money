import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import type { Eip3009Authorization } from "./x402.ts";

/**
 * The company wallet at the edge of the loop: it signs the payment
 * authorizations that leave the network. The interface is shaped so a real
 * EIP-3009 signer (secp256k1 + keccak/EIP-712 — needs deps we deliberately
 * don't take) drops in later without touching the bridge.
 */

/** EIP-712 signing domain, per the x402 exact/EVM scheme: name and version
 *  come from the requirement's `extra`, contract = asset, chain = network. */
export interface SigningDomain {
  name: string;
  version: string;
  network: string;
  asset: string;
}

export interface ExternalWallet {
  /** The on-chain address payments are authorized FROM. */
  readonly address: string;
  signAuthorization(auth: Eip3009Authorization, domain: SigningDomain): string;
}

/** Canonical bytes both signer and verifier agree on. */
function canonical(auth: Eip3009Authorization, domain: SigningDomain): Buffer {
  return Buffer.from(
    JSON.stringify({
      domain: { name: domain.name, version: domain.version, network: domain.network, asset: domain.asset },
      message: {
        from: auth.from,
        to: auth.to,
        value: auth.value,
        validAfter: auth.validAfter,
        validBefore: auth.validBefore,
        nonce: auth.nonce,
      },
    }),
    "utf8"
  );
}

/**
 * MOCK wallet: Ed25519 over the canonical (domain, authorization) JSON.
 * Structurally faithful to the real flow (consumes extra.name/version, binds
 * the full authorization) but it is NOT EIP-712/secp256k1 — green tests here
 * certify the bridge's accounting and policy, not real chain settlement.
 * Never point this at anything holding real funds.
 */
export class MockWallet implements ExternalWallet {
  readonly address: string;
  private privateKey: KeyObject;
  private publicKey: KeyObject;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    const spki = publicKey.export({ format: "der", type: "spki" });
    // Mock "address": derived from the key like a real address, wrong curve.
    this.address = "0x" + createHash("sha256").update(spki).digest("hex").slice(0, 40);
  }

  signAuthorization(auth: Eip3009Authorization, domain: SigningDomain): string {
    return "0x" + sign(null, canonical(auth, domain), this.privateKey).toString("hex");
  }

  /** The mock facilitator's verify: what a real chain does with the sig. */
  verifyAuthorization(auth: Eip3009Authorization, domain: SigningDomain, signature: string): boolean {
    try {
      if (!signature.startsWith("0x")) return false;
      return verify(null, canonical(auth, domain), this.publicKey, Buffer.from(signature.slice(2), "hex"));
    } catch {
      return false;
    }
  }
}
