import { describe, it, expect, vi } from "vitest";
import { fetchModelEndpoints } from "../../../src/providers/copilot/models.js";

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
