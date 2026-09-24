// Build Output API (v3) producer for the hosted sandbox beta on Vercel. Cribbed
// from scripts/build.mjs, but this one bundles ONE entry (dependencies
// included) into `.vercel/output/functions/api.func/` — the main product
// function by default, the public metrics function under
// MONEY_VERCEL_ENTRY=metrics — and, for the main entry, copies the landing
// page into `static/` and writes the routing config. No framework detection:
// vercel.json sets `framework: null` and `buildCommand` to this script.
//
// Build-time variables:
//   MONEY_VERCEL_ENTRY       `metrics` selects the metrics entry; unset = main.
//   MONEY_METRICS_ORIGIN     main only: `https://<metrics project host>`. When
//                            set, /metrics* and /receipts/* are rewritten to
//                            it; when unset the script warns and those paths
//                            reach the main function (which answers 404).
//   MONEY_VERCEL_OUTPUT_DIR  output directory override (tests build into a
//                            scratch directory); default `.vercel/output`.
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const entryKind = process.env.MONEY_VERCEL_ENTRY?.trim() === "metrics" ? "metrics" : "main";
const configuredOutput = process.env.MONEY_VERCEL_OUTPUT_DIR?.trim();
const outputDirectory = configuredOutput
  ? (isAbsolute(configuredOutput) ? configuredOutput : resolve(projectRoot, configuredOutput))
  : join(projectRoot, ".vercel", "output");
const functionDirectory = join(outputDirectory, "functions", "api.func");
const entryPoint = entryKind === "metrics"
  ? "src/deploy/vercel-metrics-entry.ts"
  : "src/deploy/vercel-entry.ts";

const STATIC_HEADERS = {
  "content-security-policy":
    "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** `shouldAddHelpers: false` is load-bearing: the helpers pre-parse request
 * bodies, which would break raw-body HMAC verification on /webhooks/* and the
 * signed-body hash on every signed product route. */
const FUNCTION_CONFIG = {
  runtime: "nodejs24.x",
  handler: "index.js",
  launcherType: "Nodejs",
  shouldAddHelpers: false,
  maxDuration: 60,
  regions: ["iad1"],
};

/** The metrics project's production origin: https, host only. Anything else
 * fails the build rather than silently rewriting the public metrics path to
 * the wrong place. */
function metricsOrigin() {
  const raw = process.env.MONEY_METRICS_ORIGIN?.trim();
  if (!raw) return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MONEY_METRICS_ORIGIN must be an absolute https:// origin");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== "/" || raw.endsWith("/")) {
    throw new Error("MONEY_METRICS_ORIGIN must be https://<host> with no path, query, fragment, credentials, or trailing slash");
  }
  return url.origin;
}

function mainRoutes(origin) {
  return [
    { src: "/(index\\.html)?", headers: STATIC_HEADERS, continue: true },
    ...(origin
      ? [
        { src: "/metrics(.*)", dest: `${origin}/metrics$1` },
        { src: "/receipts/(.*)", dest: `${origin}/receipts/$1` },
      ]
      : []),
    { handle: "filesystem" },
    { src: "/(.*)", dest: "/api" },
  ];
}

const origin = entryKind === "main" ? metricsOrigin() : undefined;
if (entryKind === "main" && !origin) {
  console.warn("MONEY_METRICS_ORIGIN is unset: /metrics* and /receipts/* will not be rewritten to the metrics project");
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(functionDirectory, { recursive: true });

await build({
  absWorkingDir: projectRoot,
  entryPoints: { index: join(projectRoot, entryPoint) },
  outdir: functionDirectory,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["pg-native"],
  legalComments: "none",
  sourcemap: false,
  // pg's lazy `native` getter and its pgpass/connection-string helpers are CJS
  // `require`s inside this ESM bundle; give them a real require.
  banner: {
    js: 'import { createRequire as __moneyCreateRequire } from "node:module"; const require = __moneyCreateRequire(import.meta.url);',
  },
  logLevel: "info",
});

await writeFile(join(functionDirectory, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`, "utf8");
await writeFile(join(functionDirectory, ".vc-config.json"), `${JSON.stringify(FUNCTION_CONFIG, null, 2)}\n`, "utf8");

if (entryKind === "main") {
  await mkdir(join(outputDirectory, "static"), { recursive: true });
  await copyFile(join(projectRoot, "site", "index.html"), join(outputDirectory, "static", "index.html"));
  await writeFile(
    join(outputDirectory, "config.json"),
    `${JSON.stringify({ version: 3, routes: mainRoutes(origin) }, null, 2)}\n`,
    "utf8",
  );
} else {
  await writeFile(
    join(outputDirectory, "config.json"),
    `${JSON.stringify({ version: 3, routes: [{ src: "/(.*)", dest: "/api" }] }, null, 2)}\n`,
    "utf8",
  );
}

console.log(`vercel build output (${entryKind}) written to ${outputDirectory}`);
