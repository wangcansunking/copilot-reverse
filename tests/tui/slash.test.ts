import { describe, it, expect, vi } from "vitest";
import { buildRegistry } from "../../src/tui/slash/commands.js";

const endpoint = { host: "127.0.0.1", port: 7891, apiKey: "k" };

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
    const reg = buildRegistry(ctx() as any, endpoint);
    const out = await reg.run("/status");
    expect(out.join("\n")).toMatch(/worker: ready/i);
  });
  it("/restart calls client", async () => {
    const c = ctx();
    await buildRegistry(c as any, endpoint).run("/restart");
    expect(c.client.restart).toHaveBeenCalled();
  });
  it("/doctor lists checks", async () => {
    const out = await buildRegistry(ctx() as any, endpoint).run("/doctor");
    expect(out.join("\n")).toMatch(/github-auth.*ok/i);
  });
  it("/help lists commands", async () => {
    const out = await buildRegistry(ctx() as any, endpoint).run("/help");
    expect(out.join("\n")).toMatch(/\/status/);
  });
  it("unknown command", async () => {
    const out = await buildRegistry(ctx() as any, endpoint).run("/nope");
    expect(out.join("\n")).toMatch(/unknown/i);
  });
  it("/setup-claude prints ANTHROPIC_BASE_URL", async () => {
    const out = await buildRegistry(ctx() as any, endpoint).run("/setup-claude");
    expect(out.join("\n")).toMatch(/ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:7891\/anthropic/);
  });
  it("/metrics shows empty-state when no requests", async () => {
    const out = await buildRegistry(ctx() as any, endpoint).run("/metrics");
    expect(out.join("\n")).toMatch(/no requests yet/i);
  });
  it("/dashboard opens the dashboard url in the browser", async () => {
    const opened: string[] = [];
    const reg = buildRegistry(ctx() as any, endpoint, { dashboardUrl: "http://127.0.0.1:7890/", openUrl: (u) => opened.push(u) });
    const out = await reg.run("/dashboard");
    expect(opened).toEqual(["http://127.0.0.1:7890/"]);
    expect(out.join("\n")).toMatch(/127\.0\.0\.1:7890/);
  });
  it("/report opens a prefilled GitHub issue when a repo is configured", async () => {
    const opened: string[] = [];
    const reg = buildRegistry(ctx() as any, endpoint, { reportRepo: "octo/copilot-reverse", appVersion: "0.0.1", openUrl: (u) => opened.push(u) });
    await reg.run("/report");
    expect(opened[0]).toMatch(/^https:\/\/github\.com\/octo\/copilot-reverse\/issues\/new\?/);
  });
  it("/report guides the user to set a repo when unconfigured", async () => {
    const opened: string[] = [];
    const reg = buildRegistry(ctx() as any, endpoint, { openUrl: (u) => opened.push(u) });
    const out = await reg.run("/report");
    expect(opened).toHaveLength(0);
    expect(out.join("\n")).toMatch(/reportRepo/);
  });
  it("/reset-claude invokes the reset handler for claude", async () => {
    const calls: string[] = [];
    const reg = buildRegistry(ctx() as any, endpoint, { resetClient: async (c) => { calls.push(c); return [`removed ${c} config`]; } });
    const out = await reg.run("/reset-claude");
    expect(calls).toEqual(["claude"]);
    expect(out.join("\n")).toMatch(/removed claude config/);
  });
  it("/reset-codex invokes the reset handler for codex", async () => {
    const calls: string[] = [];
    const reg = buildRegistry(ctx() as any, endpoint, { resetClient: async (c) => { calls.push(c); return ["ok"]; } });
    await reg.run("/reset-codex");
    expect(calls).toEqual(["codex"]);
  });
  it("/login invokes the login handler", async () => {
    let called = false;
    const reg = buildRegistry(ctx() as any, endpoint, { login: async () => { called = true; return ["enter code: ABCD-1234"]; } });
    const out = await reg.run("/login");
    expect(called).toBe(true);
    expect(out.join("\n")).toMatch(/ABCD-1234/);
  });
  it("/logout invokes the logout handler", async () => {
    let called = false;
    const reg = buildRegistry(ctx() as any, endpoint, { logout: async () => { called = true; return ["signed out"]; } });
    const out = await reg.run("/logout");
    expect(called).toBe(true);
    expect(out.join("\n")).toMatch(/signed out/);
  });
  it("/login and /logout degrade gracefully when no handler is wired", async () => {
    const reg = buildRegistry(ctx() as any, endpoint);
    expect((await reg.run("/login")).join("\n")).toMatch(/not available/);
    expect((await reg.run("/logout")).join("\n")).toMatch(/not available/);
  });
});
