import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { dataDir, dbPath, configPath } from "../../src/shared/paths.js";

describe("paths", () => {
  it("nests db/config under the data dir", () => {
    expect(dataDir("/home/u")).toBe(join("/home/u", ".llm-maestro"));
    expect(dbPath("/home/u")).toBe(join("/home/u", ".llm-maestro", "maestro.db"));
    expect(configPath("/home/u")).toBe(join("/home/u", ".llm-maestro", "config.json"));
  });
});
