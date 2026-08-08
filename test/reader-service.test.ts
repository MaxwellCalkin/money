import { describe, expect, it } from "vitest";
import { AgentFetchPolicy } from "../src/mcp/outbound.ts";
import { createReaderApp, readableText } from "../src/seller/reader-service.ts";

const OPTIONS = {
  networkUrl: "https://network.example",
  providerId: "prv_test",
  providerKey: "unused-in-these-tests",
  serviceId: "svc_test",
};

describe("paid reader service", () => {
  it("extracts readable text and strips scripts, styles, and tags", () => {
    const text = readableText(
      "<html><head><style>p{color:red}</style><script>alert(1)</script></head>" +
      "<body><h1>Title</h1><p>First&nbsp;para &amp; more.</p><div>Second</div></body></html>",
    );
    expect(text).toBe("Title\nFirst para & more.\nSecond");
  });

  it("rejects unsafe targets before paying any attention to them", async () => {
    // The paywall never engages: an invalid target on a paid route must not
    // consume a challenge, so we bypass payment by injecting headers that the
    // middleware treats as a redemption attempt only when present — here we
    // hit the route unpaid and expect the 402 challenge path to be exercised
    // by the network client, so instead validate the policy directly.
    const policy = new AgentFetchPolicy({});
    await expect(policy.validate("http://169.254.169.254/latest/meta-data")).rejects.toThrow();
    await expect(policy.validate("http://127.0.0.1:8080/")).rejects.toThrow();
    await expect(policy.validate("ftp://example.com/x")).rejects.toThrow();
  });

  it("serves /health without payment and keeps /read behind the paywall", async () => {
    const app = createReaderApp({
      ...OPTIONS,
      fetchImpl: async () => {
        throw new Error("outbound fetch must not run for unpaid requests");
      },
    });
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    // Unpaid /read: moneyPaid asks the network for a challenge; with an
    // unreachable network URL the middleware returns 503 (fail closed),
    // proving the resource handler (and its outbound fetch) never ran —
    // the throwing fetchImpl above would have failed the test otherwise.
    const unpaid = await app.request("/read?url=https://example.com/");
    expect([402, 503]).toContain(unpaid.status);
  });
});
