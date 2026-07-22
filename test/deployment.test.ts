import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configuredHttpOrigin,
  readBoundedJsonResponse,
} from "../src/core/api-client.ts";
import { readBoundedResponseText } from "../src/core/bounded-response.ts";
import { isLocalEndpointHostname, isLoopbackHostname } from "../src/core/url-security.ts";
import { preflightProductionService } from "../src/deploy/preflight.ts";
import { listenHost } from "../src/server/listen.ts";

const ROOT = resolve(import.meta.dirname, "..");
const KEY = Buffer.alloc(32, 11).toString("base64");

function apiEnvironment(): Record<string, string | undefined> {
  return {
    NODE_ENV: "production",
    MONEY_BIND_HOST: "0.0.0.0",
    DATABASE_URL: "postgres://money_app_login:correct-horse-battery-staple@db.internal:5432/money?sslmode=verify-full",
    MONEY_EXTERNAL_HEADER_KEYS: JSON.stringify({ "external-2026-07": KEY }),
    MONEY_EXTERNAL_HEADER_ACTIVE_KEY_ID: "external-2026-07",
    MONEY_COMPLIANCE_SESSION_KEYS: JSON.stringify({ "compliance-2026-07": KEY }),
    MONEY_COMPLIANCE_SESSION_ACTIVE_KEY_ID: "compliance-2026-07",
    MONEY_COMPLIANCE_PROVIDER: "persona",
    MONEY_EVM_SIGNER_URL: "https://signer.internal/x402",
    MONEY_EVM_SIGNER_ADDRESS: "0x1111111111111111111111111111111111111111",
    MONEY_EVM_SIGNER_TOKEN: "remote-signer-token-with-at-least-32-characters",
    MONEY_EVM_RPC_URLS: JSON.stringify({
      "eip155:8453": { url: "https://rpc.internal/base", confirmations: 2 },
    }),
  };
}

