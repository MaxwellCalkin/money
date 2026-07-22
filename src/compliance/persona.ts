import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isLoopbackHostname } from "../core/url-security.ts";
import {
  ComplianceProviderError,
  providerInstant,
  providerRecord,
  providerRetryAfterSeconds,
  providerText,
  readProviderBody,
  type ComplianceInquiry,
  type ComplianceInquiryRequest,
  type ComplianceProvider,
  type ComplianceProviderResult,
  type ComplianceWebhookCodec,
  type ComplianceWebhookEnvelope,
} from "./provider.ts";

export const PERSONA_API_VERSION = "2025-12-08";
export const PERSONA_API_ORIGIN = "https://api.withpersona.com";
const PERSONA_PROVIDER = "persona";
const PERSONA_HOSTED_ORIGIN = "https://withpersona.com";
const MAX_PERSONA_BODY_BYTES = 256 * 1024;
// A composite inquiry:event:decision reference must remain below the database's
// 255-character provider-reference ceiling even if Persona expands IDs.
const PERSONA_ID = /^(inq|evt|rep)_[A-Za-z0-9]{8,110}$/;
const PERSONA_ACCOUNT_ID = /^act_[A-Za-z0-9]{8,128}$/;
const SUBJECT_ACCOUNT_ID = /^usr_[A-Za-z0-9_-]{8,128}$/;
const TEMPLATE_ID = /^itmpl_[A-Za-z0-9]{8,128}$/;
const REPORT_TEMPLATE_ID = /^rptp_[A-Za-z0-9]{8,128}$/;

type PersonaReportType =
  | "report/watchlist"
  | "report/business-watchlist"
  | "report/business-associated-persons";

const REPORT_FIELDS: Readonly<Record<PersonaReportType, string>> = Object.freeze({
  "report/watchlist":
    "status,has-match,completed-at,created-at,is-continuous,report-template-version-name",
  "report/business-watchlist":
    "status,has-match,completed-at,created-at,is-continuous,report-template-version-name",
  "report/business-associated-persons":
    "status,completed-at,created-at,report-template-version-name",
});

type PersonaFinalStatus = "approved" | "declined" | "needs_review";
type PersonaReportEventAction = "ready" | "matched" | "dismissed" | "errored";

interface PersonaInquiryEventDefinition {
  status: PersonaFinalStatus;
  code: string;
}

interface PersonaReportEventDefinition {
  type: Exclude<PersonaReportType, "report/business-associated-persons">;
  action: PersonaReportEventAction;
  code: string;
}

const INQUIRY_EVENTS: Readonly<Record<string, PersonaInquiryEventDefinition>> = Object.freeze({
  "inquiry.approved": { status: "approved", code: "qa" },
  "inquiry.declined": { status: "declined", code: "qd" },
  "inquiry.marked-for-review": { status: "needs_review", code: "qr" },
});

const INQUIRY_EVENT_CODES: Readonly<Record<string, PersonaInquiryEventDefinition>> = Object.freeze(
  Object.fromEntries(Object.values(INQUIRY_EVENTS).map((definition) => [definition.code, definition])),
);

const REPORT_EVENTS: Readonly<Record<string, PersonaReportEventDefinition>> = Object.freeze({
  "report/watchlist.ready": { type: "report/watchlist", action: "ready", code: "ir" },
  "report/watchlist.matched": { type: "report/watchlist", action: "matched", code: "im" },
  "report/watchlist.dismissed": { type: "report/watchlist", action: "dismissed", code: "id" },
  "report/watchlist.errored": { type: "report/watchlist", action: "errored", code: "ie" },
  "report/business-watchlist.ready": {
    type: "report/business-watchlist", action: "ready", code: "br",
  },
  "report/business-watchlist.matched": {
    type: "report/business-watchlist", action: "matched", code: "bm",
  },
  "report/business-watchlist.dismissed": {
    type: "report/business-watchlist", action: "dismissed", code: "bd",
  },
  "report/business-watchlist.errored": {
    type: "report/business-watchlist", action: "errored", code: "be",
  },
});

