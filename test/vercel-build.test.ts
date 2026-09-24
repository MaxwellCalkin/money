import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "build-vercel.mjs");
const scratch = mkdtempSync(join(tmpdir(), "money-vercel-build-"));
const CA = "-----BEGIN CERTIFICATE-----\nMIIBbuildSmokeCertificate\n-----END CERTIFICATE-----";

const FUNCTION_CONFIG = {
  runtime: "nodejs24.x",
  handler: "index.js",
  launcherType: "Nodejs",
  shouldAddHelpers: false,
  maxDuration: 60,
  regions: ["iad1"],
};

const STATIC_HEADERS = {
  "content-security-policy":
    "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function runBuild(name: string, variables: Record<string, string | undefined>) {
  const output = join(scratch, name);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^MONEY_VERCEL_ENTRY$|^MONEY_METRICS_ORIGIN$/.test(key)) env[key] = value;
  }
  env.MONEY_VERCEL_OUTPUT_DIR = output;
  for (const [key, value] of Object.entries(variables)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, env, encoding: "utf8" });
  return { output, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;

/** Imports the built bundle in a fresh Node process (the launcher's own
 * shape — no Vite transform in between) and fetches the given paths through
 * its default export. */
const SMOKE_SCRIPT = [
  "// `node --input-type=module -e` has no script path: argv[1] is the first extra argument.",
  "const mod = await import(process.argv[1]);",
  "const results = [];",
  "for (const path of process.argv.slice(2)) {",
  "  const response = await mod.default.fetch(new Request(`http://beta.test${path}`));",
  "  results.push({ path, status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });",
  "}",
  "process.stdout.write(JSON.stringify({ fetchType: typeof mod.default.fetch, results }) + '\\n', () => process.exit(0));",
].join("\n");

interface SmokeResult {
  fetchType: string;
  results: Array<{ path: string; status: number; headers: Record<string, string>; body: string }>;
}

function smokeBundle(bundle: string, profile: Record<string, string>, paths: string[]): SmokeResult & { stderr: string } {
  // Start from a MONEY-free copy of the host environment (PATH, SYSTEMROOT,
  // TEMP) so no stray beta variable from the developer's shell reaches the
  // drift guard, then lay the profile's own variables on top.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(MONEY_|DATABASE_URL$|PG_POOL_MAX$|NODE_ENV$)/.test(key)) env[key] = value;
  }
  Object.assign(env, profile);
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", SMOKE_SCRIPT, "--", pathToFileURL(bundle).href, ...paths],
    { cwd: scratch, env, encoding: "utf8", timeout: 60_000 },
  );
  if (child.status !== 0) throw new Error(`bundle smoke exited ${child.status}: ${child.stderr}`);
  const line = child.stdout.trim().split("\n").at(-1) ?? "";
  return { ...(JSON.parse(line) as SmokeResult), stderr: child.stderr };
}

/** Every fake value below is non-routable or a dummy: pools connect lazily,
 * so booting the bundle never opens a socket. Each profile gets exactly the
 * variables its drift guard allows — the other profile's identities would be
 * refused at boot, which is the point of the guard. */
const POSTURE_ENVIRONMENT = {
  MONEY_POSTURE: "sandbox-beta",
  NODE_ENV: "development",
  MONEY_DB_SSL: "verify-full",
  MONEY_DB_SSL_CA: CA,
  PG_POOL_MAX: "2",
};

function mainBundleEnvironment(): Record<string, string> {
  return {
    ...POSTURE_ENVIRONMENT,
    DATABASE_URL: "postgresql://money_app_login.ref:pw@db.invalid:6543/postgres",
    MONEY_WORKER_DATABASE_URL: "postgresql://money_worker_login.ref:pw@db.invalid:6543/postgres",
    MONEY_CARD_INGRESS_DATABASE_URL: "postgresql://money_card_ingress_login.ref:pw@db.invalid:6543/postgres",
    MONEY_OPS_DATABASE_URL: "postgresql://money_ops_login.ref:pw@db.invalid:6543/postgres",
    MONEY_ALLOW_DEV_FUNDING: "true",
    MONEY_ALLOW_SESSION_OWNER_WRITES: "true",
    MONEY_SIGNUP_INVITES: JSON.stringify(["build-smoke-invite-0001"]),
    MONEY_CARD_PROVIDER: "mock",
    MONEY_CARD_REVEAL_MODE: "none",
    MONEY_CARD_WEBHOOK_SECRETS: JSON.stringify(["whsec_build_smoke_secret_000000001"]),
    MONEY_CARD_WEBHOOK_ENDPOINT_ID: "beta-mock-card-endpoint",
    MONEY_SWEEP_KEY: "build-smoke-sweep-key-0123456789abcdef",
  };
}

function metricsBundleEnvironment(): Record<string, string> {
  return {
    ...POSTURE_ENVIRONMENT,
    MONEY_METRICS_DATABASE_URL: "postgresql://money_metrics_login.ref:pw@db.invalid:6543/postgres",
    MONEY_METRICS_SANDBOX_LABEL: "true",
  };
}