describe("production deployment contract", () => {
  const previousHost = process.env.MONEY_BIND_HOST;
  afterEach(() => {
    if (previousHost === undefined) delete process.env.MONEY_BIND_HOST;
    else process.env.MONEY_BIND_HOST = previousHost;
  });

  it("accepts a narrow real-rail API environment and rejects production escape hatches", () => {
    const env = apiEnvironment();
    expect(preflightProductionService("api", env)).toEqual({ service: "api", ok: true });
    expect(() => preflightProductionService("api", {
      ...env,
      MONEY_ALLOW_DEV_FUNDING: "true",
    })).toThrow(/forbidden/);
    expect(() => preflightProductionService("api", {
      ...env,
      MONEY_AUTO_MIGRATE: "true",
    })).toThrow(/standalone migration job/);
    expect(() => preflightProductionService("api", {
      ...env,
      MONEY_MIGRATIONS: "/tmp/unreviewed-migrations",
    })).toThrow(/built-in migration directory/);
    expect(() => preflightProductionService("api", {
      ...env,
      MONEY_COMPLIANCE_PROVIDER: "uncertified-provider",
    })).toThrow(/certified only for Persona/);
    expect(() => preflightProductionService("api", {
      ...env,
      MONEY_COMPLIANCE_PROVIDER_API_KEY: "must-not-reach-product-api",
    })).toThrow(/must not be present/);
    expect(() => preflightProductionService("api", {
      ...env,
      MONEY_COLUMN_PAYOUT_API_KEY: "must-not-reach-product-api",
    })).toThrow(/must not be present/);
    expect(() => preflightProductionService("api", {
      ...env,
      DATABASE_URL: "postgres://postgres:secret@localhost:5432/money?sslmode=require",
    })).toThrow(/non-owner|loopback|verify-full/);
    expect(() => preflightProductionService("api", {
      ...env,
      MONEY_EVM_SIGNER_ADDRESS: "0x0000000000000000000000000000000000000000",
    })).toThrow(/EVM_SIGNER_ADDRESS/);
    expect(() => preflightProductionService("api", {
      ...env,
      MONEY_EVM_SIGNER_URL: "https://signer.internal/x402?token=must-not-live-in-a-url",
    })).toThrow(/query/);
    expect(() => preflightProductionService("api", {
      ...env,
      MONEY_EVM_RPC_URLS: JSON.stringify({
        "eip155:8453": "http://localhost:8545",
      }),
    })).toThrow(/HTTPS|loopback/);
  });

  it("validates Persona ingress and worker authority as different environments", () => {
    const common = {
      NODE_ENV: "production",
      MONEY_BIND_HOST: "0.0.0.0",
      MONEY_COMPLIANCE_PROVIDER: "persona",
      MONEY_COMPLIANCE_WEBHOOK_ENDPOINT_ID: "wbh_ProductionEndpoint123",
      MONEY_COMPLIANCE_WEBHOOK_SECRETS: JSON.stringify([
        "wbhsec_current-production-secret",
        "wbhsec_previous-production-secret",
      ]),
    };
    expect(preflightProductionService("compliance-webhook", {
      ...common,
      MONEY_COMPLIANCE_INGRESS_DATABASE_URL:
        "postgres://money_compliance_ingress_login:long-password@db.internal:5432/money?sslmode=verify-full",
    })).toEqual({ service: "compliance-webhook", ok: true });

    const worker = {
      NODE_ENV: "production",
      MONEY_COMPLIANCE_PROVIDER: "persona",
      MONEY_COMPLIANCE_PROVIDER_API_KEY: "persona-production-read-key",
      MONEY_PERSONA_API_VERSION: "2025-12-08",
      MONEY_PERSONA_INDIVIDUAL_TEMPLATE_ID: "itmpl_IndividualProduction123",
      MONEY_PERSONA_BUSINESS_TEMPLATE_ID: "itmpl_BusinessProduction1234",
      MONEY_PERSONA_INDIVIDUAL_WATCHLIST_REPORT_TEMPLATE_ID:
        "rptp_IndividualWatchlistProduction123",
      MONEY_PERSONA_BUSINESS_WATCHLIST_REPORT_TEMPLATE_ID:
        "rptp_BusinessWatchlistProduction12345",
      MONEY_PERSONA_BUSINESS_ASSOCIATED_PERSONS_REPORT_TEMPLATE_ID:
        "rptp_BusinessOwnersProduction12345678",
      MONEY_COMPLIANCE_WORKER_DATABASE_URL:
        "postgres://money_compliance_worker_login:long-password@db.internal:5432/money?sslmode=verify-full",
    };
    expect(preflightProductionService("compliance-events", worker)).toEqual({
      service: "compliance-events",
      ok: true,
    });
    expect(() => preflightProductionService("compliance-events", {
      ...worker,
      MONEY_COMPLIANCE_WEBHOOK_SECRET: "cross-service-secret",
    })).toThrow(/must not be present/);
    expect(() => preflightProductionService("compliance-events", {
      ...worker,
      MONEY_EVM_RPC_URLS: JSON.stringify({
        "eip155:8453": { url: "https://credentialed-rpc.example/key" },
      }),
    })).toThrow(/must not be present/);
    expect(() => preflightProductionService("compliance-events", {
      ...worker,
      MONEY_COMPLIANCE_PROVIDER_URL: "https://provider.invalid",
    })).toThrow(/api\.withpersona\.com/);
  });

  it("keeps local binds private unless deployment explicitly selects a container interface", () => {
    delete process.env.MONEY_BIND_HOST;
    expect(listenHost("127.0.0.1")).toBe("127.0.0.1");
    process.env.MONEY_BIND_HOST = "0.0.0.0";
    expect(listenHost("127.0.0.1")).toBe("0.0.0.0");
    process.env.MONEY_BIND_HOST = "public.example";
    expect(() => listenHost("127.0.0.1")).toThrow(/MONEY_BIND_HOST/);
  });

  it("recognizes non-canonical IPv4, DNS, and IPv6 local endpoints", () => {
    for (const hostname of [
      "localhost",
      "signer.localhost.",
      "127.0.0.2",
      "[::1]",
      "[::ffff:127.0.0.1]",
    ]) {
      expect(isLoopbackHostname(hostname), hostname).toBe(true);
      expect(isLocalEndpointHostname(hostname), hostname).toBe(true);
    }
    expect(isLocalEndpointHostname("0.0.0.0")).toBe(true);
    expect(isLocalEndpointHostname("[::]")).toBe(true);
    expect(isLocalEndpointHostname("db.internal")).toBe(false);
  });

  it("caps upstream bodies before JSON parsing even without a trusted length", async () => {
    const response = new Response("x".repeat(17));
    await expect(readBoundedResponseText(response, 16))
      .rejects.toThrow(/too large/);
    await expect(readBoundedJsonResponse(new Response("not-json")))
      .rejects.toThrow(/valid JSON/);
  });

  it("canonicalizes configured APIs and keeps signed CLI traffic on trusted origins", () => {
    expect(configuredHttpOrigin("https://API.EXAMPLE:443", "MONEY_API"))
      .toBe("https://api.example");
    expect(configuredHttpOrigin("http://127.0.0.2:4021", "MONEY_API"))
      .toBe("http://127.0.0.2:4021");
    expect(() => configuredHttpOrigin("http://api.example", "MONEY_API"))
      .toThrow(/HTTPS/);
    expect(() => configuredHttpOrigin("https://user:pass@api.example", "MONEY_API"))
      .toThrow(/bare origin/);
    expect(() => configuredHttpOrigin("https://api.example/v1", "MONEY_API"))
      .toThrow(/bare origin/);
  });

  it("ships an immutable non-root image and segregated service topology", () => {
    const dockerfile = readFileSync(resolve(ROOT, "Dockerfile"), "utf8");
    const attributes = readFileSync(resolve(ROOT, ".gitattributes"), "utf8");
    const codeowners = readFileSync(resolve(ROOT, ".github/CODEOWNERS"), "utf8");
    const dependabot = readFileSync(resolve(ROOT, ".github/dependabot.yml"), "utf8");
    const pullRequestTemplate = readFileSync(
      resolve(ROOT, ".github/pull_request_template.md"), "utf8",
    );
    const releaseEvidenceTemplate = readFileSync(
      resolve(ROOT, "docs/RELEASE_EVIDENCE_TEMPLATE.md"), "utf8",
    );
    const compose = readFileSync(resolve(ROOT, "deploy/compose.production.yaml"), "utf8");
    const workflow = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
    const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      version: string;
      engines: { node: string };
    };
    expect(packageJson).toEqual(expect.objectContaining({
      version: "0.13.0",
      engines: { node: ">=24" },
    }));
    expect(dockerfile.match(
      /FROM node:24\.18\.0-bookworm-slim@sha256:[0-9a-f]{64} AS build/g,
    )).toHaveLength(1);
    expect(dockerfile).toContain(
      "FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:af85d11ce7ef10172855a6e3649e3e8125b1b9e3ca41849ec2918036f05cb212 AS runtime",
    );
    expect(dockerfile).not.toMatch(/ARG\s+NODE_IMAGE|#\s*syntax=/);
    expect(dockerfile).toContain("ARG SOURCE_COMMIT=unknown");
    expect(dockerfile).toContain('org.opencontainers.image.revision="$SOURCE_COMMIT"');
    expect(readFileSync(resolve(ROOT, ".dockerignore"), "utf8")).toMatch(/^release-evidence$/m);
    expect(readFileSync(resolve(ROOT, ".gitignore"), "utf8")).toMatch(/^release-evidence\/$/m);
    expect(dockerfile).toMatch(/USER 65532/);
    expect(dockerfile).toContain('ENTRYPOINT ["/nodejs/bin/node", "--enable-source-maps"]');
    expect(dockerfile.slice(dockerfile.indexOf(" AS runtime"))).not.toMatch(/^RUN /m);
    expect(dockerfile).toMatch(/npm prune --omit=dev/);
    expect(dockerfile).not.toMatch(/COPY \. \./);
    expect(attributes).toContain("* text=auto eol=lf");
    expect(codeowners).toMatch(/^\* @MaxwellCalkin$/m);
    for (const boundary of ["/.github/", "/db/", "/src/bridge/", "/src/compliance/", "/src/treasury/"]) {
      expect(codeowners).toContain(`${boundary} @MaxwellCalkin`);
    }
    for (const requirement of [
      "Journal conservation",
      "effective-role tests",
      "fail closed",
      "docs/THREAT_MODEL.md",
      "SHA256SUMS",
      "Rollout, containment, and residual risk",
    ]) {
      expect(pullRequestTemplate).toContain(requirement);
    }
    for (const releaseGate of [
      "Candidate source commit",
      "Repository controls",
      "PostgreSQL and money-kernel gates",
      "Service preflight matrix",
      "Persona sandbox contract",
      "External x402 testnet contract",
      "Non-code launch authority",
      "Customer funds",
    ]) {
      expect(releaseEvidenceTemplate).toContain(releaseGate);
    }
    expect(workflow.match(
      /aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/g,
    )).toHaveLength(2);
    expect(workflow).toContain(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(workflow.match(
      /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/g,
    )).toHaveLength(3);
    expect(workflow).toContain(
      "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    );
    expect(workflow).not.toMatch(/uses:\s*[^\s]+@v\d/);
    expect(workflow).toMatch(/^permissions:\s*\n\s+contents:\s*read$/m);
    expect(workflow).not.toMatch(/pull_request_target|permissions:\s*write-all/);
    expect(workflow).toContain(
      "postgres:18.4-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296",
    );
    expect(workflow).toContain("npm run test:postgres-live");
    expect(workflow).toContain("npm run verify:deployment");
    const actionRefs = [...workflow.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]);
    expect(actionRefs.length).toBeGreaterThan(0);
    expect(actionRefs.every((ref) => /@[0-9a-f]{40}$/.test(ref!))).toBe(true);
    expect(workflow).toContain('--build-arg SOURCE_COMMIT="$SOURCE_COMMIT"');
    expect(workflow).toContain("docker image inspect --format='image_id={{.Id}}'");
    expect(workflow).toContain("release-evidence/runtime-contract.json");
    expect(workflow).toContain("evidence.uid !== 65532");
    for (const forbiddenRuntimePath of [
      '"/bin/sh"', '"/usr/local/bin/npm"', '"/usr/local/bin/yarn"',
    ]) {
      expect(workflow).toContain(forbiddenRuntimePath);
    }
    expect(workflow.match(/scan-type:\s*image/g)).toHaveLength(2);
    expect(workflow.match(/image-ref:\s*money:\$\{\{ github\.sha \}\}/g)).toHaveLength(2);
    expect(workflow.match(/version:\s*v0\.70\.0/g)).toHaveLength(2);
    expect(workflow.match(/cache:\s*["']false["']/g)).toHaveLength(2);
    expect(workflow).toMatch(/format:\s*cyclonedx/);
    expect(workflow).toContain("release-evidence/money.cdx.json");
    expect(workflow).toMatch(/skip-setup-trivy:\s*["']true["']/);
    expect(workflow).toMatch(/format:\s*json/);
    expect(workflow).toContain("release-evidence/trivy-high-critical.json");
    expect(workflow).toContain("xargs -0 sha256sum > SHA256SUMS");
    expect(workflow).toContain("test -s SHA256SUMS");
    expect(workflow).toMatch(/exit-code:\s*["']1["']/);
    expect(workflow).toMatch(/ignore-unfixed:\s*["']false["']/);
    expect(workflow).toMatch(/vuln-type:\s*os,library/);
    expect(workflow).toMatch(/severity:\s*CRITICAL,HIGH/);
    expect(workflow).toContain("always() && steps.build.outcome == 'success'");
    expect(workflow).toMatch(/name:\s*money-image-evidence-\$\{\{ github\.sha \}\}/);
    expect(workflow).toMatch(/if-no-files-found:\s*error/);
    expect(workflow).toMatch(/retention-days:\s*90/);
    expect(dependabot).toMatch(/package-ecosystem:\s*npm/);
    expect(dependabot).toMatch(/package-ecosystem:\s*github-actions/);
    expect(dependabot.match(/interval:\s*weekly/g)).toHaveLength(2);
    expect(compose).toMatch(/read_only: true/);
    expect(compose).toMatch(/cap_drop:\s*\n\s*- ALL/);
    expect(compose).toMatch(/no-new-privileges:true/);
    expect(compose.match(/test: \[CMD, \/nodejs\/bin\/node,/g)).toHaveLength(6);
    expect(compose).not.toMatch(/POSTGRES_PASSWORD|money-dev-only/);
    for (const service of [
      "api",
      "treasury-webhook",
      "treasury-events",
      "treasury-payouts",
      "compliance-webhook",
      "compliance-events",
      "compliance-onboarding",
      "compliance-console",
    ]) {
      expect(compose).toContain(`/${service}.env`);
    }

    const productionEntrypoints = {
      api: "src/server/postgres-api.ts",
      "database-ops": "src/server/database-ops.ts",
      "external-worker": "src/db/external-worker.ts",
      migrate: "src/db/migrate.ts",
      "treasury-webhook": "src/treasury/webhook-server.ts",
      "treasury-events": "src/treasury/event-worker.ts",
      "treasury-payouts": "src/treasury/payout-worker.ts",
      "treasury-reconciler": "src/treasury/reconciler.ts",
      "compliance-webhook": "src/compliance/webhook-server.ts",
      "compliance-events": "src/compliance/event-worker.ts",
      "compliance-onboarding": "src/compliance/onboarding-worker.ts",
      "compliance-reviews": "src/compliance/review-worker.ts",
      "compliance-ops": "src/compliance/ops-server.ts",
      "compliance-console": "src/compliance/console-server.ts",
    } as const;
    for (const [service, entrypoint] of Object.entries(productionEntrypoints)) {
      expect(readFileSync(resolve(ROOT, entrypoint), "utf8"))
        .toContain(`enforceProductionPreflight("${service}")`);
      expect(workflow).toContain(entrypoint.replace(/^src\//, "dist/").replace(/\.ts$/, ".js"));
    }
  });
});
