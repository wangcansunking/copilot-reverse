import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCopilotModels } from "../../src/providers/copilot/models.js";
import { applyClaude, applyCodex } from "../../src/tui/setup/apply.js";
import { vi } from "vitest";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("fetchCopilotModels", () => {
  it("returns ids from the live list", async () => {
    const f = vi.fn(async () => json({ data: [{ id: "gpt-4o" }, { id: "claude-opus-4-8" }] }));
    expect(await fetchCopilotModels("cop", f as unknown as typeof fetch)).toEqual(["gpt-4o", "claude-opus-4-8"]);
  });
  it("falls back when endpoint fails", async () => {
    const f = vi.fn(async () => json({}, 500));
    const out = await fetchCopilotModels("cop", f as unknown as typeof fetch);
    expect(out).toContain("gpt-4o");
    expect(out.length).toBeGreaterThan(1);
  });
});

describe("applyClaude", () => {
  it("creates settings.json with merged env (project scope)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    const r = applyClaude("project", { ANTHROPIC_BASE_URL: "http://x", ANTHROPIC_API_KEY: "k" }, { cwd });
    expect(r.path).toBe(join(cwd, ".claude", "settings.json"));
    expect(r.changed).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"]);
    const s = JSON.parse(readFileSync(r.path, "utf8"));
    expect(s.env.ANTHROPIC_BASE_URL).toBe("http://x");
  });
  it("merges non-destructively into existing settings", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ theme: "dark", env: { KEEP: "1" } }));
    const r = applyClaude("project", { ANTHROPIC_BASE_URL: "http://x" }, { cwd });
    const s = JSON.parse(readFileSync(r.path, "utf8"));
    expect(s.theme).toBe("dark");       // preserved
    expect(s.env.KEEP).toBe("1");        // preserved
    expect(s.env.ANTHROPIC_BASE_URL).toBe("http://x"); // added
    expect(r.changed).toEqual(["ANTHROPIC_BASE_URL"]);
  });
});

describe("applyCodex", () => {
  it("writes/merges .env line-wise without clobbering other lines", () => {
    const cwd = mkdtempSync(join(tmpdir(), "proj-"));
    writeFileSync(join(cwd, ".env"), "EXISTING=1\nOPENAI_BASE_URL=old\n");
    const r = applyCodex("project", { OPENAI_BASE_URL: "http://x/v1", OPENAI_API_KEY: "k" }, { cwd });
    const txt = readFileSync(join(cwd, ".env"), "utf8");
    expect(txt).toContain("EXISTING=1");          // preserved
    expect(txt).toContain("OPENAI_BASE_URL=http://x/v1"); // replaced
    expect(txt).toContain("OPENAI_API_KEY=k");     // added
    expect(r.changed).toContain("OPENAI_BASE_URL");
    expect(r.changed).toContain("OPENAI_API_KEY");
  });
});