const REPORT_EVENT_CODES: Readonly<Record<string, PersonaReportEventDefinition>> = Object.freeze(
  Object.fromEntries(Object.values(REPORT_EVENTS).map((definition) => [definition.code, definition])),
);

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function validateOrigin(value: string, allowInsecureLocalhost: boolean, name: string): URL {
  const parsed = new URL(value);
  const local = isLoopbackHostname(parsed);
  if (parsed.protocol !== "https:" && !(allowInsecureLocalhost && local)) {
    throw new Error(`${name} must use HTTPS`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error(`${name} must be a bare origin without credentials`);
  }
  return parsed;
}

function assertPersonaId(value: unknown, prefix: "inq" | "evt" | "rep", name: string): string {
  const id = providerText(value, name);
  if (!PERSONA_ID.test(id) || !id.startsWith(`${prefix}_`)) {
    const kind = prefix === "inq" ? "inquiry" : prefix === "evt" ? "event" : "report";
    throw new Error(`${name} is not a valid Persona ${kind} id`);
  }
  return id;
}

function inquiryTemplateId(data: Record<string, unknown>): string {
  const relationships = providerRecord(data.relationships, "inquiry.relationships");
  const relation = providerRecord(relationships["inquiry-template"], "inquiry.relationships.inquiry-template");
  const template = providerRecord(relation.data, "inquiry.relationships.inquiry-template.data");
  const id = providerText(template.id, "inquiry.template.id");
  if (!TEMPLATE_ID.test(id)) throw new Error("Persona inquiry template id is invalid");
  return id;
}

function inquiryAccountId(data: Record<string, unknown>): string {
  const relationships = providerRecord(data.relationships, "inquiry.relationships");
  const relation = providerRecord(relationships.account, "inquiry.relationships.account");
  const account = providerRecord(relation.data, "inquiry.relationships.account.data");
  const id = providerText(account.id, "inquiry.account.id");
  if (account.type !== "account" || !PERSONA_ACCOUNT_ID.test(id)) {
    throw new Error("Persona inquiry account relationship is invalid");
  }
  return id;
}

function personaResultRef(inquiryId: string, eventId: string, code: string): string {
  const value = `${inquiryId}:${eventId}:${code}`;
  if (value.length > 255) throw new Error("Persona inquiry event reference is too long");
  return value;
}

function personaReportResultRef(reportId: string, eventId: string, code: string): string {
  const value = `${reportId}:${eventId}:${code}`;
  if (value.length > 255) throw new Error("Persona report event reference is too long");
  return value;
}

function evidenceResultRef(resultRef: string, suffix: "sanctions" | "owners"): string {
  const value = `${resultRef}:${suffix}`;
  if (value.length > 255) throw new Error("Persona evidence result reference is too long");
  return value;
}

type PersonaResultReference =
  | {
    kind: "inquiry";
    inquiryId: string;
    eventId: string;
    eventStatus: PersonaFinalStatus;
  }
  | {
    kind: "report";
    reportId: string;
    eventId: string;
    definition: PersonaReportEventDefinition;
  };

function parsePersonaResultRef(value: string): PersonaResultReference {
  const parts = value.split(":");
  // Pre-v0.13 queued references did not retain the authenticated event
  // decision. Treat them as review-only rather than allowing a later provider
  // state to turn an ambiguous event into clearance.
  if (parts.length === 2 && parts[0]?.startsWith("inq_")) {
    return {
      kind: "inquiry",
      inquiryId: assertPersonaId(parts[0], "inq", "resultRef.inquiryId"),
      eventId: assertPersonaId(parts[1], "evt", "resultRef.eventId"),
      eventStatus: "needs_review",
    };
  }
  if (parts.length === 3 && parts[0]?.startsWith("inq_")) {
    const definition = Object.hasOwn(INQUIRY_EVENT_CODES, parts[2]!)
      ? INQUIRY_EVENT_CODES[parts[2]!] : undefined;
    if (!definition) throw new Error("Persona inquiry event reference has an invalid event code");
    return {
      kind: "inquiry",
      inquiryId: assertPersonaId(parts[0], "inq", "resultRef.inquiryId"),
      eventId: assertPersonaId(parts[1], "evt", "resultRef.eventId"),
      eventStatus: definition.status,
    };
  }
  if (parts.length === 3 && parts[0]?.startsWith("rep_")) {
    const code = parts[2]!;
    const definition = Object.hasOwn(REPORT_EVENT_CODES, code)
      ? REPORT_EVENT_CODES[code] : undefined;
    if (!definition) throw new Error("Persona report event reference has an invalid event code");
    return {
      kind: "report",
      reportId: assertPersonaId(parts[0], "rep", "resultRef.reportId"),
      eventId: assertPersonaId(parts[1], "evt", "resultRef.eventId"),
      definition,
    };
  }
  throw new Error("Persona result reference is invalid");
}

function classifyStatus(status: string): ComplianceProviderResult["decision"] {
  if (status === "approved") return "clear";
  if (status === "declined") return "blocked";
  if (status === "needs_review") return "review";
  throw new ComplianceProviderError(
    `Persona inquiry is not in a final decision state (${status})`,
    409,
    true,
  );
}

function classifyInquiryEventStatus(
  currentStatus: string,
  authenticatedEventStatus: PersonaFinalStatus,
): ComplianceProviderResult["decision"] {
  if (authenticatedEventStatus === "declined") return "blocked";
  if (authenticatedEventStatus === "needs_review") {
    return currentStatus === "declined" ? "blocked" : "review";
  }
  return classifyStatus(currentStatus);
}

interface PersonaReportLink {
  id: string;
  type: string;
}

interface PersonaReport {
  id: string;
  type: PersonaReportType;
  templateId: string;
  templateVersion: string;
  status: "pending" | "ready" | "errored";
  hasMatch?: boolean;
  continuous?: boolean;
  observedAt: Date;
  body: string;
  accountId: string;
  subjectAccountId: string;
}

function inquiryReportLinks(data: Record<string, unknown>): PersonaReportLink[] {
  const relationships = providerRecord(data.relationships, "inquiry.relationships");
  const reports = providerRecord(relationships.reports, "inquiry.relationships.reports");
  if (!Array.isArray(reports.data) || reports.data.length > 64) {
    throw new Error("Persona inquiry reports relationship is invalid");
  }
  return reports.data.map((value, index) => {
    const report = providerRecord(value, `inquiry.reports[${index}]`);
    return {
      id: assertPersonaId(report.id, "rep", `inquiry.reports[${index}].id`),
      type: providerText(report.type, `inquiry.reports[${index}].type`, 100),
    };
  });
}

function reportTemplateId(data: Record<string, unknown>): string {
  const relationships = providerRecord(data.relationships, "report.relationships");
  const relation = providerRecord(relationships["report-template"], "report.relationships.report-template");
  const template = providerRecord(relation.data, "report.relationships.report-template.data");
  const id = providerText(template.id, "report.template.id");
  if (!REPORT_TEMPLATE_ID.test(id)) throw new Error("Persona report template id is invalid");
  return id;
}

function reportAccountId(data: Record<string, unknown>): string {
  const relationships = providerRecord(data.relationships, "report.relationships");
  const relation = providerRecord(relationships.account, "report.relationships.account");
  const account = providerRecord(relation.data, "report.relationships.account.data");
  const id = providerText(account.id, "report.account.id");
  if (account.type !== "account" || !PERSONA_ACCOUNT_ID.test(id)) {
    throw new Error("Persona report account relationship is invalid");
  }
  return id;
}

function includedAccountReference(
  root: Record<string, unknown>,
  expectedAccountId: string,
): string {
  const included = root.included;
  if (!Array.isArray(included) || included.length !== 1) {
    throw new Error("Persona report must include exactly one account resource");
  }
  const account = providerRecord(included[0], "report.included.account");
  const accountId = providerText(account.id, "report.included.account.id");
  if (account.type !== "account" || !PERSONA_ACCOUNT_ID.test(accountId)
    || accountId !== expectedAccountId) {
    throw new Error("Persona included account does not match the report account");
  }
  const attributes = providerRecord(account.attributes, "report.included.account.attributes");
  const subjectAccountId = providerText(
    attributes["reference-id"], "report.included.account.reference-id",
  );
  if (!SUBJECT_ACCOUNT_ID.test(subjectAccountId)) {
    throw new Error("Persona account has an invalid subject reference");
  }
  return subjectAccountId;
}

function reportEvidenceHash(
  resultRef: string,
  reports: readonly PersonaReport[],
): Buffer {
  const digest = createHash("sha256").update(resultRef, "utf8");
  for (const report of [...reports].sort((left, right) => left.id.localeCompare(right.id))) {
    digest.update("\0", "utf8").update(report.id, "utf8")
      .update("\0", "utf8").update(report.body, "utf8");
  }
  return digest.digest();
}

function reportVersionFingerprint(reports: readonly PersonaReport[]): string {
  const versions = [...new Set(reports.map((report) => report.templateVersion))].sort();
  return createHash("sha256").update(versions.join("\0"), "utf8").digest("hex").slice(0, 32);
}

function reportListVersion(apiVersion: string, templateId: string, reports: readonly PersonaReport[]): string {
  return `persona:${apiVersion}:${templateId}:${reportVersionFingerprint(reports)}`;
}

export interface PersonaComplianceProviderOptions {
  apiKey: string;
  individualTemplateId: string;
  businessTemplateId: string;
  individualWatchlistReportTemplateId: string;
  businessWatchlistReportTemplateId: string;
  businessAssociatedPersonsReportTemplateId: string;
  baseUrl?: string;
  apiVersion?: string;
  hostedOrigins?: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  inquiryTtlSeconds?: number;
  evidenceTtlDays?: number;
  screeningTtlDays?: number;
  allowInsecureLocalhost?: boolean;
  clock?: () => Date;
}

/** Persona adapter pinned to one dated API contract. It asks Persona to make
 * an account-linked one-time hosted URL and later refetches only sparse
 * decision and report projections. Raw Persona fields are hashed and
 * discarded; they are never returned to the product database layer. */
export class PersonaComplianceProvider implements ComplianceProvider {
  readonly provider = PERSONA_PROVIDER;
  readonly apiVersion: string;
  private readonly apiOrigin: URL;
  private readonly authorization: string;
  private readonly templates: Readonly<Record<ComplianceInquiryRequest["subjectType"], string>>;
  private readonly reportTemplates: Readonly<{
    individualWatchlist: string;
    businessWatchlist: string;
    businessAssociatedPersons: string;
  }>;
  private readonly hostedOrigins: ReadonlySet<string>;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly inquiryTtlSeconds: number;
  private readonly evidenceTtlDays: number;
  private readonly screeningTtlDays: number;
  private readonly clock: () => Date;

  constructor(options: PersonaComplianceProviderOptions) {
    if (!options.apiKey || options.apiKey.length > 512
      || options.apiKey.trim() !== options.apiKey || /[\r\n]/.test(options.apiKey)) {
      throw new Error("Persona API key is required");
    }
    if (!TEMPLATE_ID.test(options.individualTemplateId)
      || !TEMPLATE_ID.test(options.businessTemplateId)
      || options.individualTemplateId === options.businessTemplateId) {
      throw new Error("distinct Persona individual and business inquiry template ids are required");
    }
    const reportTemplateIds = [
      options.individualWatchlistReportTemplateId,
      options.businessWatchlistReportTemplateId,
      options.businessAssociatedPersonsReportTemplateId,
    ];
    if (reportTemplateIds.some((id) => !REPORT_TEMPLATE_ID.test(id))
      || new Set(reportTemplateIds).size !== reportTemplateIds.length) {
      throw new Error("distinct Persona screening and associated-person report template ids are required");
    }
    const allowInsecure = options.allowInsecureLocalhost ?? false;
    this.apiOrigin = validateOrigin(options.baseUrl ?? PERSONA_API_ORIGIN, allowInsecure, "Persona API URL");
    this.apiVersion = options.apiVersion ?? PERSONA_API_VERSION;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(this.apiVersion)) {
      throw new Error("Persona API version must be a dated version");
    }
    this.authorization = `Bearer ${options.apiKey}`;
    this.templates = Object.freeze({
      individual: options.individualTemplateId,
      business: options.businessTemplateId,
    });
    this.reportTemplates = Object.freeze({
      individualWatchlist: options.individualWatchlistReportTemplateId,
      businessWatchlist: options.businessWatchlistReportTemplateId,
      businessAssociatedPersons: options.businessAssociatedPersonsReportTemplateId,
    });
    const origins = options.hostedOrigins?.length
      ? options.hostedOrigins : [PERSONA_HOSTED_ORIGIN];
    if (origins.length > 16) {
      throw new Error("Persona hosted origins must contain at most 16 origins");
    }
    this.hostedOrigins = new Set(origins.map((origin) =>
      validateOrigin(origin, allowInsecure, "Persona hosted origin").origin));
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, 100, 30_000, "Persona timeout");
    this.inquiryTtlSeconds = boundedInteger(
      options.inquiryTtlSeconds ?? 86_400, 300, 7 * 86_400, "Persona inquiry TTL",
    );
    this.evidenceTtlDays = boundedInteger(
      options.evidenceTtlDays ?? 365, 1, 730, "Persona evidence TTL days",
    );
    this.screeningTtlDays = boundedInteger(
      options.screeningTtlDays ?? 30, 1, 365, "Persona screening TTL days",
    );
    this.clock = options.clock ?? (() => new Date());
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    return {
      authorization: this.authorization,
      accept: "application/json",
      "content-type": "application/json",
      "key-inflection": "kebab",
      "persona-version": this.apiVersion,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    };
  }

  private async request(url: URL, init: RequestInit): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ComplianceProviderError(
        `Persona request failed: ${error instanceof Error ? error.message : "network error"}`,
        0,
        true,
      );
    }
    const body = await readProviderBody(response, MAX_PERSONA_BODY_BYTES);
    if (!response.ok) {
      throw new ComplianceProviderError(
        `Persona returned HTTP ${response.status}`,
        response.status,
        response.status === 408 || response.status === 409 || response.status === 425
          || response.status === 429 || response.status >= 500,
        undefined,
        providerRetryAfterSeconds(response),
      );
    }
    return body;
  }

  async createInquiry(input: ComplianceInquiryRequest): Promise<ComplianceInquiry> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.sessionId)) {
      throw new Error("compliance inquiry session id is invalid");
    }
    if (!SUBJECT_ACCOUNT_ID.test(input.subjectAccountId)
      || !/^[A-Z]{2}$/.test(input.countryCode)) {
      throw new Error("compliance inquiry profile is invalid");
    }
    const templateId = this.templates[input.subjectType];
    const url = new URL("/api/v1/inquiries", this.apiOrigin);
    url.searchParams.set("fields[inquiry]", "reference-id,expires-at");
    const body = await this.request(url, {
      method: "POST",
      headers: this.headers(input.sessionId),
      body: JSON.stringify({
        data: {
          attributes: { "inquiry-template-id": templateId },
        },
        meta: {
          "auto-create-account": true,
          "auto-create-account-reference-id": input.subjectAccountId,
          "auto-create-one-time-link": true,
          "expiration-after-create-interval-seconds": this.inquiryTtlSeconds,
        },
      }),
    });
    let value: unknown;
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      throw new ComplianceProviderError("Persona create inquiry returned invalid JSON", 200, false);
    }
    const root = providerRecord(value, "Persona create inquiry response");
    const data = providerRecord(root.data, "Persona inquiry data");
    if (data.type !== "inquiry") throw new Error("Persona returned a non-inquiry resource");
    const id = assertPersonaId(data.id, "inq", "inquiry.id");
    const attributes = providerRecord(data.attributes, "inquiry.attributes");
    if (providerText(attributes["reference-id"], "inquiry.reference-id") !== input.subjectAccountId) {
      throw new Error("Persona inquiry is bound to a different subject");
    }
    if (inquiryTemplateId(data) !== templateId) {
      throw new Error("Persona inquiry used a different template");
    }
    const meta = providerRecord(root.meta, "Persona inquiry meta");
    const hostedUrl = new URL(providerText(meta["one-time-link"], "inquiry.one-time-link", 8_192));
    if (!this.hostedOrigins.has(hostedUrl.origin)
      || hostedUrl.username || hostedUrl.password || hostedUrl.hash) {
      throw new Error("Persona returned an untrusted hosted URL");
    }
    const expiresAt = providerInstant(attributes["expires-at"], "inquiry.expires-at");
    const now = this.clock().getTime();
    if (expiresAt.getTime() <= now + 60_000 || expiresAt.getTime() > now + 7 * 86_400_000) {
      throw new Error("Persona inquiry expiry is outside the accepted window");
    }
    return { id, hostedUrl: hostedUrl.href, expiresAt };
  }

  private async retrieveReport(link: PersonaReportLink): Promise<PersonaReport> {
    if (!Object.hasOwn(REPORT_FIELDS, link.type)) {
      throw new Error(`unsupported Persona report type ${link.type}`);
    }
    const type = link.type as PersonaReportType;
    const url = new URL(`/api/v1/reports/${encodeURIComponent(link.id)}`, this.apiOrigin);
    url.searchParams.set("include", "account");
    url.searchParams.set(`fields[${type}]`, REPORT_FIELDS[type]);
    url.searchParams.set("fields[account]", "reference-id");
    const body = await this.request(url, { method: "GET", headers: this.headers() });
    let value: unknown;
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      throw new ComplianceProviderError("Persona retrieve report returned invalid JSON", 200, false);
    }
    const root = providerRecord(value, "Persona retrieve report response");
    const data = providerRecord(root.data, "Persona report data");
    if (data.type !== type) throw new Error("Persona returned a different report type");
    const id = assertPersonaId(data.id, "rep", "report.id");
    if (id !== link.id) throw new Error("Persona returned a different report id");
    const attributes = providerRecord(data.attributes, "report.attributes");
    const status = providerText(attributes.status, "report.status") as PersonaReport["status"];
    if (!["pending", "ready", "errored"].includes(status)) {
      throw new Error("Persona report has an unsupported status");
    }
    const templateVersion = attributes["report-template-version-name"] === undefined
      && status === "pending"
      ? "pending"
      : providerText(
        attributes["report-template-version-name"], "report.report-template-version-name", 100,
      );
    const observedAt = providerInstant(
      attributes["completed-at"] ?? attributes["created-at"], "report.completed-at",
    );
    if (observedAt.getTime() > this.clock().getTime() + 5 * 60_000) {
      throw new Error("Persona report timestamp is in the future");
    }
    let hasMatch: boolean | undefined;
    if (type !== "report/business-associated-persons" && status === "ready") {
      if (typeof attributes["has-match"] !== "boolean") {
        throw new Error("Persona watchlist report is missing has-match");
      }
      hasMatch = attributes["has-match"];
    }
    const continuous = attributes["is-continuous"];
    if (continuous !== undefined && typeof continuous !== "boolean") {
      throw new Error("Persona report has invalid continuous-monitoring state");
    }
    const accountId = reportAccountId(data);
    const subjectAccountId = includedAccountReference(root, accountId);
    return {
      id,
      type,
      templateId: reportTemplateId(data),
      templateVersion,
      status,
      ...(hasMatch !== undefined ? { hasMatch } : {}),
      ...(typeof continuous === "boolean" ? { continuous } : {}),
      observedAt,
      body,
      accountId,
      subjectAccountId,
    };
  }

  private async reportsForTemplate(
    links: readonly PersonaReportLink[],
    type: PersonaReportType,
    templateId: string,
    accountId: string,
    subjectAccountId: string,
  ): Promise<PersonaReport[]> {
    const candidates = links.filter((link) => link.type === type);
    if (candidates.length > 8) throw new Error(`Persona inquiry has too many ${type} reports`);
    const reports = await Promise.all(candidates.map((candidate) => this.retrieveReport(candidate)));
    const configured = reports.filter((report) => report.templateId === templateId);
    if (configured.length < 1) {
      throw new ComplianceProviderError(
        `Persona inquiry does not yet expose required ${type} report`, 409, true,
      );
    }
    const newestObservedAt = Math.max(
      ...configured.map((report) => report.observedAt.getTime()),
    );
    const current = configured.filter(
      (report) => report.observedAt.getTime() === newestObservedAt,
    );
    if (current.some((report) => report.status === "pending")) {
      throw new ComplianceProviderError(`Persona ${type} report is still pending`, 409, true);
    }
    if (current.some((report) => report.accountId !== accountId
      || report.subjectAccountId !== subjectAccountId)) {
      throw new Error("Persona report is bound to a different inquiry account");
    }
    return current;
  }

  private reportResult(input: {
    id: string;
    resultRef: string;
    subjectAccountId: string;
    providerSubjectRef: string;
    kind: "sanctions" | "beneficial_owner";
    templateId: string;
    reports: readonly PersonaReport[];
    eventAction?: PersonaReportEventAction;
  }): ComplianceProviderResult {
    const errored = input.eventAction === "errored"
      || input.reports.some((report) => report.status === "errored");
    const eventRequiresReview = input.eventAction === "matched"
      || input.eventAction === "dismissed";
    const hasMatch = input.kind === "sanctions"
      && input.reports.some((report) => report.hasMatch === true);
    const decision: ComplianceProviderResult["decision"] = errored
      ? "error"
      : input.kind === "beneficial_owner" || eventRequiresReview || hasMatch
        ? "review"
        : "clear";
    const observedAt = new Date(Math.max(...input.reports.map((report) => report.observedAt.getTime())));
    const expiresAt = new Date(observedAt.getTime() + this.screeningTtlDays * 86_400_000);
    const reportType = input.reports[0]!.type;
    return {
      id: input.id,
      subjectAccountId: input.subjectAccountId,
      providerSubjectRef: input.providerSubjectRef,
      kind: input.kind,
      decision,
      evidenceHash: reportEvidenceHash(input.resultRef, input.reports),
      listVersion: reportListVersion(this.apiVersion, input.templateId, input.reports),
      observedAt,
      expiresAt,
      normalized: {
        status: errored ? "errored" : "ready",
        reportType,
        reportCount: input.reports.length,
        reportTemplateId: input.templateId,
        reportVersionFingerprint: reportVersionFingerprint(input.reports),
        providerApiVersion: this.apiVersion,
        decisionSource: input.kind === "sanctions"
          ? "persona_watchlist_report" : "persona_owner_discovery_report",
        ...(input.eventAction ? { eventAction: input.eventAction } : {}),
        ...(input.kind === "sanctions" ? {
          hasMatch,
          ongoingMonitoring: input.reports.some((report) => report.continuous === true),
        } : {
          ownerVerification: "required",
        }),
      },
    };
  }

  private async getReportEventResults(
    resultRef: string,
    parsedRef: Extract<PersonaResultReference, { kind: "report" }>,
  ): Promise<readonly ComplianceProviderResult[]> {
    const report = await this.retrieveReport({
      id: parsedRef.reportId,
      type: parsedRef.definition.type,
    });
    if (report.status === "pending") {
      throw new ComplianceProviderError("Persona watchlist report is still pending", 409, true);
    }
    const expectedTemplateId = report.type === "report/watchlist"
      ? this.reportTemplates.individualWatchlist : this.reportTemplates.businessWatchlist;
    if (report.templateId !== expectedTemplateId) {
      throw new Error("Persona watchlist event used an unconfigured report template");
    }
    return [this.reportResult({
      id: resultRef,
      resultRef,
      subjectAccountId: report.subjectAccountId,
      providerSubjectRef: report.accountId,
      kind: "sanctions",
      templateId: expectedTemplateId,
      reports: [report],
      eventAction: parsedRef.definition.action,
    })];
  }

  async getResults(resultRef: string): Promise<readonly ComplianceProviderResult[]> {
    const parsedRef = parsePersonaResultRef(providerText(resultRef, "resultRef"));
    if (parsedRef.kind === "report") {
      return this.getReportEventResults(resultRef, parsedRef);
    }
    const url = new URL(`/api/v1/inquiries/${encodeURIComponent(parsedRef.inquiryId)}`, this.apiOrigin);
    url.searchParams.set(
      "fields[inquiry]",
      "status,reference-id,updated-at,decisioned-at,marked-for-review-at",
    );
    const body = await this.request(url, { method: "GET", headers: this.headers() });
    let value: unknown;
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      throw new ComplianceProviderError("Persona retrieve inquiry returned invalid JSON", 200, false);
    }
    const root = providerRecord(value, "Persona retrieve inquiry response");
    const data = providerRecord(root.data, "Persona inquiry data");
    if (data.type !== "inquiry") throw new Error("Persona returned a non-inquiry resource");
    if (assertPersonaId(data.id, "inq", "inquiry.id") !== parsedRef.inquiryId) {
      throw new Error("Persona returned a different inquiry id");
    }
    const attributes = providerRecord(data.attributes, "inquiry.attributes");
    const subjectAccountId = providerText(attributes["reference-id"], "inquiry.reference-id");
    if (!SUBJECT_ACCOUNT_ID.test(subjectAccountId)) {
      throw new Error("Persona inquiry has an invalid subject reference");
    }
    const accountId = inquiryAccountId(data);
    const templateId = inquiryTemplateId(data);
    const kind: ComplianceProviderResult["kind"] = templateId === this.templates.individual
      ? "identity"
      : templateId === this.templates.business
        ? "business"
        : (() => { throw new Error("Persona inquiry used an unconfigured template"); })();
    const status = providerText(attributes.status, "inquiry.status");
    const decision = classifyInquiryEventStatus(status, parsedRef.eventStatus);
    const observedAt = providerInstant(
      attributes["decisioned-at"] ?? attributes["marked-for-review-at"] ?? attributes["updated-at"],
      "inquiry.decisioned-at",
    );
    if (observedAt.getTime() > this.clock().getTime() + 5 * 60_000) {
      throw new Error("Persona inquiry decision timestamp is in the future");
    }
    const expiresAt = new Date(observedAt.getTime() + this.evidenceTtlDays * 86_400_000);
    const evidenceHash = createHash("sha256")
      .update(resultRef, "utf8").update("\0", "utf8").update(body, "utf8").digest();
    const decisionResult: ComplianceProviderResult = {
      id: resultRef,
      subjectAccountId,
      providerSubjectRef: accountId,
      kind,
      decision,
      evidenceHash,
      listVersion: `persona:${this.apiVersion}:${templateId}`,
      observedAt,
      expiresAt,
      normalized: {
        status,
        eventStatus: parsedRef.eventStatus,
        templateId,
        providerApiVersion: this.apiVersion,
        decisionSource: "persona_inquiry",
      },
    };
    if (decision !== "clear") return [decisionResult];

    const links = inquiryReportLinks(data);
    const watchlistType: PersonaReportType = kind === "identity"
      ? "report/watchlist" : "report/business-watchlist";
    const watchlistTemplateId = kind === "identity"
      ? this.reportTemplates.individualWatchlist : this.reportTemplates.businessWatchlist;
    const reportSets = kind === "business"
      ? await Promise.all([
        this.reportsForTemplate(
          links, watchlistType, watchlistTemplateId, accountId, subjectAccountId,
        ),
        this.reportsForTemplate(
          links,
          "report/business-associated-persons",
          this.reportTemplates.businessAssociatedPersons,
          accountId,
          subjectAccountId,
        ),
      ])
      : [await this.reportsForTemplate(
        links, watchlistType, watchlistTemplateId, accountId, subjectAccountId,
      )];
    const watchlist = reportSets[0]!;
    const results: ComplianceProviderResult[] = [
      decisionResult,
      this.reportResult({
        id: evidenceResultRef(resultRef, "sanctions"),
        resultRef,
        subjectAccountId,
        providerSubjectRef: accountId,
        kind: "sanctions",
        templateId: watchlistTemplateId,
        reports: watchlist,
      }),
    ];
    if (kind === "business") {
      const owners = reportSets[1]!;
      results.push(this.reportResult({
        id: evidenceResultRef(resultRef, "owners"),
        resultRef,
        subjectAccountId,
        providerSubjectRef: accountId,
        kind: "beneficial_owner",
        templateId: this.reportTemplates.businessAssociatedPersons,
        reports: owners,
      }));
    }
    return results;
  }

}

