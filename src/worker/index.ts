import { createWorkerApp } from "./server.js";
import { Router } from "./router.js";
import { CopilotAdapter } from "../providers/copilot/adapter.js";
import { CopilotTokenStore } from "../providers/copilot/token.js";
import { fetchCopilotModels, fetchModelEndpoints } from "../providers/copilot/models.js";
import { readGhToken } from "../shared/creds.js";
import { readWebIqKey, readWebSearchMode, resolveWebSearchBackend } from "../shared/webiq-key.js";
import { makeGatewayRunner } from "../core/server-tools.js";
import { borrowSearch } from "../providers/copilot/borrow-search.js";
import { dataDir } from "../shared/paths.js";
import { defaultConfig } from "../shared/config.js";
import type { WorkerToSupervisor } from "../shared/ipc.js";

// Sending after the parent tore down the IPC channel throws ERR_IPC_CHANNEL_CLOSED; guard it so a
// crash-time report can't itself become a second, masking crash.
function send(msg: WorkerToSupervisor): void { try { if (process.connected) process.send?.(msg); } catch { /* channel gone */ } }

const cfg = defaultConfig();
const port = Number(process.env.WORKER_PORT ?? cfg.workerPort);
const host = process.env.BIND_HOST ?? cfg.bindHost;

const gh = readGhToken(dataDir());
if (!gh) { send({ type: "error", message: "no GitHub token; run `copilot-reverse` and /login first" }); process.exit(1); }

const tokenStore = new CopilotTokenStore(gh);
// Per-model supported_endpoints, populated lazily from the live model list (same source as the model
// ids). The adapter reads through this map so responses-only models (e.g. gpt-5.5) route to /responses
// as soon as discovery resolves; until then the map is empty and the /chat 400 safety net covers it.
let modelEndpoints: Record<string, string[]> = {};
const router = new Router([new CopilotAdapter(tokenStore, fetch, (m) => modelEndpoints[m] ?? [])], cfg.modelMap);
// Load the live model list so the router can fuzzy-match near-miss ids (e.g. dated Anthropic ids),
// and the endpoint map so the adapter can route per model. One token fetch feeds both.
void tokenStore.get().then(async (t) => {
  const [ids, endpoints] = await Promise.all([fetchCopilotModels(t), fetchModelEndpoints(t)]);
  router.setAvailableModels(ids);
  modelEndpoints = endpoints;
}).catch(() => {});
// Gateway-run web_search / web_fetch. The backend is resolved per call (lazy → /webiq toggles need no
// restart): currently WebIQ when a key is set, else unavailable (Copilot borrow is disabled — see
// COPILOT_WEB_SEARCH_ENABLED). resolveWebSearchBackend centralises that policy.
const gatewayRunner = makeGatewayRunner({
  backend: () => resolveWebSearchBackend(readWebSearchMode(dataDir()), Boolean(readWebIqKey(dataDir()))),
  webiqKey: () => readWebIqKey(dataDir()),
  borrow: { run: (input) => borrowSearch(tokenStore, input) },
});
const app = createWorkerApp(router, (m) => send({ type: "request-metric", ...m }), gatewayRunner);
const server = app.listen(port, host, () => send({ type: "ready", port }));
const hb = setInterval(() => send({ type: "heartbeat", ts: Date.now() }), 5_000);

process.on("message", (m: { type?: string }) => { if (m?.type === "shutdown") { clearInterval(hb); server.close(() => process.exit(0)); } });

// Crash diagnostics: write to STDERR FIRST so the supervisor's stderr capture (and crash.log) records
// the reason even when the IPC channel is already gone; the IPC send is a best-effort extra. Without
// the unhandledRejection handler, a stray floating rejection silently kills the worker on Node ≥15 —
// the exact "exit 1, empty stderr" crash loop we kept seeing.
function fatal(kind: string, e: unknown): never {
  const detail = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
  try { process.stderr.write(`worker ${kind}: ${detail}\n`); } catch { /* nothing more we can do */ }
  send({ type: "error", message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
  process.exit(1);
}
process.on("uncaughtException", (e) => fatal("uncaughtException", e));
process.on("unhandledRejection", (e) => fatal("unhandledRejection", e));
