// Vocabulary lint for owner- and agent-facing copy (docs/CARD_RAIL.md,
// spec section 5). The card rail may never be marketed with issuer-restricted
// or money-transmission vocabulary: the approved terms are "reserved card",
// "spend mandate up to $X", and "agent funds". This script fails the build
// when a banned term appears in README.md, packages/*/README.md,
// docs/marketing/**, the landing-page copy (site/index.html,
// site/copy-variants.md), or an MCP tool description in src/mcp/server.ts.
//
// Run directly (`npm run lint:vocabulary`) or through test/vocabulary.test.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Banned in all scanned copy. `deposit` and `bank account` are banned because
 * every scanned surface is owner-facing funding/card copy; factual negations
 * carry an explicit allowed context below. */
export const BANNED_TERMS = [
  { name: "prepaid", pattern: /\bprepaid\b/gi },
  { name: "debit card", pattern: /\bdebit\s+cards?\b/gi },
  { name: "P2P", pattern: /\bp2p\b/gi },
  { name: "send money", pattern: /\bsend(?:s|ing)?\s+money\b/gi },
  { name: "Member FDIC", pattern: /\bmember\s+fdic\b/gi },
  { name: "bank account", pattern: /\bbank\s+accounts?\b/gi },
  { name: "deposit", pattern: /\bdeposits?\b/gi },
];

/** A match whose surrounding text matches one of these is allowed:
 * - "prepaid credits" / "prepaid platform credits" / "prepaid-credits" name a
 *   competitor API-credit workaround in the discovery research instruments,
 *   not this product's card;
 * - the mandatory sandbox label ("nothing here is a bank, card, or deposit
 *   account") and the founder-vision/YC factual statements negate the concept
 *   rather than market with it (spec section 5 allow-list). */
export const ALLOWED_CONTEXTS = [
  // ">" tolerated because blockquoted markdown wraps across "> "-prefixed lines.
  /prepaid[\s>-]+(?:platform[\s>-]+)?credits?/i,
  /nothing (?:here|in this \w+) is a bank, card, or deposit account/i,
  /no company bank account/i,
];

function contextSlice(text, index, length) {
  return text.slice(Math.max(0, index - 100), index + length + 100);
}

/** Returns findings ({term, index, line, context}) for one text blob. */
export function scanText(text) {
  const findings = [];
  for (const { name, pattern } of BANNED_TERMS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const slice = contextSlice(text, match.index, match[0].length);
      if (ALLOWED_CONTEXTS.some((allowed) => allowed.test(slice))) continue;
      findings.push({
        term: name,
        index: match.index,
        line: text.slice(0, match.index).split("\n").length,
        context: slice.replace(/\s+/g, " ").trim(),
      });
    }
  }
  return findings;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) yield* walk(path);
    else if (/\.(md|txt)$/i.test(entry)) yield path;
  }
}

/** Every user-facing string in src/mcp/server.ts: tool descriptions (the
 * second argument of server.tool) and zod .describe() parameter strings. */
export function extractMcpDescriptions(source) {
  const strings = [];
  for (const match of source.matchAll(/server\.tool\(\s*"([^"]+)",\s*"((?:[^"\\]|\\.)*)"/g)) {
    strings.push({ label: `tool ${match[1]} description`, text: match[2] });
  }
  for (const match of source.matchAll(/\.describe\(\s*("(?:[^"\\]|\\.)*"(?:\s*\+\s*"(?:[^"\\]|\\.)*")*)/g)) {
    const text = match[1]
      .split(/\s*\+\s*/)
      .map((part) => JSON.parse(part))
      .join("");
    strings.push({ label: "parameter description", text });
  }
  return strings;
}

export function lintRepository(root = ROOT) {
  const problems = [];
  const files = [
    join(root, "README.md"),
    join(root, "site", "index.html"),
    join(root, "site", "copy-variants.md"),
    ...readdirSync(join(root, "packages"))
      .map((name) => join(root, "packages", name, "README.md"))
      .filter((path) => {
        try { return statSync(path).isFile(); } catch { return false; }
      }),
    ...walk(join(root, "docs", "marketing")),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const finding of scanText(text)) {
      problems.push(`${relative(root, file)}:${finding.line}: banned term "${finding.term}" — …${finding.context}…`);
    }
  }
  const mcpSource = readFileSync(join(root, "src", "mcp", "server.ts"), "utf8");
  for (const { label, text } of extractMcpDescriptions(mcpSource)) {
    for (const finding of scanText(text)) {
      problems.push(`src/mcp/server.ts (${label}): banned term "${finding.term}" — …${finding.context}…`);
    }
  }
  return problems;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const problems = lintRepository();
  if (problems.length) {
    console.error("vocabulary lint failed (docs/CARD_RAIL.md lexicon):");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log("vocabulary lint clean");
}
