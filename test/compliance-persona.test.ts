import { createHash, createHmac } from "node:crypto";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runComplianceEventBatch } from "../src/compliance/event-worker.ts";
import { runComplianceOnboardingBatch } from "../src/compliance/onboarding-worker.ts";
import {
  PERSONA_API_VERSION,
  PersonaComplianceProvider,
  PersonaWebhookCodec,
} from "../src/compliance/persona.ts";
import {
  createComplianceProviderFromEnv,
  createComplianceWebhookCodecFromEnv,
} from "../src/compliance/runtime.ts";
import { createComplianceSessionKeyring } from "../src/compliance/session-cipher.ts";
import { createComplianceWebhookApp } from "../src/compliance/webhook-server.ts";
import { PostgresCompliance } from "../src/db/compliance.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { runMigrations } from "../src/db/migrate.ts";

const INDIVIDUAL_TEMPLATE = "itmpl_Individual123456";
const BUSINESS_TEMPLATE = "itmpl_Business12345678";
const INDIVIDUAL_WATCHLIST_TEMPLATE = "rptp_IndividualWatchlist123";
const BUSINESS_WATCHLIST_TEMPLATE = "rptp_BusinessWatchlist12345";
const BUSINESS_OWNERS_TEMPLATE = "rptp_BusinessOwners12345678";
const INQUIRY_ID = "inq_A1B2C3D4E5F6G7H8";
const EVENT_ID = "evt_H8G7F6E5D4C3B2A1";
const WATCHLIST_REPORT_ID = "rep_W1A2T3C4H5L6I7S8";
const BUSINESS_WATCHLIST_REPORT_ID = "rep_B1U2S3W4A5T6C7H8";
const BUSINESS_OWNERS_REPORT_ID = "rep_O1W2N3E4R5S6R7P8";
const PERSONA_ACCOUNT_ID = "act_A1C2C3O4U5N6T7I8";
const ENDPOINT_ID = "wbh_PersonaEndpoint123";
const WEBHOOK_SECRET = "wbhsec_persona-fixture-secret";

class EmbeddedPostgres implements TransactionalDatabase {
  constructor(readonly pg: PGliteInterface) {}
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryRows<T>> {
    const result = await this.pg.query<T>(text, [...values]);
    return { rows: result.rows, affectedRows: result.affectedRows };
  }
  async executeScript(text: string) { await this.pg.exec(text); }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (transaction: Transaction) => work({
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ) => {
        const result = await transaction.query<R>(text, [...values]);
        return { rows: result.rows, affectedRows: result.affectedRows };
      },
      executeScript: async (text: string) => { await transaction.exec(text); },
    }));
  }
  async close() { await this.pg.close(); }
}

function personaInquiry(input: {
  subjectId: string;
  templateId?: string;
  status?: string;
  expiresAt?: Date;
  observedAt?: Date;
  hostedUrl?: string;
  reports?: Array<{ type: string; id: string }>;
}) {
  const status = input.status ?? "approved";
  const observedAt = input.observedAt ?? new Date("2026-07-20T11:59:00.000Z");
  return {
    data: {
      type: "inquiry",
      id: INQUIRY_ID,
      attributes: {
        status,
        "reference-id": input.subjectId,
        "updated-at": observedAt.toISOString(),
        ...(status === "needs_review"
          ? { "marked-for-review-at": observedAt.toISOString() }
          : { "decisioned-at": observedAt.toISOString() }),
        "expires-at": (input.expiresAt ?? new Date("2026-07-21T12:00:00.000Z")).toISOString(),
        // Persona can return raw fields; the adapter must never normalize these.
        fields: { "name-first": { type: "string", value: "Sensitive Fixture" } },
      },
      relationships: {
        account: {
          data: { type: "account", id: PERSONA_ACCOUNT_ID },
        },
        "inquiry-template": {
          data: { type: "inquiry-template", id: input.templateId ?? INDIVIDUAL_TEMPLATE },
        },
        reports: {
          data: input.reports ?? [{ type: "report/watchlist", id: WATCHLIST_REPORT_ID }],
        },
      },
    },
    meta: {
      "one-time-link": input.hostedUrl ?? "https://withpersona.com/verify?code=one-time-secret",
    },
  };
}

