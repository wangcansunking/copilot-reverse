import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWebIqKey, writeWebIqKey, clearWebIqKey } from "../../src/shared/webiq-key.js";

describe("webiq-key", () => {
  const prev = process.env.WEBIQ_API_KEY;
  beforeEach(() => { delete process.env.WEBIQ_API_KEY; });
  afterEach(() => { if (prev === undefined) delete process.env.WEBIQ_API_KEY; else process.env.WEBIQ_API_KEY = prev; });

  it("round-trips a key", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeWebIqKey("k_abc", d);
    expect(readWebIqKey(d)).toBe("k_abc");
  });
  it("null when absent", () => {
    expect(readWebIqKey(mkdtempSync(join(tmpdir(), "m-")))).toBeNull();
  });
  it("clearWebIqKey removes the key (and is a no-op when absent)", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeWebIqKey("k_abc", d);
    clearWebIqKey(d);
    expect(readWebIqKey(d)).toBeNull();
    expect(() => clearWebIqKey(d)).not.toThrow();
  });
  it("env WEBIQ_API_KEY overrides the file", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeWebIqKey("from_file", d);
    process.env.WEBIQ_API_KEY = "from_env";
    expect(readWebIqKey(d)).toBe("from_env");
  });
});
