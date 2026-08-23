import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain-mjs helper without type declarations
import { extractMcpDescriptions, lintRepository, scanText } from "../scripts/lint-vocabulary.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/** The card-rail lexicon (docs/CARD_RAIL.md, spec section 5) is enforced, not
 * aspirational: banned issuer-marketing and money-transmission terms fail the
 * build wherever owner- or agent-facing copy lives. */
describe("vocabulary lint", () => {
  it("catches every banned term", () => {
    const text = [
      "a prepaid card for your agent",
      "works like a debit card",
      "P2P payments between agents",
      "send money to a friend's agent",
      "Member FDIC",
      "link your bank account",
      "deposit funds to get started",
    ].join("\n");
    const found = new Set(scanText(text).map((finding: { term: string }) => finding.term));
    expect([...found].sort()).toEqual([
      "Member FDIC", "P2P", "bank account", "debit card", "deposit", "prepaid", "send money",
    ]);
  });

  it("allows the documented negations and the API-credit workaround phrasing", () => {
    expect(scanText("Prepaid credits and hope? Also prepaid platform credits.")).toEqual([]);
    expect(scanText("sandbox, no real funds; nothing here is a bank, card, or deposit account")).toEqual([]);
    expect(scanText("No company bank account (no entity yet); founder-funded.")).toEqual([]);
    // The allowance is contextual, not a free pass for the bare word.
    expect(scanText("prepaid card").map((finding: { term: string }) => finding.term)).toEqual(["prepaid"]);
  });

  it("extracts MCP tool and parameter descriptions", () => {
    const source = `
      server.tool(
        "money_card_create",
        "Create a reserved virtual card under the owner's spend mandate.",
        { amount_usd: z.number().describe("the card's cap in dollars") },
        async () => {}
      );
    `;
    const extracted = extractMcpDescriptions(source) as Array<{ label: string; text: string }>;
    expect(extracted.map((entry) => entry.text)).toEqual([
      "Create a reserved virtual card under the owner's spend mandate.",
      "the card's cap in dollars",
    ]);
  });

  it("passes on the repository's actual copy surfaces", () => {
    expect(lintRepository(ROOT)).toEqual([]);
  });

  it("exits zero as the npm script", () => {
    const output = execFileSync(process.execPath, [join(ROOT, "scripts", "lint-vocabulary.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(output).toContain("vocabulary lint clean");
  });
});
