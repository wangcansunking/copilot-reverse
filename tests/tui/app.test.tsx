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
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("/ping");
    stdin.write("\r"); // Enter
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain("pong");
  });

  it("shows the worker-state badge in the header", () => {
    const { lastFrame } = render(<App registry={reg()} title="maestro" workerState="ready" />);
    expect(lastFrame()).toContain("worker: ready");
  });
});
