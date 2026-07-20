import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const LEGACY_VERSION = 1;
const KEYRING_VERSION = 2;
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

export interface ExternalHeaderKeyring {
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

function instant(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid authorization binding timestamp");
  return date.toISOString();
}

/** Stable associated data binds ciphertext to every durable economic term. */
export function externalAuthorizationAad(
  binding: ExternalAuthorizationBinding,
  version = LEGACY_VERSION,
  keyId?: string,
): Buffer {
  return Buffer.from(JSON.stringify({
    v: version,
    ...(keyId ? { keyId } : {}),
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

function checkedKeyId(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new Error("external header key ids must contain 1-64 letters, digits, dot, underscore, or hyphen");
  }
  return value;
}

export function createExternalHeaderKeyring(
  activeKeyId: string,
  entries: Record<string, string | Uint8Array>,
): ExternalHeaderKeyring {
  const keys = new Map<string, Buffer>();
  for (const [rawId, rawKey] of Object.entries(entries)) {
    const id = checkedKeyId(rawId);
    const key = typeof rawKey === "string" ? parseExternalHeaderKey(rawKey) : checkedKey(rawKey);
    keys.set(id, Buffer.from(key));
  }
  const active = checkedKeyId(activeKeyId);
  if (!keys.has(active)) throw new Error(`active external header key ${active} is absent from the keyring`);
  if (keys.size === 0 || keys.size > 32) throw new Error("external header keyring must contain 1-32 keys");
  return { activeKeyId: active, keys };
}

/** JSON object of key-id -> base64/hex, with a separately selected active id. */
export function parseExternalHeaderKeyring(encoded: string, activeKeyId: string): ExternalHeaderKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("MONEY_EXTERNAL_HEADER_KEYS must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MONEY_EXTERNAL_HEADER_KEYS must be a JSON object");
  }
  const entries: Record<string, string> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") throw new Error(`external header key ${id} must be a base64 or hex string`);
    entries[id] = value;
  }
  return createExternalHeaderKeyring(activeKeyId, entries);
}

export function singleExternalHeaderKeyring(key: Uint8Array, keyId = "legacy"): ExternalHeaderKeyring {
  return createExternalHeaderKeyring(keyId, { [keyId]: key });
}

function checkedKey(key: Uint8Array): Buffer {
  const material = Buffer.from(key);
  if (material.length !== KEY_BYTES) throw new Error("external header encryption key must be 32 bytes");
  return material;
}

/** Legacy envelope: version (1) || IV (12) || GCM tag (16) || ciphertext. */
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
  return Buffer.concat([Buffer.from([LEGACY_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptPaymentHeader(
  envelope: Uint8Array,
  key: Uint8Array,
  binding: ExternalAuthorizationBinding
): string {
  const blob = Buffer.from(envelope);
  if (blob.length <= 1 + IV_BYTES + TAG_BYTES || blob[0] !== LEGACY_VERSION) {
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


/** Rotatable envelope: version (2) || id length || key id || IV || tag || ciphertext. */
export function encryptPaymentHeaderWithKeyring(
  plaintext: string,
  keyring: ExternalHeaderKeyring,
  binding: ExternalAuthorizationBinding,
): { ciphertext: Buffer; keyId: string } {
  if (!plaintext || Buffer.byteLength(plaintext, "utf8") > 64 * 1024) {
    throw new Error("payment header must contain 1-65536 UTF-8 bytes");
  }
  const keyId = checkedKeyId(keyring.activeKeyId);
  const key = keyring.keys.get(keyId);
  if (!key) throw new Error(`active external header key ${keyId} is unavailable`);
  const idBytes = Buffer.from(keyId, "utf8");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", checkedKey(key), iv);
  cipher.setAAD(externalAuthorizationAad(binding, KEYRING_VERSION, keyId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    keyId,
    ciphertext: Buffer.concat([
      Buffer.from([KEYRING_VERSION, idBytes.length]),
      idBytes,
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]),
  };
}

export function decryptPaymentHeaderWithKeyring(
  envelope: Uint8Array,
  keyring: ExternalHeaderKeyring,
  binding: ExternalAuthorizationBinding,
  expectedKeyId?: string,
): { plaintext: string; keyId: string } {
  const blob = Buffer.from(envelope);
  if (blob[0] === LEGACY_VERSION) {
    const keyId = expectedKeyId ?? (keyring.keys.has("legacy") ? "legacy" : "");
    const key = keyring.keys.get(keyId);
    if (!key) throw new Error("legacy payment header key is unavailable during rotation");
    return { plaintext: decryptPaymentHeader(blob, key, binding), keyId };
  }
  if (blob.length <= 2 + IV_BYTES + TAG_BYTES || blob[0] !== KEYRING_VERSION) {
    throw new Error("unsupported or malformed payment header ciphertext");
  }
  const idLength = blob[1]!;
  const minimum = 2 + idLength + IV_BYTES + TAG_BYTES + 1;
  if (idLength < 1 || idLength > 64 || blob.length < minimum) {
    throw new Error("malformed payment header keyring envelope");
  }
  const keyId = checkedKeyId(blob.subarray(2, 2 + idLength).toString("utf8"));
  if (expectedKeyId && expectedKeyId !== keyId) throw new Error("payment header key id does not match durable metadata");
  const key = keyring.keys.get(keyId);
  if (!key) throw new Error(`external header key ${keyId} is unavailable`);
  const ivStart = 2 + idLength;
  const iv = blob.subarray(ivStart, ivStart + IV_BYTES);
  const tag = blob.subarray(ivStart + IV_BYTES, ivStart + IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(ivStart + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", checkedKey(key), iv);
  decipher.setAAD(externalAuthorizationAad(binding, KEYRING_VERSION, keyId));
  decipher.setAuthTag(tag);
  return {
    keyId,
    plaintext: Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
  };
}
