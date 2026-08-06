import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");

/** Same specifier extraction as scripts/build-packages.mjs bareImportsOf():
 * static import/from, dynamic import, and esbuild's __require CJS-interop
 * shape. Anchoring to import syntax (not raw substrings) keeps ordinary
 * string literals like "pg_..." from tripping the dependency assertions. */
function bareImportsOf(source: string): string[] {
  const specifiers = [...source.matchAll(/from\s*"([^"]+)"|import\s*\(\s*"([^"]+)"\s*\)|import\s*"([^"]+)"|__require\(\s*"([^"]+)"\s*\)|require\(\s*"([^"]+)"\s*\)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5])
    .filter((spec): spec is string => Boolean(spec) && !spec!.startsWith(".") && !spec!.startsWith("node:"));
  return [...new Set(specifiers)];
}

/** The published packages are assembled from src/ by scripts/build-packages.mjs.
 * This suite runs that build and pins its load-bearing invariants: the bin
 * shebang, the dependency guards (the wallet must never re-acquire @x402/* or
 * viem — see src/bridge/x402-v2-wire.ts), manifest/dependency agreement, and
 * the hand-written seller d.ts staying aligned with the source exports. */
describe("publishable packages", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [join(ROOT, "scripts", "build-packages.mjs")], {
      cwd: ROOT,
      stdio: "pipe",
    });
  }, 120_000);

  it("builds the wallet bin with a shebang and only its declared dependencies", () => {
    const bundle = readFileSync(join(ROOT, "packages/wallet-mcp/dist/server.js"), "utf8");
    expect(bundle.startsWith("#!/usr/bin/env node")).toBe(true);
    const imports = bareImportsOf(bundle);
    for (const forbidden of ["@x402/core", "@x402/evm", "@x402/extensions", "viem", "hono", "pg"]) {
      expect(
        imports.filter((spec) => spec === forbidden || spec.startsWith(`${forbidden}/`)),
        `wallet bundle must not import ${forbidden}`,
      ).toEqual([]);
    }
    expect(imports.every((spec) => spec.startsWith("@modelcontextprotocol/sdk") || spec === "zod")).toBe(true);
    const manifest = JSON.parse(readFileSync(join(ROOT, "packages/wallet-mcp/package.json"), "utf8")) as {
      bin: Record<string, string>;
      dependencies: Record<string, string>;
      files: string[];
      type: string;
    };
    expect(manifest.type).toBe("module");
    expect(Object.values(manifest.bin)).toEqual(["dist/server.js"]);
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@modelcontextprotocol/sdk", "zod"]);
    expect(manifest.files).toContain("dist");
  });

  it("builds the seller SDK with zero runtime dependencies", () => {
    const bundle = readFileSync(join(ROOT, "packages/seller-sdk/dist/index.js"), "utf8");
    // Every import specifier in the bundle must be a node: builtin.
    expect(bareImportsOf(bundle)).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(ROOT, "packages/seller-sdk/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies: Record<string, string>;
      exports: Record<string, { types: string; default: string }>;
    };
    expect(manifest.dependencies).toBeUndefined();
    expect(Object.keys(manifest.peerDependencies)).toEqual(["hono"]);
    expect(manifest.exports["."]!.types).toBe("./index.d.ts");
    expect(existsSync(join(ROOT, "packages/seller-sdk", manifest.exports["."]!.default))).toBe(true);
  });

  it("keeps the hand-written seller declarations aligned with the source exports", () => {
    const dts = readFileSync(join(ROOT, "packages/seller-sdk/index.d.ts"), "utf8");
    const source = readFileSync(join(ROOT, "src/seller/index.ts"), "utf8");
    for (const name of [
      "createMoneySellerClient",
      "moneyPaid",
      "secretFromEnv",
      "MoneySellerClientOptions",
      "MoneySellerOptions",
      "NetworkJson",
      "SellerNetworkResponse",
    ]) {
      expect(source, `src/seller/index.ts must export ${name}`).toContain(name);
      expect(dts, `index.d.ts must declare ${name}`).toContain(name);
    }
    // The bundle's runtime exports must all be declared.
    const bundle = readFileSync(join(ROOT, "packages/seller-sdk/dist/index.js"), "utf8");
    const exported = bundle.match(/export\s*\{([^}]+)\}/g)?.join(",") ?? "";
    for (const name of ["createMoneySellerClient", "moneyPaid", "secretFromEnv"]) {
      expect(exported, `bundle must export ${name}`).toContain(name);
    }
  });

  it("keeps package versions in lockstep with the MCP server's advertised version", () => {
    const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    const server = readFileSync(join(ROOT, "src/mcp/server.ts"), "utf8");
    expect(server).toContain(`version: "${root.version}"`);
    for (const pkg of ["packages/wallet-mcp/package.json", "packages/seller-sdk/package.json"]) {
      const manifest = JSON.parse(readFileSync(join(ROOT, pkg), "utf8")) as {
        version: string;
        private?: boolean;
        license: string;
        scripts: Record<string, string>;
      };
      expect(manifest.version, `${pkg} version`).toBe(root.version);
      expect(manifest.private, `${pkg} must be publishable`).toBeUndefined();
      expect(manifest.license, `${pkg} license`).toBe("Apache-2.0");
      // prepack rebuilds from src/ so stale or missing dist can never publish.
      expect(manifest.scripts.prepack).toBe("node ../../scripts/build-packages.mjs");
      expect(existsSync(join(ROOT, pkg, "..", "LICENSE")), `${pkg} LICENSE file`).toBe(true);
    }
  });
});
