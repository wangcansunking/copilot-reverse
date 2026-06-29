import type { StatusResponse, DoctorCheck, MetricSample } from "../shared/control-types.js";

export class DaemonClient {
  constructor(private base: string, private fetchFn: typeof fetch = fetch) {}
  private async post(path: string): Promise<void> { await this.fetchFn(`${this.base}${path}`, { method: "POST" }); }
  async status(): Promise<StatusResponse> { return (await (await this.fetchFn(`${this.base}/api/status`)).json()) as StatusResponse; }
  async restart(): Promise<void> { return this.post("/api/restart"); }
  async stop(): Promise<void> { return this.post("/api/stop"); }
  async start(): Promise<void> { return this.post("/api/start"); }
  // ping=true runs the slower per-configured-model connectivity probe; default (false) is the cheap
  // light check (also what the dashboard polls). The TUI /doctor passes true.
  async doctor(ping = false): Promise<DoctorCheck[]> { return ((await (await this.fetchFn(`${this.base}/api/doctor${ping ? "?ping=1" : ""}`)).json()) as { checks: DoctorCheck[] }).checks; }
  async requests(): Promise<MetricSample[]> { return ((await (await this.fetchFn(`${this.base}/api/requests`)).json()) as { requests: MetricSample[] }).requests; }
  eventsUrl(): string { return `${this.base}/api/events`; }
}
