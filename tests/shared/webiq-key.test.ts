import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWebIqKey, writeWebIqKey, clearWebIqKey, readWebSearchMode, writeWebSearchMode, resolveWebSearchBackend, COPILOT_WEB_SEARCH_ENABLED } from "../../src/shared/webiq-key.js";

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

  it("defaults the web-search mode to copilot", () => {
    expect(readWebSearchMode(mkdtempSync(join(tmpdir(), "m-")))).toBe("copilot");
  });
  it("round-trips the web-search mode without disturbing the key", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeWebIqKey("k_abc", d);
    writeWebSearchMode(d, "webiq");
    expect(readWebSearchMode(d)).toBe("webiq");
    expect(readWebIqKey(d)).toBe("k_abc"); // key preserved across a mode write
  });
  it("clearWebIqKey also resets the mode to copilot", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeWebIqKey("k_abc", d);
    writeWebSearchMode(d, "webiq");
    clearWebIqKey(d);
    expect(readWebSearchMode(d)).toBe("copilot");
  });
});

describe("resolveWebSearchBackend", () => {
  // While Copilot (borrow gpt-5-mini) search is disabled, web search MUST go through WebIQ; with no key
  // it is unavailable (the runner then tells the user to run /webiq). These tests pin BOTH flag states
  // so re-enabling Copilot search later is a deliberate, tested flip — not a silent regression.
  it("is currently configured with Copilot web search DISABLED", () => {
    expect(COPILOT_WEB_SEARCH_ENABLED).toBe(false);
  });

  describe("with Copilot search disabled (current default)", () => {
    const resolve = (mode: "copilot" | "webiq", hasKey: boolean) => resolveWebSearchBackend(mode, hasKey, false);
    it("uses WebIQ whenever a key is present, regardless of mode", () => {
      expect(resolve("webiq", true)).toBe("webiq");
      expect(resolve("copilot", true)).toBe("webiq");
    });
    it("is unavailable when no key is present", () => {
      expect(resolve("webiq", false)).toBe("unavailable");
      expect(resolve("copilot", false)).toBe("unavailable");
    });
  });

  describe("with Copilot search enabled (future re-enable)", () => {
    const resolve = (mode: "copilot" | "webiq", hasKey: boolean) => resolveWebSearchBackend(mode, hasKey, true);
    it("borrows via copilot by default (no key needed)", () => {
      expect(resolve("copilot", false)).toBe("copilot");
    });
    it("uses WebIQ when in webiq mode with a key, else falls back to copilot borrow", () => {
      expect(resolve("webiq", true)).toBe("webiq");
      expect(resolve("webiq", false)).toBe("copilot");
    });
  });
});
