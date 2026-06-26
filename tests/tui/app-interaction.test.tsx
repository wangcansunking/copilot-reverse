// Deep TUI interaction tests — render the real Ink <App>, drive it via stdin, and assert on the
// rendered frames. These cover user-facing flows the basic app.test.tsx doesn't: esc-to-interrupt,
// error rendering, HUD per-scope badges (read from a status fn), reset flipping the badge, the
// model picker, multi-turn streaming, and Repl autocomplete navigation.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../../src/tui/app.js";
import { Registry } from "../../src/tui/slash/registry.js";
import type { ClientStatus } from "../../src/tui/setup/status.js";

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
function reg(extra?: (r: Registry) => void) {
  const r = new Registry({ client: {} as any, quit: vi.fn() });
  r.add({ name: "/ping", describe: "ping", run: async () => ["pong"] });
  extra?.(r);
  return r;
}
const STATUS = (over: Partial<ClientStatus> = {}): ClientStatus => ({
  claude: { user: false, project: false }, codex: { user: false, project: false }, ...over,
});

describe("TUI: HUD client badges (from the real status fn)", () => {
  it("renders per-scope user/project markers for claude and codex", () => {
    const readStatus = () => STATUS({ claude: { user: true, project: false }, codex: { user: false, project: true } });
    const { lastFrame } = render(<App registry={reg()} title="m" readStatus={readStatus} />);
    const f = lastFrame() ?? "";
    expect(f).toMatch(/claude u:✓ p:○/);
    expect(f).toMatch(/codex u:○ p:✓/);
  });
});

describe("TUI: assistant errors are rendered (not swallowed)", () => {
  it("shows an error line when onChat prints an error", async () => {
    const onChat = async (_t: string, print: (l: string) => void) => { print("assistant error: boom"); };
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" onChat={onChat} />);
    await tick();
    stdin.write("hi there");
    await tick();
    stdin.write("\r");
    await tick(80);
    expect(lastFrame()).toContain("assistant error: boom");
  });
});

describe("TUI: esc interrupts an in-flight turn", () => {
  it("aborts the turn and the abort signal fires", async () => {
    let aborted = false;
    const onChat = (_t: string, _p: (l: string) => void, _m?: string, abort?: AbortController) =>
      new Promise<void>((resolve) => {
        abort?.signal.addEventListener("abort", () => { aborted = true; resolve(); });
      });
    const { stdin } = render(<App registry={reg()} title="m" onChat={onChat} />);
    await tick();
    stdin.write("do something long");
    await tick();
    stdin.write("\r");          // start the turn
    await tick();
    stdin.write("\x1b");        // ESC
    await tick(80);
    expect(aborted).toBe(true);
  });
});

describe("TUI: multi-turn streaming keeps answers distinct", () => {
  it("each turn lands in its own bubble", async () => {
    let n = 0;
    const onChat = async (_t: string, print: (l: string) => void) => { n++; print(`answer-${n}`); };
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" onChat={onChat} />);
    await tick();
    stdin.write("q1"); await tick(); stdin.write("\r"); await tick(80);
    stdin.write("q2"); await tick(); stdin.write("\r"); await tick(80);
    const f = lastFrame() ?? "";
    expect(f).toContain("answer-1");
    expect(f).toContain("answer-2");
  });
});

describe("TUI: Repl autocomplete navigation", () => {
  it("down-arrow moves the highlight so Enter runs the second match", async () => {
    const r = new Registry({ client: {} as any, quit: vi.fn() });
    r.add({ name: "/setup-claude", describe: "a", run: async () => ["ran-claude"] });
    r.add({ name: "/setup-codex", describe: "b", run: async () => ["ran-codex"] });
    const { stdin, lastFrame } = render(<App registry={r} title="m" />);
    await tick();
    stdin.write("/setup");        // popup shows both, highlights the first
    await tick();
    stdin.write("\x1b[B");        // Down arrow -> highlight /setup-codex
    await tick();
    stdin.write("\r");
    await tick(80);
    const f = lastFrame() ?? "";
    expect(f).toContain("ran-codex");
    expect(f).not.toContain("ran-claude");
  });

  it("tab completes the highlighted command without running it", async () => {
    const r = new Registry({ client: {} as any, quit: vi.fn() });
    r.add({ name: "/doctor", describe: "d", run: async () => ["health-ok"] });
    const { stdin, lastFrame } = render(<App registry={r} title="m" />);
    await tick();
    stdin.write("/doc");
    await tick();
    stdin.write("\t");           // Tab -> completes to "/doctor " but does not run
    await tick(60);
    expect(lastFrame()).not.toContain("health-ok");
  });
});

