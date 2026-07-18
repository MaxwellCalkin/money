import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";

/**
 * Agent identity: an Ed25519 keypair per agent. The agent holds the private
 * key (delivered once, via its MCP config); the network registers the public
 * key at agent creation and verifies a signature over
 * (method, path, sha256(body), timestamp, nonce) on every spend request.
 * The x-agent-id header is still sent, but it is now a claim the signature
 * has to prove — not the trust-me placeholder it was in v0.
 *
 * Web-Bot-Auth-shaped; production migrates to RFC 9421 HTTP Message
 * Signatures — same envelope, standard wire format.
 *
 * Keys travel as single-line base64 DER: SPKI for public, PKCS#8 for private.
 */

export interface SignedRequestParts {
  method: string;
  /** URL pathname + search, e.g. "/pay". */
  path: string;
  /** Raw request body exactly as sent ("" for bodyless requests). */
  body: string;
  /** Unix ms at signing; the server rejects outside its freshness window. */
  ts: number;
  /** Random single-use value; the server rejects reuse within the window. */
  nonce: string;
}

/** True if `s` parses as a base64 SPKI Ed25519 public key. Cheap gate so the
 *  durable log can't be filled with keys that could never verify anything. */
export function isValidPublicKey(s: unknown): s is string {
  if (typeof s !== "string" || !s) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(s, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

export function generateAgentKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

function canonical(parts: SignedRequestParts): Buffer {
  const bodyHash = createHash("sha256").update(parts.body, "utf8").digest("hex");
  return Buffer.from(
    [parts.method.toUpperCase(), parts.path, bodyHash, String(parts.ts), parts.nonce].join("\n"),
    "utf8"
  );
}

export function signRequest(privateKeyB64: string, parts: SignedRequestParts): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  return sign(null, canonical(parts), key).toString("base64");
}

export function verifyRequest(publicKeyB64: string, signatureB64: string, parts: SignedRequestParts): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return verify(null, canonical(parts), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false; // a malformed key or signature is a clean rejection, not a crash
  }
}

/** The headers a client attaches to a signed request. Agents identify via
 * x-agent-id, owners via x-user-id, and sellers via x-provider-id. */
export function signedHeaders(
  accountId: string,
  privateKeyB64: string,
  parts: Omit<SignedRequestParts, "ts" | "nonce">,
  idHeader: "x-agent-id" | "x-user-id" | "x-provider-id" = "x-agent-id"
): Record<string, string> {
  const ts = Date.now();
  const nonce = randomUUID();
  return {
    [idHeader]: accountId,
    "x-signature-ts": String(ts),
    "x-signature-nonce": nonce,
    "x-signature": signRequest(privateKeyB64, { ...parts, ts, nonce }),
  };
}
