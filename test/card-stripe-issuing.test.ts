import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CardIssuerApiError, ISSUER_API_VERSION } from "../src/cards/issuer.ts";
import { MockIssuer } from "../src/cards/mock-issuer.ts";
import { createCardIssuerFromEnv } from "../src/cards/runtime.ts";
import { StripeIssuingClient } from "../src/cards/stripe-issuing.ts";

/** All Stripe traffic in this suite is recorded fixture JSON served through a
 * stubbed fetch; the live sandbox is never called. The fixtures are recorded
 * from documentation — see test/fixtures/stripe-issuing/README.md for the
 * fields that must be re-verified against live test mode. */

const PAN_PATTERN = /\d{13,19}/;
const CARD_ID = "7b1c9c4e-3f2a-4d1b-9e5f-1a2b3c4d5e6f";
const CARDHOLDER_ID = "ich_1QfFixtureCardholder001";
const CARD_REF = "ic_1QfFixture0000000000001";
const AUTHORIZATION_REF = "iauth_1QfFixture000000000001";
const TRANSACTION_REF = "ipi_1QfFixture0000000000001";
const EVENT_ID = "evt_1QfFixture0000000000001";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/stripe-issuing/${name}`, import.meta.url), "utf8");
}

function json(name: string, status = 200): Response {
  return new Response(fixture(name), { status, headers: { "content-type": "application/json" } });
}

function stub(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function apiClient(fetcher: typeof fetch): StripeIssuingClient {
  return new StripeIssuingClient({
    apiKey: "sk_test_fixture_secret_key",
    role: "api",
    cardholderId: CARDHOLDER_ID,
    baseUrl: "https://stripe.test",
    fetch: fetcher,
  });
}

function workerClient(fetcher: typeof fetch): StripeIssuingClient {
  return new StripeIssuingClient({
    apiKey: "rk_test_fixture_event_key",
    role: "worker",
    baseUrl: "https://stripe.test",
    fetch: fetcher,
  });
}

function createInput() {
  return {
    cardId: CARD_ID,
    capMicros: 29_000_000n,
    expiresAt: new Date("2026-08-24T10:00:00.000Z"),
    merchantHint: "mock-shop.example",
    singleUse: true,
    agentId: "agent:demo-buyer",
    ownerId: "user:owner-1",
  };
}

describe("Stripe Issuing client", () => {
  it("rejects ambiguous privileged configuration before any request", () => {
    expect(() => new StripeIssuingClient({
      apiKey: "sk_test_fixture_secret_key", role: "api", cardholderId: CARDHOLDER_ID,
      baseUrl: "http://stripe.test",
    })).toThrow(/HTTPS/);
    expect(() => new StripeIssuingClient({
      apiKey: "sk_test_fixture_secret_key", role: "api", cardholderId: CARDHOLDER_ID,
      baseUrl: "https://stripe.test/v1",
    })).toThrow(/bare origin/);
    expect(() => new StripeIssuingClient({
      apiKey: " padded-key ", role: "api", cardholderId: CARDHOLDER_ID,
      baseUrl: "https://stripe.test",
    })).toThrow(/API key/);
    expect(() => new StripeIssuingClient({
      apiKey: "sk_test_fixture_secret_key", role: "api", baseUrl: "https://stripe.test",
    })).toThrow(/cardholder/);
    expect(() => new StripeIssuingClient({
      apiKey: "rk_test_fixture_event_key", role: "worker", cardholderId: CARDHOLDER_ID,
      baseUrl: "https://stripe.test",
    })).toThrow(/must not carry a cardholder/);
  });

  it("creates a card with the exact form contract, pinned version, and card-id idempotency", async () => {
    const { fetcher, calls } = stub(() => json("card-created.json"));
    const material = await apiClient(fetcher).createCard(createInput());
    expect(material).toEqual({ providerCardRef: CARD_REF, last4: "4242", expMonth: 8, expYear: 2029 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.href).toBe("https://stripe.test/v1/issuing/cards");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.redirect).toBe("error");
    const headers = new Headers(calls[0]!.init?.headers as Record<string, string>);
    expect(headers.get("authorization")).toBe("Bearer sk_test_fixture_secret_key");
    expect(headers.get("idempotency-key")).toBe(CARD_ID);
    expect(headers.get("stripe-version")).toBe(ISSUER_API_VERSION);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");

    const body = new URLSearchParams(String(calls[0]!.init?.body));
    expect(Object.fromEntries(body)).toEqual({
      cardholder: CARDHOLDER_ID,
      currency: "usd",
      type: "virtual",
      status: "active",
      "spending_controls[spending_limits][0][amount]": "2900",
      "spending_controls[spending_limits][0][interval]": "per_authorization",
      "metadata[agentmoney_card]": CARD_ID,
      "metadata[agentmoney_agent]": "agent:demo-buyer",
    });
    // Addendum 12: single-use must not be sent as an unverified Stripe
    // lifecycle parameter; the decline ladder and per_authorization limit
    // enforce it.
    expect(String(calls[0]!.init?.body)).not.toContain("lifecycle_controls");
  });

  it("rejects card-creation response drift and non-whole-cent caps", async () => {
    const drifted = JSON.parse(fixture("card-created.json")) as Record<string, unknown>;
    (drifted.metadata as Record<string, unknown>).agentmoney_card = "someone-elses-card";
    const { fetcher } = stub(() => new Response(JSON.stringify(drifted), { status: 200 }));
    await expect(apiClient(fetcher).createCard(createInput()))
      .rejects.toThrow(/does not match the requested card terms/);

    const { fetcher: fractional, calls } = stub(() => json("card-created.json"));
    await expect(apiClient(fractional).createCard({ ...createInput(), capMicros: 29_000_001n }))
      .rejects.toThrow(/whole number of cents/);
    expect(calls).toHaveLength(0);
  });

  it("refuses card creation and reveal with the worker-role credential", async () => {
    const { fetcher, calls } = stub(() => json("card-created.json"));
    const worker = workerClient(fetcher);
    await expect(worker.createCard(createInput())).rejects.toMatchObject({
      name: "CardIssuerApiError", status: 403, retryable: false,
    });
    await expect(worker.revealCard(CARD_REF)).rejects.toMatchObject({
      name: "CardIssuerApiError", status: 403, retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  it("reveals with expand[]=number and expand[]=cvc to the api role only", async () => {
    const { fetcher, calls } = stub(() => json("card-revealed.json"));
    const secrets = await apiClient(fetcher).revealCard(CARD_REF);
    expect(secrets).toEqual({ pan: "4242424242424242", cvc: "123", expMonth: 8, expYear: 2029 });
    expect(calls[0]!.url.pathname).toBe(`/v1/issuing/cards/${CARD_REF}`);
    expect(calls[0]!.url.search).toBe("?expand%5B%5D=number&expand%5B%5D=cvc");
  });

  it("never places reveal response bytes into a thrown error", async () => {
    const leakyBody = JSON.stringify({
      error: { message: "card 4242424242424242 not available", type: "invalid_request_error" },
    });
    const { fetcher } = stub(() => new Response(leakyBody, { status: 402 }));
    const failure = await apiClient(fetcher).revealCard(CARD_REF).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CardIssuerApiError);
    expect((failure as CardIssuerApiError).responseBody).toBeUndefined();
    expect((failure as CardIssuerApiError).message).not.toMatch(PAN_PATTERN);

    // A canceled or otherwise non-active card is refused without echoing any
    // response field.
    const { fetcher: canceled } = stub(() => json("card-canceled.json"));
    const inactive = await apiClient(canceled).revealCard(CARD_REF).catch((error: unknown) => error);
    expect(inactive).toBeInstanceOf(CardIssuerApiError);
    expect((inactive as CardIssuerApiError).message).not.toMatch(PAN_PATTERN);
    expect((inactive as CardIssuerApiError).responseBody).toBeUndefined();
  });

  it("cancels a card and verifies the canceled response", async () => {
    const { fetcher, calls } = stub(() => json("card-canceled.json"));
    await workerClient(fetcher).closeCard(CARD_REF);
    expect(calls[0]!.url.pathname).toBe(`/v1/issuing/cards/${CARD_REF}`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(String(calls[0]!.init?.body)).toBe("status=canceled");
    const headers = new Headers(calls[0]!.init?.headers as Record<string, string>);
    expect(headers.get("authorization")).toBe("Bearer rk_test_fixture_event_key");

    const { fetcher: stillActive } = stub(() => json("card-created.json"));
    await expect(workerClient(stillActive).closeCard(CARD_REF)).rejects.toThrow(/did not cancel/);
    const { fetcher: wrongCard } = stub(() => json("card-canceled.json"));
    await expect(workerClient(wrongCard).closeCard("ic_1QfSomeOtherCard0000001"))
      .rejects.toThrow(/different card id/);
  });

  it("fetches and binds events, authorizations, and transactions to the requested id", async () => {
    const { fetcher, calls } = stub((url) => {
      if (url.pathname.startsWith("/v1/events/")) return json("event-authorization-created.json");
      if (url.pathname.startsWith("/v1/issuing/authorizations/")) return json("authorization.json");
      return json("transaction-capture.json");
    });
    const worker = workerClient(fetcher);

    const event = await worker.getEvent(EVENT_ID);
    expect(event.id).toBe(EVENT_ID);
    expect(event.type).toBe("issuing_authorization.created");
    expect((event.data.object as { id?: unknown }).id).toBe(AUTHORIZATION_REF);

    const authorization = await worker.getAuthorization(AUTHORIZATION_REF);
    expect(authorization).toEqual(expect.objectContaining({
      id: AUTHORIZATION_REF, approved: true, amount: 2900, currency: "usd",
      cardRef: CARD_REF, status: "closed",
    }));
    expect(authorization.requestHistory.at(-1)).toEqual({ approved: true, reason: "webhook_approved" });

    const transaction = await worker.getTransaction(TRANSACTION_REF);
    expect(transaction).toEqual(expect.objectContaining({
      id: TRANSACTION_REF, type: "capture", amount: -2900, currency: "usd",
      authorizationRef: AUTHORIZATION_REF, cardRef: CARD_REF,
    }));
    expect(calls.map((call) => call.url.pathname)).toEqual([
      `/v1/events/${EVENT_ID}`,
      `/v1/issuing/authorizations/${AUTHORIZATION_REF}`,
      `/v1/issuing/transactions/${TRANSACTION_REF}`,
    ]);

    await expect(worker.getEvent("evt_1QfSomeOtherEvent00001")).rejects.toThrow(/different event id/);
    await expect(worker.getAuthorization("iauth_1QfSomeOtherAuth001")).rejects.toThrow(/different authorization id/);
    await expect(worker.getTransaction("ipi_1QfSomeOtherTxn00001")).rejects.toThrow(/different transaction id/);
  });

  it("classifies HTTP 429 and 5xx as retryable and 4xx as terminal", async () => {
    const { fetcher: limited } = stub(() => json("error-rate-limited.json", 429));
    await expect(workerClient(limited).getEvent(EVENT_ID)).rejects.toMatchObject({
      name: "CardIssuerApiError", status: 429, retryable: true,
    });

    const { fetcher: broken } = stub(() => json("error-server.json", 500));
    await expect(workerClient(broken).getEvent(EVENT_ID)).rejects.toMatchObject({
      name: "CardIssuerApiError", status: 500, retryable: true,
    });

    const { fetcher: refused } = stub(() => new Response(
      JSON.stringify({ error: { message: "No such event", type: "invalid_request_error" } }),
      { status: 404 },
    ));
    await expect(workerClient(refused).getEvent(EVENT_ID)).rejects.toMatchObject({
      name: "CardIssuerApiError", status: 404, retryable: false,
    });

    const failing = vi.fn(async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
    await expect(workerClient(failing).getEvent(EVENT_ID)).rejects.toMatchObject({
      name: "CardIssuerApiError", status: 0, retryable: true,
    });
  });

  it("refuses malformed, oversized, and redirected responses", async () => {
    const { fetcher: malformed } = stub(() => new Response("<html>gateway error</html>", { status: 200 }));
    await expect(workerClient(malformed).getEvent(EVENT_ID)).rejects.toMatchObject({
      name: "CardIssuerApiError", retryable: false,
      message: expect.stringContaining("invalid JSON"),
    });

    const { fetcher: oversized } = stub(() => new Response(
      `{"padding":"${"x".repeat(1024 * 1024 + 1)}"}`,
      { status: 200 },
    ));
    await expect(workerClient(oversized).getEvent(EVENT_ID)).rejects.toMatchObject({
      name: "CardIssuerApiError", retryable: true,
      message: expect.stringContaining("too large"),
    });

    const { fetcher: redirected } = stub(() => new Response(null, {
      status: 302, headers: { location: "https://evil.test/v1/events" },
    }));
    await expect(workerClient(redirected).getEvent(EVENT_ID)).rejects.toMatchObject({
      name: "CardIssuerApiError", status: 302, retryable: false,
      message: expect.stringContaining("redirect refused"),
    });
  });
});

describe("card issuer runtime wiring", () => {
  it("wires the api role from MONEY_CARD_ISSUER_API_KEY and the cardholder id", () => {
    const issuer = createCardIssuerFromEnv({
      MONEY_CARD_PROVIDER: "stripe-issuing",
      MONEY_CARD_ISSUER_API_KEY: "sk_test_fixture_secret_key",
      MONEY_CARD_STRIPE_CARDHOLDER_ID: CARDHOLDER_ID,
      MONEY_CARD_ISSUER_BASE_URL: "https://stripe.test",
    }, { role: "api" });
    expect(issuer).toBeInstanceOf(StripeIssuingClient);
    expect(issuer.provider).toBe("stripe-issuing");

    expect(() => createCardIssuerFromEnv({
      MONEY_CARD_PROVIDER: "stripe-issuing",
      MONEY_CARD_STRIPE_CARDHOLDER_ID: CARDHOLDER_ID,
    }, { role: "api" })).toThrow(/MONEY_CARD_ISSUER_API_KEY/);
    expect(() => createCardIssuerFromEnv({
      MONEY_CARD_PROVIDER: "stripe-issuing",
      MONEY_CARD_ISSUER_API_KEY: "sk_test_fixture_secret_key",
    }, { role: "api" })).toThrow(/MONEY_CARD_STRIPE_CARDHOLDER_ID/);
  });

  it("wires the worker role from the segregated read key only", () => {
    const issuer = createCardIssuerFromEnv({
      MONEY_CARD_PROVIDER: "stripe-issuing",
      MONEY_CARD_EVENT_API_KEY: "rk_test_fixture_event_key",
      MONEY_CARD_ISSUER_BASE_URL: "https://stripe.test",
    }, { role: "worker" });
    expect(issuer).toBeInstanceOf(StripeIssuingClient);
    // The worker role reads only MONEY_CARD_EVENT_API_KEY: an api key present
    // in a misconfigured worker process is never picked up.
    expect(() => createCardIssuerFromEnv({
      MONEY_CARD_PROVIDER: "stripe-issuing",
      MONEY_CARD_ISSUER_API_KEY: "sk_test_fixture_secret_key",
    }, { role: "worker" })).toThrow(/MONEY_CARD_EVENT_API_KEY/);
  });

  it("keeps the mock branch intact", () => {
    expect(createCardIssuerFromEnv({ MONEY_CARD_PROVIDER: "mock" }, { role: "api" }))
      .toBeInstanceOf(MockIssuer);
    expect(() => createCardIssuerFromEnv({
      MONEY_CARD_PROVIDER: "mock", NODE_ENV: "production",
    }, { role: "api" })).toThrow(/forbidden in production/);
    expect(() => createCardIssuerFromEnv({ MONEY_CARD_PROVIDER: "acme" }, { role: "api" }))
      .toThrow(/unsupported card issuer provider/);
  });
});
