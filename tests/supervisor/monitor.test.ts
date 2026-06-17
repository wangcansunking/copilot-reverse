import { describe, it, expect } from "vitest";
import { RestartController } from "../../src/supervisor/monitor.js";
import { defaultConfig } from "../../src/shared/config.js";

describe("RestartController", () => {
  it("exponential backoff capped", () => {
    const c = new RestartController(defaultConfig().restart, () => 0);
    expect(c.onCrash().backoffMs).toBe(500);
    expect(c.onCrash().backoffMs).toBe(1000);
    expect(c.onCrash().backoffMs).toBe(2000);
  });
  it("unhealthy after maxCrashes in window", () => {
    let now = 0;
    const c = new RestartController(defaultConfig().restart, () => now);
    let last = c.onCrash();
    for (let i = 0; i < 4; i++) { now += 1000; last = c.onCrash(); }
    expect(last.markedUnhealthy).toBe(true);
  });
  it("healthy when spread beyond window", () => {
    let now = 0;
    const c = new RestartController(defaultConfig().restart, () => now);
    for (let i = 0; i < 4; i++) { now += 20_000; c.onCrash(); }
    expect(c.onCrash().markedUnhealthy).toBe(false);
  });
});
