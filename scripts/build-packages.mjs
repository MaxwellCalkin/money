import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Assembles the two publishable packages from src/ — no source duplication:
 *
 *   packages/wallet-mcp/dist/server.js  — the agent wallet MCP bin
 *   packages/seller-sdk/dist/index.js   — the seller SDK library
 *
 * Divergences from scripts/build.mjs are deliberate: target node20 (the
 * client closures need only Node >=18; the >=24 floor is a server-side
 * contract), no sourcemaps (tarballs carry no src/), a shebang banner on the
 * bin, and a hard guard that fails the build if a bundle acquires a bare
 * import outside its declared dependency list — the wallet's whole point is
 * that @x402/* and viem stay OUT of its tree (see src/bridge/x402-v2-wire.ts).
 */
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const PACKAGES = [
  {
    name: "wallet-mcp",
    entry: "src/mcp/server.ts",
    outfile: "packages/wallet-mcp/dist/server.js",
    banner: "#!/usr/bin/env node",
    allowedBareImports: ["@modelcontextprotocol/sdk", "zod"],
  },
  {
    name: "seller-sdk",
    entry: "src/seller/index.ts",
    outfile: "packages/seller-sdk/dist/index.js",
    allowedBareImports: [],
  },
];

function bareImportsOf(source) {
  // Static import/from, dynamic import, and CJS-interop require specifiers
  // that are neither relative nor node: builtins. esbuild emits a require()
  // of an external inside bundled CJS code as __require("pkg") — an import
  // shape that would throw at runtime under ESM, so it must fail the guard.
  const specifiers = [...source.matchAll(/from\s*"([^"]+)"|import\s*\(\s*"([^"]+)"\s*\)|import\s*"([^"]+)"|__require\(\s*"([^"]+)"\s*\)|require\(\s*"([^"]+)"\s*\)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5])
    .filter((spec) => spec && !spec.startsWith(".") && !spec.startsWith("node:"));
  return [...new Set(specifiers)];
}

for (const pkg of PACKAGES) {
  const outfile = join(projectRoot, pkg.outfile);
  await rm(dirname(outfile), { recursive: true, force: true });
  await build({
    entryPoints: [join(projectRoot, pkg.entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "external",
    legalComments: "none",
    logLevel: "info",
    ...(pkg.banner ? { banner: { js: pkg.banner } } : {}),
  });
  const output = await readFile(outfile, "utf8");
  if (pkg.banner && !output.startsWith(pkg.banner)) {
    throw new Error(`${pkg.name}: shebang banner missing from ${pkg.outfile}`);
  }
  const bare = bareImportsOf(output);
  const disallowed = bare.filter(
    (spec) => !pkg.allowedBareImports.some((allowed) => spec === allowed || spec.startsWith(`${allowed}/`)),
  );
  if (disallowed.length > 0) {
    throw new Error(
      `${pkg.name}: bundle acquired undeclared runtime dependencies: ${disallowed.join(", ")} — ` +
      "either declare them in the package manifest or keep them out of the import closure",
    );
  }
  console.log(`${pkg.name}: ${pkg.outfile} (${(output.length / 1024).toFixed(1)} KiB, bare imports: ${bare.join(", ") || "none"})`);
}
