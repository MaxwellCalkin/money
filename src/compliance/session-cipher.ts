import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface ComplianceSessionBinding {
  sessionId: string;
  subjectAccountId: string;
  provider: string;
  expiresAt: Date | string | number;
}

export interface ComplianceSessionKeyring {
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

function keyId(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new Error("compliance session key ids must contain 1-64 safe characters");
  }
  return value;
}

function keyMaterial(value: string | Uint8Array): Buffer {
  const material = typeof value === "string"
    ? (/^[0-9a-f]{64}$/i.test(value.trim())
      ? Buffer.from(value.trim(), "hex")
      : Buffer.from(value.trim(), "base64"))
    : Buffer.from(value);
  if (material.length !== KEY_BYTES) {
    throw new Error("compliance session encryption keys must be 32 bytes");
  }
  return material;
}

function instant(value: Date | string | number): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("invalid compliance session expiry");
  return parsed.toISOString();
}

function aad(binding: ComplianceSessionBinding, selectedKeyId: string): Buffer {
  return Buffer.from(JSON.stringify({
    v: VERSION,
    keyId: selectedKeyId,
    sessionId: binding.sessionId,
    subjectAccountId: binding.subjectAccountId,
    provider: binding.provider,
    expiresAt: instant(binding.expiresAt),
  }), "utf8");
}

export function createComplianceSessionKeyring(
  activeKeyId: string,
  entries: Record<string, string | Uint8Array>,
): ComplianceSessionKeyring {
  const keys = new Map<string, Buffer>();
  for (const [rawId, rawKey] of Object.entries(entries)) {
    keys.set(keyId(rawId), keyMaterial(rawKey));
  }
  const active = keyId(activeKeyId);
  if (keys.size < 1 || keys.size > 32 || !keys.has(active)) {
    throw new Error("compliance session keyring must contain its active key and at most 32 keys");
  }
  return { activeKeyId: active, keys };
}

export function parseComplianceSessionKeyring(
  encoded: string,
  activeKeyId: string,
): ComplianceSessionKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("MONEY_COMPLIANCE_SESSION_KEYS must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MONEY_COMPLIANCE_SESSION_KEYS must be a JSON object");
  }
  const entries: Record<string, string> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") throw new Error(`compliance session key ${id} must be encoded text`);
    entries[id] = value;
  }
  return createComplianceSessionKeyring(activeKeyId, entries);
}

export function encryptHostedVerificationUrl(
  plaintext: string,
  keyring: ComplianceSessionKeyring,
  binding: ComplianceSessionBinding,
): { ciphertext: Buffer; keyId: string } {
  if (!plaintext || Buffer.byteLength(plaintext, "utf8") > 8_192) {
    throw new Error("hosted verification URL must contain 1-8192 UTF-8 bytes");
  }
  const selectedKeyId = keyId(keyring.activeKeyId);
  const key = keyring.keys.get(selectedKeyId);
  if (!key) throw new Error(`active compliance session key ${selectedKeyId} is unavailable`);
  const id = Buffer.from(selectedKeyId, "utf8");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(binding, selectedKeyId));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    keyId: selectedKeyId,
    ciphertext: Buffer.concat([
      Buffer.from([VERSION, id.length]), id, iv, cipher.getAuthTag(), encrypted,
    ]),
  };
}

export function decryptHostedVerificationUrl(
  envelope: Uint8Array,
  keyring: ComplianceSessionKeyring,
  binding: ComplianceSessionBinding,
  expectedKeyId?: string,
): { plaintext: string; keyId: string } {
  const blob = Buffer.from(envelope);
  if (blob.length < 2 + 1 + IV_BYTES + TAG_BYTES + 1 || blob[0] !== VERSION) {
    throw new Error("unsupported or malformed hosted verification URL ciphertext");
  }
  const idLength = blob[1]!;
  if (idLength < 1 || idLength > 64 || blob.length < 2 + idLength + IV_BYTES + TAG_BYTES + 1) {
    throw new Error("malformed hosted verification URL key envelope");
  }
  const selectedKeyId = keyId(blob.subarray(2, 2 + idLength).toString("utf8"));
  if (expectedKeyId && selectedKeyId !== expectedKeyId) {
    throw new Error("hosted verification URL key id does not match durable metadata");
  }
  const key = keyring.keys.get(selectedKeyId);
  if (!key) throw new Error(`compliance session key ${selectedKeyId} is unavailable`);
  const ivStart = 2 + idLength;
  const iv = blob.subarray(ivStart, ivStart + IV_BYTES);
  const tag = blob.subarray(ivStart + IV_BYTES, ivStart + IV_BYTES + TAG_BYTES);
  const encrypted = blob.subarray(ivStart + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad(binding, selectedKeyId));
  decipher.setAuthTag(tag);
  return {
    keyId: selectedKeyId,
    plaintext: Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"),
  };
}
