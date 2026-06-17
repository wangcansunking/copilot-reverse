import { describe, it, expect, vi } from "vitest";
import { buildRegistry } from "../../src/tui/slash/commands.js";

function ctx() {
  return {
    client: {
      status: vi.fn(async () => ({ workerState: "ready", restarts: [{ ts: 1, reason: "crash", exitCode: 1, stderrTail: "boom", markedUnhealthy: 0 as const }] })),
      restart: vi.fn(async () => {}), stop: vi.fn(async () => {}), start: vi.fn(async () => {}),
      doctor: vi.fn(async () => [{ name: "github-auth", ok: true, detail: "ok" }]),
      requests: vi.fn(async () => []),
    },
    quit: vi.fn(),
  };
}

describe("slash commands", () => {
  it("dispatches /status", async () => {
    const reg = buildRegistry(ctx() as any);
    const out = await reg.run("/status");
    expect(out.join("\n")).toMatch(/worker: ready/i);
  });
  it("/restart calls client", async () => {
    const c = ctx();
    await buildRegistry(c as any).run("/restart");
    expect(c.client.restart).toHaveBeenCalled();
  });
  it("/doctor lists checks", async () => {
    const out = await buildRegistry(ctx() as any).run("/doctor");
    expect(out.join("\n")).toMatch(/github-auth.*ok/i);
  });
  it("/help lists commands", async () => {
    const out = await buildRegistry(ctx() as any).run("/help");
    expect(out.join("\n")).toMatch(/\/status/);
  });
  it("unknown command", async () => {
    const out = await buildRegistry(ctx() as any).run("/nope");
    expect(out.join("\n")).toMatch(/unknown/i);
  });
});
