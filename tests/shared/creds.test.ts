import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGhToken, writeGhToken, clearGhToken, hasGhTokenFile } from "../../src/shared/creds.js";

describe("creds", () => {
  it("round-trips a token", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeGhToken("gho_abc", d);
    expect(readGhToken(d)).toBe("gho_abc");
  });
  it("null when absent", () => {
    expect(readGhToken(mkdtempSync(join(tmpdir(), "m-")))).toBeNull();
  });
  it("returns null (does not throw) on a corrupt creds.json", () => {
    // A partial write / locked read must not throw: readGhToken runs on the heartbeat tick whose
    // rejection would kill the TUI. An unreadable file reads as "no token".
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeFileSync(join(d, "creds.json"), "{ this is not valid json");
    expect(() => readGhToken(d)).not.toThrow();
    expect(readGhToken(d)).toBeNull();
  });
  it("hasGhTokenFile reports existence, even when the contents are unparseable", () => {
    // The signed-out gate uses existence, not a parse: a corrupt-but-present file is a real (if
    // momentarily unreadable) login, so it must NOT read as signed out.
    const d = mkdtempSync(join(tmpdir(), "m-"));
    expect(hasGhTokenFile(d)).toBe(false);
    writeFileSync(join(d, "creds.json"), "{ corrupt");
    expect(hasGhTokenFile(d)).toBe(true);   // present despite readGhToken(d) === null
    expect(readGhToken(d)).toBeNull();
  });
  it("clearGhToken removes the stored token (and is a no-op when absent)", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeGhToken("gho_abc", d);
    clearGhToken(d);
    expect(readGhToken(d)).toBeNull();
    expect(() => clearGhToken(d)).not.toThrow(); // safe to call again
  });
});
