import { afterEach, describe, expect, it } from "vitest";
import { MockIssuer } from "../src/cards/mock-issuer.ts";
import { postgresApiOptionsFromEnv } from "../src/server/postgres-api.ts";

function betaEnvironment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: "development",
    MONEY_ALLOW_DEV_FUNDING: "true",
    MONEY_ALLOW_SESSION_OWNER_WRITES: "true",
    MONEY_SIGNUP_INVITES: JSON.stringify(["pilot-invite-0001", "pilot-invite-0002"]),
    MONEY_CARD_PROVIDER: "mock",
    MONEY_CARD_REVEAL_MODE: "none",
    ...overrides,
  };
}

/** The option assembly shared by the container entry point and the Vercel
 * composers. It must be pure (reads only the map it is given) and keep every
 * production refusal the inline code carried. */
describe("postgresApiOptionsFromEnv", () => {
  const savedDevFunding = process.env.MONEY_ALLOW_DEV_FUNDING;
  afterEach(() => {
    if (savedDevFunding === undefined) delete process.env.MONEY_ALLOW_DEV_FUNDING;
    else process.env.MONEY_ALLOW_DEV_FUNDING = savedDevFunding;
  });

  it("assembles the sandbox beta profile", () => {
    const options = postgresApiOptionsFromEnv(betaEnvironment());
    expect(options).toEqual(expect.objectContaining({
      allowDevelopmentFunding: true,
      allowSessionOwnerWrites: true,
      signupInvites: ["pilot-invite-0001", "pilot-invite-0002"],
      cardRevealMode: "none",
      cardAuthTtlSeconds: 604_800,
    }));
    expect(options.cardIssuer).toBeInstanceOf(MockIssuer);
    expect(options).not.toHaveProperty("externalHeaderKeyring");
    expect(options).not.toHaveProperty("externalPaymentSigner");
    expect(options).not.toHaveProperty("externalWallet");
    expect(options).not.toHaveProperty("verifyExternalSettlement");
    expect(options).not.toHaveProperty("complianceSessionKeyring");
    expect(options).not.toHaveProperty("cardRevealTokenKey");
  });

  it("reads only the environment it is handed", () => {
    process.env.MONEY_ALLOW_DEV_FUNDING = "true";
    const options = postgresApiOptionsFromEnv({});
    expect(options.allowDevelopmentFunding).toBe(false);
    expect(options.allowSessionOwnerWrites).toBe(false);
    expect(options).not.toHaveProperty("signupInvites");
    expect(options).not.toHaveProperty("cardIssuer");
  });

  it("keeps the production refusals", () => {
    expect(() => postgresApiOptionsFromEnv(betaEnvironment({
      NODE_ENV: "production", MONEY_EXTERNAL_MOCK: "true", MONEY_CARD_PROVIDER: undefined,
    }))).toThrow(/MONEY_EXTERNAL_MOCK cannot be enabled in production/);
    expect(() => postgresApiOptionsFromEnv(betaEnvironment({ NODE_ENV: "production" })))
      .toThrow(/mock card issuer is forbidden in production/);
    expect(() => postgresApiOptionsFromEnv(betaEnvironment({
      NODE_ENV: "production", MONEY_CARD_PROVIDER: undefined, MONEY_EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    }))).toThrow(/MONEY_EVM_PRIVATE_KEY is refused in production/);
    expect(() => postgresApiOptionsFromEnv(betaEnvironment({
      NODE_ENV: "production", MONEY_CARD_PROVIDER: undefined, MONEY_EXTERNAL_HEADER_KEY: "legacy",
    }))).toThrow(/MONEY_EXTERNAL_HEADER_KEY is a legacy local fallback/);
  });

  it("refuses inconsistent optional configuration", () => {
    expect(() => postgresApiOptionsFromEnv(betaEnvironment({ MONEY_CARD_REVEAL_MODE: "token" })))
      .toThrow(/MONEY_CARD_REVEAL_TOKEN_KEY/);
    expect(() => postgresApiOptionsFromEnv(betaEnvironment({ MONEY_COMPLIANCE_SESSION_KEYS: "{}" })))
      .toThrow(/MONEY_COMPLIANCE_SESSION_ACTIVE_KEY_ID/);
    expect(() => postgresApiOptionsFromEnv(betaEnvironment({ MONEY_EXTERNAL_MOCK: "true" })))
      .toThrow(/external header keyring is required/);
    expect(() => postgresApiOptionsFromEnv(betaEnvironment({ MONEY_SIGNUP_INVITES: "not json" })))
      .toThrow(/MONEY_SIGNUP_INVITES/);
  });
});
