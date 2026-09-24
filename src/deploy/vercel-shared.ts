import { createHash, timingSafeEqual } from "node:crypto";
import { resolvePostgresSsl, type PostgresOptions } from "../db/postgres.ts";
import { SEGREGATED_AUTHORITY } from "./preflight.ts";

export type BetaEnvironment = Readonly<Record<string, string | undefined>>;
export type BetaProfile = "main" | "metrics";

/** The hosted beta is one posture: sandbox money only. Every composer refuses
 * to boot under any other value so an env edit can never nudge the deployment
 * toward real-money configuration. */
export const BETA_POSTURE = "sandbox-beta";

/** Names each profile may hold out of the segregated-authority list. The main
 * function is the product API plus the sweep worker, card ingress, and ops
 * probe, so it holds exactly those four database identities and the webhook
 * secrets; the metrics function holds the metrics login and nothing else. */
const MAIN_ALLOWED_AUTHORITY: ReadonlySet<string> = new Set([
  "DATABASE_URL",
  "MONEY_WORKER_DATABASE_URL",
  "MONEY_CARD_INGRESS_DATABASE_URL",
  "MONEY_CARD_WEBHOOK_SECRETS",
]);
const MAIN_EXTRA_FORBIDDEN = [
  "MONEY_EXTERNAL_MOCK",
  "MONEY_METRICS_DATABASE_URL",
  "MONEY_CARD_WORKER_DATABASE_URL",
  "MONEY_CARD_EVENT_API_KEY",
  "MONEY_OPS_TOKEN",
  "MONEY_AUTO_MIGRATE",
] as const;
const METRICS_ALLOWED_AUTHORITY: ReadonlySet<string> = new Set(["MONEY_METRICS_DATABASE_URL"]);
const METRICS_EXTRA_FORBIDDEN = ["DATABASE_URL"] as const;

function present(env: BetaEnvironment, name: string): boolean {
  return Boolean(env[name]?.trim());
}

/** Boot-time drift guard shared by both composers. Throws (naming the profile
 * and the variable, never a value) unless the environment states the sandbox
 * posture, is not NODE_ENV=production, pins the database CA, and carries no
 * authority the profile has no business holding. */
export function readBetaPosture(env: BetaEnvironment, profile: BetaProfile): void {
  const where = `vercel ${profile} profile`;
  if (env.MONEY_POSTURE?.trim() !== BETA_POSTURE) {
    throw new Error(`${where}: MONEY_POSTURE must be ${BETA_POSTURE}`);
  }
  const nodeEnv = env.NODE_ENV?.trim();
  if (nodeEnv && nodeEnv !== "development") {
    throw new Error(`${where}: NODE_ENV must be unset or development (this profile is sandbox-only)`);
  }
  if (env.MONEY_DB_SSL?.trim() !== "verify-full") {
    throw new Error(`${where}: MONEY_DB_SSL must be verify-full (require is MITM-tolerant, off is plaintext)`);
  }
  if (!present(env, "MONEY_DB_SSL_CA")) {
    throw new Error(`${where}: MONEY_DB_SSL_CA must carry the database CA (PEM)`);
  }
  const allowed = profile === "main" ? MAIN_ALLOWED_AUTHORITY : METRICS_ALLOWED_AUTHORITY;
  const extra: readonly string[] = profile === "main" ? MAIN_EXTRA_FORBIDDEN : METRICS_EXTRA_FORBIDDEN;
  const forbidden = [
    ...SEGREGATED_AUTHORITY.filter((name) => !allowed.has(name)),
    ...extra,
  ].filter((name) => present(env, name));
  if (forbidden.length) {
    throw new Error(`${where}: ${forbidden.join(", ")} must not be present`);
  }
}

/** Hash both sides so the comparison is constant-time regardless of length
 * (the same shape as the invite-code check in the product API). */
export function sweepKeyMatches(expected: string, supplied: string): boolean {
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  const suppliedHash = createHash("sha256").update(supplied, "utf8").digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

const RETRYABLE_CODES: ReadonlySet<string> = new Set(["ECONNRESET", "EPIPE", "57P01"]);

function isConnectionDrop(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === "object"; depth += 1) {
    const candidate = cursor as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && RETRYABLE_CODES.has(candidate.code)) return true;
    if (typeof candidate.message === "string" && candidate.message.includes("Connection terminated unexpectedly")) {
      return true;
    }
    cursor = candidate.cause;
  }
  return false;
}

/** One retry for the idle-disconnect case: a paused instance's pooled client
 * may have been dropped by the pooler without pg noticing (idle timers do not
 * fire while the instance is paused). Anything else propagates unchanged. */
export async function withConnectionRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isConnectionDrop(error)) throw error;
    return fn();
  }
}

/** Pool options for the serverless profile: tiny pools (two per identity per
 * instance), short idle timeout, and the pinned-CA TLS from MONEY_DB_SSL. */
export function betaPoolOptions(
  env: BetaEnvironment,
  options: { connectionString: string; applicationName: string; statementTimeoutMs: number },
): PostgresOptions {
  const configured = env.PG_POOL_MAX?.trim();
  const maxConnections = configured === undefined || configured === "" ? 2 : Number(configured);
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 10) {
    throw new Error("PG_POOL_MAX must be an integer between 1 and 10");
  }
  const ssl = resolvePostgresSsl(env);
  return {
    connectionString: options.connectionString,
    applicationName: options.applicationName,
    statementTimeoutMs: options.statementTimeoutMs,
    maxConnections,
    idleTimeoutMs: 5_000,
    ...(ssl !== undefined ? { ssl } : {}),
  };
}

/** A required variable, named in the error, never echoed. */
export function requiredBetaVariable(env: BetaEnvironment, name: string, profile: BetaProfile): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`vercel ${profile} profile: ${name} is required`);
  return value;
}