export interface PersonaWebhookCodecOptions {
  endpointId: string;
  secrets: readonly string[];
  toleranceSeconds?: number;
}

/** Verifies Persona's timestamped raw-body HMAC, including overlapping
 * secrets during rotation. Final inquiry decisions and watchlist state
 * changes enter the durable inbox; other signed lifecycle noise is ignored. */
export class PersonaWebhookCodec implements ComplianceWebhookCodec {
  readonly provider = PERSONA_PROVIDER;
  readonly endpointId: string;
  private readonly secrets: readonly string[];
  private readonly toleranceSeconds: number;

  constructor(options: PersonaWebhookCodecOptions) {
    if (!options.endpointId || options.endpointId.length > 255) {
      throw new Error("Persona webhook endpoint id is required");
    }
    if (options.secrets.length < 1 || options.secrets.length > 4
      || options.secrets.some((secret) => secret.length < 16 || secret.length > 512
        || secret.trim() !== secret || /[\r\n]/.test(secret))) {
      throw new Error("one to four Persona webhook secrets are required");
    }
    this.endpointId = options.endpointId;
    this.secrets = Object.freeze([...new Set(options.secrets)]);
    this.toleranceSeconds = boundedInteger(
      options.toleranceSeconds ?? 300, 30, 900, "Persona webhook tolerance",
    );
  }

