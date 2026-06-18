import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../../src/tui/app.js";
import { Registry } from "../../src/tui/slash/registry.js";

function reg() {
  const r = new Registry({ client: {} as any, quit: vi.fn() });
  r.add({ name: "/ping", describe: "ping", run: async () => ["pong"] });
  return r;
}

describe("App", () => {
  it("renders a prompt and runs a slash command on submit", async () => {
    const { stdin, lastFrame } = render(<App registry={reg()} title="maestro" />);
    expect(lastFrame()).toContain("maestro");
    // let Ink's useInput subscribe to stdin before typing (avoids a write/subscribe race)
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("/ping");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r"); // Enter
    await new Promise((r) => setTimeout(r, 60)); // async registry.run + re-render
    expect(lastFrame()).toContain("pong");
  });

  it("shows the worker-state badge in the header", () => {
    const { lastFrame } = render(<App registry={reg()} title="maestro" workerState="ready" />);
    expect(lastFrame()).toContain("worker: ready");
  });

  it("Enter runs the highlighted suggestion, not the raw typed prefix", async () => {
    const r = new Registry({ client: {} as any, quit: vi.fn() });
    r.add({ name: "/setup-claude", describe: "c", run: async () => ["ran-claude"] });
    const { stdin, lastFrame } = render(<App registry={r} title="m" />);
    await new Promise((res) => setTimeout(res, 30));
    stdin.write("/setup"); // "/setup" is not a command; the popup highlights /setup-claude
    await new Promise((res) => setTimeout(res, 20));
    stdin.write("\r"); // Enter must run the highlighted /setup-claude, not "/setup"
    await new Promise((res) => setTimeout(res, 60));
    const frame = lastFrame();
    expect(frame).toContain("ran-claude");
    expect(frame).not.toContain("unknown command");
  });
});