describe("scripts/build-vercel.mjs", () => {
  it("produces the main project's build output with the metrics rewrites", async () => {
    const build = runBuild("main", {
      MONEY_VERCEL_ENTRY: undefined,
      MONEY_METRICS_ORIGIN: "https://agentmoney-metrics.vercel.app",
    });
    expect(build.status, build.stderr).toBe(0);
    const fn = join(build.output, "functions", "api.func");
    expect(readJson(join(fn, ".vc-config.json"))).toEqual(FUNCTION_CONFIG);
    expect(readJson(join(fn, "package.json"))).toEqual({ type: "module" });
    expect(statSync(join(fn, "index.js")).size).toBeGreaterThan(100_000);
    expect(existsSync(join(fn, "index.js.map"))).toBe(false);
    expect(readJson(join(build.output, "config.json"))).toEqual({
      version: 3,
      routes: [
        { src: "/(index\\.html)?", headers: STATIC_HEADERS, continue: true },
        { src: "/metrics(.*)", dest: "https://agentmoney-metrics.vercel.app/metrics$1" },
        { src: "/receipts/(.*)", dest: "https://agentmoney-metrics.vercel.app/receipts/$1" },
        { handle: "filesystem" },
        { src: "/(.*)", dest: "/api" },
      ],
    });
    expect(readFileSync(join(build.output, "static", "index.html"), "utf8"))
      .toBe(readFileSync(join(ROOT, "site", "index.html"), "utf8"));

    // The bundle is a self-contained ESM module whose default export carries
    // `fetch`; booting it with a fake environment answers liveness without
    // any CJS require leaking and without opening a socket.
    const smoke = smokeBundle(join(fn, "index.js"), mainBundleEnvironment(), ["/health/live", "/internal/sweep", "/no-such-route"]);
    expect(smoke.fetchType).toBe("function");
    expect(smoke.results.map((entry) => [entry.path, entry.status])).toEqual([
      ["/health/live", 200],
      ["/internal/sweep", 405],
      ["/no-such-route", 404],
    ]);
    expect(JSON.parse(smoke.results[0]!.body)).toEqual({ ok: true });
    expect(smoke.stderr).not.toMatch(/boot refused|Dynamic require/);
  }, 120_000);

  it("omits the rewrites and warns when MONEY_METRICS_ORIGIN is unset", () => {
    const build = runBuild("main-no-origin", { MONEY_VERCEL_ENTRY: undefined, MONEY_METRICS_ORIGIN: undefined });
    expect(build.status, build.stderr).toBe(0);
    expect(build.stderr).toMatch(/MONEY_METRICS_ORIGIN is unset/);
    const config = readJson(join(build.output, "config.json")) as { routes: Array<{ src?: string; dest?: string }> };
    expect(config.routes.map((route) => route.src ?? "filesystem")).toEqual(["/(index\\.html)?", "filesystem", "/(.*)"]);
    expect(config.routes.some((route) => route.dest?.includes("/metrics"))).toBe(false);
  }, 120_000);

  it("fails the build on a malformed metrics origin", () => {
    for (const origin of ["http://agentmoney-metrics.vercel.app", "https://agentmoney-metrics.vercel.app/", "https://agentmoney-metrics.vercel.app/metrics", "agentmoney-metrics.vercel.app", "https://u:p@agentmoney-metrics.vercel.app"]) {
      const build = runBuild("main-bad-origin", { MONEY_VERCEL_ENTRY: undefined, MONEY_METRICS_ORIGIN: origin });
      expect(build.status, origin).not.toBe(0);
      expect(build.stderr).toMatch(/MONEY_METRICS_ORIGIN/);
      expect(existsSync(join(build.output, "config.json"))).toBe(false);
    }
  }, 60_000);

  it("produces the metrics project's build output with no static directory", async () => {
    const build = runBuild("metrics", { MONEY_VERCEL_ENTRY: "metrics", MONEY_METRICS_ORIGIN: undefined });
    expect(build.status, build.stderr).toBe(0);
    const fn = join(build.output, "functions", "api.func");
    expect(readJson(join(fn, ".vc-config.json"))).toEqual(FUNCTION_CONFIG);
    expect(readJson(join(fn, "package.json"))).toEqual({ type: "module" });
    expect(readJson(join(build.output, "config.json"))).toEqual({
      version: 3,
      routes: [{ src: "/(.*)", dest: "/api" }],
    });
    expect(existsSync(join(build.output, "static"))).toBe(false);

    const smoke = smokeBundle(join(fn, "index.js"), metricsBundleEnvironment(), ["/health/live", "/users"]);
    expect(smoke.fetchType).toBe("function");
    expect(smoke.results.map((entry) => [entry.path, entry.status])).toEqual([["/health/live", 200], ["/users", 404]]);
    expect(smoke.results[0]!.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(smoke.stderr).not.toMatch(/boot refused|Dynamic require/);
  }, 120_000);
});

describe("vercel.json", () => {
  it("disables framework detection and every non-production build", () => {
    const config = readJson(join(ROOT, "vercel.json")) as {
      framework: unknown;
      installCommand: string;
      buildCommand: string;
      ignoreCommand: string;
      git: { deploymentEnabled: Record<string, boolean> };
    };
    expect(config.framework).toBeNull();
    expect(config.installCommand).toBe("npm ci --no-audit --no-fund");
    expect(config.buildCommand).toBe("node scripts/build-vercel.mjs");
    expect(config.ignoreCommand).toContain("VERCEL_ENV");
    expect(config.ignoreCommand).toMatch(/production.*exit 1.*exit 0/);
    expect(config.git.deploymentEnabled).toEqual({ main: true, "*": false, "**": false });
  });

  it("keeps the build output out of the repository", () => {
    expect(readFileSync(join(ROOT, ".gitignore"), "utf8").split(/\r?\n/)).toContain(".vercel/");
  });
});
