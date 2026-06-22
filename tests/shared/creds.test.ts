import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGhToken, writeGhToken, clearGhToken } from "../../src/shared/creds.js";

describe("creds", () => {
  it("round-trips a token", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeGhToken("gho_abc", d);
    expect(readGhToken(d)).toBe("gho_abc");
  });
  it("null when absent", () => {
    expect(readGhToken(mkdtempSync(join(tmpdir(), "m-")))).toBeNull();
  });
  it("clearGhToken removes the stored token (and is a no-op when absent)", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeGhToken("gho_abc", d);
    clearGhToken(d);
    expect(readGhToken(d)).toBeNull();
    expect(() => clearGhToken(d)).not.toThrow(); // safe to call again
  });
});
