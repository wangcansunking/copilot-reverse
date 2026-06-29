import type { MetricSample, DoctorCheck, StatusResponse } from "../shared/control-types.js";

// Sentinel for an unconfigured report target. /report refuses to open until this is changed.
export const PLACEHOLDER_REPO = "OWNER/REPO";

export interface ReportInput {
  repo: string;            // "owner/repo"
  version: string;
  platform: string;        // e.g. "win32 node-v20.11.0"
  status: StatusResponse;
  doctor: DoctorCheck[];
  errors: MetricSample[];  // recent failed requests (status >= 400, or a 200 cut short by the guard)
}

// A diagnostics-only report, structured like a good hand-written issue (e.g. #5): Summary →
// Environment → Diagnostics → Steps to reproduce. It contains metrics, doctor output, and worker
// restart reasons — never request/response bodies — so there is no user prompt content to leak.
export function buildIssueBody(i: ReportInput): string {
  const runaways = i.errors.filter((e) => e.status < 400 && /runaway/.test(e.error ?? ""));
  const summary = runaways.length
    ? `Stream(s) degenerated and were cut early (model looped, no stop) on ${i.status.workerState} worker — ${runaways.length} runaway(s).`
    : i.errors.length
      ? `${i.errors.length} recent request error(s) on a ${i.status.workerState} worker; details below.`
      : `Worker state: ${i.status.workerState}. (Describe the problem below.)`;
  const lines: string[] = [
    "### Summary", "", summary, "",
    "### Environment", "",
    `- copilot-reverse **${i.version}**`,
    `- platform: ${i.platform}`,
    `- worker state: ${i.status.workerState}`,
    "",
    "### Health checks",
    ...i.doctor.map((c) => `- ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`),
    "",
    "### Recent request errors",
    ...(i.errors.length
      ? i.errors.map((e) => `- \`${e.status}\` ${e.endpoint} ${e.model} — ${e.error ?? "(no message)"}`)
      : ["- (none)"]),
  ];
  if (runaways.length) {
    lines.push("", "### Stream runaways (model degenerated, cut early)",
      ...runaways.map((e) => `- ${e.endpoint} ${e.model} after ${e.latencyMs}ms — ${e.error}`));
  }
  if (i.status.restarts.length) {
    lines.push("", "### Recent worker restarts",
      ...i.status.restarts.slice(0, 5).map((r) => `- ${new Date(r.ts).toISOString()} ${r.reason} exit=${r.exitCode ?? "-"} ${r.stderrTail.slice(0, 120)}`));
  }
  lines.push("", "### Steps to reproduce", "<!-- what were you doing? which client/model? -->", "");
  // Keep well under GitHub's ~8KB URL cap once encoded.
  return lines.join("\n").slice(0, 5500);
}

export function buildIssueTitle(i: ReportInput): string {
  const runaway = i.errors.find((e) => e.status < 400 && /runaway/.test(e.error ?? ""));
  if (runaway) return `copilot-reverse: stream runaway (${runaway.model})`;
  const first = i.errors[0]?.error;
  return `copilot-reverse report: ${first ? first.slice(0, 70) : i.status.workerState}`;
}

export function buildIssueUrl(i: ReportInput): string {
  const q = `title=${encodeURIComponent(buildIssueTitle(i))}&body=${encodeURIComponent(buildIssueBody(i))}`;
  return `https://github.com/${i.repo}/issues/new?${q}`;
}
