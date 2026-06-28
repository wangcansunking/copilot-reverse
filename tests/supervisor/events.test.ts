import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../../src/supervisor/events.js";

describe("EventBus", () => {
  it("broadcasts and unsubscribes", () => {
    const bus = new EventBus();
    const a = vi.fn();
    const off = bus.subscribe(a);
    bus.emit("state", { x: 1 });
    off();
    bus.emit("state", { x: 2 });
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener neither aborts the broadcast nor escapes emit", () => {
    const bus = new EventBus();
    const bad = vi.fn(() => { throw new Error("socket destroyed"); });
    const good = vi.fn();
    bus.subscribe(bad);
    bus.subscribe(good);
    // The throw from `bad` must not prevent `good` from receiving the event, and must not propagate.
    expect(() => bus.emit("metric", { x: 1 })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("drops a faulting listener so it isn't retried on the next emit", () => {
    const bus = new EventBus();
    const bad = vi.fn(() => { throw new Error("socket destroyed"); });
    bus.subscribe(bad);
    bus.emit("metric", { x: 1 });
    bus.emit("metric", { x: 2 });
    expect(bad).toHaveBeenCalledTimes(1); // dropped after the first throw
  });
});
