import { describe, it, expect, vi } from "vitest";
import { fetchModelEndpoints, fetchModelReasoningSupport, fetchModelOneMSupport } from "../../../src/providers/copilot/models.js";

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("fetchModelEndpoints", () => {
  it("maps model id -> supported_endpoints", async () => {
    const f = vi.fn(async () => json({ data: [
      { id: "gpt-5.5", supported_endpoints: ["/responses", "ws:/responses"] },
      { id: "gpt-4o", supported_endpoints: undefined },
      { id: "gpt-5-mini", supported_endpoints: ["/chat/completions", "/responses"] },
    ] }));
    const out = await fetchModelEndpoints("tok", f as unknown as typeof fetch);
    expect(out["gpt-5.5"]).toEqual(["/responses", "ws:/responses"]);
    expect(out["gpt-5-mini"]).toContain("/chat/completions");
    expect(out["gpt-4o"]).toBeUndefined(); // no field -> omitted
  });

  it("returns {} when the endpoint fails", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    expect(await fetchModelEndpoints("tok", f as unknown as typeof fetch)).toEqual({});
  });
});

describe("fetchModelReasoningSupport", () => {
  it("includes only ids whose capabilities advertise a non-empty reasoning_effort", async () => {
    const f = vi.fn(async () => json({ data: [
      { id: "claude-opus-4.8", capabilities: { supports: { reasoning_effort: ["low", "medium", "high"] } } },
      { id: "gpt-5.5", capabilities: { supports: { reasoning_effort: ["none", "low", "high"] } } },
      { id: "gpt-4o", capabilities: { supports: { tool_calls: true } } }, // no reasoning_effort
      { id: "gpt-4o-mini", capabilities: { supports: { reasoning_effort: [] } } }, // empty -> excluded
      { id: "text-embedding-3-small", capabilities: { supports: {} } },
    ] }));
    const out = await fetchModelReasoningSupport("tok", f as unknown as typeof fetch);
    expect(out.has("claude-opus-4.8")).toBe(true);
    expect(out.has("gpt-5.5")).toBe(true);
    expect(out.has("gpt-4o")).toBe(false);
    expect(out.has("gpt-4o-mini")).toBe(false);
    expect(out.has("text-embedding-3-small")).toBe(false);
  });

  it("returns an empty set when the endpoint fails", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    expect((await fetchModelReasoningSupport("tok", f as unknown as typeof fetch)).size).toBe(0);
  });
});

describe("fetchModelOneMSupport", () => {
  it("includes only ids whose context window exceeds the 1M threshold", async () => {
    const f = vi.fn(async () => json({ data: [
      { id: "claude-opus-4.8", capabilities: { limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 936_000 } } },
      { id: "claude-sonnet-5", capabilities: { limits: { max_context_window_tokens: 1_000_000 } } },
      { id: "claude-sonnet-4.5", capabilities: { limits: { max_context_window_tokens: 200_000 } } }, // 200K -> excluded
      { id: "gpt-4o", capabilities: { limits: {} } }, // no window -> excluded
      { id: "no-caps" }, // no capabilities at all -> excluded
    ] }));
    const out = await fetchModelOneMSupport("tok", f as unknown as typeof fetch);
    expect(out.has("claude-opus-4.8")).toBe(true);
    expect(out.has("claude-sonnet-5")).toBe(true);
    expect(out.has("claude-sonnet-4.5")).toBe(false);
    expect(out.has("gpt-4o")).toBe(false);
    expect(out.has("no-caps")).toBe(false);
  });

  it("falls back to max_prompt_tokens when max_context_window_tokens is absent", async () => {
    const f = vi.fn(async () => json({ data: [
      { id: "claude-opus-4.7", capabilities: { limits: { max_prompt_tokens: 936_000 } } }, // 936K > 800K -> included
    ] }));
    const out = await fetchModelOneMSupport("tok", f as unknown as typeof fetch);
    expect(out.has("claude-opus-4.7")).toBe(true);
  });

  it("returns an empty set when the endpoint fails", async () => {
    const f = vi.fn(async () => new Response("", { status: 500 }));
    expect((await fetchModelOneMSupport("tok", f as unknown as typeof fetch)).size).toBe(0);
  });
});
