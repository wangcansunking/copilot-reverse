import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// A "profile" is an isolated instance of the app — its own ports AND its own data dir — so a dev build
// can run alongside the installed prod build without the two fighting over :7890/:7891 or scribbling on
// the same ~/.copilot-reverse (token, db, access key, client-setup). Selected by COPILOT_REVERSE_PROFILE;
// absent ⇒ the "default" (prod) profile, byte-identical to historical behavior.
//
// Resolution is a PURE function of the environment (no I/O) so it's fully unit-testable and every
// consumer — dataDir(), defaultConfig(), the daemon probe — derives from one place and can't drift.

// The historical base ports. The default profile uses these unchanged; named profiles offset off them.
export const BASE_SUPERVISOR_PORT = 7890;
export const BASE_WORKER_PORT = 7891;
// The prod data-dir name. Named profiles get a "<base>-<name>" sibling so they're easy to spot and rm.
export const BASE_DATA_DIR_NAME = ".copilot-reverse";
// dev is a first-class, well-known profile with pretty fixed ports (+100) rather than a hashed offset.
const DEV_PORT_OFFSET = 100;

export interface ProfileResolution {
  name: string; // "default" | "dev" | <custom>
  dataDirName: string; // relative dir name under $HOME, e.g. ".copilot-reverse-dev"
  dataDirOverride?: string; // absolute path from COPILOT_REVERSE_DATA_DIR; wins over dataDirName
  supervisorPort: number;
  workerPort: number;
}

// A small deterministic offset for an arbitrary named profile, so two different names are very unlikely
// to collide on ports. dev is special-cased to +100; default is +0. Kept in a sane range (×10, under
// ~8000 span) and away from 0 so a custom name never silently lands on the prod ports.
function offsetFor(name: string): number {
  if (name === "default") return 0;
  if (name === "dev") return DEV_PORT_OFFSET;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return 200 + (h % 600) * 10; // 200..6190, even tens; never collides with default(0) or dev(100)
}

// Resolve the active profile from env. Precedence for ports: an explicit SUPERVISOR_PORT / WORKER_PORT
// always wins (CI, manual tuning, the historical WORKER_PORT knob), else they're derived from the
// profile's offset. Precedence for the data dir: an explicit COPILOT_REVERSE_DATA_DIR wins, else the
// "<base>[-<name>]" convention.
export function resolveProfile(env: NodeJS.ProcessEnv = process.env): ProfileResolution {
  const raw = (env.COPILOT_REVERSE_PROFILE ?? "").trim();
  const name = raw === "" ? "default" : raw;
  const off = offsetFor(name);
  const dataDirName = name === "default" ? BASE_DATA_DIR_NAME : `${BASE_DATA_DIR_NAME}-${name}`;
  const override = (env.COPILOT_REVERSE_DATA_DIR ?? "").trim();
  const envPort = (v: string | undefined): number | undefined => {
    const n = Number(v);
    return v && Number.isInteger(n) && n > 0 ? n : undefined;
  };
  return {
    name,
    dataDirName,
    dataDirOverride: override === "" ? undefined : override,
    supervisorPort: envPort(env.SUPERVISOR_PORT) ?? BASE_SUPERVISOR_PORT + off,
    workerPort: envPort(env.WORKER_PORT) ?? BASE_WORKER_PORT + off,
  };
}

// The absolute data dir for a resolution: the explicit override if set, else $HOME/<dataDirName>.
export function profileDataDir(p: ProfileResolution, home: string = homedir()): string {
  return p.dataDirOverride ?? join(home, p.dataDirName);
}

// One-call convenience for process entry points: resolve the active profile and, if it's a non-default
// profile whose data dir doesn't exist yet, seed it from the prod data dir (idempotent — see
// seedProfileFromBase). Returns the resolution so callers can show the profile name. Safe and cheap to
// call on every boot; for the default profile it's a no-op (base === target).
export function ensureProfileSeeded(home: string = homedir()): { profile: ProfileResolution; outcome: SeedOutcome } {
  const profile = resolveProfile();
  const target = profileDataDir(profile, home);
  const outcome = seedProfileFromBase(join(home, BASE_DATA_DIR_NAME), target);
  return { profile, outcome };
}

// Files seeded into a fresh non-default profile from the prod data dir, so the new instance starts
// signed-in instead of forcing a re-/login. We copy CREDENTIALS and harmless prefs only:
//   - creds.json  (GitHub token)        — the whole point: don't re-login
//   - webiq.json  (WebIQ key + mode)    — a key; carry it over
//   - prefs.json  (chosen model, banner)— harmless, keeps your pinned model
// network.json is handled specially (key copied, mode forced to localhost — a dev instance must not
// inherit a LAN posture and bind 0.0.0.0 on first boot). DELIBERATELY NOT copied:
//   - clients.json — records that a CLIENT was pointed at the PROD ports; copying it would make the
//                    dev HUD claim "configured" while the client still talks to prod. Start at false.
//   - copilot-reverse.db — dev gets its own empty metrics/log db.
//   - config.json / crash logs — instance-local, not credentials.
const PLAIN_SEED_FILES = ["creds.json", "webiq.json", "prefs.json"] as const;

export type SeedOutcome = "noop-same-dir" | "exists" | "seeded";

// Idempotently seed `targetDir` from `baseDir` (prod). No-op if they're the same path or the target
// already exists — so this is safe to call on every boot; it only acts the first time a profile appears.
// Best-effort per file: an unreadable/corrupt source is skipped, never thrown (matches how every store
// here treats a bad file as "absent"). Returns what happened, for an optional one-line UI note.
export function seedProfileFromBase(baseDir: string, targetDir: string): SeedOutcome {
  if (baseDir === targetDir) return "noop-same-dir";
  if (existsSync(targetDir)) return "exists";
  mkdirSync(targetDir, { recursive: true });
  if (!existsSync(baseDir)) return "seeded"; // nothing to copy from; fresh empty profile
  for (const f of PLAIN_SEED_FILES) {
    const src = join(baseDir, f);
    if (existsSync(src)) {
      try { copyFileSync(src, join(targetDir, f)); } catch { /* skip unreadable source */ }
    }
  }
  // network.json: carry the KEY but reset the mode to safe localhost.
  const netSrc = join(baseDir, "network.json");
  if (existsSync(netSrc)) {
    try {
      const key = (JSON.parse(readFileSync(netSrc, "utf8")) as { key?: string }).key;
      if (key) writeFileSync(join(targetDir, "network.json"), JSON.stringify({ key }), { mode: 0o600 });
    } catch { /* corrupt source → no network seed; dev starts keyless+localhost */ }
  }
  return "seeded";
}
