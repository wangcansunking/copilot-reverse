import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, skillsDir } from "../../src/tui/skills/install.js";
import { SKILL_CATALOG, findSkill } from "../../src/tui/skills/catalog.js";

const entry = SKILL_CATALOG[0];

describe("skill catalog", () => {
  it("is non-empty and every entry is well-formed", () => {
    expect(SKILL_CATALOG.length).toBeGreaterThan(0);
    for (const s of SKILL_CATALOG) {
      expect(s.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/); // kebab-case id
      expect(s.title).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(s.files["SKILL.md"]).toBeTruthy(); // SKILL.md is required
      // The frontmatter `name:` must match the entry id so the client indexes it under the right id.
      expect(s.files["SKILL.md"]).toMatch(new RegExp(`^---[\\s\\S]*?\\nname:\\s*${s.name}\\b`));
      expect(s.files["SKILL.md"]).toMatch(/\ndescription:\s*\S/); // has a description in frontmatter
    }
  });
  it("names are unique", () => {
    const names = SKILL_CATALOG.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it("findSkill resolves by name and misses cleanly", () => {
    expect(findSkill(entry.name)).toBe(entry);
    expect(findSkill("does-not-exist")).toBeUndefined();
  });
});

describe("skillsDir", () => {
  it("resolves global under home/.claude/skills and project under cwd/.claude/skills", () => {
    expect(skillsDir("global", { home: "/h", cwd: "/c" })).toBe(join("/h", ".claude", "skills"));
    expect(skillsDir("project", { home: "/h", cwd: "/c" })).toBe(join("/c", ".claude", "skills"));
  });
});

describe("installSkill", () => {
  it("writes SKILL.md under <skillsDir>/<name>/ (project scope)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "skill-"));
    const r = installSkill("project", entry, { cwd });
    expect(r.path).toBe(join(cwd, ".claude", "skills", entry.name));
    expect(r.changed).toContain("SKILL.md");
    const written = readFileSync(join(r.path, "SKILL.md"), "utf8");
    expect(written).toBe(entry.files["SKILL.md"]);
  });

  it("writes under home/.claude/skills for global scope", () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const r = installSkill("global", entry, { home });
    expect(r.path).toBe(join(home, ".claude", "skills", entry.name));
    expect(existsSync(join(r.path, "SKILL.md"))).toBe(true);
  });

  it("re-installing identical content reports no change (idempotent)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "skill-"));
    installSkill("project", entry, { cwd });
    const again = installSkill("project", entry, { cwd });
    expect(again.changed).toEqual([]);
  });

  it("overwrites a stale copy and reports it changed", () => {
    const cwd = mkdtempSync(join(tmpdir(), "skill-"));
    const dir = join(cwd, ".claude", "skills", entry.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "old stale content");
    const r = installSkill("project", entry, { cwd });
    expect(r.changed).toContain("SKILL.md");
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe(entry.files["SKILL.md"]);
  });

  it("does not disturb other skills already in the skills dir", () => {
    const cwd = mkdtempSync(join(tmpdir(), "skill-"));
    const other = join(cwd, ".claude", "skills", "someone-elses-skill");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "SKILL.md"), "keep me");
    installSkill("project", entry, { cwd });
    expect(readFileSync(join(other, "SKILL.md"), "utf8")).toBe("keep me"); // untouched
  });

  it("writes multi-file skills preserving relative paths", () => {
    const cwd = mkdtempSync(join(tmpdir(), "skill-"));
    const multi = { name: "multi", title: "m", description: "d",
      files: { "SKILL.md": "top", "references/extra.md": "nested" } };
    const r = installSkill("project", multi, { cwd });
    expect(r.changed.sort()).toEqual(["SKILL.md", "references/extra.md"].sort());
    expect(readFileSync(join(r.path, "references", "extra.md"), "utf8")).toBe("nested");
  });
});
