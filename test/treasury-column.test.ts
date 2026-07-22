import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PostgresTreasury } from "../src/db/treasury.ts";
import {
  ColumnClient,
  columnBankSnapshot,
  normalizeColumnEvent,
  verifyColumnWebhook,
  type ColumnAchTransfer,
} from "../src/treasury/column.ts";
import { createTreasuryWebhookApp } from "../src/treasury/webhook-server.ts";

function transfer(overrides: Partial<ColumnAchTransfer> = {}): ColumnAchTransfer {
  return {
    id: "acht_fixture_001",
    amount: 123,
    account_number_id: "acno_fixture_001",
    bank_account_id: "bacc_fixture_001",
    counterparty_id: "ctpy_fixture_001",
    currency_code: "USD",
    is_incoming: true,
    status: "SETTLED",
    type: "CREDIT",
    created_at: "2026-07-19T10:00:00.000Z",
    updated_at: "2026-07-19T10:01:00.000Z",
    settled_at: "2026-07-19T10:01:00.000Z",
    ...overrides,
  };
}

function event(type: string, data: ColumnAchTransfer, id = "evnt_fixture_001") {
  return { id, created_at: "2026-07-19T10:01:00.000Z", type, data };
}

describe("Column treasury adapter", () => {
  it("rejects ambiguous privileged API configuration", () => {
    expect(() => new ColumnClient({
      apiKey: "test_fixture_key",
      baseUrl: "http://column.test",
    })).toThrow(/HTTPS/);
    expect(() => new ColumnClient({
      apiKey: "test_fixture_key",
      baseUrl: "https://user:secret@column.test",
    })).toThrow(/bare origin/);
    expect(() => new ColumnClient({
      apiKey: " padded-key ",
      baseUrl: "https://column.test",
    })).toThrow(/API key/);
  });

  it("verifies the exact raw webhook bytes and endpoint binding", () => {
    const raw = Buffer.from('{\n  "id":"evnt_fixture_001", "created_at":"2026-07-19T10:01:00Z", "type":"ach.incoming_transfer.settled", "data":{}\n}');
    const signature = createHmac("sha256", "whsec_fixture").update(raw).digest("hex");
    expect(verifyColumnWebhook({
      rawBody: raw, signature, endpointId: "webh_fixture", expectedEndpointId: "webh_fixture", secret: "whsec_fixture",
    })).toBe(true);
    expect(verifyColumnWebhook({
      rawBody: Buffer.from(JSON.stringify(JSON.parse(raw.toString("utf8")))), signature,
      endpointId: "webh_fixture", expectedEndpointId: "webh_fixture", secret: "whsec_fixture",
    })).toBe(false);
    expect(verifyColumnWebhook({
      rawBody: raw, signature, endpointId: "webh_other", expectedEndpointId: "webh_fixture", secret: "whsec_fixture",
    })).toBe(false);
  });

  it("normalizes authenticated historical state while binding current immutable terms", () => {
    const settled = transfer();
    const currentReturned = transfer({
      status: "RETURNED", updated_at: "2026-07-20T10:00:00.000Z", returned_at: "2026-07-20T10:00:00.000Z",
    });
    const normalized = normalizeColumnEvent(event("ach.incoming_transfer.settled", settled), currentReturned);
    expect(normalized).toEqual(expect.objectContaining({
      kind: "funding_settled", providerRouteRef: "acno_fixture_001",
      amountMicros: 1_230_000n, asset: "USD", providerTransferId: "acht_fixture_001",
    }));
    expect(normalized.payloadHash).toHaveLength(32);
    const sameEventBeforeAdvance = normalizeColumnEvent(event("ach.incoming_transfer.settled", settled), settled);
    expect(normalized.payloadHash.equals(sameEventBeforeAdvance.payloadHash)).toBe(true);

    const returned = normalizeColumnEvent(event(
      "ach.incoming_transfer.returned",
      transfer({ status: "RETURNED", returned_at: "2026-07-20T10:00:00.000Z", return_details: [{ return_code: "R10" }] }),
      "evnt_fixture_return"
    ), currentReturned);
    expect(returned).toEqual(expect.objectContaining({ kind: "funding_returned", reason: expect.stringContaining("R10") }));
    expect(() => normalizeColumnEvent(event("ach.incoming_transfer.settled", settled), transfer({ amount: 124 })))
      .toThrow(/immutable terms/i);
  });

  it("maps outgoing ACH lifecycle states without accepting unrelated events", () => {
    const outgoing = transfer({ is_incoming: false, status: "SUBMITTED" });
    expect(normalizeColumnEvent(event("ach.outgoing_transfer.submitted", outgoing), outgoing))
      .toEqual(expect.objectContaining({ kind: "payout_transition", providerState: "submitted" }));
    const returned = transfer({ is_incoming: false, status: "RETURNED", returned_at: "2026-07-20T10:00:00.000Z" });
    expect(normalizeColumnEvent(event("ach.outgoing_transfer.returned", returned), returned))
      .toEqual(expect.objectContaining({ kind: "payout_transition", providerState: "returned" }));
    expect(normalizeColumnEvent(event("wire.outgoing_transfer.completed", outgoing), outgoing))
      .toEqual(expect.objectContaining({ kind: "ignored" }));
  });

  it("binds provider point-lookup responses to the requested resource id", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith("/events/")) {
        return new Response(JSON.stringify(event(
          "ach.incoming_transfer.settled", transfer(), "evnt_other"
        )), { status: 200 });
      }
      if (path.startsWith("/transfers/ach/")) {
        return new Response(JSON.stringify(transfer({ id: "acht_other" })), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: "bacc_other",
        currency_code: "USD",
        balances: { available_amount: 100, holding_amount: 0, locked_amount: 0, pending_amount: 0 },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ColumnClient({ apiKey: "test_fixture_key", baseUrl: "https://column.test", fetch: fetcher });

    await expect(client.getEvent("evnt_expected")).rejects.toThrow(/different event id/i);
    await expect(client.getAchTransfer("acht_expected")).rejects.toThrow(/different ACH transfer id/i);
    await expect(client.getBankAccount("bacc_expected")).rejects.toThrow(/different bank account id/i);
  });

  it("uses blank-username Basic auth, exact cents, and deterministic provider idempotency", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const responseTransfer = transfer({ is_incoming: false, status: "PENDING_SUBMISSION" });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(responseTransfer), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new ColumnClient({ apiKey: "test_fixture_key", baseUrl: "https://column.test", fetch: fetcher });
    const result = await client.createAchPayout({
      payoutId: "b122cc73-1a0d-4fc7-ac86-84be894f371c",
      sourceBankAccountId: "bacc_fixture_001", counterpartyId: "ctpy_fixture_001", amountMicros: 1_230_000n,
    });
    expect(result.id).toBe("acht_fixture_001");
    expect(calls[0]?.url).toBe("https://column.test/transfers/ach");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from(":test_fixture_key").toString("base64")}`);
    expect(headers.get("idempotency-key")).toBe("money-payout-b122cc73-1a0d-4fc7-ac86-84be894f371c");
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect(Object.fromEntries(body)).toEqual(expect.objectContaining({
      amount: "123", bank_account_id: "bacc_fixture_001", counterparty_id: "ctpy_fixture_001",
      currency_code: "USD", type: "CREDIT", same_day: "false",
    }));
  });

  it("rejects provider response drift and computes the book balance without pending funds", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(transfer({
      is_incoming: false, amount: 124, status: "SUBMITTED",
    })), { status: 200 })) as unknown as typeof fetch;
    const client = new ColumnClient({ apiKey: "test_fixture_key", baseUrl: "https://column.test", fetch: fetcher });
    await expect(client.createAchPayout({
      payoutId: "f0aca548-5f02-4722-95fd-9fd4a9795e80",
      sourceBankAccountId: "bacc_fixture_001", counterpartyId: "ctpy_fixture_001", amountMicros: 1_230_000n,
    })).rejects.toThrow(/does not match reserved payout terms/i);

    const observedAt = new Date("2026-07-19T10:05:00.000Z");
    expect(columnBankSnapshot({
      id: "bacc_fixture_001", currency_code: "USD",
      balances: { available_amount: 100, holding_amount: 20, locked_amount: 3, pending_amount: 9 },
    }, observedAt)).toEqual(expect.objectContaining({
      bookMicros: 1_230_000n, availableMicros: 1_000_000n,
      holdingMicros: 200_000n, lockedMicros: 30_000n, pendingMicros: 90_000n,
    }));
  });

  it("webhook ingress authenticates then enqueues only the event envelope", async () => {
    const enqueueEvent = vi.fn(async () => ({ inboxId: 1n, replayed: false, state: "queued" }));
    const treasury = { enqueueEvent } as unknown as PostgresTreasury;
    const app = createTreasuryWebhookApp(treasury, { secret: "whsec_fixture", endpointId: "webh_fixture" });
    const payload = JSON.stringify(event("ach.incoming_transfer.settled", transfer()));
    const signature = createHmac("sha256", "whsec_fixture").update(payload).digest("hex");
    const response = await app.request("/webhooks/column", {
      method: "POST",
      headers: {
        "content-type": "application/json", "column-signature": signature,
        "webhook-endpoint-id": "webh_fixture",
      },
      body: payload,
    });
    expect(response.status).toBe(202);
    expect(enqueueEvent).toHaveBeenCalledOnce();
    expect(enqueueEvent).toHaveBeenCalledWith(expect.objectContaining({
      provider: "column", providerEventId: "evnt_fixture_001", endpointId: "webh_fixture",
      deliveryHash: expect.any(Buffer),
    }));
  });

  it("rejects a chunked webhook before buffering beyond the ingress limit", async () => {
    const enqueueEvent = vi.fn();
    const treasury = { enqueueEvent } as unknown as PostgresTreasury;
    const app = createTreasuryWebhookApp(treasury, {
      secret: "whsec_fixture", endpointId: "webh_fixture", maxBodyBytes: 64,
    });
    const response = await app.request("/webhooks/column", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(65),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
});