  authenticate(input: { rawBody: Buffer; headers: Headers; now?: Date }): boolean {
    const header = input.headers.get("persona-signature");
    if (!header || header.length > 2_048) return false;
    const groups = header.trim().split(/\s+/);
    let timestamp: string | undefined;
    const signatures: string[] = [];
    for (const group of groups) {
      const fields = Object.fromEntries(group.split(",").map((part) => {
        const at = part.indexOf("=");
        return at > 0 ? [part.slice(0, at), part.slice(at + 1)] : [part, ""];
      }));
      if (fields.t) {
        if (timestamp && timestamp !== fields.t) return false;
        timestamp = fields.t;
      }
      if (fields.v1 && /^[0-9a-f]{64}$/i.test(fields.v1)) signatures.push(fields.v1.toLowerCase());
    }
    if (!timestamp || !/^\d{10}$/.test(timestamp) || signatures.length < 1) return false;
    const sentAt = Number(timestamp);
    const now = Math.floor((input.now ?? new Date()).getTime() / 1_000);
    if (!Number.isSafeInteger(sentAt) || Math.abs(now - sentAt) > this.toleranceSeconds) return false;
    let matched = false;
    for (const secret of this.secrets) {
      const expected = createHmac("sha256", secret)
        .update(timestamp, "utf8").update(".", "utf8").update(input.rawBody).digest();
      for (const signature of signatures) {
        const presented = Buffer.from(signature, "hex");
        matched = (presented.length === expected.length
          && timingSafeEqual(presented, expected)) || matched;
      }
    }
    return matched;
  }

