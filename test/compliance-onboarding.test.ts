import { createHash } from "node:crypto";
import { PGlite, type PGliteInterface, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runComplianceOnboardingBatch } from "../src/compliance/onboarding-worker.ts";
import { ComplianceProviderClient } from "../src/compliance/provider.ts";
import {
  createComplianceSessionKeyring,
  decryptHostedVerificationUrl,
} from "../src/compliance/session-cipher.ts";
import { PostgresCompliance } from "../src/db/compliance.ts";
import type { QueryRows, SqlExecutor, TransactionalDatabase } from "../src/db/database.ts";
import { PostgresLedger } from "../src/db/ledger.ts";
import { runMigrations } from "../src/db/migrate.ts";

class EmbeddedPostgres implements TransactionalDatabase {
  constructor(readonly pg: PGliteInterface) {}
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string, values: readonly unknown[] = [],
  ): Promise<QueryRows<T>> {
    const result = await this.pg.query<T>(text, [...values]);
    return { rows: result.rows, affectedRows: result.affectedRows };
  }
  async executeScript(text: string) { await this.pg.exec(text); }
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (transaction: Transaction) => work({
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(
        text: string, values: readonly unknown[] = [],
      ) => {
        const result = await transaction.query<R>(text, [...values]);
        return { rows: result.rows, affectedRows: result.affectedRows };
      },
      executeScript: async (text: string) => { await transaction.exec(text); },
    }));
  }
  async close() { await this.pg.close(); }
}

const KEYRING = createComplianceSessionKeyring("onboarding-2026-07", {
  "onboarding-2026-07": Buffer.alloc(32, 7),
});

describe("hosted compliance onboarding", () => {
  let db: EmbeddedPostgres;
  let compliance: PostgresCompliance;
  let ledger: PostgresLedger;

  beforeEach(async () => {
    db = new EmbeddedPostgres(new PGlite({ extensions: { pgcrypto } }));
    await runMigrations(db);
    compliance = new PostgresCompliance(db);
    ledger = new PostgresLedger(db);
  }, 30_000);

  afterEach(async () => { await db.close(); });

  async function pendingOwner(id = "usr_hostedowner01") {
    await ledger.registerAccount({ id, kind: "user", name: "Hosted owner" });
    await compliance.beginVerification({
      userId: id,
      subjectType: "individual",
      countryCode: "US",
      expectedSingleMicros: 2_000_000n,
      expectedMonthlyMicros: 20_000_000n,
    });
    return id;
  }

  it("coalesces retries, creates one provider inquiry, and stores only ciphertext", async () => {
    const userId = await pendingOwner();
    const first = await compliance.requestVerificationSession({
      userId, provider: "fixture", idempotencyKey: "hosted-session-0001",
    });
    expect(first).toEqual(expect.objectContaining({ state: "requested", replayed: false }));
    expect((await compliance.requestVerificationSession({
      userId, provider: "fixture", idempotencyKey: "hosted-session-0001",
    }))).toEqual(expect.objectContaining({ id: first.id, replayed: true }));
    expect((await compliance.requestVerificationSession({
      userId, provider: "fixture", idempotencyKey: "different-active-key",
    }))).toEqual(expect.objectContaining({ id: first.id, replayed: true }));

    const expiresAt = new Date(Date.now() + 30 * 60_000);
    const hostedUrl = `https://verify.example/session/${first.id}?token=opaque-secret`;
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer provider-secret");
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(first.id);
      expect(JSON.parse(String(init?.body))).toEqual({
        idempotencyKey: first.id,
        subjectAccountId: userId,
        subjectType: "individual",
        countryCode: "US",
      });
      return new Response(JSON.stringify({
        id: "inq_fixture_001", hostedUrl, expiresAt: expiresAt.toISOString(),
      }), { status: 201, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const provider = new ComplianceProviderClient({
      provider: "fixture",
      apiKey: "provider-secret",
      baseUrl: "https://api.provider.example",
      hostedOrigins: ["https://verify.example"],
      fetch: fetcher,
    });

    expect(await runComplianceOnboardingBatch(
      compliance, provider, KEYRING, "worker-hosted", 10,
    )).toEqual({ claimed: 1, completed: 1, failed: 0, expired: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await runComplianceOnboardingBatch(
      compliance, provider, KEYRING, "worker-hosted", 10,
    )).toEqual({ claimed: 0, completed: 0, failed: 0, expired: 0 });

    const ready = await compliance.verificationSession(userId, first.id);
    expect(ready).toEqual(expect.objectContaining({
      state: "ready", encryptionKeyId: "onboarding-2026-07",
      hostedUrlCiphertext: expect.any(Buffer), hostedUrlHash: expect.any(Buffer),
    }));
    expect(ready!.hostedUrlCiphertext!.includes(Buffer.from("opaque-secret"))).toBe(false);
    expect(ready!.hostedUrlHash!.equals(createHash("sha256").update(hostedUrl).digest())).toBe(true);
    expect(decryptHostedVerificationUrl(
      ready!.hostedUrlCiphertext!, KEYRING,
      { sessionId: first.id, subjectAccountId: userId, provider: "fixture", expiresAt },
      ready!.encryptionKeyId,
    ).plaintext).toBe(hostedUrl);
    expect(() => decryptHostedVerificationUrl(
      ready!.hostedUrlCiphertext!, KEYRING,
      { sessionId: first.id, subjectAccountId: "usr_differentowner", provider: "fixture", expiresAt },
      ready!.encryptionKeyId,
    )).toThrow();
    expect((await db.query<{ provider_inquiry_ref: string; plaintext_present: boolean }>(`
      select provider_inquiry_ref,
        position(convert_to('opaque-secret','utf8') in hosted_url_ciphertext) > 0 as plaintext_present
      from money.compliance_verification_sessions where id = $1
    `, [first.id])).rows[0]).toEqual({
      provider_inquiry_ref: "inq_fixture_001", plaintext_present: false,
    });
  });

  it("dead-letters an inquiry when the provider returns an untrusted redirect", async () => {
    const userId = await pendingOwner("usr_hostedowner02");
    const session = await compliance.requestVerificationSession({
      userId, provider: "fixture", idempotencyKey: "hosted-session-0002",
    });
    const provider = new ComplianceProviderClient({
      provider: "fixture", apiKey: "provider-secret",
      baseUrl: "https://api.provider.example",
      hostedOrigins: ["https://verify.example"],
      fetch: (async () => new Response(JSON.stringify({
        id: "inq_bad_redirect",
        hostedUrl: "https://phishing.example/collect",
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }), { status: 201 })) as typeof fetch,
    });
    expect(await runComplianceOnboardingBatch(
      compliance, provider, KEYRING, "worker-hosted", 1,
    )).toEqual({ claimed: 1, completed: 0, failed: 1, expired: 0 });
    expect(await compliance.verificationSession(userId, session.id)).toEqual(
      expect.objectContaining({ state: "failed" }),
    );
    const stored = await db.query<{
      provider_inquiry_ref: string | null;
      hosted_url_ciphertext: Uint8Array | null;
      last_error: string;
    }>(`select provider_inquiry_ref, hosted_url_ciphertext, last_error
        from money.compliance_verification_sessions where id = $1`, [session.id]);
    expect(stored.rows[0]).toEqual({
      provider_inquiry_ref: null,
      hosted_url_ciphertext: null,
      last_error: expect.stringContaining("untrusted hosted URL"),
    });
  });
});
