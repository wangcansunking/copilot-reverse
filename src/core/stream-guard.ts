// Defends a streaming turn against upstream model degeneration: the model collapses into emitting
// the same short token forever ("code\ncode\ncode…") and never sends a stop, so a faithful proxy
// would relay deltas until the socket dies — the session appears frozen. This watchdog converts
// that into a clean, bounded stop. It is pure (no I/O, no timers) so it is trivially testable; the
// idle/wall-clock timeout lives at the SSE loop where the timers are. Defaults are generous: real
// answers don't hit them, only runaways do.

export interface RunawayLimits {
  maxRepeats?: number;     // identical consecutive deltas before tripping
  maxOutputChars?: number; // total streamed chars before tripping
}
export type RunawayReason = "repetition" | "max_output";

export class RunawayGuard {
  private maxRepeats: number;
  private maxOutputChars: number;
  private last = "";
  private repeats = 0;
  private chars = 0;
  reason?: RunawayReason;

  constructor(limits: RunawayLimits = {}) {
    this.maxRepeats = limits.maxRepeats ?? 200;
    this.maxOutputChars = limits.maxOutputChars ?? 2_000_000;
  }

  // Returns true the moment a limit is exceeded; thereafter `reason` is set. Short repeated deltas
  // are the degenerate signal — long varied text just accumulates against the char cap.
  push(delta: string): boolean {
    this.chars += delta.length;
    if (delta === this.last) this.repeats++; else { this.repeats = 1; this.last = delta; }
    if (delta.length <= 16 && this.repeats > this.maxRepeats) { this.reason = "repetition"; return true; }
    if (this.chars > this.maxOutputChars) { this.reason = "max_output"; return true; }
    return false;
  }
}