function personaReport(input: {
  id?: string;
  type?: "report/watchlist" | "report/business-watchlist" | "report/business-associated-persons";
  templateId?: string;
  status?: "pending" | "ready" | "errored";
  hasMatch?: boolean;
  observedAt?: Date;
  continuous?: boolean;
  subjectId?: string;
  accountId?: string;
}) {
  const type = input.type ?? "report/watchlist";
  const status = input.status ?? "ready";
  const observedAt = input.observedAt ?? new Date("2026-07-20T11:58:00.000Z");
  return {
    data: {
      type,
      id: input.id ?? WATCHLIST_REPORT_ID,
      attributes: {
        status,
        "created-at": new Date(observedAt.getTime() - 1_000).toISOString(),
        ...(status === "ready" ? { "completed-at": observedAt.toISOString() } : {}),
        "report-template-version-name": "screening-2026-07",
        ...(type !== "report/business-associated-persons" ? {
          "has-match": input.hasMatch ?? false,
          "is-continuous": input.continuous ?? true,
          // A real response may contain match details. They are hashed and discarded.
          "matched-lists": [{ name: "Sensitive sanctions list fixture" }],
        } : {
          "ownership-information": {
            owners: [{ name: "Sensitive Owner Fixture", birthdate: "1980-05" }],
          },
        }),
      },
      relationships: {
        account: {
          data: { type: "account", id: input.accountId ?? PERSONA_ACCOUNT_ID },
        },
        "report-template": {
          data: {
            type: `report-template/${type.slice("report/".length)}`,
            id: input.templateId ?? INDIVIDUAL_WATCHLIST_TEMPLATE,
          },
        },
      },
    },
    included: [{
      type: "account",
      id: input.accountId ?? PERSONA_ACCOUNT_ID,
      attributes: {
        "reference-id": input.subjectId ?? "usr_personafixture02",
        fields: { name: { value: "Sensitive Account Fixture" } },
      },
    }],
  };
}

function personaReportEvent(
  name: string,
  report: ReturnType<typeof personaReport>,
) {
  return {
    data: {
      type: "event",
      id: EVENT_ID,
      attributes: {
        name,
        "created-at": "2026-07-20T12:00:00.000Z",
        payload: report,
      },
    },
  };
}

function personaEvent(name: string, status: string, includeSensitive = false) {
  return {
    data: {
      type: "event",
      id: EVENT_ID,
      attributes: {
        name,
        "created-at": "2026-07-20T12:00:00.000Z",
        payload: {
          data: {
            type: "inquiry",
            id: INQUIRY_ID,
            attributes: {
              status,
              ...(includeSensitive ? { fields: { "name-first": { value: "Webhook PII" } } } : {}),
            },
          },
        },
      },
    },
  };
}

function personaSignature(body: Buffer, timestamp: number, secret = WEBHOOK_SECRET) {
  return `t=${timestamp},v1=${createHmac("sha256", secret)
    .update(String(timestamp)).update(".").update(body).digest("hex")}`;
}

function provider(options: Partial<ConstructorParameters<typeof PersonaComplianceProvider>[0]> = {}) {
  return new PersonaComplianceProvider({
    apiKey: "persona-sandbox-key",
    individualTemplateId: INDIVIDUAL_TEMPLATE,
    businessTemplateId: BUSINESS_TEMPLATE,
    individualWatchlistReportTemplateId: INDIVIDUAL_WATCHLIST_TEMPLATE,
    businessWatchlistReportTemplateId: BUSINESS_WATCHLIST_TEMPLATE,
    businessAssociatedPersonsReportTemplateId: BUSINESS_OWNERS_TEMPLATE,
    ...options,
  });
}

