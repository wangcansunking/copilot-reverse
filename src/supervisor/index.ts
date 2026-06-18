import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { openDb, recordRestart, recordRequest } from "./db.js";
import { WorkerMonitor } from "./monitor.js";
import { EventBus } from "./events.js";
import { createControlApp } from "./api.js";
import { defaultConfig } from "../shared/config.js";
import { dataDir, dbPath } from "../shared/paths.js";
import { readGhToken } from "../shared/creds.js";
import { CopilotTokenStore } from "../providers/copilot/token.js";
import type { WorkerState, DoctorCheck } from "../shared/control-types.js";

export function startSupervisor(): { stop: () => void } {
  const config = defaultConfig();
  mkdirSync(dataDir(), { recursive: true });
  const db = openDb(dbPath());
  const bus = new EventBus();
  const workerEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "index.js");

  let state: WorkerState = "starting";
  const monitor = new WorkerMonitor(config, workerEntry, {
    onStateChange: (s) => { state = s; bus.emit("state", { state: s }); },
    onCrash: (d, exitCode, stderrTail) => {
      recordRestart(db, { ts: Date.now(), reason: d.markedUnhealthy ? "unhealthy" : "crash", exitCode, stderrTail, backoffMs: d.backoffMs, markedUnhealthy: d.markedUnhealthy ? 1 : 0 });
      bus.emit("crash", { exitCode, ...d });
    },
    onWorkerMessage: (m) => {
      if (m.type === "request-metric") {
        recordRequest(db, { ts: Date.now(), endpoint: m.endpoint, model: m.model, status: m.status, latencyMs: m.latencyMs });
        bus.emit("metric", { ts: Date.now(), endpoint: m.endpoint, model: m.model, status: m.status, latencyMs: m.latencyMs });
      }
    },
  });

  const doctor = async (): Promise<DoctorCheck[]> => {
    const gh = readGhToken(dataDir());
    let auth: DoctorCheck;
    if (!gh) {
      auth = { name: "github-auth", ok: false, detail: "not logged in — restart maestro to log in" };
    } else {
      // Validate the token actually exchanges, not just that it exists on disk.
      try { await new CopilotTokenStore(gh).get(); auth = { name: "github-auth", ok: true, detail: "token valid" }; }
      catch (e) { auth = { name: "github-auth", ok: false, detail: e instanceof Error ? e.message : String(e) }; }
    }
    return [auth, { name: "worker", ok: state === "ready", detail: `worker is ${state}` }];
  };

  const app = createControlApp({
    db, getState: () => state,
    restart: () => monitor.restartManually(),
    stop: () => monitor.stop(),
    start: () => monitor.start(),
    doctor,
    subscribe: (send) => bus.subscribe(send),
  });

  app.listen(config.supervisorPort, config.bindHost, () => monitor.start());
  process.on("SIGINT", () => { monitor.stop(); process.exit(0); });
  process.on("SIGTERM", () => { monitor.stop(); process.exit(0); });
  return { stop: () => monitor.stop() };
}

// Allow `node dist/supervisor/index.js` to boot the daemon directly.
if (process.argv[1] && process.argv[1].endsWith(join("supervisor", "index.js"))) startSupervisor();