describe("TUI: /login surfaces the device code before the poll resolves", () => {
  it("renders the verification URL + code immediately, not buffered behind the token poll", async () => {
    // Reproduces the deadlock: the old /login buffered its device-code line and only returned
    // (and thus rendered) after pollForToken resolved — but the user can't authorize a code they
    // can't see. The login prop must push the code to the UI, then resolve when authorized.
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((r) => { releaseToken = r; });
    const login = (show: (lines: string[]) => void) => {
      show(["Open https://github.com/login/device and enter code: AB-12"]);
      return tokenGate.then(() => ["GitHub authorization complete."]);
    };
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" login={login} />);
    await tick();
    stdin.write("/login");
    await tick();
    stdin.write("\r");
    await tick(80);
    // The code is on screen WHILE the token poll is still pending (gate not released).
    expect(lastFrame()).toContain("AB-12");
    expect(lastFrame()).toContain("github.com/login/device");

    releaseToken();
    await tick(80);
    expect(lastFrame()).toContain("GitHub authorization complete.");
  });

  it("renders an error card (not a crash) when authorization fails", async () => {
    // A rejected poll (e.g. expired/incorrect device code) must surface as an error card. The old
    // path let the rejection escape as an unhandled rejection and killed the whole process.
    const login = (show: (lines: string[]) => void) => {
      show(["Open https://github.com/login/device and enter code: AB-12"]);
      return Promise.reject(new Error("authorization failed: incorrect_device_code"));
    };
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" login={login} />);
    await tick();
    stdin.write("/login");
    await tick();
    stdin.write("\r");
    await tick(80);
    const f = lastFrame() ?? "";
    expect(f).toContain("login failed");
    expect(f).toContain("incorrect_device_code");
    // The raw "Error:" prefix should be stripped — show a clean message.
    expect(f).not.toContain("Error:");
  });

  it("ignores a second /login while one is already in flight", async () => {
    // The user can hit Enter on /login twice; without a guard that starts two device-code flows,
    // and polling a superseded code fails with incorrect_device_code. Only one flow should start.
    let starts = 0;
    const gate = new Promise<string[]>(() => {}); // never resolves — login stays pending
    const login = (show: (lines: string[]) => void) => { starts++; show([`code ${starts}`]); return gate; };
    const { stdin } = render(<App registry={reg()} title="m" login={login} />);
    await tick();
    stdin.write("/login"); await tick(); stdin.write("\r"); await tick(60);
    stdin.write("/login"); await tick(); stdin.write("\r"); await tick(60);
    expect(starts).toBe(1);
  });
});

describe("TUI: /web-search-support key entry", () => {
  it("opens a masked key screen and persists the typed key via saveWebIqKey", async () => {
    const saved: string[] = [];
    const saveWebIqKey = (k: string) => { saved.push(k); };
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" saveWebIqKey={saveWebIqKey} />);
    await tick();
    stdin.write("/web-search-support");
    await tick();
    stdin.write("\r");          // run the command -> opens the screen
    await tick(60);
    expect(lastFrame()).toMatch(/WebIQ API key/i);
    // type a key (should render masked, not echoed)
    stdin.write("secret-key-123");
    await tick();
    expect(lastFrame()).not.toContain("secret-key-123");
    expect(lastFrame()).toMatch(/•/);
    stdin.write("\r");          // submit
    await tick(60);
    expect(saved).toEqual(["secret-key-123"]);
  });
});

describe("TUI: model picker", () => {
  it("/model opens the picker and lists models with context windows", async () => {
    const loadModels = async () => ["gpt-4o", "claude-opus-4.8"];
    const modelLimits = { "gpt-4o": 128000, "claude-opus-4.8": 1_000_000 };
    const { stdin, lastFrame } = render(<App registry={reg()} title="m" loadModels={loadModels} modelLimits={modelLimits} />);
    await tick();
    stdin.write("/model");
    await tick();
    stdin.write("\r");
    await tick(80);
    const f = lastFrame() ?? "";
    expect(f).toContain("select chat model");
    expect(f).toMatch(/1M|128K/);
  });
});
