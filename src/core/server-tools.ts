import type { CanonicalTool } from "./canonical.js";
import { webSearch, webFetch, formatSearchResults, formatFetchResult, type SearchOutcome, type FetchOutcome } from "../providers/webiq/client.js";
import { formatBorrowSources, type BorrowOutcome } from "../providers/copilot/borrow-search.js";
import type { WebSearchMode } from "../shared/webiq-key.js";

// Tools the GATEWAY executes itself, rather than forwarding to the model's client. These mirror Claude
// Code's server-side web_search / web_fetch, which a Copilot-backed gateway must fulfil internally —
// the model calls them like normal function tools and we run them in-process.
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

// Injection seams: production passes the real backends; tests pass fakes.
export interface WebIqClient {
  search: (key: string, params: { query: string }, fetchFn?: typeof fetch) => Promise<SearchOutcome>;
  fetchPage: (key: string, params: { url: string }, fetchFn?: typeof fetch) => Promise<FetchOutcome>;
}
export interface BorrowBackend {
  run: (input: string) => Promise<BorrowOutcome>;
}
const DEFAULT_WEBIQ: WebIqClient = { search: webSearch, fetchPage: webFetch };

// Two web-search backends, selected per call (lazy — so /webiq toggles need no worker restart):
//   mode "copilot" (default) → borrow gpt-5-mini's native web_search (no key needed).
//   mode "webiq" + a key     → force ALL traffic through WebIQ.
// webiq mode with no key degrades to borrow, so search never silently dies.
export interface GatewayRunnerConfig {
  mode: () => WebSearchMode;
  webiqKey: () => string | null;
  borrow: BorrowBackend;
  webiq?: WebIqClient;
}

export function makeGatewayRunner(cfg: GatewayRunnerConfig): GatewayToolRunner {
  const webiq = cfg.webiq ?? DEFAULT_WEBIQ;
  return async (name, input) => {
    const arg = (input ?? {}) as Record<string, unknown>;
    const key = cfg.webiqKey();
    const useWebiq = cfg.mode() === "webiq" && !!key;

    if (name === "web_search") {
      const query = typeof arg.query === "string" ? arg.query.trim() : "";
      if (!query) return "web_search error: missing 'query'";
      if (useWebiq) { const out = await webiq.search(key!, { query }); return out.ok ? formatSearchResults(out.results) : out.error; }
      const out = await cfg.borrow.run(query);
      return out.ok ? formatBorrowSources(out.sources) : out.error;
    }
    if (name === "web_fetch") {
      const url = typeof arg.url === "string" ? arg.url.trim() : "";
      if (!url) return "web_fetch error: missing 'url'";
      if (useWebiq) { const out = await webiq.fetchPage(key!, { url }); return out.ok ? formatFetchResult(out) : out.error; }
      // Copilot's web_search tool also fetches: "Open {url}…" makes gpt-5-mini open that exact page.
      const out = await cfg.borrow.run(`Open ${url} and extract its main content.`);
      if (!out.ok) return out.error;
      return out.text || formatBorrowSources(out.sources);
    }
    return `unknown gateway tool: ${name}`;
  };
}
