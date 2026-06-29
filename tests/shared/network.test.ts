import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readAccessMode, readAccessKey, setAccessMode, rotateAccessKey, generateAccessKey,
} from "../../src/shared/network.js";
import { workerBindHost } from "../../src/shared/config.js";

const mkdir = () => mkdtempSync(join(tmpdir(), "cr-net-"));

describe("network access mode store", () => {
  const prevMode = process.env.ACCESS_MODE;
  const prevKey = process.env.ACCESS_KEY;
  beforeEach(() => { delete process.env.ACCESS_MODE; delete process.env.ACCESS_KEY; });
  afterEach(() => {
    if (prevMode === undefined) delete process.env.ACCESS_MODE; else process.env.ACCESS_MODE = prevMode;
    if (prevKey === undefined) delete process.env.ACCESS_KEY; else process.env.ACCESS_KEY = prevKey;
  });

  it("defaults to localhost when nothing is stored", () => {
    expect(readAccessMode(mkdir())).toBe("localhost");
    expect(readAccessKey(mkdir())).toBeNull();
  });

  it("a corrupt network.json reads as the safe localhost default (never silently opens LAN)", () => {
    const d = mkdir();
    writeFileSync(join(d, "network.json"), "{ broken");
    expect(readAccessMode(d)).toBe("localhost");
  });

  it("entering LAN is fail-closed: a key is minted in the same write so lan is never keyless", () => {
    const d = mkdir();
    const { mode, key } = setAccessMode(d, "lan");
    expect(mode).toBe("lan");
    expect(key).toBeTruthy();
    expect(readAccessMode(d)).toBe("lan");
    expect(readAccessKey(d)).toBe(key); // persisted, guards the proxy
  });

  it("toggling localhost→lan→localhost→lan reuses the same key (no churn per toggle)", () => {
    const d = mkdir();
    const first = setAccessMode(d, "lan").key;
    setAccessMode(d, "localhost");
    expect(readAccessKey(d)).toBe(first); // key kept on disk when leaving LAN
    const second = setAccessMode(d, "lan").key;
    expect(second).toBe(first);
  });

  it("rotateAccessKey replaces the key and persists it without changing the mode", () => {
    const d = mkdir();
    const k1 = setAccessMode(d, "lan").key;
    const k2 = rotateAccessKey(d);
    expect(k2).not.toBe(k1);
    expect(readAccessKey(d)).toBe(k2);
    expect(readAccessMode(d)).toBe("lan"); // rotate does not touch the mode
  });

  it("rotating in localhost pre-seeds a key reused by the next LAN switch", () => {
    const d = mkdir();
    const seeded = rotateAccessKey(d);
    expect(readAccessMode(d)).toBe("localhost");
    expect(setAccessMode(d, "lan").key).toBe(seeded);
  });

  it("ACCESS_MODE env overrides the file (both directions)", () => {
    const d = mkdir();
    setAccessMode(d, "localhost");
    process.env.ACCESS_MODE = "lan";
    expect(readAccessMode(d)).toBe("lan");
    process.env.ACCESS_MODE = "localhost";
    setAccessMode(d, "lan");
    expect(readAccessMode(d)).toBe("localhost");
  });

  it("ACCESS_KEY env overrides the stored key", () => {
    const d = mkdir();
    setAccessMode(d, "lan");
    process.env.ACCESS_KEY = "from_env";
    expect(readAccessKey(d)).toBe("from_env");
  });

  it("setAccessMode(lan) honors ACCESS_KEY env instead of minting (CI-injected key)", () => {
    const d = mkdir();
    process.env.ACCESS_KEY = "ci_injected";
    expect(setAccessMode(d, "lan").key).toBe("ci_injected");
  });

  it("rotateAccessKey returns the EFFECTIVE key — an ACCESS_KEY env override is reflected honestly", () => {
    const d = mkdir();
    process.env.ACCESS_KEY = "env_wins";
    // Rotation writes a fresh key to disk (survives a future env-unset) but reports what the gate will
    // actually accept right now — the env value — so the UI never claims a rotation the env shadows.
    expect(rotateAccessKey(d)).toBe("env_wins");
  });

  it("generateAccessKey produces distinct url-safe keys", () => {
    const a = generateAccessKey(), b = generateAccessKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url: no +/= padding to mangle in a URL
    expect(a.length).toBeGreaterThanOrEqual(40);
  });
});

describe("workerBindHost", () => {
  it("localhost binds loopback only", () => {
    expect(workerBindHost("localhost")).toBe("127.0.0.1");
  });
  it("lan binds all interfaces so the network can reach the proxy", () => {
    expect(workerBindHost("lan")).toBe("0.0.0.0");
  });
});
