import { describe, it, expect, vi } from "vitest";
import { fetchModelEndpoints, fetchModelReasoningSupport } from "../../../src/providers/copilot/models.js";

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
