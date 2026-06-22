import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClientSetup, writeClientSetup } from "../../src/shared/client-setup.js";

const tmp = () => mkdtempSync(join(tmpdir(), "clset-"));

describe("client-setup", () => {
  it("defaults to all-false when no file exists", () => {
    expect(readClientSetup(tmp())).toEqual({ claude: false, codex: false });
  });
  it("round-trips written state", () => {
    const dir = tmp();
    writeClientSetup(dir, { claude: true, codex: false });
    expect(readClientSetup(dir)).toEqual({ claude: true, codex: false });
  });
  it("creates the dir if missing", () => {
    const dir = join(tmp(), "nested", "deeper");
    writeClientSetup(dir, { claude: false, codex: true });
    expect(readClientSetup(dir).codex).toBe(true);
  });
  it("falls back to all-false on a corrupt file", () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "clients.json"), "{ not json");
    expect(readClientSetup(dir)).toEqual({ claude: false, codex: false });
  });
  it("coerces missing keys to false", () => {
    const dir = tmp();
    writeFileSync(join(dir, "clients.json"), JSON.stringify({ claude: true }));
    expect(readClientSetup(dir)).toEqual({ claude: true, codex: false });
  });
});
