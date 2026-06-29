import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { App, cardRows } from "../../src/tui/app.js";
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
    expect(f).toMatch(/github.*✗ \/login/);
  });

  it("footer shows github ✓ when the heartbeat reports connected", async () => {
    const statusSource = async () => ({ workerState: "ready" as const, restarts: [], github: { ok: true, hasToken: true, checkedAt: 1, detail: "token valid" } });
    const { lastFrame } = render(<App registry={reg()} title="m" statusSource={statusSource} />);
    await new Promise((r) => setTimeout(r, 60));
    expect(lastFrame() ?? "").toMatch(/github.*✓/);
  });

  it("/status does a live githubStatus() check rather than trusting the cached heartbeat (which can be stale)", async () => {
    // Live check says "expired" (token just revoked); the cached heartbeat still reads "connected".
    // /status must reflect the fresh live result, not the up-to-60s-stale cache.
    const githubStatus = vi.fn(async () => "expired" as const);
    const statusSource = async () => ({ workerState: "ready" as const, restarts: [], github: { ok: true, hasToken: true, checkedAt: 1, detail: "token valid" } });
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" statusSource={statusSource} githubStatus={githubStatus} startupStatus={{ github: "connected", webSearch: "webiq", worker: "ready", clients: { claude: false, codex: false } } as any} />);
    await new Promise((r) => setTimeout(r, 60)); // poll populates the cached 'connected' state
    stdin.write("/status");
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 80));
    const f = lastFrame() ?? "";
    expect(githubStatus).toHaveBeenCalled();  // /status is authoritative: it runs the live check
    expect(f).toMatch(/expired/i);            // and reflects the live result, not the stale cache
  });

  it("a command whose output smuggles in a newline still renders (defense-in-depth)", async () => {
    // End-to-end smoke: a line with an embedded newline must not crash the card and all content
    // survives. The border-integrity guarantee itself is unit-tested via cardRows() below — a
    // TTY-less render harness pads the box to a fixed width and can't reproduce the visual break.
    const r = new Registry({ client: {} as any, quit: vi.fn() });
    r.add({ name: "/boom", describe: "x", run: async () => ["first\nsecond bled through", "tail"] });
    const { stdin, lastFrame } = render(<App registry={r} title="m" />);
    await new Promise((res) => setTimeout(res, 30));
    stdin.write("/boom");
    await new Promise((res) => setTimeout(res, 20));
    stdin.write("\r");
    await new Promise((res) => setTimeout(res, 60));
    const frame = lastFrame() ?? "";
    for (const word of ["first", "second", "tail"]) expect(frame).toContain(word);
  });
});

describe("cardRows", () => {
  it("explodes embedded newlines into separate physical rows", () => {
    // The core defense: no returned row may contain a newline, so no single <Text> can ever carry one
    // into the box and break the border. CRLF and LF both split.
    const out = cardRows(["a\nb", "c\r\nd", "plain"]);
    expect(out).toEqual(["a", "b", "c", "d", "plain"]);
    for (const row of out) expect(row).not.toMatch(/\r?\n/);
  });
  it("leaves single-line input untouched", () => {
    expect(cardRows(["one", "two"])).toEqual(["one", "two"]);
  });
});
