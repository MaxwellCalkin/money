import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import {
  canonicalHostname,
  isAllowlistablePrivateIpAddress,
  isLocalEndpointHostname,
  isPrivateOrReservedIpAddress,
} from "../core/url-security.ts";

export type AddressResolver = (
  hostname: string,
) => Promise<readonly { address: string }[]>;

export interface AgentFetchPolicyOptions {
  /** JSON array of exact origins explicitly approved for local CLI/private API
   * access, e.g. ["http://127.0.0.1:8080"]. */
  privateOrigins?: string;
  resolver?: AddressResolver;
}

export interface ResolvedAgentFetchTarget {
  url: URL;
  addresses: readonly string[];
}

function isNonPublicAddress(address: string): boolean {
  return isLocalEndpointHostname(address) || isPrivateOrReservedIpAddress(address);
}

function isExplicitPrivateAddress(address: string): boolean {
  return isAllowlistablePrivateIpAddress(address);
}

function normalizedUrl(value: string): URL {
  if (!value || value.length > 2_048 || value.trim() !== value) {
    throw new Error("fetch URL must contain 1-2048 characters without surrounding whitespace");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("fetch URL is invalid");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("fetch URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("fetch URL must not contain credentials or a fragment");
  }
  const hostname = canonicalHostname(url);
  if (!hostname) throw new Error("fetch URL has no hostname");
  if (url.hostname.endsWith(".")) url.hostname = hostname;
  return url;
}

export function parsePrivateFetchOrigins(encoded: string | undefined): ReadonlySet<string> {
  if (!encoded?.trim()) return new Set();
  let values: unknown;
  try {
    values = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error("MONEY_FETCH_PRIVATE_ORIGINS must be a JSON array of exact origins");
  }
  if (!Array.isArray(values) || values.length > 32
    || values.some((value) => typeof value !== "string" || value.trim() !== value)) {
    throw new Error("MONEY_FETCH_PRIVATE_ORIGINS must contain at most 32 exact origins");
  }
  const origins = new Set<string>();
  for (const value of values as string[]) {
    const url = normalizedUrl(value);
    if (url.pathname !== "/" || url.search) {
      throw new Error("MONEY_FETCH_PRIVATE_ORIGINS entries must be bare origins");
    }
    origins.add(url.origin);
  }
  return origins;
}

/** Validates the target immediately before each request. Literal and resolved
 * local/private/reserved destinations fail closed. Exact origins can opt a
 * trusted loopback/private-network CLI into access, but cannot authorize a
 * public, link-local metadata, or otherwise reserved destination. The caller
 * must still disable automatic redirects and revalidate a Location before
 * issuing another request. */
export class AgentFetchPolicy {
  private readonly privateOrigins: ReadonlySet<string>;
  private readonly resolver: AddressResolver;

  constructor(options: AgentFetchPolicyOptions = {}) {
    this.privateOrigins = parsePrivateFetchOrigins(options.privateOrigins);
    this.resolver = options.resolver ?? (async (hostname) =>
      lookup(hostname, { all: true, verbatim: true }));
  }

  async resolve(value: string): Promise<ResolvedAgentFetchTarget> {
    const url = normalizedUrl(value);
    const privateOrigin = this.privateOrigins.has(url.origin);
    if (!privateOrigin && url.protocol !== "https:") {
      throw new Error("public agent fetches must use HTTPS");
    }

    const hostname = canonicalHostname(url);
    if (!privateOrigin && (isLocalEndpointHostname(hostname)
      || isPrivateOrReservedIpAddress(hostname))) {
      throw new Error("fetch target is local, private, or reserved");
    }
    if (isIP(hostname)) {
      if (privateOrigin && !isExplicitPrivateAddress(hostname)) {
        throw new Error(
          "configured private fetch origin is not a loopback or private-network address",
        );
      }
      return { url, addresses: [hostname] };
    }

    let addresses: readonly { address: string }[];
    try {
      addresses = await this.resolver(hostname);
    } catch {
      throw new Error("fetch target DNS lookup failed");
    }
    if (addresses.length < 1 || addresses.length > 64) {
      throw new Error("fetch target DNS lookup returned no usable addresses");
    }
    if (addresses.some(({ address }) => !isIP(address)
      || (!privateOrigin && isNonPublicAddress(address)))) {
      throw new Error("fetch target resolves to a local, private, or reserved address");
    }
    const resolved = [...new Set(addresses.map(({ address }) => address))];
    if (privateOrigin && resolved.some((address) => !isExplicitPrivateAddress(address))) {
      throw new Error(
        "configured private fetch origin must resolve only to loopback or private-network addresses",
      );
    }
    return { url, addresses: resolved };
  }

  async validate(value: string): Promise<URL> {
    return (await this.resolve(value)).url;
  }
}

/** Issue a GET on a socket pinned to an address returned by the policy's
 * immediately preceding DNS classification. The original hostname remains
 * the TLS SNI/certificate identity and Host header. Redirects are surfaced as
 * responses; no credential-bearing header is ever forwarded automatically. */
export async function pinnedAgentFetch(
  policy: AgentFetchPolicy,
  value: string,
  init: RequestInit = {},
): Promise<Response> {
  if ((init.method && init.method.toUpperCase() !== "GET") || init.body) {
    throw new Error("agent resource fetcher supports GET requests only");
  }
  const { url, addresses } = await policy.resolve(value);
  const address = addresses[0]!;
  const headers = new Headers(init.headers);
  headers.delete("connection");
  headers.delete("content-length");
  headers.set("accept-encoding", "identity");
  headers.set("host", url.host);

  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: address,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: Object.fromEntries(headers.entries()),
      ...(url.protocol === "https:" && !isIP(canonicalHostname(url))
        ? { servername: canonicalHostname(url), rejectUnauthorized: true }
        : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    }, (incoming) => {
      const status = incoming.statusCode;
      if (!status || status < 200 || status > 599) {
        incoming.destroy();
        reject(new Error("fetch target returned an invalid HTTP status"));
        return;
      }
      try {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        }
        const encoding = responseHeaders.get("content-encoding");
        if (encoding && encoding.toLowerCase() !== "identity") {
          incoming.destroy();
          reject(new Error("fetch target ignored the bounded identity encoding requirement"));
          return;
        }
        const noBody = status === 204 || status === 205 || status === 304;
        if (noBody) incoming.resume();
        resolve(new Response(
          noBody ? null : Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>,
          { status, statusText: incoming.statusMessage, headers: responseHeaders },
        ));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.once("error", reject);
    request.end();
  });
}
