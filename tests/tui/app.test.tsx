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
    const { stdin, lastFrame } = render(<App registry={reg()} title="copilot-reverse" />);
    expect(lastFrame()).toContain("copilot-reverse");
    // let Ink's useInput subscribe to stdin before typing (avoids a write/subscribe race)
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("/ping");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r"); // Enter
    await new Promise((r) => setTimeout(r, 60)); // async registry.run + re-render
    expect(lastFrame()).toContain("pong");
  });

  it("shows the worker-state badge in the header", () => {
    const { lastFrame } = render(<App registry={reg()} title="copilot-reverse" workerState="ready" />);
    expect(lastFrame()).toContain("worker: ready");
  });

  it("shows a loading indicator while the assistant streams, landing deltas in one bubble", async () => {
    let release: () => void = () => {};
    const turnOpen = new Promise<void>((r) => { release = r; });
    const onChat = async (_text: string, print: (l: string) => void) => {
      print("Hel");
      print("lo");
      await turnOpen; // hold the turn open so the loading/streaming state is observable
    };
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" onChat={onChat} />);
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("hello there");
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 60));
    const mid = lastFrame() ?? "";
    // both deltas concatenated into a single assistant bubble (not two separate "Hel"/"lo" lines)
    expect(mid).toContain("Hello");
    expect(mid.match(/Hello/g)?.length).toBe(1);
    // a loading/streaming indicator is visible while the turn is still open
    expect(mid).toMatch(/▍|…|thinking/i);
    release();
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

  it("reflects the heartbeat github state in the footer (expired → ✗ /login)", async () => {
    const statusSource = async () => ({ workerState: "ready" as const, restarts: [], github: { ok: false, hasToken: true, checkedAt: 1, detail: "expired" } });
    const { lastFrame } = render(<App registry={reg()} title="m" statusSource={statusSource} />);
    await new Promise((r) => setTimeout(r, 60)); // let the immediate poll tick land
    const f = lastFrame() ?? "";
    expect(f).toMatch(/登录.*✗ \/login/);
  });

  it("footer shows 登录 ✓ when the heartbeat reports connected", async () => {
    const statusSource = async () => ({ workerState: "ready" as const, restarts: [], github: { ok: true, hasToken: true, checkedAt: 1, detail: "token valid" } });
    const { lastFrame } = render(<App registry={reg()} title="m" statusSource={statusSource} />);
    await new Promise((r) => setTimeout(r, 60));
    expect(lastFrame() ?? "").toMatch(/登录.*✓/);
  });

  it("/status uses the cached heartbeat value and does NOT make a redundant githubStatus call", async () => {
    const githubStatus = vi.fn(async () => "connected" as const);
    const statusSource = async () => ({ workerState: "ready" as const, restarts: [], github: { ok: false, hasToken: true, checkedAt: 1, detail: "expired" } });
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" statusSource={statusSource} githubStatus={githubStatus} startupStatus={{ github: "connected", webSearch: "webiq", worker: "ready", clients: { claude: false, codex: false } } as any} />);
    await new Promise((r) => setTimeout(r, 60)); // poll populates the cached 'expired' state
    stdin.write("/status");
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 80));
    const f = lastFrame() ?? "";
    expect(f).toMatch(/expired/i);       // card reflects the cached heartbeat value, not startup's "connected"
    expect(githubStatus).not.toHaveBeenCalled(); // cached → no redundant network check
  });
});
