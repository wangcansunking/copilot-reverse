import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { defaultConfig } from "../shared/config.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface EnsureOptions {
  spawn: () => void;
  probe: () => Promise<boolean>;
  retries: number;
  delayMs: number;
}

export async function ensureDaemon(opts: EnsureOptions): Promise<"already-running" | "started"> {
  if (await opts.probe()) return "already-running";
  opts.spawn();
  for (let i = 0; i < opts.retries; i++) {
    await sleep(opts.delayMs);
    if (await opts.probe()) return "started";
  }
  throw new Error("daemon did not become healthy in time");
}

// Real implementations wired by the CLI/TUI.
export function spawnSupervisor(): void {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "supervisor", "index.js");
  const child = nodeSpawn(process.execPath, [entry], { detached: true, stdio: "ignore" });
  child.unref();
}

export async function probeSupervisor(fetchFn: typeof fetch = fetch): Promise<boolean> {
  const cfg = defaultConfig();
  try {
    const res = await fetchFn(`http://${cfg.bindHost}:${cfg.supervisorPort}/api/status`);
    return res.ok;
  } catch { return false; }
}
