import { probeGithubAuth, type AuthProbe } from "../providers/copilot/token.js";
import type { GithubStatus } from "../shared/control-types.js";

// How often the supervisor re-checks the GitHub token. Token failure is rare (revoke / re-auth) and
// GitHub rate-limits, so a slow cadence is plenty; an initial short delay populates the status soon
// after boot without racing worker startup.
export const GITHUB_HEARTBEAT_INTERVAL_MS = 60_000;
export const GITHUB_HEARTBEAT_INITIAL_DELAY_MS = 2_000;

// Shared so /doctor and the heartbeat show the same remediation hint for the signed-out state.
export const SIGNED_OUT_DETAIL = "not logged in — run /login";

// Pure reducer: given the prior cached status, whether a token is on disk, and the latest probe
// result, decide the next cached status. Transient errors are sticky — they keep the prior status —
// so a brief blip doesn't flip a connected session to "expired". Caveat (see probeGithubAuth): the
// stickiness is unbounded, and if the FIRST probe is transient (prev still undefined) the status stays
// undefined / "pending", so /api/status omits `github` and the HUD shows no badge until a non-transient
// result lands.
export function nextGithubStatus(
  prev: GithubStatus | undefined,
  hasToken: boolean,
  probe: AuthProbe | null,
  now: number,
): GithubStatus | undefined {
  if (!hasToken) return { ok: false, hasToken: false, checkedAt: now, detail: SIGNED_OUT_DETAIL };
  if (probe && probe.transient) return prev; // keep last-known-good (or stay pending if none yet)
  if (!probe) return prev;
  return { ok: probe.ok, hasToken: true, checkedAt: now, detail: probe.detail };
}

// Periodically probes the GitHub token in the supervisor process and caches a GithubStatus the control
// API exposes via /api/status. Dependencies are injected for testing (token reader, probe, clock).
export class GithubHeartbeat {
  private status: GithubStatus | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private inFlight = false;
  private intervalMs: number;
  private initialDelayMs: number;

  constructor(
    private readToken: () => string | null,
    private probe: (ghToken: string) => Promise<AuthProbe> = probeGithubAuth,
    private now: () => number = () => Date.now(),
    opts: { intervalMs?: number; initialDelayMs?: number } = {},
  ) {
    this.intervalMs = opts.intervalMs ?? GITHUB_HEARTBEAT_INTERVAL_MS;
    this.initialDelayMs = opts.initialDelayMs ?? GITHUB_HEARTBEAT_INITIAL_DELAY_MS;
  }

  current(): GithubStatus | undefined { return this.status; }

  // One probe cycle. Reads the token first: no token → signed-out, and the network probe is skipped.
  // Guarded so a slow probe (up to ~8s) can't overlap the next tick.
  async runOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const token = this.readToken();
      const probe = token ? await this.probe(token) : null;
      if (this.stopped) return; // a late result after stop() must not resurrect the timer/state
      this.status = nextGithubStatus(this.status, Boolean(token), probe, this.now());
    } finally {
      this.inFlight = false;
    }
  }

  start(): void {
    if (this.timer) return; // idempotent: don't leak a second timer if start() is called twice
    this.stopped = false;
    const tick = () => { void this.runOnce(); };
    this.timer = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, this.intervalMs);
    }, this.initialDelayMs);
  }

  stop(): void {
    this.stopped = true;
    // The timer handle is either the initial setTimeout or the later setInterval; clearing both kinds
    // is safe with either function in Node.
    if (this.timer) { clearTimeout(this.timer); clearInterval(this.timer); this.timer = undefined; }
  }
}