  parse(value: unknown): ComplianceWebhookEnvelope | null {
    const root = providerRecord(value, "Persona webhook");
    const data = providerRecord(root.data, "Persona webhook.data");
    if (data.type !== "event") throw new Error("Persona webhook resource is not an event");
    const eventId = assertPersonaId(data.id, "evt", "event.id");
    const attributes = providerRecord(data.attributes, "Persona webhook.attributes");
    const name = providerText(attributes.name, "event.name");
    const inquiryEvent = Object.hasOwn(INQUIRY_EVENTS, name) ? INQUIRY_EVENTS[name] : undefined;
    const reportEvent = Object.hasOwn(REPORT_EVENTS, name) ? REPORT_EVENTS[name] : undefined;
    if (!inquiryEvent && !reportEvent) return null;
    const payload = providerRecord(attributes.payload, "event.payload");
    const resource = providerRecord(payload.data, "event.payload.data");
    if (inquiryEvent) {
      if (resource.type !== "inquiry") throw new Error("Persona decision event is not for an inquiry");
      const inquiryId = assertPersonaId(resource.id, "inq", "event.inquiry.id");
      const inquiryAttributes = providerRecord(resource.attributes, "event.inquiry.attributes");
      if (providerText(inquiryAttributes.status, "event.inquiry.status") !== inquiryEvent.status) {
        throw new Error("Persona event name and inquiry status disagree");
      }
      return {
        id: eventId,
        resultRef: personaResultRef(inquiryId, eventId, inquiryEvent.code),
      };
    }
    if (!reportEvent || resource.type !== reportEvent.type) {
      throw new Error("Persona report event name and resource type disagree");
    }
    const reportId = assertPersonaId(resource.id, "rep", "event.report.id");
    const reportAttributes = providerRecord(resource.attributes, "event.report.attributes");
    const reportStatus = providerText(reportAttributes.status, "event.report.status");
    const expectedReportStatus = reportEvent.action === "errored" ? "errored" : "ready";
    if (reportStatus !== expectedReportStatus) {
      throw new Error("Persona report event name and status disagree");
    }
    if (["matched", "dismissed"].includes(reportEvent.action)
      && reportAttributes["has-match"] !== true) {
      throw new Error("Persona report match event is missing its match state");
    }
    return {
      id: eventId,
      resultRef: personaReportResultRef(reportId, eventId, reportEvent.code),
    };
  }
}
