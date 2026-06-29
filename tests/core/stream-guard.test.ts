import { describe, it, expect } from "vitest";
import { RunawayGuard } from "../../src/core/stream-guard.js";

describe("RunawayGuard", () => {
  it("trips on a short delta repeated past the limit", () => {
    const g = new RunawayGuard({ maxRepeats: 50 });
    let tripped = false;
    for (let i = 0; i < 200; i++) tripped = g.push("code\n") || tripped;
    expect(tripped).toBe(true);
    expect(g.reason).toBe("repetition");
  });

  it("does not trip on varied text", () => {
    const g = new RunawayGuard({ maxRepeats: 50 });
    let tripped = false;
    for (let i = 0; i < 200; i++) tripped = g.push(`line ${i} `) || tripped;
    expect(tripped).toBe(false);
  });

  it("trips when total output exceeds the cap", () => {
    const g = new RunawayGuard({ maxOutputChars: 100 });
    let tripped = false;
    for (let i = 0; i < 50; i++) tripped = g.push(`chunk-${i} `) || tripped;
    expect(tripped).toBe(true);
    expect(g.reason).toBe("max_output");
  });

  it("tolerates a few repeats then variety (counter resets)", () => {
    const g = new RunawayGuard({ maxRepeats: 50 });
    for (let i = 0; i < 10; i++) expect(g.push("a")).toBe(false);
    expect(g.push("b")).toBe(false);
    for (let i = 0; i < 10; i++) expect(g.push("a")).toBe(false);
  });
});
