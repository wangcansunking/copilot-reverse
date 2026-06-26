// Microsoft Web IQ REST client. Two grounding endpoints used to back Claude Code's server-side
// web_search / web_fetch tools, which our gateway executes itself (Copilot can't). Every call
// returns a discriminated result instead of throwing: a failed search must degrade to a message the
// model can read and answer around, never abort the in-flight turn.
const SEARCH_URL = "https://api.microsoft.ai/v3/search/web";
const BROWSE_URL = "https://api.microsoft.ai/v3/browse";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface WebResult { title: string; url: string; content: string; crawledAt?: string; lastUpdatedAt?: string }
export type SearchOutcome = { ok: true; results: WebResult[] } | { ok: false; error: string };
export type FetchOutcome = { ok: true; title: string; url: string; content: string } | { ok: false; error: string };

export interface SearchParams { query: string; maxResults?: number; language?: string; region?: string; maxLength?: number; contentFormat?: string }
export interface FetchParams { url: string; maxLength?: number; language?: string; region?: string; contentFormat?: string; liveCrawl?: string }

const headers = (key: string) => ({ host: "api.microsoft.ai", "x-apikey": key, "content-type": "application/json" });

// Status -> readable, model-facing reason. Kept identical across both endpoints so the model gets a
// consistent, actionable string it can reason about (e.g. fall back to its own knowledge).
function statusError(status: number, kind: "search" | "fetch"): string {
  if (status === 401 || status === 403) return "web search unavailable: WebIQ API key missing or invalid — run /webiq to set it";
  if (status === 429) return "web search unavailable: WebIQ rate limit exceeded — try again shortly";
  if (status === 404 && kind === "fetch") return "web fetch failed: the page was not found or is not indexed";
  return `web ${kind} failed: WebIQ returned ${status}`;
}

async function post(url: string, key: string, body: unknown, fetchFn: typeof fetch, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetchFn(url, { method: "POST", headers: headers(key), body: JSON.stringify(body), signal: ctrl.signal }); }
  finally { clearTimeout(timer); }
}

export async function webSearch(key: string, params: SearchParams, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SearchOutcome> {
  if (!key) return { ok: false, error: statusError(401, "search") };
  try {
    const res = await post(SEARCH_URL, key, { maxResults: 10, contentFormat: "passage", ...params }, fetchFn, timeoutMs);
    if (!res.ok) return { ok: false, error: statusError(res.status, "search") };
    const data = (await res.json()) as { webResults?: WebResult[] };
    return { ok: true, results: data.webResults ?? [] };
  } catch {
    return { ok: false, error: "web search failed: could not reach WebIQ" };
  }
}

export async function webFetch(key: string, params: FetchParams, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FetchOutcome> {
  if (!key) return { ok: false, error: statusError(401, "fetch") };
  try {
    const res = await post(BROWSE_URL, key, { maxLength: 10_000, contentFormat: "markdown", ...params }, fetchFn, timeoutMs);
    if (!res.ok) return { ok: false, error: statusError(res.status, "fetch") };
    const data = (await res.json()) as { title?: string; url?: string; content?: string };
    return { ok: true, title: data.title ?? "", url: data.url ?? params.url, content: data.content ?? "" };
  } catch {
    return { ok: false, error: "web fetch failed: could not reach WebIQ" };
  }
}

// Render results as the tool_result text fed back to the model — compact, citation-friendly.
export function formatSearchResults(results: WebResult[]): string {
  if (!results.length) return "no results found";
  return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`.trim()).join("\n\n");
}
export function formatFetchResult(r: { title: string; url: string; content: string }): string {
  return `${r.title}\n${r.url}\n\n${r.content}`.trim();
}
