import { describe, it, expect, vi } from "vitest";
import { GATEWAY_TOOL_DEFS, isGatewayTool, makeGatewayRunner } from "../../src/core/server-tools.js";

describe("GATEWAY_TOOL_DEFS", () => {
  it("defines web_search and web_fetch as real function tools with JSON-Schema params", () => {
    const names = GATEWAY_TOOL_DEFS.map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    for (const t of GATEWAY_TOOL_DEFS) {
      expect(t.parameters).toBeTypeOf("object");
      expect((t.parameters as any).type).toBe("object");
    }
  });
});

describe("isGatewayTool", () => {
  it("matches the gateway tool names", () => {
    expect(isGatewayTool("web_search")).toBe(true);
    expect(isGatewayTool("web_fetch")).toBe(true);
  });
  it("rejects client/other tools", () => {
    expect(isGatewayTool("Read")).toBe(false);
    expect(isGatewayTool("bash")).toBe(false);
  });
});

// Backend selection: default "copilot" borrows gpt-5-mini; "webiq" forces the WebIQ client. The runner
// reads mode + key lazily (per call) so /webiq toggles take effect without a worker restart.
const webiqClient = (over: any = {}) => ({ search: vi.fn(), fetchPage: vi.fn(), ...over });
const borrow = (over: any = {}) => ({ run: vi.fn(), ...over });

describe("makeGatewayRunner — copilot (borrow) default", () => {
  it("routes web_search through the borrow backend and formats its sources", async () => {
    const borrowRun = vi.fn(async () => ({ ok: true, sources: [{ title: "T", url: "https://a" }], text: "answer" }));
    const wiq = webiqClient();
    const run = makeGatewayRunner({ mode: () => "copilot", webiqKey: () => null, borrow: { run: borrowRun }, webiq: wiq });
    const out = await run("web_search", { query: "hello" });
    expect(borrowRun).toHaveBeenCalledWith("hello");
    expect(wiq.search).not.toHaveBeenCalled();
    expect(out).toContain("T");
    expect(out).toContain("https://a");
  });

  it("routes web_fetch through the borrow backend as an 'open URL' instruction, returns extracted text", async () => {
    const borrowRun = vi.fn(async () => ({ ok: true, sources: [{ title: "P", url: "https://b" }], text: "PAGE BODY" }));
    const run = makeGatewayRunner({ mode: () => "copilot", webiqKey: () => null, borrow: { run: borrowRun }, webiq: webiqClient() });
    const out = await run("web_fetch", { url: "https://b" });
    expect(borrowRun.mock.calls[0][0]).toMatch(/https:\/\/b/);
    expect(out).toContain("PAGE BODY");
  });

  it("does not need a WebIQ key for the default backend", async () => {
    const run = makeGatewayRunner({ mode: () => "copilot", webiqKey: () => null, borrow: { run: vi.fn(async () => ({ ok: true, sources: [], text: "" })) }, webiq: webiqClient() });
    const out = await run("web_search", { query: "x" });
    expect(out).not.toMatch(/not configured/i);
  });

  it("returns the borrow error string (not a throw) when borrowing fails", async () => {
    const run = makeGatewayRunner({ mode: () => "copilot", webiqKey: () => null, borrow: { run: vi.fn(async () => ({ ok: false, error: "borrow search failed: 400" })) }, webiq: webiqClient() });
    expect(await run("web_search", { query: "x" })).toMatch(/borrow search failed/);
  });

  it("guards against a malformed input (missing query)", async () => {
    const run = makeGatewayRunner({ mode: () => "copilot", webiqKey: () => null, borrow: borrow(), webiq: webiqClient() });
    expect(await run("web_search", {})).toMatch(/query/i);
  });
});

describe("makeGatewayRunner — webiq mode", () => {
  it("routes web_search through the WebIQ client when mode is webiq and a key is set", async () => {
    const search = vi.fn(async () => ({ ok: true as const, results: [{ title: "W", url: "https://w", content: "C" }] }));
    const borrowRun = vi.fn();
    const run = makeGatewayRunner({ mode: () => "webiq", webiqKey: () => "KEY", borrow: { run: borrowRun }, webiq: { search, fetchPage: vi.fn() } as any });
    const out = await run("web_search", { query: "hello" });
    expect(search).toHaveBeenCalledWith("KEY", expect.objectContaining({ query: "hello" }));
    expect(borrowRun).not.toHaveBeenCalled();
    expect(out).toMatch(/W/);
  });

  it("routes web_fetch through the WebIQ client in webiq mode", async () => {
    const fetchPage = vi.fn(async () => ({ ok: true as const, title: "P", url: "https://b", content: "BODY" }));
    const run = makeGatewayRunner({ mode: () => "webiq", webiqKey: () => "KEY", borrow: borrow(), webiq: { search: vi.fn(), fetchPage } as any });
    expect(await run("web_fetch", { url: "https://b" })).toMatch(/BODY/);
  });

  it("falls back to borrow when webiq mode is on but no key is available", async () => {
    const borrowRun = vi.fn(async () => ({ ok: true, sources: [{ title: "T", url: "https://a" }], text: "" }));
    const search = vi.fn();
    const run = makeGatewayRunner({ mode: () => "webiq", webiqKey: () => null, borrow: { run: borrowRun }, webiq: { search, fetchPage: vi.fn() } as any });
    await run("web_search", { query: "x" });
    expect(borrowRun).toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });
});
