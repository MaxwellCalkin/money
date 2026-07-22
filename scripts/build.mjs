import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(projectRoot, "dist");

const entryPoints = [
  "src/server/api.ts",
  "src/server/postgres-api.ts",
  "src/server/database-ops.ts",
  "src/mcp/server.ts",
  "src/db/migrate.ts",
  "src/db/reconcile.ts",
  "src/db/external-worker.ts",
  "src/db/external-key-rotation.ts",
  "src/treasury/webhook-server.ts",
  "src/treasury/event-worker.ts",
  "src/treasury/payout-worker.ts",
  "src/treasury/reconciler.ts",
  "src/treasury/setup.ts",
  "src/compliance/webhook-server.ts",
  "src/compliance/event-worker.ts",
  "src/compliance/onboarding-worker.ts",
  "src/compliance/review-worker.ts",
  "src/compliance/ops-server.ts",
  "src/compliance/console-server.ts",
  "src/compliance/operator-setup.ts",
  "src/compliance/operator-login.ts",
  "src/deploy/preflight.ts",
  "src/dashboard-login.ts",
  "src/onboard.ts",
  "src/onboard-seller.ts",
];

const namedEntryPoints = Object.fromEntries(entryPoints.map((entryPoint) => [
  entryPoint.slice("src/".length, -".ts".length),
  join(projectRoot, entryPoint),
]));

await rm(outputDirectory, { recursive: true, force: true });
const result = await build({
  absWorkingDir: projectRoot,
  entryPoints: namedEntryPoints,
  outdir: outputDirectory,
  entryNames: "[dir]/[name]",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  sourcesContent: false,
  legalComments: "none",
  metafile: true,
  logLevel: "info",
});
await writeFile(
  join(outputDirectory, "build-manifest.json"),
  `${JSON.stringify({ entryPoints, outputs: Object.keys(result.metafile.outputs).sort() }, null, 2)}\n`,
  "utf8",
);
