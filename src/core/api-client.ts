import { readBoundedResponseText } from "./bounded-response.ts";
import { isLoopbackHostname } from "./url-security.ts";

export const DEFAULT_CLIENT_RESPONSE_BYTES = 256 * 1024;
export const DEFAULT_CLIENT_TIMEOUT_MS = 30_000;

/** Canonicalize a configured service endpoint without permitting path-based
 * endpoint confusion or cleartext credentials outside local development. */
export function configuredHttpOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP or HTTPS origin`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url))) {
    throw new Error(`${name} must use HTTPS outside explicit loopback development`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be a bare origin without credentials, query, or fragment`);
  }
  return url.origin;
}

/** Parse a service response only after enforcing an exact byte ceiling. */
export async function readBoundedJsonResponse<T>(
  response: Response,
  maxBytes = DEFAULT_CLIENT_RESPONSE_BYTES,
  label = "service response",
): Promise<T> {
  const text = await readBoundedResponseText(
    response,
    maxBytes,
    `${label} is too large`,
  );
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}
