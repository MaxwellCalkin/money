import { createHmac, timingSafeEqual } from "node:crypto";
import { readBoundedResponseText } from "../core/bounded-response.ts";
import { isLoopbackHostname } from "../core/url-security.ts";

const MAX_PROVIDER_BODY_BYTES = 256 * 1024;

export interface ComplianceProviderClientOptions {
  provider: string;
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  allowInsecureLocalhost?: boolean;
  hostedOrigins?: readonly string[];
}

export interface ComplianceInquiryRequest {
  sessionId: string;
  subjectAccountId: string;
  subjectType: "individual" | "business";
  countryCode: string;
}

export interface ComplianceInquiry {
  id: string;
  hostedUrl: string;
  expiresAt: Date;
}

export interface ComplianceProviderResult {
  id: string;
  subjectAccountId: string;
  /** Stable opaque provider-side subject/account identifier. It is not PII;
   * workers use it to bind later monitoring events to the original subject. */
  providerSubjectRef?: string;
  kind: "identity" | "business" | "beneficial_owner" | "sanctions" | "pep" | "adverse_media";
  decision: "clear" | "review" | "blocked" | "error";
  evidenceHash: Buffer;
  listVersion?: string;
  observedAt: Date;
  expiresAt: Date;
  normalized: Record<string, unknown>;
}

export interface ComplianceProvider {
  readonly provider: string;
  createInquiry(input: ComplianceInquiryRequest): Promise<ComplianceInquiry>;
  getResults(resultRef: string): Promise<readonly ComplianceProviderResult[]>;
}

export interface ComplianceWebhookEnvelope {
  id: string;
  resultRef: string;
}

export interface ComplianceWebhookCodec {
  readonly provider: string;
  readonly endpointId: string;
  authenticate(input: { rawBody: Buffer; headers: Headers; now?: Date }): boolean;
  parse(value: unknown): ComplianceWebhookEnvelope | null;
}

export class ComplianceProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly responseBody?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ComplianceProviderError";
  }
}

