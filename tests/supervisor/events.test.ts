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
});
