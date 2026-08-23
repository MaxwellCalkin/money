import { describe, expect, it } from "vitest";
import { runCardDemo } from "../src/demo-card.ts";

/**
 * The card demo is a distribution artifact: its transcript is committed to
 * docs/marketing/demo/agent-card-transcript.md. This test runs the demo's main
 * function in-process and pins the story beats the transcript sells — the $29
 * approval, the $400 gift-card decline with its exact code, the agent-to-agent
 * payment — and proves nothing PAN-shaped ever reaches the transcript.
 */
describe("card rail demo", () => {
  it("tells the full sandbox story, exits cleanly, and never prints a PAN-shaped digit run", async () => {
    const lines: string[] = [];
    // Resolving without throwing is the demo's "exit 0": the CLI wrapper in
    // src/demo-card.ts exits nonzero only when runCardDemo rejects.
    await expect(runCardDemo((line) => lines.push(line))).resolves.toBeUndefined();
    const output = lines.join("\n");

    // Sandbox labeling (required lexicon) opens and closes the transcript.
    expect(output).toContain("SANDBOX — no real funds; nothing here is a bank, card, or deposit account.");

    // The $29 approval at the ordinary merchant, inside the issuer deadline.
    expect(output).toContain("APPROVED · $29.00 at MOCK SHOP EXAMPLE (MCC 5734)");
    expect(output).toContain("decision latency: <2 s");

    // The $400 gift-card attempt is visibly declined with the exact code and
    // a plain-words reason.
    expect(output).toContain("DECLINED · $400.00 at GIFT CARD EMPORIUM (MCC 6051)");
    expect(output).toContain("decline code: new_payee_cap");
    expect(output).toMatch(/new-payee cap/);

    // The $5 agent-to-agent payment on the internal rail.
    expect(output).toContain("@scout paid @writer-agent $5.00");

    // One feed carrying both rails, and the recomputed ledger verdict.
    expect(output).toContain("card:mock-shop.example");
    expect(output).toContain("ledger_health: zero-sum true · receipt evidence recomputed from the ledger: true");

    // The demo prints no ids, hashes, or timestamps, so the sweep is strict:
    // no 13-19 digit run may appear anywhere in the output — a PAN could
    // never hide in a transcript that stays below that bar.
    expect(output).not.toMatch(/\d{13,19}/);
  }, 240_000);
});
