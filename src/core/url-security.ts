import { isIP } from "node:net";

/** Normalize URL.hostname for security comparisons. WHATWG implementations
 * retain brackets around IPv6 literals and permit a trailing dot on DNS
 * names, neither of which should change whether an endpoint is local. */
export function canonicalHostname(value: URL | string): string {
  let hostname = (typeof value === "string" ? value : value.hostname).trim().toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  return hostname.replace(/\.+$/, "");
}

export function isLoopbackHostname(value: URL | string): boolean {
  const hostname = canonicalHostname(value);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;

  const ipv4 = hostname.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/.test(part)
    && Number(part) <= 255)) {
    return Number(ipv4[0]) === 127;
  }

  if (hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return true;
  // WHATWG canonicalizes IPv4-mapped loopback addresses such as
  // ::ffff:127.0.0.1 to ::ffff:7f00:1 in current Node releases.
  return /^::(?:ffff:)?7f[0-9a-f]{2}(?::|$)/.test(hostname)
    || /^0:0:0:0:0:(?:ffff:)?7f[0-9a-f]{2}(?::|$)/.test(hostname)
    || /^::ffff:127\./.test(hostname);
}

export function isLocalEndpointHostname(value: URL | string): boolean {
  const hostname = canonicalHostname(value);
  return isLoopbackHostname(hostname)
    || hostname === "0.0.0.0"
    || hostname === "::"
    || hostname === "0:0:0:0:0:0:0:0";
}

function ipv4Octets(value: string): number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part)
    || Number(part) > 255)) return undefined;
  return parts.map(Number);
}

function ipv6Words(value: string): number[] | undefined {
  let hostname = canonicalHostname(value);
  if (hostname.includes(".")) {
    const at = hostname.lastIndexOf(":");
    const octets = ipv4Octets(hostname.slice(at + 1));
    if (at < 0 || !octets) return undefined;
    hostname = `${hostname.slice(0, at)}:${((octets[0]! << 8) | octets[1]!).toString(16)}`
      + `:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = hostname.split("::");
  if (halves.length > 2) return undefined;
  const read = (part: string): number[] | undefined => {
    if (!part) return [];
    const words = part.split(":");
    if (words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return undefined;
    return words.map((word) => Number.parseInt(word, 16));
  };
  const left = read(halves[0]!);
  const right = read(halves[1] ?? "");
  if (!left || !right) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  return missing >= 1 ? [...left, ...Array<number>(missing).fill(0), ...right] : undefined;
}

/** Addresses an operator may deliberately expose to a trusted agent by exact
 * origin. This is narrower than the special-purpose classifier: loopback,
 * RFC1918, shared CGNAT (including common overlay networks), IPv6 ULA, and
 * private IPv4-mapped IPv6 are allowed; link-local metadata, unspecified,
 * documentation, benchmark, multicast, and other reserved ranges are not. */
export function isAllowlistablePrivateIpAddress(value: string): boolean {
  const hostname = canonicalHostname(value);
  if (isIP(hostname) === 4) {
    const [a, b] = ipv4Octets(hostname)!;
    return a === 10 || a === 127
      || (a === 100 && b! >= 64 && b! <= 127)
      || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 168);
  }
  if (isIP(hostname) !== 6) return false;
  const words = ipv6Words(hostname);
  if (!words) return false;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  if ((words[0]! & 0xfe00) === 0xfc00) return true;
  if (words.slice(0, 5).every((word) => word === 0)
    && (words[5] === 0 || words[5] === 0xffff)) {
    return isAllowlistablePrivateIpAddress([
      words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff,
    ].join("."));
  }
  return false;
}

/** True for literal IP ranges that an internet-browsing agent must not reach
 * by default: local/private/link-local, metadata-adjacent, documentation,
 * multicast, and otherwise non-global destinations. DNS names are resolved
 * separately by the caller and each returned address is checked here. */
export function isPrivateOrReservedIpAddress(value: string): boolean {
  const hostname = canonicalHostname(value);
  if (isIP(hostname) === 4) {
    const octets = ipv4Octets(hostname)!;
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b! >= 64 && b! <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 0 && octets[2] === 0)
      || (a === 192 && b === 0 && octets[2] === 2)
      || (a === 192 && b === 168)
      || (a === 192 && b === 88 && octets[2] === 99)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && octets[2] === 100)
      || (a === 203 && b === 0 && octets[2] === 113)
      || a! >= 224;
  }
  if (isIP(hostname) !== 6) return false;
  const words = ipv6Words(hostname);
  if (!words) return true;
  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const ietfProtocolAssignmentException = (
    words[0] === 0x2001 && words[1] === 0x0001
      && words.slice(2, 7).every((word) => word === 0)
      && [1, 2, 3].includes(words[7]!)
  ) || (words[0] === 0x2001 && words[1] === 0x0003)
    || (words[0] === 0x2001 && words[1] === 0x0004 && words[2] === 0x0112);
  const nonGeneralPurposeIetfAssignment = words[0] === 0x2001
    && words[1]! <= 0x01ff && !ietfProtocolAssignmentException;
  if (allZero || loopback
    || (words[0]! & 0xfe00) === 0xfc00
    || (words[0]! & 0xffc0) === 0xfe80
    || (words[0]! & 0xffc0) === 0xfec0
    || (words[0]! & 0xff00) === 0xff00
    || words[0] === 0x3ffe
    || (words[0] === 0x3fff && (words[1]! & 0xf000) === 0)
    || words[0] === 0x5f00
    || nonGeneralPurposeIetfAssignment
    || (words[0] === 0x2001 && words[1] === 0x0000)
    || (words[0] === 0x2001 && words[1] === 0x0002 && words[2] === 0)
    || (words[0] === 0x2001 && words[1]! >= 0x0010 && words[1]! <= 0x003f)
    || (words[0] === 0x2001 && words[1] === 0x0db8)
    || words[0] === 0x2002
    || (words[0] === 0x0100 && words.slice(1, 4).every((word) => word === 0))
    || (words[0] === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 1)) {
    return true;
  }
  const embeddedIpv4 = (high: number, low: number) => isPrivateOrReservedIpAddress([
    high >> 8, high & 0xff, low >> 8, low & 0xff,
  ].join("."));
  if (words.slice(0, 5).every((word) => word === 0)
    && (words[5] === 0 || words[5] === 0xffff)) {
    return embeddedIpv4(words[6]!, words[7]!);
  }
  if (words[0] === 0x0064 && words[1] === 0xff9b
    && words.slice(2, 6).every((word) => word === 0)) {
    return embeddedIpv4(words[6]!, words[7]!);
  }
  if (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 1) return true;
  // IANA currently assigns ordinary global-unicast addresses only from
  // 2000::/3. Translation and mapped-address exceptions returned above.
  return (words[0]! & 0xe000) !== 0x2000;
}
