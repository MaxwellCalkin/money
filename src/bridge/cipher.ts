import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface ExternalAuthorizationBinding {
  externalId: string;
  agentId: string;
  idempotencyKey: string;
  host: string;
  payTo: string;
  settlementAsset: string;
  settlementNetwork: string;
  resource: string;
  policyPayee: string;
  amountMicros: bigint | number | string;
  authorizationExpiresAt: Date | string | number;
  reverseAfter: Date | string | number;
}

function instant(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid authorization binding timestamp");
  return date.toISOString();
}

/** Stable associated data binds ciphertext to every durable economic term. */
export function externalAuthorizationAad(binding: ExternalAuthorizationBinding): Buffer {
  return Buffer.from(JSON.stringify({
    v: VERSION,
    externalId: binding.externalId,
    agentId: binding.agentId,
    idempotencyKey: binding.idempotencyKey,
    host: binding.host,
    payTo: binding.payTo,
    settlementAsset: binding.settlementAsset,
    settlementNetwork: binding.settlementNetwork,
    resource: binding.resource,
    policyPayee: binding.policyPayee,
    amountMicros: BigInt(binding.amountMicros).toString(),
    authorizationExpiresAt: instant(binding.authorizationExpiresAt),
    reverseAfter: instant(binding.reverseAfter),
  }), "utf8");
}

export function parseExternalHeaderKey(encoded: string): Buffer {
  const value = encoded.trim();
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("MONEY_EXTERNAL_HEADER_KEY must be 32 bytes encoded as base64 or 64 hex characters");
  }
  return key;
}

function checkedKey(key: Uint8Array): Buffer {
  const material = Buffer.from(key);
  if (material.length !== KEY_BYTES) throw new Error("external header encryption key must be 32 bytes");
  return material;
}

/** Envelope: version (1) || IV (12) || GCM tag (16) || ciphertext. */
export function encryptPaymentHeader(
  plaintext: string,
  key: Uint8Array,
  binding: ExternalAuthorizationBinding
): Buffer {
  if (!plaintext || Buffer.byteLength(plaintext, "utf8") > 64 * 1024) {
    throw new Error("payment header must contain 1-65536 UTF-8 bytes");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", checkedKey(key), iv);
  cipher.setAAD(externalAuthorizationAad(binding));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptPaymentHeader(
  envelope: Uint8Array,
  key: Uint8Array,
  binding: ExternalAuthorizationBinding
): string {
  const blob = Buffer.from(envelope);
  if (blob.length <= 1 + IV_BYTES + TAG_BYTES || blob[0] !== VERSION) {
    throw new Error("unsupported or malformed payment header ciphertext");
  }
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", checkedKey(key), iv);
  decipher.setAAD(externalAuthorizationAad(binding));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
