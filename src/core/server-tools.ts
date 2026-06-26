import type { CanonicalTool } from "./canonical.js";
import { webSearch, webFetch, formatSearchResults, formatFetchResult, type SearchOutcome, type FetchOutcome } from "../providers/webiq/client.js";
import { formatBorrowSources, type BorrowOutcome } from "../providers/copilot/borrow-search.js";
import type { WebSearchBackend } from "../shared/webiq-key.js";

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

// The gateway runner dispatches on a resolved backend (see resolveWebSearchBackend in webiq-key.ts),
// supplied lazily per call so /webiq toggles need no worker restart:
//   "copilot"     → borrow gpt-5-mini's native web_search (no key). Currently disabled by default.
//   "webiq"       → run through WebIQ with the stored key.
//   "unavailable" → no backend (Copilot search off + no WebIQ key): tell the user to run /webiq.
export interface GatewayRunnerConfig {
  backend: () => WebSearchBackend;
  webiqKey: () => string | null;
  borrow: BorrowBackend;
  webiq?: WebIqClient;
}

// Shown when web search is unavailable (Copilot borrow disabled and no WebIQ key configured).
const UNAVAILABLE = "web search/fetch not available, please run /webiq to use the key, to get the key please go to https://webiq.microsoft.ai/profiles/";

export function makeGatewayRunner(cfg: GatewayRunnerConfig): GatewayToolRunner {
  const webiq = cfg.webiq ?? DEFAULT_WEBIQ;
  return async (name, input) => {
    const arg = (input ?? {}) as Record<string, unknown>;
    const backend = cfg.backend();
    const key = cfg.webiqKey();

    if (name === "web_search") {
      const query = typeof arg.query === "string" ? arg.query.trim() : "";
      if (!query) return "web_search error: missing 'query'";
      if (backend === "unavailable") return UNAVAILABLE;
      if (backend === "webiq") { const out = await webiq.search(key!, { query }); return out.ok ? formatSearchResults(out.results) : out.error; }
      const out = await cfg.borrow.run(query);
      return out.ok ? formatBorrowSources(out.sources) : out.error;
    }
    if (name === "web_fetch") {
      const url = typeof arg.url === "string" ? arg.url.trim() : "";
      if (!url) return "web_fetch error: missing 'url'";
      if (backend === "unavailable") return UNAVAILABLE;
      if (backend === "webiq") { const out = await webiq.fetchPage(key!, { url }); return out.ok ? formatFetchResult(out) : out.error; }
      // Copilot's web_search tool also fetches: "Open {url}…" makes gpt-5-mini open that exact page.
      const out = await cfg.borrow.run(`Open ${url} and extract its main content.`);
      if (!out.ok) return out.error;
      return out.text || formatBorrowSources(out.sources);
    }
    return `unknown gateway tool: ${name}`;
  };
}
