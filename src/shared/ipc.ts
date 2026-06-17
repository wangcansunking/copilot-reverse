export type WorkerToSupervisor =
  | { type: "ready"; port: number }
  | { type: "heartbeat"; ts: number }
  | { type: "request-metric"; endpoint: string; model: string; status: number; latencyMs: number }
  | { type: "error"; message: string; stack?: string };
export type SupervisorToWorker = { type: "ping" } | { type: "shutdown" };
