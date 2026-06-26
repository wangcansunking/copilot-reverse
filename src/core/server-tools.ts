import type { CanonicalTool } from "./canonical.js";
import { webSearch, webFetch, formatSearchResults, formatFetchResult, type SearchOutcome, type FetchOutcome } from "../providers/webiq/client.js";

// Tools the GATEWAY executes itself (against WebIQ), rather than forwarding to the model's client.
// These mirror Claude Code's server-side web_search / web_fetch, which a Copilot-backed gateway must
// fulfil internally — the model calls them like normal function tools and we run them in-process.
export const GATEWAY_TOOL_DEFS: CanonicalTool[] = [
  {
    name: "web_search",
    description: "Search the web for current information. Returns ranked results with titles, URLs, and content snippets.",
    parameters: { type: "object", properties: { query: { type: "string", description: "The search query." } }, required: ["query"] },
  },
  {
    name: "web_fetch",
    description: "Fetch and read the content of a specific web page by URL.",
    parameters: { type: "object", properties: { url: { type: "string", description: "The URL of the page to fetch." } }, required: ["url"] },
  },
];

const GATEWAY_TOOL_NAMES = new Set(GATEWAY_TOOL_DEFS.map((t) => t.name));
export function isGatewayTool(name: string): boolean { return GATEWAY_TOOL_NAMES.has(name); }

// Executes a gateway tool call and returns the tool_result text fed back to the model. Always
// resolves to a string — failures become readable messages so the agentic loop never wedges.
export type GatewayToolRunner = (name: string, input: unknown) => Promise<string>;

// Injection seam: production passes the real WebIQ functions; tests pass fakes.
export interface WebIqClient {
  search: (key: string, params: { query: string }, fetchFn?: typeof fetch) => Promise<SearchOutcome>;
  fetchPage: (key: string, params: { url: string }, fetchFn?: typeof fetch) => Promise<FetchOutcome>;
}
const DEFAULT_CLIENT: WebIqClient = { search: webSearch, fetchPage: webFetch };

const NO_KEY = "web search is not configured — run /web-search-support to add a WebIQ API key";

export function makeGatewayRunner(getKey: () => string | null, client: WebIqClient = DEFAULT_CLIENT): GatewayToolRunner {
  return async (name, input) => {
    const key = getKey();
    if (!key) return NO_KEY;
    const arg = (input ?? {}) as Record<string, unknown>;
    if (name === "web_search") {
      const query = typeof arg.query === "string" ? arg.query : "";
      if (!query) return "web_search error: missing 'query'";
      const out = await client.search(key, { query });
      return out.ok ? formatSearchResults(out.results) : out.error;
    }
    if (name === "web_fetch") {
      const url = typeof arg.url === "string" ? arg.url : "";
      if (!url) return "web_fetch error: missing 'url'";
      const out = await client.fetchPage(key, { url });
      return out.ok ? formatFetchResult(out) : out.error;
    }
    return `unknown gateway tool: ${name}`;
  };
}