export function providerRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function providerText(value: unknown, name: string, max = 255): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function providerInstant(value: unknown, name: string): Date {
  const parsed = new Date(providerText(value, name, 100));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} must be an ISO timestamp`);
  return parsed;
}

const SENSITIVE_KEYS = /(name|dob|birth|ssn|tin|ein|tax[_-]?id|address|email|phone|passport|license|document|image|selfie)/i;

function assertNormalizedEvidence(value: unknown, path = "normalized"): Record<string, unknown> {
  const root = providerRecord(value, path);
  const visit = (entry: unknown, location: string, depth: number): void => {
    if (depth > 8) throw new Error("normalized evidence is too deeply nested");
    if (Array.isArray(entry)) {
      if (entry.length > 100) throw new Error("normalized evidence array is too large");
      entry.forEach((item, index) => visit(item, `${location}[${index}]`, depth + 1));
      return;
    }
    if (!entry || typeof entry !== "object") return;
    for (const [key, item] of Object.entries(entry as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.test(key)) {
        throw new Error(`normalized evidence must not contain raw identity field ${location}.${key}`);
      }
      visit(item, `${location}.${key}`, depth + 1);
    }
  };
  visit(root, path, 0);
  return root;
}

export async function readProviderBody(
  response: Response,
  maxBytes = MAX_PROVIDER_BODY_BYTES,
): Promise<string> {
  return readBoundedResponseText(
    response,
    maxBytes,
    "compliance provider response is too large",
  );
}

export function providerRetryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86_400
      ? seconds : undefined;
  }
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return undefined;
  return Math.min(86_400, Math.max(0, Math.ceil((at - Date.now()) / 1_000)));
}

export function parseComplianceWebhookEnvelope(value: unknown): ComplianceWebhookEnvelope {
  const row = providerRecord(value, "compliance webhook");
  return {
    id: providerText(row.id, "event.id"),
    resultRef: providerText(row.resultRef, "event.resultRef"),
  };
}

export function verifyComplianceWebhook(input: {
  rawBody: Buffer;
  signature?: string;
  endpointId?: string;
  expectedEndpointId: string;
  secret: string;
}): boolean {
  if (!input.signature || !/^[0-9a-f]{64}$/i.test(input.signature)) return false;
  if (!input.endpointId || input.endpointId !== input.expectedEndpointId) return false;
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest();
  const presented = Buffer.from(input.signature, "hex");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export class GenericComplianceWebhookCodec implements ComplianceWebhookCodec {
  readonly provider: string;
  readonly endpointId: string;
  private readonly secret: string;

  constructor(input: { provider: string; endpointId: string; secret: string }) {
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(input.provider)) {
      throw new Error("compliance provider is invalid");
    }
    if (!input.secret || input.secret.length > 512 || !input.endpointId
      || input.endpointId.length > 255) {
      throw new Error("compliance webhook secret and endpoint id are required");
    }
    this.provider = input.provider;
    this.endpointId = input.endpointId;
    this.secret = input.secret;
  }

  authenticate(input: { rawBody: Buffer; headers: Headers }): boolean {
    return verifyComplianceWebhook({
      rawBody: input.rawBody,
      signature: input.headers.get("x-compliance-signature") ?? undefined,
      endpointId: input.headers.get("x-compliance-endpoint-id") ?? undefined,
      expectedEndpointId: this.endpointId,
      secret: this.secret,
    });
  }

  parse(value: unknown): ComplianceWebhookEnvelope {
    return parseComplianceWebhookEnvelope(value);
  }
}

export class ComplianceProviderClient implements ComplianceProvider {
  readonly provider: string;
  readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly authorization: string;
  private readonly timeoutMs: number;
  private readonly hostedOrigins: ReadonlySet<string>;

  constructor(options: ComplianceProviderClientOptions) {
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(options.provider)) throw new Error("compliance provider name is invalid");
    if (!options.apiKey || options.apiKey.length > 512
      || options.apiKey.trim() !== options.apiKey || /[\r\n]/.test(options.apiKey)) {
      throw new Error("compliance provider API key is required");
    }
    this.provider = options.provider;
    this.baseUrl = new URL(options.baseUrl);
    const local = isLoopbackHostname(this.baseUrl);
    if (this.baseUrl.protocol !== "https:" && !(options.allowInsecureLocalhost && local)) {
      throw new Error("compliance provider URL must use HTTPS");
    }
    if (this.baseUrl.username || this.baseUrl.password || this.baseUrl.pathname !== "/"
      || this.baseUrl.search || this.baseUrl.hash) {
      throw new Error("compliance provider URL must be a bare origin without credentials");
    }
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.authorization = `Bearer ${options.apiKey}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error("compliance provider timeout must be an integer from 100 to 60000 milliseconds");
    }
    const origins = options.hostedOrigins?.length ? options.hostedOrigins : [this.baseUrl.origin];
    if (origins.length > 16) throw new Error("compliance hosted origins must contain at most 16 origins");
    this.hostedOrigins = new Set(origins.map((origin) => {
      const parsed = new URL(origin);
      const localOrigin = isLoopbackHostname(parsed);
      if (parsed.protocol !== "https:" && !(options.allowInsecureLocalhost && localOrigin)) {
        throw new Error("compliance hosted origins must use HTTPS");
      }
      if (parsed.origin !== origin.replace(/\/$/, "") || parsed.username || parsed.password
        || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        throw new Error("compliance hosted origins must be bare origins");
      }
      return parsed.origin;
    }));
  }

  async createInquiry(input: ComplianceInquiryRequest): Promise<ComplianceInquiry> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.sessionId)) {
      throw new Error("compliance inquiry session id is invalid");
    }
    if (!/^usr_[A-Za-z0-9_-]{8,128}$/.test(input.subjectAccountId)) {
      throw new Error("compliance inquiry subject id is invalid");
    }
    if (!["individual", "business"].includes(input.subjectType)
      || !/^[A-Z]{2}$/.test(input.countryCode)) {
      throw new Error("compliance inquiry profile is invalid");
    }
    const url = new URL("/v1/inquiries", this.baseUrl);
    const requestBody = JSON.stringify({
      idempotencyKey: input.sessionId,
      subjectAccountId: input.subjectAccountId,
      subjectType: input.subjectType,
      countryCode: input.countryCode,
    });
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers: {
          authorization: this.authorization,
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": input.sessionId,
        },
        body: requestBody,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ComplianceProviderError(
        `compliance provider inquiry failed: ${error instanceof Error ? error.message : "network error"}`,
        0,
        true,
      );
    }
    const body = await readProviderBody(response, 64 * 1024);
    if (!response.ok) {
      throw new ComplianceProviderError(
        `compliance provider inquiry returned HTTP ${response.status}`,
        response.status,
        response.status === 408 || response.status === 409 || response.status === 425
          || response.status === 429 || response.status >= 500,
        body.slice(0, 2_000),
        providerRetryAfterSeconds(response),
      );
    }
    let parsed: unknown;
    try {
      parsed = body ? JSON.parse(body) as unknown : {};
    } catch {
      throw new ComplianceProviderError("compliance provider inquiry returned invalid JSON", response.status, false);
    }
    const row = providerRecord(parsed, "compliance provider inquiry");
    const id = providerText(row.id, "inquiry.id");
    const hostedUrl = new URL(providerText(row.hostedUrl, "inquiry.hostedUrl", 8_192));
    if (!this.hostedOrigins.has(hostedUrl.origin)
      || hostedUrl.username || hostedUrl.password || hostedUrl.hash) {
      throw new Error("compliance provider returned an untrusted hosted URL");
    }
    const expiresAt = providerInstant(row.expiresAt, "inquiry.expiresAt");
    const now = Date.now();
    if (expiresAt.getTime() <= now + 60_000 || expiresAt.getTime() > now + 7 * 86_400_000) {
      throw new Error("compliance provider inquiry expiry is outside the accepted window");
    }
    return { id, hostedUrl: hostedUrl.href, expiresAt };
  }

  async getResult(resultRef: string): Promise<ComplianceProviderResult> {
    const expectedId = providerText(resultRef, "resultRef");
    const url = new URL(`/v1/results/${encodeURIComponent(expectedId)}`, this.baseUrl);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: { authorization: this.authorization, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ComplianceProviderError(
        `compliance provider request failed: ${error instanceof Error ? error.message : "network error"}`,
        0,
        true
      );
    }
    const body = await readProviderBody(response);
    if (!response.ok) {
      throw new ComplianceProviderError(
        `compliance provider returned HTTP ${response.status}`,
        response.status,
        response.status === 408 || response.status === 409 || response.status === 425
          || response.status === 429 || response.status >= 500,
        body.slice(0, 2_000),
        providerRetryAfterSeconds(response),
      );
    }
    let value: unknown;
    try {
      value = body ? JSON.parse(body) as unknown : {};
    } catch {
      throw new ComplianceProviderError("compliance provider returned invalid JSON", response.status, false);
    }
    const row = providerRecord(value, "compliance provider result");
    const id = providerText(row.id, "result.id");
    if (id !== expectedId) throw new Error("compliance provider returned a different result id");
    const subjectAccountId = providerText(row.subjectAccountId, "result.subjectAccountId");
    if (!/^usr_[A-Za-z0-9_-]{8,128}$/.test(subjectAccountId)) {
      throw new Error("compliance provider result has an invalid subject account id");
    }
    const kind = providerText(row.kind, "result.kind") as ComplianceProviderResult["kind"];
    if (!["identity", "business", "beneficial_owner", "sanctions", "pep", "adverse_media"].includes(kind)) {
      throw new Error("compliance provider result has an unsupported evidence kind");
    }
    const decision = providerText(row.decision, "result.decision") as ComplianceProviderResult["decision"];
    if (!["clear", "review", "blocked", "error"].includes(decision)) {
      throw new Error("compliance provider result has an invalid decision");
    }
    const evidenceHex = providerText(row.evidenceHash, "result.evidenceHash", 64);
    if (!/^[0-9a-f]{64}$/i.test(evidenceHex)) throw new Error("result.evidenceHash must be 32-byte hex");
    const observedAt = providerInstant(row.observedAt, "result.observedAt");
    const expiresAt = providerInstant(row.expiresAt, "result.expiresAt");
    if (expiresAt <= observedAt) throw new Error("compliance provider result expires before it was observed");
    return {
      id,
      subjectAccountId,
      ...(row.providerSubjectRef !== undefined
        ? { providerSubjectRef: providerText(
          row.providerSubjectRef, "result.providerSubjectRef", 255,
        ) }
        : {}),
      kind,
      decision,
      evidenceHash: Buffer.from(evidenceHex, "hex"),
      ...(row.listVersion !== undefined
        ? { listVersion: providerText(row.listVersion, "result.listVersion", 200) }
        : {}),
      observedAt,
      expiresAt,
      normalized: assertNormalizedEvidence(row.normalized ?? {}),
    };
  }

  async getResults(resultRef: string): Promise<readonly ComplianceProviderResult[]> {
    return [await this.getResult(resultRef)];
  }
}
