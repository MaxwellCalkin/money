import { createHash, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  decryptPaymentHeaderWithKeyring,
  encryptPaymentHeaderWithKeyring,
  parseExternalHeaderKeyring,
  type ExternalAuthorizationBinding,
  type ExternalHeaderKeyring,
} from "../bridge/cipher.ts";
import { PostgresExternal, type ExternalAuthorizationRotationCandidate } from "./external.ts";
import { PostgresDatabase } from "./postgres.ts";

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`expected an integer between ${min} and ${max}`);
  }
  return parsed;
}

function binding(candidate: ExternalAuthorizationRotationCandidate): ExternalAuthorizationBinding {
  return {
    externalId: candidate.externalId,
    agentId: candidate.agentId,
    idempotencyKey: candidate.idempotencyKey,
    host: candidate.host,
    payTo: candidate.payTo,
    settlementAsset: candidate.settlementAsset,
    settlementNetwork: candidate.settlementNetwork,
    resource: candidate.resource,
    policyPayee: candidate.policyPayee,
    amountMicros: candidate.amountMicros,
    authorizationExpiresAt: candidate.authorizationExpiresAt,
    reverseAfter: candidate.reverseAfter,
  };
}

export interface ExternalKeyRotationResult {
  scanned: number;
  rotated: number;
  skipped: number;
}

/** Re-encrypt one bounded batch. The compare-and-swap database command keeps
 * lifecycle races safe and never changes the plaintext authorization hash. */
export async function rotateExternalAuthorizationKeysOnce(
  external: PostgresExternal,
  keyring: ExternalHeaderKeyring,
  limit = 100,
): Promise<ExternalKeyRotationResult> {
  const candidates = await external.rotationCandidates(keyring.activeKeyId, limit);
  let rotated = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const terms = binding(candidate);
    const { plaintext } = decryptPaymentHeaderWithKeyring(
      candidate.paymentHeaderCiphertext,
      keyring,
      terms,
      candidate.authorizationKeyId,
    );
    const plaintextHash = createHash("sha256").update(plaintext).digest();
    if (!timingSafeEqual(plaintextHash, candidate.authorizationHash)) {
      throw new Error(`external authorization ${candidate.externalId} failed plaintext hash verification`);
    }
    const encrypted = encryptPaymentHeaderWithKeyring(plaintext, keyring, terms);
    const changed = await external.rotateAuthorization({
      externalId: candidate.externalId,
      expectedAuthorizationHash: candidate.authorizationHash,
      paymentHeaderCiphertext: encrypted.ciphertext,
      authorizationKeyId: encrypted.keyId,
    });
    if (changed) rotated += 1;
    else skipped += 1;
  }
  return { scanned: candidates.length, rotated, skipped };
}

export async function runExternalKeyRotation(): Promise<ExternalKeyRotationResult> {
  const encodedKeyring = process.env.MONEY_EXTERNAL_HEADER_KEYS;
  const activeKeyId = process.env.MONEY_EXTERNAL_HEADER_ACTIVE_KEY_ID;
  if (!encodedKeyring || !activeKeyId) {
    throw new Error("MONEY_EXTERNAL_HEADER_KEYS and MONEY_EXTERNAL_HEADER_ACTIVE_KEY_ID are required");
  }
  const keyring = parseExternalHeaderKeyring(encodedKeyring, activeKeyId);
  const batchSize = boundedInteger(process.env.MONEY_EXTERNAL_ROTATION_BATCH, 100, 1, 1_000);
  const maximum = boundedInteger(process.env.MONEY_EXTERNAL_ROTATION_MAX, 10_000, 1, 1_000_000);
  const db = new PostgresDatabase({
    connectionString: process.env.MONEY_KEY_ROTATION_DATABASE_URL ?? process.env.DATABASE_URL,
    applicationName: "money-external-key-rotation",
    maxConnections: 2,
  });
  const external = new PostgresExternal(db);
  const total: ExternalKeyRotationResult = { scanned: 0, rotated: 0, skipped: 0 };
  try {
    while (total.scanned < maximum) {
      const limit = Math.min(batchSize, maximum - total.scanned);
      const batch = await rotateExternalAuthorizationKeysOnce(external, keyring, limit);
      total.scanned += batch.scanned;
      total.rotated += batch.rotated;
      total.skipped += batch.skipped;
      if (batch.scanned < limit || batch.rotated === 0) break;
    }
    return total;
  } finally {
    await db.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runExternalKeyRotation().then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