describe("Persona compliance provider", () => {
  const databases: EmbeddedPostgres[] = [];
  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.close()));
  });

  it("bounds the configured hosted verification origin set", () => {
    expect(() => provider({
      hostedOrigins: Array.from(
        { length: 17 },
        (_, index) => `https://verify-${index}.example`,
      ),
    })).toThrow(/at most 16 origins/);
  });

  it("creates an account-bound, idempotent one-time hosted inquiry using the pinned API", async () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const subjectId = "usr_personafixture01";
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.pathname).toBe("/api/v1/inquiries");
      expect(url.searchParams.get("fields[inquiry]")).toBe("reference-id,expires-at");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer persona-sandbox-key");
      expect(headers.get("persona-version")).toBe(PERSONA_API_VERSION);
      expect(headers.get("key-inflection")).toBe("kebab");
      expect(headers.get("idempotency-key")).toBe(sessionId);
      expect(JSON.parse(String(init?.body))).toEqual({
        data: {
          attributes: { "inquiry-template-id": INDIVIDUAL_TEMPLATE },
        },
        meta: {
          "auto-create-account": true,
          "auto-create-account-reference-id": subjectId,
          "auto-create-one-time-link": true,
          "expiration-after-create-interval-seconds": 86_400,
        },
      });
      return new Response(JSON.stringify(personaInquiry({ subjectId })), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const adapter = provider({ fetch: fetcher, clock: () => now });

    await expect(adapter.createInquiry({
      sessionId,
      subjectAccountId: subjectId,
      subjectType: "individual",
      countryCode: "US",
    })).resolves.toEqual({
      id: INQUIRY_ID,
      hostedUrl: "https://withpersona.com/verify?code=one-time-secret",
      expiresAt: new Date("2026-07-21T12:00:00.000Z"),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refetches sparse identity and watchlist evidence without emitting identity fields", async () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const observedAt = new Date("2026-07-20T11:59:00.000Z");
    const subjectId = "usr_personafixture02";
    const resultRef = `${INQUIRY_ID}:${EVENT_ID}:qa`;
    const responseBody = JSON.stringify(personaInquiry({ subjectId, observedAt }));
    const reportObservedAt = new Date("2026-07-20T11:58:00.000Z");
    const reportBody = JSON.stringify(personaReport({
      observedAt: reportObservedAt,
      subjectId,
    }));
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("persona-version")).toBe(PERSONA_API_VERSION);
      if (url.pathname.includes("/inquiries/")) {
        expect(url.pathname).toBe(`/api/v1/inquiries/${INQUIRY_ID}`);
        expect(url.searchParams.get("fields[inquiry]")).toBe(
          "status,reference-id,updated-at,decisioned-at,marked-for-review-at",
        );
        return new Response(responseBody, { status: 200 });
      }
      expect(url.pathname).toBe(`/api/v1/reports/${WATCHLIST_REPORT_ID}`);
      expect(url.searchParams.get("include")).toBe("account");
      expect(url.searchParams.get("fields[account]")).toBe("reference-id");
      expect(url.searchParams.get("fields[report/watchlist]")).toBe(
        "status,has-match,completed-at,created-at,is-continuous,report-template-version-name",
      );
      return new Response(reportBody, { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = provider({
      fetch: fetcher, clock: () => now, evidenceTtlDays: 30, screeningTtlDays: 14,
    });

    const results = await adapter.getResults(resultRef);
    expect(results[0]).toEqual({
      id: resultRef,
      subjectAccountId: subjectId,
      providerSubjectRef: PERSONA_ACCOUNT_ID,
      kind: "identity",
      decision: "clear",
      evidenceHash: createHash("sha256").update(resultRef).update("\0").update(responseBody).digest(),
      listVersion: `persona:${PERSONA_API_VERSION}:${INDIVIDUAL_TEMPLATE}`,
      observedAt,
      expiresAt: new Date(observedAt.getTime() + 30 * 86_400_000),
      normalized: {
        status: "approved",
        eventStatus: "approved",
        templateId: INDIVIDUAL_TEMPLATE,
        providerApiVersion: PERSONA_API_VERSION,
        decisionSource: "persona_inquiry",
      },
    });
    const versionFingerprint = createHash("sha256")
      .update("screening-2026-07").digest("hex").slice(0, 32);
    expect(results[1]).toEqual({
      id: `${resultRef}:sanctions`,
      subjectAccountId: subjectId,
      providerSubjectRef: PERSONA_ACCOUNT_ID,
      kind: "sanctions",
      decision: "clear",
      evidenceHash: createHash("sha256").update(resultRef)
        .update("\0").update(WATCHLIST_REPORT_ID).update("\0").update(reportBody).digest(),
      listVersion:
        `persona:${PERSONA_API_VERSION}:${INDIVIDUAL_WATCHLIST_TEMPLATE}:${versionFingerprint}`,
      observedAt: reportObservedAt,
      expiresAt: new Date(reportObservedAt.getTime() + 14 * 86_400_000),
      normalized: {
        status: "ready",
        reportType: "report/watchlist",
        reportCount: 1,
        reportTemplateId: INDIVIDUAL_WATCHLIST_TEMPLATE,
        reportVersionFingerprint: versionFingerprint,
        providerApiVersion: PERSONA_API_VERSION,
        decisionSource: "persona_watchlist_report",
        hasMatch: false,
        ongoingMonitoring: true,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(results)).not.toMatch(
      /Sensitive Fixture|Sensitive sanctions list fixture|name-first|matched-lists/i,
    );
  });

  it("authenticates exact timestamped webhook bytes across rotation and ignores non-decisions", () => {
    const oldSecret = "wbhsec_old-persona-secret";
    const codec = new PersonaWebhookCodec({
      endpointId: ENDPOINT_ID,
      secrets: [WEBHOOK_SECRET, oldSecret],
      toleranceSeconds: 300,
    });
    const now = new Date("2026-07-20T12:00:00.000Z");
    const timestamp = Math.floor(now.getTime() / 1_000);
    const body = Buffer.from(JSON.stringify(personaEvent("inquiry.approved", "approved")));
    const oldSignature = personaSignature(body, timestamp, oldSecret);
    const currentSignature = personaSignature(body, timestamp);
    const headers = new Headers({
      "persona-signature": `${oldSignature} ${currentSignature}`,
    });

    expect(codec.authenticate({ rawBody: body, headers, now })).toBe(true);
    expect(codec.authenticate({ rawBody: Buffer.concat([body, Buffer.from(" ")]), headers, now })).toBe(false);
    expect(codec.authenticate({
      rawBody: body,
      headers,
      now: new Date(now.getTime() + 301_000),
    })).toBe(false);
    expect(codec.parse(JSON.parse(body.toString("utf8")) as unknown)).toEqual({
      id: EVENT_ID,
      resultRef: `${INQUIRY_ID}:${EVENT_ID}:qa`,
    });
    expect(codec.parse(personaEvent("inquiry.declined", "declined"))).toEqual({
      id: EVENT_ID,
      resultRef: `${INQUIRY_ID}:${EVENT_ID}:qd`,
    });
    expect(codec.parse(personaEvent("inquiry.marked-for-review", "needs_review"))).toEqual({
      id: EVENT_ID,
      resultRef: `${INQUIRY_ID}:${EVENT_ID}:qr`,
    });
    expect(codec.parse(personaEvent("inquiry.completed", "completed"))).toBeNull();
    expect(() => codec.parse(personaEvent("inquiry.approved", "declined"))).toThrow(/disagree/);
    expect(codec.parse(personaReportEvent(
      "report/watchlist.matched",
      personaReport({ hasMatch: true }),
    ))).toEqual({
      id: EVENT_ID,
      resultRef: `${WATCHLIST_REPORT_ID}:${EVENT_ID}:im`,
    });
  });

  it("re-fetches continuous watchlist matches with an included sparse Persona account", async () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const subjectId = "usr_personacontinuous01";
    const resultRef = `${WATCHLIST_REPORT_ID}:${EVENT_ID}:im`;
    const reportBody = JSON.stringify(personaReport({ hasMatch: true, subjectId }));
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.pathname).toBe(`/api/v1/reports/${WATCHLIST_REPORT_ID}`);
      expect(url.searchParams.get("include")).toBe("account");
      expect(url.searchParams.get("fields[account]")).toBe("reference-id");
      const reportFields = url.searchParams.get("fields[report/watchlist]")?.split(",");
      expect(reportFields).not.toContain("matched-lists");
      expect(reportFields).not.toContain("query");
      expect(reportFields).not.toContain("account");
      expect(reportFields).not.toContain("report-template");
      return new Response(reportBody, { status: 200 });
    }) as unknown as typeof fetch;

    const results = await provider({ fetch: fetcher, clock: () => now }).getResults(resultRef);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({
      id: resultRef,
      subjectAccountId: subjectId,
      providerSubjectRef: PERSONA_ACCOUNT_ID,
      kind: "sanctions",
      decision: "review",
      evidenceHash: createHash("sha256").update(resultRef)
        .update("\0").update(WATCHLIST_REPORT_ID).update("\0").update(reportBody).digest(),
      normalized: expect.objectContaining({
        hasMatch: true,
        eventAction: "matched",
        decisionSource: "persona_watchlist_report",
      }),
    }));
    expect(JSON.stringify(results)).not.toMatch(
      /Sensitive sanctions list fixture|Sensitive Account Fixture|matched-lists|fields/i,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never lets a later no-match report clear a safety-significant report event", async () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const reportBody = JSON.stringify(personaReport({
      hasMatch: false,
      subjectId: "usr_personamonotonic01",
    }));
    const fetcher = vi.fn(async () => new Response(reportBody, { status: 200 })) as unknown as typeof fetch;
    const adapter = provider({ fetch: fetcher, clock: () => now });

    const matched = await adapter.getResults(`${WATCHLIST_REPORT_ID}:${EVENT_ID}:im`);
    const dismissed = await adapter.getResults(`${WATCHLIST_REPORT_ID}:${EVENT_ID}:id`);
    const errored = await adapter.getResults(`${WATCHLIST_REPORT_ID}:${EVENT_ID}:ie`);

    expect(matched[0]).toEqual(expect.objectContaining({
      decision: "review",
      normalized: expect.objectContaining({ eventAction: "matched", hasMatch: false }),
    }));
    expect(dismissed[0]).toEqual(expect.objectContaining({
      decision: "review",
      normalized: expect.objectContaining({ eventAction: "dismissed", hasMatch: false }),
    }));
    expect(errored[0]).toEqual(expect.objectContaining({
      decision: "error",
      normalized: expect.objectContaining({ eventAction: "errored", status: "errored" }),
    }));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("never lets a later inquiry state weaken an authenticated safety decision", async () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const subjectId = "usr_personainquiryorder01";
    const approvedBody = JSON.stringify(personaInquiry({ subjectId, status: "approved" }));
    const safetyFetcher = vi.fn(async () => new Response(approvedBody, { status: 200 })) as unknown as typeof fetch;
    const adapter = provider({ fetch: safetyFetcher, clock: () => now });

    await expect(adapter.getResults(`${INQUIRY_ID}:${EVENT_ID}:qd`)).resolves.toEqual([
      expect.objectContaining({
        decision: "blocked",
        normalized: expect.objectContaining({ status: "approved", eventStatus: "declined" }),
      }),
    ]);
    await expect(adapter.getResults(`${INQUIRY_ID}:${EVENT_ID}:qr`)).resolves.toEqual([
      expect.objectContaining({
        decision: "review",
        normalized: expect.objectContaining({ status: "approved", eventStatus: "needs_review" }),
      }),
    ]);
    await expect(adapter.getResults(`${INQUIRY_ID}:${EVENT_ID}`)).resolves.toEqual([
      expect.objectContaining({
        decision: "review",
        normalized: expect.objectContaining({ status: "approved", eventStatus: "needs_review" }),
      }),
    ]);
    expect(safetyFetcher).toHaveBeenCalledTimes(3);

    const declinedFetcher = vi.fn(async () => new Response(JSON.stringify(personaInquiry({
      subjectId,
      status: "declined",
    })), { status: 200 })) as unknown as typeof fetch;
    await expect(provider({ fetch: declinedFetcher, clock: () => now })
      .getResults(`${INQUIRY_ID}:${EVENT_ID}:qa`)).resolves.toEqual([
      expect.objectContaining({
        decision: "blocked",
        normalized: expect.objectContaining({ status: "declined", eventStatus: "approved" }),
      }),
    ]);
  });

  it("fails closed when a report account reference disagrees with its inquiry", async () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const subjectId = "usr_personabinding01";
    const resultRef = `${INQUIRY_ID}:${EVENT_ID}:qa`;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.includes("/inquiries/")) {
        return new Response(JSON.stringify(personaInquiry({ subjectId })), { status: 200 });
      }
      return new Response(JSON.stringify(personaReport({
        subjectId: "usr_personadifferent01",
      })), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(provider({ fetch: fetcher, clock: () => now }).getResults(resultRef))
      .rejects.toThrow(/bound to a different inquiry account/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("records business owner discovery as review evidence instead of claiming UBO verification", async () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const subjectId = "usr_personabusiness01";
    const resultRef = `${INQUIRY_ID}:${EVENT_ID}:qa`;
    const inquiry = personaInquiry({
      subjectId,
      templateId: BUSINESS_TEMPLATE,
      reports: [
        { type: "report/business-watchlist", id: BUSINESS_WATCHLIST_REPORT_ID },
        { type: "report/business-associated-persons", id: BUSINESS_OWNERS_REPORT_ID },
      ],
    });
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.includes("/inquiries/")) {
        return new Response(JSON.stringify(inquiry), { status: 200 });
      }
      if (url.pathname.endsWith(BUSINESS_WATCHLIST_REPORT_ID)) {
        return new Response(JSON.stringify(personaReport({
          id: BUSINESS_WATCHLIST_REPORT_ID,
          type: "report/business-watchlist",
          templateId: BUSINESS_WATCHLIST_TEMPLATE,
          subjectId,
        })), { status: 200 });
      }
      expect(url.searchParams.get("include")).toBe("account");
      expect(url.searchParams.get("fields[account]")).toBe("reference-id");
      const reportFields = url.searchParams
        .get("fields[report/business-associated-persons]")?.split(",");
      expect(reportFields).not.toContain("account");
      expect(reportFields).not.toContain("report-template");
      return new Response(JSON.stringify(personaReport({
        id: BUSINESS_OWNERS_REPORT_ID,
        type: "report/business-associated-persons",
        templateId: BUSINESS_OWNERS_TEMPLATE,
        subjectId,
      })), { status: 200 });
    }) as unknown as typeof fetch;

    const results = await provider({ fetch: fetcher, clock: () => now }).getResults(resultRef);
    expect(results.map(({ kind, decision }) => ({ kind, decision }))).toEqual([
      { kind: "business", decision: "clear" },
      { kind: "sanctions", decision: "clear" },
      { kind: "beneficial_owner", decision: "review" },
    ]);
    expect(results[2]?.normalized).toEqual(expect.objectContaining({
      decisionSource: "persona_owner_discovery_report",
      ownerVerification: "required",
    }));
    expect(JSON.stringify(results)).not.toMatch(/Sensitive Owner Fixture|birthdate/i);
  });

  it("selects Persona only through its certified production configuration", () => {
    const env = {
      NODE_ENV: "production",
      MONEY_COMPLIANCE_PROVIDER: "persona",
      MONEY_COMPLIANCE_PROVIDER_API_KEY: "persona-key",
      MONEY_PERSONA_API_VERSION: PERSONA_API_VERSION,
      MONEY_PERSONA_INDIVIDUAL_TEMPLATE_ID: INDIVIDUAL_TEMPLATE,
      MONEY_PERSONA_BUSINESS_TEMPLATE_ID: BUSINESS_TEMPLATE,
      MONEY_PERSONA_INDIVIDUAL_WATCHLIST_REPORT_TEMPLATE_ID: INDIVIDUAL_WATCHLIST_TEMPLATE,
      MONEY_PERSONA_BUSINESS_WATCHLIST_REPORT_TEMPLATE_ID: BUSINESS_WATCHLIST_TEMPLATE,
      MONEY_PERSONA_BUSINESS_ASSOCIATED_PERSONS_REPORT_TEMPLATE_ID: BUSINESS_OWNERS_TEMPLATE,
      MONEY_COMPLIANCE_WEBHOOK_ENDPOINT_ID: ENDPOINT_ID,
      MONEY_COMPLIANCE_WEBHOOK_SECRETS: JSON.stringify([
        "new-persona-webhook-secret", "old-persona-webhook-secret",
      ]),
    };
    expect(createComplianceProviderFromEnv(env)).toBeInstanceOf(PersonaComplianceProvider);
    expect(createComplianceWebhookCodecFromEnv(env)).toBeInstanceOf(PersonaWebhookCodec);
    expect(() => createComplianceProviderFromEnv({
      ...env,
      MONEY_PERSONA_API_VERSION: "2099-01-01",
    })).toThrow(/certified only/);
    expect(() => createComplianceProviderFromEnv({
      ...env,
      MONEY_PERSONA_BUSINESS_TEMPLATE_ID: undefined,
    })).toThrow(/MONEY_PERSONA_BUSINESS_TEMPLATE_ID/);
    expect(() => createComplianceProviderFromEnv({
      ...env,
      MONEY_PERSONA_INDIVIDUAL_WATCHLIST_REPORT_TEMPLATE_ID: undefined,
    })).toThrow(/MONEY_PERSONA_INDIVIDUAL_WATCHLIST_REPORT_TEMPLATE_ID/);
    expect(() => createComplianceWebhookCodecFromEnv({
      ...env,
      MONEY_COMPLIANCE_WEBHOOK_SECRETS: JSON.stringify([" padded-webhook-secret "]),
    })).toThrow(/WEBHOOK_SECRETS/);
  });

  it("runs hosted onboarding and signed decision ingestion end to end without persisting Persona PII", async () => {
    const db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    databases.push(db);
    await runMigrations(db);
    const compliance = new PostgresCompliance(db);
    const ledger = new PostgresLedger(db);
    const subjectId = "usr_personaowner01";
    await ledger.registerAccount({ id: subjectId, kind: "user", name: "Persona owner" });
    await compliance.beginVerification({
      userId: subjectId,
      subjectType: "individual",
      countryCode: "US",
      expectedSingleMicros: 1_000_000n,
      expectedMonthlyMicros: 10_000_000n,
    });
    const session = await compliance.requestVerificationSession({
      userId: subjectId,
      provider: "persona",
      idempotencyKey: "persona-hosted-session-001",
    });
    const now = new Date();
    const observedAt = new Date(now.getTime() - 1_000);
    const expiresAt = new Date(now.getTime() + 86_400_000);
    let activeReportAccountId = PERSONA_ACCOUNT_ID;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (init?.method === "POST") {
        return new Response(JSON.stringify(personaInquiry({
          subjectId,
          expiresAt,
          hostedUrl: "https://withpersona.com/verify?code=database-secret",
        })), { status: 201 });
      }
      if (url.pathname.includes("/inquiries/")) {
        expect(url.pathname).toBe(`/api/v1/inquiries/${INQUIRY_ID}`);
        return new Response(JSON.stringify(personaInquiry({ subjectId, observedAt })), { status: 200 });
      }
      expect(url.pathname).toBe(`/api/v1/reports/${WATCHLIST_REPORT_ID}`);
      return new Response(JSON.stringify(personaReport({
        observedAt,
        subjectId,
        accountId: activeReportAccountId,
      })), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = provider({ fetch: fetcher, clock: () => now });
    const keyring = createComplianceSessionKeyring("persona-url-key", {
      "persona-url-key": Buffer.alloc(32, 19),
    });

    expect(await runComplianceOnboardingBatch(
      compliance, adapter, keyring, "persona-onboarding-worker", 10,
    )).toEqual({ claimed: 1, completed: 1, failed: 0, expired: 0 });
    expect(await compliance.verificationSession(subjectId, session.id)).toEqual(
      expect.objectContaining({ state: "ready" }),
    );
    expect((await db.query<{ provider_inquiry_ref: string }>(
      "select provider_inquiry_ref from money.compliance_verification_sessions where id = $1",
      [session.id],
    )).rows[0]?.provider_inquiry_ref).toBe(INQUIRY_ID);

    const codec = new PersonaWebhookCodec({ endpointId: ENDPOINT_ID, secrets: [WEBHOOK_SECRET] });
    const app = createComplianceWebhookApp(compliance, { codec });
    const eventBody = Buffer.from(JSON.stringify(
      personaEvent("inquiry.approved", "approved", true),
    ));
    const timestamp = Math.floor(Date.now() / 1_000);
    const accepted = await app.request("/webhooks/compliance", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "persona-signature": personaSignature(eventBody, timestamp),
      },
      body: eventBody,
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ accepted: true, replayed: false });
    const eventBatch = await runComplianceEventBatch(
      compliance, adapter, "persona-evidence-worker", 10,
    );
    const eventFailure = await db.query<{ last_error: string | null }>(`
      select last_error from money.compliance_event_inbox
      where provider_event_id = $1
    `, [EVENT_ID]);
    expect(eventBatch, eventFailure.rows[0]?.last_error ?? "Persona evidence event failed")
      .toEqual({ claimed: 1, completed: 1, failed: 0 });

    const stored = await db.query<{
      kind: string;
      provider_result_ref: string;
      decision: string;
      normalized: Record<string, unknown>;
    }>(`
      select e.kind, e.provider_result_ref, e.decision, e.normalized
      from money.compliance_evidence e
      order by e.kind
    `);
    expect(stored.rows).toEqual([
      {
        kind: "identity",
        provider_result_ref: `${INQUIRY_ID}:${EVENT_ID}:qa`,
        decision: "clear",
        normalized: {
          status: "approved",
          eventStatus: "approved",
          templateId: INDIVIDUAL_TEMPLATE,
          providerApiVersion: PERSONA_API_VERSION,
          decisionSource: "persona_inquiry",
        },
      },
      {
        kind: "sanctions",
        provider_result_ref: `${INQUIRY_ID}:${EVENT_ID}:qa:sanctions`,
        decision: "clear",
        normalized: expect.objectContaining({
          status: "ready",
          reportType: "report/watchlist",
          reportTemplateId: INDIVIDUAL_WATCHLIST_TEMPLATE,
          hasMatch: false,
        }),
      },
    ]);
    expect((await db.query<{ delivery_hash_bytes: number; evidence_id: string }>(`
      select octet_length(delivery_hash)::integer as delivery_hash_bytes, evidence_id
      from money.compliance_event_inbox
    `)).rows).toEqual([{ delivery_hash_bytes: 32, evidence_id: expect.any(String) }]);
    expect((await db.query<{
      ordinal: number;
      kind: string;
      provider_subject_ref: string | null;
    }>(`
      select link.ordinal::integer as ordinal, evidence.kind, link.provider_subject_ref
      from money.compliance_event_evidence link
      join money.compliance_evidence evidence on evidence.id = link.evidence_id
      order by link.ordinal
    `)).rows).toEqual([
      { ordinal: 1, kind: "identity", provider_subject_ref: PERSONA_ACCOUNT_ID },
      { ordinal: 2, kind: "sanctions", provider_subject_ref: PERSONA_ACCOUNT_ID },
    ]);
    expect((await db.query<{ provider: string; provider_subject_ref: string }>(`
      select provider, provider_subject_ref
      from money.compliance_subjects
      where account_id = $1
    `, [subjectId])).rows).toEqual([{
      provider: "persona",
      provider_subject_ref: PERSONA_ACCOUNT_ID,
    }]);
    expect(await compliance.state(subjectId)).toEqual(expect.objectContaining({
      state: "pending",
      screeningState: "clear",
      identityExpiresAt: expect.any(Date),
      screeningExpiresAt: expect.any(Date),
    }));

    const mismatchedEventId = "evt_AccountMismatch123456";
    activeReportAccountId = "act_DifferentAccount123456";
    await compliance.enqueueEvent({
      provider: "persona",
      providerEventId: mismatchedEventId,
      providerResultRef: `${WATCHLIST_REPORT_ID}:${mismatchedEventId}:ir`,
      endpointId: ENDPOINT_ID,
      deliveryHash: createHash("sha256").update("persona-account-mismatch").digest(),
    });
    expect(await runComplianceEventBatch(
      compliance, adapter, "persona-evidence-worker", 10,
    )).toEqual({ claimed: 1, completed: 0, failed: 1 });
    expect((await db.query<{ state: string; last_error: string }>(`
      select state, last_error
      from money.compliance_event_inbox
      where provider_event_id = $1
    `, [mismatchedEventId])).rows).toEqual([{
      state: "dead",
      last_error: expect.stringContaining("provider subject"),
    }]);
    expect((await db.query<{ count: number }>(
      "select count(*)::integer as count from money.compliance_evidence",
    )).rows).toEqual([{ count: 2 }]);
    expect(await compliance.state(subjectId)).toEqual(expect.objectContaining({
      screeningState: "clear",
    }));
    expect(JSON.stringify(stored.rows)).not.toMatch(/Webhook PII|Sensitive Fixture|name-first/i);
  }, 30_000);
});
