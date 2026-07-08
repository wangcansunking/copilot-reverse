import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { Scope, ApplyResult, PlaceOpts } from "../setup/apply.js";
import type { SkillEntry } from "./catalog.js";

// Where a client discovers skills: ~/.claude/skills/ (global, all projects on this machine) or
// <cwd>/.claude/skills/ (project-local). Mirrors claudePath() in setup/apply.ts — same .claude root,
// a sibling `skills/` dir. One directory per skill, holding its SKILL.md (+ any resources).
export function skillsDir(scope: Scope, o: PlaceOpts = {}): string {
  const home = o.home ?? homedir();
  const cwd = o.cwd ?? process.cwd();
  return scope === "global" ? join(home, ".claude", "skills") : join(cwd, ".claude", "skills");
}

// Install one catalog skill: write each of its files under <skillsDir>/<name>/. Overwrites an existing
// copy (re-running installs the bundled version — that's the intended "update to what shipped"), but
// only reports a path as changed when the content actually differs, so a no-op re-install reads clean.
// `path` is the skill's directory; `changed` is the list of files that were created or updated.
export function installSkill(scope: Scope, entry: SkillEntry, o: PlaceOpts = {}): ApplyResult {
  const dir = join(skillsDir(scope, o), entry.name);
  const changed: string[] = [];
  for (const [rel, content] of Object.entries(entry.files)) {
    const target = join(dir, rel);
    const prev = existsSync(target) ? safeRead(target) : undefined;
    if (prev === content) continue; // already up to date — don't report a spurious change
    if (!existsSync(dirname(target))) mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    changed.push(rel);
  }
  return { path: dir, changed };
}

function safeRead(p: string): string | undefined {
  try { return readFileSync(p, "utf8"); } catch { return undefined; }
}
