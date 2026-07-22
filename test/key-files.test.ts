import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { secretFromEnv } from "../src/core/key-files.ts";

const dir = mkdtempSync(join(tmpdir(), "money-key-files-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("secretFromEnv", () => {
  it("prefers the inline variable and trims it", () => {
    expect(secretFromEnv("MONEY_TEST_KEY", { MONEY_TEST_KEY: "  inline-secret \n" }))
      .toBe("inline-secret");
  });

  it("reads the first non-empty line of the _FILE form", () => {
    const path = join(dir, "agent.key");
    writeFileSync(path, "\n\nfile-secret\nsecond-line\n", "utf8");
    expect(secretFromEnv("MONEY_TEST_KEY", { MONEY_TEST_KEY_FILE: path })).toBe("file-secret");
  });

  it("lets the inline variable win when both forms are set", () => {
    const path = join(dir, "shadowed.key");
    writeFileSync(path, "file-secret\n", "utf8");
    expect(secretFromEnv("MONEY_TEST_KEY", {
      MONEY_TEST_KEY: "inline-secret",
      MONEY_TEST_KEY_FILE: path,
    })).toBe("inline-secret");
  });

  it("returns undefined when neither form is configured", () => {
    expect(secretFromEnv("MONEY_TEST_KEY", {})).toBeUndefined();
    expect(secretFromEnv("MONEY_TEST_KEY", { MONEY_TEST_KEY: "   " })).toBeUndefined();
  });

  it("fails loudly on an empty key file instead of authenticating with nothing", () => {
    const path = join(dir, "empty.key");
    writeFileSync(path, "\n  \n", "utf8");
    expect(() => secretFromEnv("MONEY_TEST_KEY", { MONEY_TEST_KEY_FILE: path }))
      .toThrow(/is empty/);
  });

  it("fails loudly on a missing key file", () => {
    expect(() => secretFromEnv("MONEY_TEST_KEY", {
      MONEY_TEST_KEY_FILE: join(dir, "does-not-exist.key"),
    })).toThrow();
  });
});
