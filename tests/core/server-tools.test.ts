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

describe("makeGatewayRunner", () => {
  it("dispatches web_search to the WebIQ client and returns formatted text", async () => {
    const search = vi.fn(async () => ({ ok: true as const, results: [{ title: "T", url: "https://a", content: "C" }] }));
    const fetchPage = vi.fn();
    const run = makeGatewayRunner(() => "KEY", { search, fetchPage } as any);
    const out = await run("web_search", { query: "hello" });
    expect(search).toHaveBeenCalledWith("KEY", expect.objectContaining({ query: "hello" }));
    expect(out).toMatch(/T/);
    expect(out).toMatch(/https:\/\/a/);
  });

  it("dispatches web_fetch to the WebIQ client", async () => {
    const search = vi.fn();
    const fetchPage = vi.fn(async () => ({ ok: true as const, title: "P", url: "https://b", content: "BODY" }));
    const run = makeGatewayRunner(() => "KEY", { search, fetchPage } as any);
    const out = await run("web_fetch", { url: "https://b" });
    expect(fetchPage).toHaveBeenCalledWith("KEY", expect.objectContaining({ url: "https://b" }));
    expect(out).toMatch(/BODY/);
  });

  it("returns the WebIQ error string (not a throw) when the call fails", async () => {
    const search = vi.fn(async () => ({ ok: false as const, error: "web search unavailable: key missing" }));
    const run = makeGatewayRunner(() => "KEY", { search, fetchPage: vi.fn() } as any);
    const out = await run("web_search", { query: "x" });
    expect(out).toMatch(/key missing/);
  });

  it("tells the model when no key is configured, without calling the client", async () => {
    const search = vi.fn();
    const run = makeGatewayRunner(() => null, { search, fetchPage: vi.fn() } as any);
    const out = await run("web_search", { query: "x" });
    expect(search).not.toHaveBeenCalled();
    expect(out).toMatch(/web-search-support/);
  });

  it("guards against a malformed input (missing query)", async () => {
    const run = makeGatewayRunner(() => "KEY", { search: vi.fn(), fetchPage: vi.fn() } as any);
    const out = await run("web_search", {});
    expect(out).toMatch(/query/i);
  });
});
