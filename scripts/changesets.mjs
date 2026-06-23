// Lightweight changeset engine (no @changesets/cli dependency — overkill for a single-package repo).
//
// A "changeset" is any .md file in .changes/ (except README.md) carrying a bump level:
//
//   ---
//   bump: minor      # patch | minor | major
//   ---
//   Human-readable summary of the change (goes into CHANGELOG.md).
//
// The release workflow reads `status` to decide whether (and how much) to bump, publishes,
// then calls `consume` to delete the spent changesets. Developers scaffold one with `new`.
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(root, ".changes");
const BUMP_ORDER = { patch: 1, minor: 2, major: 3 };
const BUMP_RE = /^bump:\s*(patch|minor|major)\s*$/im;

// Strips an optional leading `--- ... ---` front-matter fence, returning the prose body.
function stripFrontMatter(text) {
  const m = text.match(/^---\n[\s\S]*?\n---\n?/);
  return (m ? text.slice(m[0].length) : text).trim();
}

// Every non-README .md in .changes/ is a changeset. A missing/invalid bump line is a hard error —
// a typo'd level must fail loudly, not silently skip a release.
function active() {
  if (!existsSync(DIR)) return [];
  const out = [];
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".md") || f === "README.md") continue;
    const full = join(DIR, f);
    const text = readFileSync(full, "utf8");
    const m = text.match(BUMP_RE);
    if (!m) throw new Error(`changeset ${f} has no valid "bump: patch|minor|major" line`);
    out.push({ file: full, name: f, bump: m[1].toLowerCase(), body: stripFrontMatter(text.replace(/^---\n[\s\S]*?\n---\n?/, "")) });
  }
  return out;
}

const highest = (list) => list.reduce((hi, x) => (BUMP_ORDER[x.bump] > BUMP_ORDER[hi] ? x.bump : hi), "patch");

const cmd = process.argv[2];

if (cmd === "status") {
  const list = active();
  const result = { hasChangeset: list.length > 0, bump: list.length ? highest(list) : null, files: list.map((x) => x.name), bodies: list.map((x) => x.body) };
  console.log(JSON.stringify(result, null, 2));
  if (process.argv.includes("--github-output") && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `has=${result.hasChangeset}\nbump=${result.bump ?? ""}\n`);
  }
} else if (cmd === "bodies") {
  // Print just the changeset bodies (used by the release workflow to build CHANGELOG entries).
  console.log(active().map((x) => x.body).filter(Boolean).join("\n\n"));
} else if (cmd === "consume") {
  const list = active();
  for (const x of list) rmSync(x.file);
  console.log(`consumed ${list.length} changeset(s)`);
} else if (cmd === "new") {
  const bump = process.argv[3];
  if (!BUMP_ORDER[bump]) { console.error("usage: changesets.mjs new <patch|minor|major> [slug...]"); process.exit(1); }
  const slug = process.argv.slice(4).join("-").replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "change";
  // No Date.now() name collisions in practice; if two land the same ms, the second just overwrites — fine for a scaffold.
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const file = join(DIR, `${Date.now()}-${slug}.md`);
  writeFileSync(file, `---\nbump: ${bump}\n---\nDescribe the change here (this line lands in CHANGELOG.md).\n`);
  console.log(`created ${file}`);
} else {
  console.error("usage: changesets.mjs <status|bodies|consume|new>");
  process.exit(1);
}
