import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_PROVIDER_BODY_BYTES = 256 * 1024;

export interface ComplianceProviderClientOptions {
  provider: string;
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  allowInsecureLocalhost?: boolean;
}

export interface ComplianceProviderResult {
  id: string;
  subjectAccountId: string;
  kind: "identity" | "business" | "beneficial_owner" | "sanctions" | "pep" | "adverse_media";
  decision: "clear" | "review" | "blocked" | "error";
  evidenceHash: Buffer;
  listVersion?: string;
  observedAt: Date;
  expiresAt: Date;
  normalized: Record<string, unknown>;
}

export interface ComplianceWebhookEnvelope {
  id: string;
  resultRef: string;
}

export class ComplianceProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly responseBody?: string
  ) {
    super(message);
    this.name = "ComplianceProviderError";
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 255): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function instant(value: unknown, name: string): Date {
  const parsed = new Date(text(value, name, 100));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} must be an ISO timestamp`);
  return parsed;
}

const SENSITIVE_KEYS = /(name|dob|birth|ssn|tin|ein|tax[_-]?id|address|email|phone|passport|license|document|image|selfie)/i;

function assertNormalizedEvidence(value: unknown, path = "normalized"): Record<string, unknown> {
  const root = record(value, path);
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

async function limitedBody(response: Response, maxBytes = MAX_PROVIDER_BODY_BYTES): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > maxBytes) throw new Error("compliance provider response is too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("compliance provider response is too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function parseComplianceWebhookEnvelope(value: unknown): ComplianceWebhookEnvelope {
  const row = record(value, "compliance webhook");
  return {
    id: text(row.id, "event.id"),
    resultRef: text(row.resultRef, "event.resultRef"),
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

export class ComplianceProviderClient {
  readonly provider: string;
  readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly authorization: string;
  private readonly timeoutMs: number;

  constructor(options: ComplianceProviderClientOptions) {
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(options.provider)) throw new Error("compliance provider name is invalid");
    if (!options.apiKey || options.apiKey.length > 512) throw new Error("compliance provider API key is required");
    this.provider = options.provider;
    this.baseUrl = new URL(options.baseUrl);
    const local = ["127.0.0.1", "localhost", "::1"].includes(this.baseUrl.hostname);
    if (this.baseUrl.protocol !== "https:" && !(options.allowInsecureLocalhost && local)) {
      throw new Error("compliance provider URL must use HTTPS");
    }
    if (this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) {
      throw new Error("compliance provider URL must not contain credentials, query, or fragment");
    }
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.authorization = `Bearer ${options.apiKey}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new Error("compliance provider timeout must be an integer from 100 to 60000 milliseconds");
    }
  }

  async getResult(resultRef: string): Promise<ComplianceProviderResult> {
    const expectedId = text(resultRef, "resultRef");
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
    const body = await limitedBody(response);
    if (!response.ok) {
      throw new ComplianceProviderError(
        `compliance provider returned HTTP ${response.status}`,
        response.status,
        response.status === 408 || response.status === 409 || response.status === 425
          || response.status === 429 || response.status >= 500,
        body.slice(0, 2_000)
      );
    }
    let value: unknown;
    try {
      value = body ? JSON.parse(body) as unknown : {};
    } catch {
      throw new ComplianceProviderError("compliance provider returned invalid JSON", response.status, false);
    }
    const row = record(value, "compliance provider result");
    const id = text(row.id, "result.id");
    if (id !== expectedId) throw new Error("compliance provider returned a different result id");
    const subjectAccountId = text(row.subjectAccountId, "result.subjectAccountId");
    if (!/^usr_[A-Za-z0-9_-]{8,128}$/.test(subjectAccountId)) {
      throw new Error("compliance provider result has an invalid subject account id");
    }
    const kind = text(row.kind, "result.kind") as ComplianceProviderResult["kind"];
    if (!["identity", "business", "beneficial_owner", "sanctions", "pep", "adverse_media"].includes(kind)) {
      throw new Error("compliance provider result has an unsupported evidence kind");
    }
    const decision = text(row.decision, "result.decision") as ComplianceProviderResult["decision"];
    if (!["clear", "review", "blocked", "error"].includes(decision)) {
      throw new Error("compliance provider result has an invalid decision");
    }
    const evidenceHex = text(row.evidenceHash, "result.evidenceHash", 64);
    if (!/^[0-9a-f]{64}$/i.test(evidenceHex)) throw new Error("result.evidenceHash must be 32-byte hex");
    const observedAt = instant(row.observedAt, "result.observedAt");
    const expiresAt = instant(row.expiresAt, "result.expiresAt");
    if (expiresAt <= observedAt) throw new Error("compliance provider result expires before it was observed");
    return {
      id,
      subjectAccountId,
      kind,
      decision,
      evidenceHash: Buffer.from(evidenceHex, "hex"),
      ...(row.listVersion !== undefined ? { listVersion: text(row.listVersion, "result.listVersion", 200) } : {}),
      observedAt,
      expiresAt,
      normalized: assertNormalizedEvidence(row.normalized ?? {}),
    };
  }
}
