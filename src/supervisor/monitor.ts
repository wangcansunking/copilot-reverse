import { fork, type ChildProcess } from "node:child_process";
import type { RestartPolicy, AppConfig } from "../shared/config.js";
import type { WorkerToSupervisor } from "../shared/ipc.js";
import type { WorkerState } from "../shared/control-types.js";

export interface RestartDecision { backoffMs: number; markedUnhealthy: boolean; crashesInWindow: number }

export class RestartController {
  private crashTimes: number[] = [];
  private consecutive = 0;
  constructor(private policy: RestartPolicy, private now: () => number = () => Date.now()) {}
  onCrash(): RestartDecision {
    const t = this.now();
    this.crashTimes.push(t);
    this.crashTimes = this.crashTimes.filter((ct) => t - ct < this.policy.windowMs);
    this.consecutive += 1;
    const backoffMs = Math.min(this.policy.baseBackoffMs * 2 ** (this.consecutive - 1), this.policy.maxBackoffMs);
    return { backoffMs, markedUnhealthy: this.crashTimes.length >= this.policy.maxCrashes, crashesInWindow: this.crashTimes.length };
  }
  reset(): void { this.consecutive = 0; this.crashTimes = []; }
}

export interface MonitorHooks {
  onStateChange(s: WorkerState): void;
  onCrash(d: RestartDecision, exitCode: number | null, stderrTail: string): void;
  onWorkerMessage(m: WorkerToSupervisor): void;
}

export class WorkerMonitor {
  private child?: ChildProcess;
  private controller: RestartController;
  private stderrTail = "";
  private state: WorkerState = "starting";
  private stopped = false;
  constructor(private config: AppConfig, private workerEntry: string, private hooks: MonitorHooks) {
    this.controller = new RestartController(config.restart);
  }
  start(): void { this.spawn(); }
  currentState(): WorkerState { return this.state; }
  private set(s: WorkerState): void { this.state = s; this.hooks.onStateChange(s); }
  private spawn(): void {
    this.set("starting");
    const child = fork(this.workerEntry, [], {
      env: { ...process.env, WORKER_PORT: String(this.config.workerPort), BIND_HOST: this.config.bindHost },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.child = child;
    this.stderrTail = "";
    child.stderr?.on("data", (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-4000); });
    child.on("message", (m: WorkerToSupervisor) => {
      if (m.type === "ready") { this.controller.reset(); this.set("ready"); }
      this.hooks.onWorkerMessage(m);
    });
    child.on("exit", (code) => {
      if (this.stopped) return;
      const d = this.controller.onCrash();
      this.hooks.onCrash(d, code, this.stderrTail);
      if (d.markedUnhealthy) {
        // Don't give up forever: a transient crash burst (token rotation, a flaky upstream) shouldn't
        // leave the daemon permanently dead. Mark unhealthy, then after a cooldown reset the window and
        // try once more — recovering on its own if the cause has passed.
        this.set("unhealthy");
        setTimeout(() => { if (!this.stopped) { this.controller.reset(); this.spawn(); } }, this.config.restart.unhealthyCooldownMs);
        return;
      }
      this.set("crashed");
      setTimeout(() => this.spawn(), d.backoffMs);
    });
  }
  restartManually(): void {
    this.controller.reset(); this.stopped = false;
    if (this.child && !this.child.killed) { this.child.removeAllListeners("exit"); this.child.kill(); }
    this.spawn();
  }
  stop(): void {
    this.stopped = true;
    const child = this.child;
    if (!child || child.killed) return;
    // The IPC channel may already be torn down (e.g. right after a manual restart) — sending then
    // throws ERR_IPC_CHANNEL_CLOSED. Guard the graceful shutdown and fall back to a hard kill.
    try { if (child.connected) child.send({ type: "shutdown" }); } catch { /* channel already closed */ }
    child.kill();
  }
}
