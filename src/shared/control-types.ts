export type WorkerState = "starting" | "ready" | "crashed" | "unhealthy";

export interface RestartRow {
  ts: number;
  reason: string;
  exitCode: number | null;
  stderrTail: string;
  markedUnhealthy: 0 | 1;
}
export interface StatusResponse {
  workerState: WorkerState;
  restarts: RestartRow[];
}
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface MetricSample {
  ts: number;
  endpoint: string;
  model: string;
  status: number;
  latencyMs: number;
}
