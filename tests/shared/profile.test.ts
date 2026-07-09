import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveProfile,
  profileDataDir,
  seedProfileFromBase,
  BASE_SUPERVISOR_PORT,
  BASE_WORKER_PORT,
} from "../../src/shared/profile.js";

describe("resolveProfile", () => {
  it("default profile is byte-identical to historical behavior", () => {
    const p = resolveProfile({});
    expect(p.name).toBe("default");
    expect(p.dataDirName).toBe(".copilot-reverse");
    expect(p.dataDirOverride).toBeUndefined();
    expect(p.supervisorPort).toBe(BASE_SUPERVISOR_PORT);
    expect(p.workerPort).toBe(BASE_WORKER_PORT);
  });

  it("dev profile gets +100 ports and a -dev data dir", () => {
    const p = resolveProfile({ COPILOT_REVERSE_PROFILE: "dev" });
    expect(p.name).toBe("dev");
    expect(p.dataDirName).toBe(".copilot-reverse-dev");
    expect(p.supervisorPort).toBe(7990);
    expect(p.workerPort).toBe(7991);
  });

  it("blank/whitespace profile falls back to default", () => {
    expect(resolveProfile({ COPILOT_REVERSE_PROFILE: "   " }).name).toBe("default");
    expect(resolveProfile({ COPILOT_REVERSE_PROFILE: "" }).supervisorPort).toBe(BASE_SUPERVISOR_PORT);
  });

  it("a custom profile name never collides with default or dev ports", () => {
    for (const name of ["staging", "test", "qa", "alice", "x"]) {
      const p = resolveProfile({ COPILOT_REVERSE_PROFILE: name });
      expect(p.dataDirName).toBe(`.copilot-reverse-${name}`);
      expect(p.supervisorPort).not.toBe(7890);
      expect(p.supervisorPort).not.toBe(7990);
      expect(p.workerPort).not.toBe(7891);
      expect(p.workerPort).not.toBe(7991);
    }
  });

  it("explicit SUPERVISOR_PORT / WORKER_PORT override the derived ports", () => {
    const p = resolveProfile({ COPILOT_REVERSE_PROFILE: "dev", SUPERVISOR_PORT: "9000", WORKER_PORT: "9001" });
    expect(p.supervisorPort).toBe(9000);
    expect(p.workerPort).toBe(9001);
  });

  it("ignores a non-numeric / non-positive port override", () => {
    const p = resolveProfile({ SUPERVISOR_PORT: "abc", WORKER_PORT: "0" });
    expect(p.supervisorPort).toBe(BASE_SUPERVISOR_PORT);
    expect(p.workerPort).toBe(BASE_WORKER_PORT);
  });

  it("COPILOT_REVERSE_DATA_DIR overrides the derived dir name", () => {
    const p = resolveProfile({ COPILOT_REVERSE_PROFILE: "dev", COPILOT_REVERSE_DATA_DIR: "/tmp/custom" });
    expect(p.dataDirOverride).toBe("/tmp/custom");
    expect(profileDataDir(p, "/home/u")).toBe("/tmp/custom");
  });

  it("profileDataDir joins HOME with the derived name when no override", () => {
    const p = resolveProfile({ COPILOT_REVERSE_PROFILE: "dev" });
    expect(profileDataDir(p, "/home/u")).toBe(join("/home/u", ".copilot-reverse-dev"));
  });
});

describe("seedProfileFromBase", () => {
  let root: string;
  let base: string;
  let target: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cr-profile-"));
    base = join(root, "prod");
    target = join(root, "dev");
    mkdirSync(base, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const seedBase = () => {
    writeFileSync(join(base, "creds.json"), JSON.stringify({ ghToken: "gho_PROD" }));
    writeFileSync(join(base, "webiq.json"), JSON.stringify({ apiKey: "wk_PROD", mode: "webiq" }));
    writeFileSync(join(base, "prefs.json"), JSON.stringify({ chatModel: "gpt-5.5" }));
    writeFileSync(join(base, "network.json"), JSON.stringify({ mode: "lan", key: "ACCESS_PROD" }));
    writeFileSync(join(base, "clients.json"), JSON.stringify({ claude: true, codex: true }));
    writeFileSync(join(base, "copilot-reverse.db"), "BINARYDB");
  };

  it("copies creds, webiq, prefs verbatim", () => {
    seedBase();
    expect(seedProfileFromBase(base, target)).toBe("seeded");
    expect(JSON.parse(readFileSync(join(target, "creds.json"), "utf8")).ghToken).toBe("gho_PROD");
    expect(JSON.parse(readFileSync(join(target, "webiq.json"), "utf8")).apiKey).toBe("wk_PROD");
    expect(JSON.parse(readFileSync(join(target, "prefs.json"), "utf8")).chatModel).toBe("gpt-5.5");
  });

  it("carries the access KEY but forces mode back to localhost", () => {
    seedBase();
    seedProfileFromBase(base, target);
    const net = JSON.parse(readFileSync(join(target, "network.json"), "utf8"));
    expect(net.key).toBe("ACCESS_PROD");
    expect(net.mode).toBeUndefined(); // absent ⇒ readAccessMode returns the safe localhost default
  });

  it("does NOT copy clients.json or the db (dev starts unconfigured with an empty db)", () => {
    seedBase();
    seedProfileFromBase(base, target);
    expect(existsSync(join(target, "clients.json"))).toBe(false);
    expect(existsSync(join(target, "copilot-reverse.db"))).toBe(false);
  });

  it("is a no-op when base and target are the same dir (the default profile)", () => {
    expect(seedProfileFromBase(base, base)).toBe("noop-same-dir");
  });

  it("does not re-seed an existing target (one-time snapshot, not continuous sync)", () => {
    seedBase();
    seedProfileFromBase(base, target);
    // prod rotates its token afterwards; dev must keep its original snapshot
    writeFileSync(join(base, "creds.json"), JSON.stringify({ ghToken: "gho_ROTATED" }));
    expect(seedProfileFromBase(base, target)).toBe("exists");
    expect(JSON.parse(readFileSync(join(target, "creds.json"), "utf8")).ghToken).toBe("gho_PROD");
  });

  it("seeds an empty profile when base has no files yet", () => {
    expect(seedProfileFromBase(base, target)).toBe("seeded");
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, "creds.json"))).toBe(false);
  });

  it("network seed with no key writes nothing (dev stays keyless+localhost)", () => {
    writeFileSync(join(base, "network.json"), JSON.stringify({ mode: "lan" }));
    seedProfileFromBase(base, target);
    expect(existsSync(join(target, "network.json"))).toBe(false);
  });
});
