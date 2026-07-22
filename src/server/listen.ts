const LISTEN_HOSTS = new Set(["127.0.0.1", "0.0.0.0", "::1", "::"]);

/** Keep local development private by default while allowing an explicit
 * all-interface bind inside an isolated production container or pod. */
export function listenHost(fallback: "127.0.0.1" | "0.0.0.0"): string {
  const value = process.env.MONEY_BIND_HOST?.trim() || fallback;
  if (!LISTEN_HOSTS.has(value)) {
    throw new Error("MONEY_BIND_HOST must be 127.0.0.1, 0.0.0.0, ::1, or ::");
  }
  return value;
}
