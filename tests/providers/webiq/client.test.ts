import { describe, it, expect, vi } from "vitest";
import { webSearch, webFetch, formatSearchResults, formatFetchResult } from "../../../src/providers/webiq/client.js";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("webSearch", () => {
  it("posts the query with the api key and returns parsed results", async () => {
    const f = vi.fn(async () => json({ webResults: [{ title: "T1", url: "https://a", content: "C1" }], traceId: "tid" }));
    const out = await webSearch("KEY", { query: "llm rag" }, f as unknown as typeof fetch);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ title: "T1", url: "https://a", content: "C1" });
    // Verify the wire call: endpoint, method, x-apikey header, query in body.
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.microsoft.ai/v3/search/web");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-apikey"]).toBe("KEY");
    expect(JSON.parse(init.body as string)).toMatchObject({ query: "llm rag" });
  });

  it("maps a 401 to a readable, non-throwing error", async () => {
    const f = vi.fn(async () => json({}, 401));
    const out = await webSearch("BAD", { query: "x" }, f as unknown as typeof fetch);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected error");
    expect(out.error).toMatch(/key/i);
  });

  it("maps a 429 to a rate-limit message", async () => {
    const f = vi.fn(async () => json({}, 429));
    const out = await webSearch("KEY", { query: "x" }, f as unknown as typeof fetch);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected error");
    expect(out.error).toMatch(/rate limit/i);
  });

  it("never throws on a network failure — returns an error result", async () => {
    const f = vi.fn(async () => { throw new Error("ECONNRESET"); });
    const out = await webSearch("KEY", { query: "x" }, f as unknown as typeof fetch);
    expect(out.ok).toBe(false);
  });
});

describe("webFetch", () => {
  it("posts the url and returns the page content", async () => {
    const f = vi.fn(async () => json({ title: "Page", url: "https://b", content: "BODY" }));
    const out = await webFetch("KEY", { url: "https://b" }, f as unknown as typeof fetch);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.title).toBe("Page");
    expect(out.content).toBe("BODY");
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.microsoft.ai/v3/browse");
    expect(JSON.parse(init.body as string)).toMatchObject({ url: "https://b" });
  });

  it("maps a 404 to a not-found message", async () => {
    const f = vi.fn(async () => json({}, 404));
    const out = await webFetch("KEY", { url: "https://missing" }, f as unknown as typeof fetch);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected error");
    expect(out.error).toMatch(/not found/i);
  });
});

describe("formatters produce model-readable tool_result text", () => {
  it("formatSearchResults lists numbered title/url/content", () => {
    const s = formatSearchResults([
      { title: "T1", url: "https://a", content: "C1" },
      { title: "T2", url: "https://b", content: "C2" },
    ]);
    expect(s).toMatch(/T1/);
    expect(s).toMatch(/https:\/\/a/);
    expect(s).toMatch(/C1/);
    expect(s).toMatch(/T2/);
  });
  it("formatSearchResults handles an empty list", () => {
    expect(formatSearchResults([])).toMatch(/no results/i);
  });
  it("formatFetchResult includes title, url, and content", () => {
    const s = formatFetchResult({ title: "Page", url: "https://b", content: "BODY" });
    expect(s).toMatch(/Page/);
    expect(s).toMatch(/https:\/\/b/);
    expect(s).toMatch(/BODY/);
  });
});
