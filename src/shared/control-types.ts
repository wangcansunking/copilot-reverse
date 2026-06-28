export type WorkerState = "starting" | "ready" | "crashed" | "unhealthy";

export interface RestartRow {
  ts: number;
  reason: string;
  exitCode: number | null;
  stderrTail: string;
  markedUnhealthy: 0 | 1;
}
// Result of the supervisor's GitHub-token heartbeat. `hasToken` keeps "signed-out" (no token on disk)
// distinct from "expired" (token present but no longer exchanges) without parsing `detail`.
export interface GithubStatus {
  ok: boolean;        // the GitHub token currently exchanges for a Copilot token
  hasToken: boolean;  // a GitHub token is present on disk
  checkedAt: number;  // ms epoch of the last completed probe
  detail: string;     // "token valid" | auth-error message | "not logged in — run /login"
}
export interface StatusResponse {
  workerState: WorkerState;
  restarts: RestartRow[];
  github?: GithubStatus; // absent until the heartbeat's first probe completes
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
  error?: string; // failure message for non-2xx requests; absent on success
}
