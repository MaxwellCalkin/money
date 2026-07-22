import { readFileSync } from "node:fs";

/** Resolve a secret from NAME or NAME_FILE. The _FILE form keeps long-lived
 * private keys out of shell history, process listings, and committed configs
 * such as .mcp.json; the file's first non-empty line is the secret. */
export function secretFromEnv(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const direct = env[name]?.trim();
  if (direct) return direct;
  const filePath = env[`${name}_FILE`]?.trim();
  if (!filePath) return undefined;
  const line = readFileSync(filePath, "utf8").split(/\r?\n/).find((entry) => entry.trim());
  if (!line) throw new Error(`${name}_FILE ${filePath} is empty`);
  return line.trim();
}
