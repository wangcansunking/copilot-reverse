import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCrashLog, CRASH_LOG_NAME, CRASH_LOG_MAX_BYTES } from "../../src/shared/crash-log.js";

describe("appendCrashLog", () => {
  it("appends a timestamped line with the kind and error detail", () => {
    const d = mkdtempSync(join(tmpdir(), "cl-"));
    appendCrashLog("uncaughtException", new Error("boom"), d);
    const body = readFileSync(join(d, CRASH_LOG_NAME), "utf8");
    expect(body).toMatch(/uncaughtException: boom/);
    expect(body).toMatch(/^\[\d{4}-\d{2}-\d{2}T/); // ISO timestamp prefix
  });

  it("rotates to crash.log.1 once the file reaches the size cap", () => {
    const d = mkdtempSync(join(tmpdir(), "cl-"));
    const path = join(d, CRASH_LOG_NAME);
    // Pre-fill past the cap so the next append triggers a roll.
    writeFileSync(path, "x".repeat(CRASH_LOG_MAX_BYTES));
    appendCrashLog("test", "after-roll", d);
    expect(existsSync(`${path}.1`)).toBe(true);                 // old generation preserved
    expect(statSync(`${path}.1`).size).toBe(CRASH_LOG_MAX_BYTES);
    const fresh = readFileSync(path, "utf8");
    expect(fresh).toMatch(/test: after-roll/);                  // new file starts fresh
    expect(fresh.length).toBeLessThan(CRASH_LOG_MAX_BYTES);
  });

  it("never throws even when the target dir is unwritable", () => {
    // Point at a path whose parent is a file, so mkdir/append fail — must be swallowed.
    const d = mkdtempSync(join(tmpdir(), "cl-"));
    const fileAsParent = join(d, "afile");
    writeFileSync(fileAsParent, "i am a file");
    expect(() => appendCrashLog("x", new Error("y"), join(fileAsParent, "nested"))).not.toThrow();
  });
});
