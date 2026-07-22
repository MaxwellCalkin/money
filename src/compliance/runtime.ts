import {
  ComplianceProviderClient,
  GenericComplianceWebhookCodec,
  type ComplianceProvider,
  type ComplianceWebhookCodec,
} from "./provider.ts";
import {
  PERSONA_API_ORIGIN,
  PERSONA_API_VERSION,
  PersonaComplianceProvider,
  PersonaWebhookCodec,
} from "./persona.ts";

type Environment = Readonly<Record<string, string | undefined>>;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function hostedOrigins(env: Environment): string[] | undefined {
  const values = env.MONEY_COMPLIANCE_HOSTED_ORIGINS
    ?.split(",").map((value) => value.trim()).filter(Boolean);
  return values?.length ? values : undefined;
}

export function parseComplianceWebhookSecrets(
  encoded: string | undefined,
  legacySecret: string | undefined,
): string[] {
  if (!encoded?.trim()) return legacySecret?.trim() ? [legacySecret.trim()] : [];
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error("MONEY_COMPLIANCE_WEBHOOK_SECRETS must be a JSON array");
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 4
    || value.some((secret) => typeof secret !== "string" || secret.length < 16
      || secret.length > 512 || secret.trim() !== secret || /[\r\n]/.test(secret))) {
    throw new Error("MONEY_COMPLIANCE_WEBHOOK_SECRETS must contain one to four secrets");
  }
  return [...new Set(value as string[])];
}

export function createComplianceProviderFromEnv(
  env: Environment = process.env,
  fetcher?: typeof fetch,
): ComplianceProvider {
  const provider = required(env, "MONEY_COMPLIANCE_PROVIDER");
  const apiKey = required(env, "MONEY_COMPLIANCE_PROVIDER_API_KEY");
  const timeoutMs = optionalInteger(
    env.MONEY_COMPLIANCE_PROVIDER_TIMEOUT_MS,
    10_000,
    100,
    provider === "persona" ? 30_000 : 60_000,
    "MONEY_COMPLIANCE_PROVIDER_TIMEOUT_MS",
  );
  const allowInsecureLocalhost = env.NODE_ENV !== "production";
  if (provider === "persona") {
    const configuredBaseUrl = env.MONEY_COMPLIANCE_PROVIDER_URL?.trim();
    if (env.NODE_ENV === "production" && configuredBaseUrl
      && new URL(configuredBaseUrl).origin !== PERSONA_API_ORIGIN) {
      throw new Error(`production Persona requests must use ${PERSONA_API_ORIGIN}`);
    }
    const apiVersion = env.MONEY_PERSONA_API_VERSION?.trim() || PERSONA_API_VERSION;
    if (apiVersion !== PERSONA_API_VERSION) {
      throw new Error(
        `Persona adapter is certified only for API version ${PERSONA_API_VERSION}`,
      );
    }
    return new PersonaComplianceProvider({
      apiKey,
      individualTemplateId: required(env, "MONEY_PERSONA_INDIVIDUAL_TEMPLATE_ID"),
      businessTemplateId: required(env, "MONEY_PERSONA_BUSINESS_TEMPLATE_ID"),
      individualWatchlistReportTemplateId: required(
        env, "MONEY_PERSONA_INDIVIDUAL_WATCHLIST_REPORT_TEMPLATE_ID",
      ),
      businessWatchlistReportTemplateId: required(
        env, "MONEY_PERSONA_BUSINESS_WATCHLIST_REPORT_TEMPLATE_ID",
      ),
      businessAssociatedPersonsReportTemplateId: required(
        env, "MONEY_PERSONA_BUSINESS_ASSOCIATED_PERSONS_REPORT_TEMPLATE_ID",
      ),
      baseUrl: configuredBaseUrl || undefined,
      apiVersion,
      hostedOrigins: hostedOrigins(env),
      timeoutMs,
      inquiryTtlSeconds: optionalInteger(
        env.MONEY_PERSONA_INQUIRY_TTL_SECONDS,
        86_400,
        300,
        7 * 86_400,
        "MONEY_PERSONA_INQUIRY_TTL_SECONDS",
      ),
      evidenceTtlDays: optionalInteger(
        env.MONEY_PERSONA_EVIDENCE_TTL_DAYS,
        365,
        1,
        730,
        "MONEY_PERSONA_EVIDENCE_TTL_DAYS",
      ),
      screeningTtlDays: optionalInteger(
        env.MONEY_PERSONA_SCREENING_TTL_DAYS,
        30,
        1,
        365,
        "MONEY_PERSONA_SCREENING_TTL_DAYS",
      ),
      allowInsecureLocalhost,
      ...(fetcher ? { fetch: fetcher } : {}),
    });
  }
  return new ComplianceProviderClient({
    provider,
    baseUrl: required(env, "MONEY_COMPLIANCE_PROVIDER_URL"),
    apiKey,
    timeoutMs,
    allowInsecureLocalhost,
    hostedOrigins: hostedOrigins(env),
    ...(fetcher ? { fetch: fetcher } : {}),
  });
}

export function createComplianceWebhookCodecFromEnv(
  env: Environment = process.env,
): ComplianceWebhookCodec {
  const provider = required(env, "MONEY_COMPLIANCE_PROVIDER");
  const endpointId = required(env, "MONEY_COMPLIANCE_WEBHOOK_ENDPOINT_ID");
  if (provider === "persona") {
    const secrets = parseComplianceWebhookSecrets(
      env.MONEY_COMPLIANCE_WEBHOOK_SECRETS,
      env.MONEY_COMPLIANCE_WEBHOOK_SECRET,
    );
    return new PersonaWebhookCodec({
      endpointId,
      secrets,
      toleranceSeconds: optionalInteger(
        env.MONEY_COMPLIANCE_WEBHOOK_TOLERANCE_SECONDS,
        300,
        30,
        900,
        "MONEY_COMPLIANCE_WEBHOOK_TOLERANCE_SECONDS",
      ),
    });
  }
  return new GenericComplianceWebhookCodec({
    provider,
    endpointId,
    secret: required(env, "MONEY_COMPLIANCE_WEBHOOK_SECRET"),
  });
}
