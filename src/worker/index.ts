import { createWorkerApp } from "./server.js";
import { Router } from "./router.js";
import { CopilotAdapter } from "../providers/copilot/adapter.js";
import { CopilotTokenStore } from "../providers/copilot/token.js";
import { fetchCopilotModels } from "../providers/copilot/models.js";
import { readGhToken } from "../shared/creds.js";
import { dataDir } from "../shared/paths.js";
import { defaultConfig } from "../shared/config.js";
import type { WorkerToSupervisor } from "../shared/ipc.js";

function send(msg: WorkerToSupervisor): void { if (process.send) process.send(msg); }

const cfg = defaultConfig();
const port = Number(process.env.WORKER_PORT ?? cfg.workerPort);
const host = process.env.BIND_HOST ?? cfg.bindHost;

const gh = readGhToken(dataDir());
if (!gh) { send({ type: "error", message: "no GitHub token; run `copilot-reverse` and /login first" }); process.exit(1); }

const tokenStore = new CopilotTokenStore(gh);
const router = new Router([new CopilotAdapter(tokenStore)], cfg.modelMap);
// Load the live model list so the router can fuzzy-match near-miss ids (e.g. dated Anthropic ids).
void tokenStore.get().then((t) => fetchCopilotModels(t)).then((ids) => router.setAvailableModels(ids)).catch(() => {});
const app = createWorkerApp(router, (m) => send({ type: "request-metric", ...m }));
const server = app.listen(port, host, () => send({ type: "ready", port }));
const hb = setInterval(() => send({ type: "heartbeat", ts: Date.now() }), 5_000);

process.on("message", (m: { type?: string }) => { if (m?.type === "shutdown") { clearInterval(hb); server.close(() => process.exit(0)); } });
process.on("uncaughtException", (e) => { send({ type: "error", message: e.message, stack: e.stack }); process.exit(1); });
