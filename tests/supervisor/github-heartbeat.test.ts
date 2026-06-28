import { describe, it, expect, vi } from "vitest";
import {
  nextGithubStatus, GithubHeartbeat,
  GITHUB_HEARTBEAT_INTERVAL_MS, GITHUB_HEARTBEAT_INITIAL_DELAY_MS,
} from "../../src/supervisor/github-heartbeat.js";
import type { AuthProbe } from "../../src/providers/copilot/token.js";
import type { GithubStatus } from "../../src/shared/control-types.js";

const ok: AuthProbe = { ok: true, transient: false, detail: "token valid" };
const expired: AuthProbe = { ok: false, transient: false, detail: "GitHub login expired" };
const blip: AuthProbe = { ok: false, transient: true, detail: "ECONNRESET" };

describe("nextGithubStatus (pure reducer)", () => {
  it("signed-out when there is no token (probe ignored)", () => {
    expect(nextGithubStatus(undefined, false, null, 5)).toEqual({ ok: false, hasToken: false, checkedAt: 5, detail: "not logged in — run /login" });
  });
  it("connected on a successful probe", () => {
    expect(nextGithubStatus(undefined, true, ok, 7)).toEqual({ ok: true, hasToken: true, checkedAt: 7, detail: "token valid" });
  });
  it("expired on a definitive (non-transient) failure", () => {
    expect(nextGithubStatus(undefined, true, expired, 9)).toEqual({ ok: false, hasToken: true, checkedAt: 9, detail: "GitHub login expired" });
  });
  it("keeps the previous status on a transient failure (sticky, no flip)", () => {
    const prev: GithubStatus = { ok: true, hasToken: true, checkedAt: 1, detail: "token valid" };
    expect(nextGithubStatus(prev, true, blip, 99)).toBe(prev); // unchanged reference
  });
  it("stays pending (undefined) when the first probe is transient", () => {
    expect(nextGithubStatus(undefined, true, blip, 99)).toBeUndefined();
  });
});

describe("GithubHeartbeat", () => {
  it("runOnce → signed-out without calling the probe when there is no token", async () => {
    const probe = vi.fn();
    const hb = new GithubHeartbeat(() => null, probe as unknown as (t: string) => Promise<AuthProbe>, () => 42);
    await hb.runOnce();
    expect(probe).not.toHaveBeenCalled();
    expect(hb.current()).toEqual({ ok: false, hasToken: false, checkedAt: 42, detail: "not logged in — run /login" });
  });
  it("runOnce → connected when the token exchanges", async () => {
    const hb = new GithubHeartbeat(() => "gho", async () => ok, () => 1);
    await hb.runOnce();
    expect(hb.current()).toMatchObject({ ok: true, hasToken: true });
  });
  it("runOnce → expired on a definitive failure", async () => {
    const hb = new GithubHeartbeat(() => "gho", async () => expired, () => 1);
    await hb.runOnce();
    expect(hb.current()).toMatchObject({ ok: false, hasToken: true });
  });
  it("a transient failure does not flip a previously-connected status", async () => {
    const probe = vi.fn<[], Promise<AuthProbe>>().mockResolvedValueOnce(ok).mockResolvedValueOnce(blip);
    const hb = new GithubHeartbeat(() => "gho", probe as unknown as (t: string) => Promise<AuthProbe>, () => 1);
    await hb.runOnce(); // connected
    await hb.runOnce(); // transient blip
    expect(hb.current()).toMatchObject({ ok: true });
  });
  it("current() is undefined before the first probe", () => {
    const hb = new GithubHeartbeat(() => "gho", async () => ok);
    expect(hb.current()).toBeUndefined();
  });

  it("start() probes after the initial delay, then every interval; stop() halts it", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn(async () => ok);
      const hb = new GithubHeartbeat(() => "gho", probe, () => 1);
      hb.start();
      expect(probe).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(GITHUB_HEARTBEAT_INITIAL_DELAY_MS);
      expect(probe).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(GITHUB_HEARTBEAT_INTERVAL_MS);
      expect(probe).toHaveBeenCalledTimes(2);
      hb.stop();
      await vi.advanceTimersByTimeAsync(GITHUB_HEARTBEAT_INTERVAL_MS * 3);
      expect(probe).toHaveBeenCalledTimes(2); // no further probes after stop
    } finally {
      vi.useRealTimers();
    }
  });
});
