import { describe, it, expect } from "vitest";
import { defaultConfig, mergeConfig } from "../../src/shared/config.js";

describe("config", () => {
  it("defaults", () => {
    const c = defaultConfig();
    expect(c.supervisorPort).toBe(7890);
    expect(c.workerPort).toBe(7891);
    expect(c.bindHost).toBe("127.0.0.1");
    expect(c.restart.maxCrashes).toBe(5);
    expect(c.modelMap).toEqual({}); // pass-through routing by default
  });
  it("deep merges", () => {
    const c = mergeConfig(defaultConfig(), { restart: { maxCrashes: 3 } });
    expect(c.restart.maxCrashes).toBe(3);
    expect(c.restart.windowMs).toBe(60_000);
  });
});
