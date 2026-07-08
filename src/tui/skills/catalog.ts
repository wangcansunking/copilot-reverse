// Bundled agent-skill catalog. `/setup-skill` installs one of these into a client's skills directory
// (~/.claude/skills/<name>/ or .claude/skills/<name>/). Content is inlined as string constants — the
// build only compiles/ships `dist/` (see package.json `files`), so loose `.md` assets under src/ would
// never be published. `changes.ts` uses the same inline-constant pattern for the same reason.
//
// Each entry is one skill: `name` is the directory + the skill's canonical id, `files` maps a relative
// path (SKILL.md required, plus any extra resources) to its content. The map shape means a future
// multi-file skill (references/, scripts/) needs no change to the installer.

export interface SkillEntry {
  /** Directory name under the skills dir; also the skill's canonical id. kebab-case. */
  name: string;
  /** One-line human title shown in the picker. */
  title: string;
  /** One-line description shown under the title in the picker. */
  description: string;
  /** relative path -> file content. Must include "SKILL.md". */
  files: Record<string, string>;
}

// A skill that walks the agent through turning the current working session into a well-formed GitHub
// issue: gather what happened + environment diagnostics, then open a prefilled issue. Kept generic (no
// copilot-reverse specifics) so it's useful in any repo it's installed into.
const ANALYZE_SESSION_CREATE_ISSUE: SkillEntry = {
  name: "analyze-session-create-issue",
  title: "Analyze session → create GitHub issue",
  description: "Summarize what happened this session, gather diagnostics, and open a prefilled GitHub issue.",
  files: {
    "SKILL.md": `---
name: analyze-session-create-issue
description: Use when the user wants to file a GitHub issue from the current session — a bug they just hit, a feature they discussed, or work to hand off. Analyzes the conversation, gathers repo + environment context, and opens a well-formed issue.
---

# Analyze session → create GitHub issue

Turn the current working session into a clear, actionable GitHub issue. Do the analysis and
context-gathering yourself; only ask the user for what you genuinely cannot infer.

## When to use

- The user says "file an issue", "open a bug", "create a ticket", or "capture this for later".
- A bug surfaced during the session and it should be tracked rather than fixed right now.
- A feature or follow-up was discussed that belongs in the backlog.

## Steps

1. **Classify.** Decide the issue type from the conversation: \`bug\`, \`feature\`, or \`task\`. State your
   choice; don't ask unless it's genuinely ambiguous.

2. **Gather context — do this before asking the user anything.**
   - What was attempted and what actually happened (pull the concrete facts from the session, not a
     vague paraphrase).
   - Repo + branch: \`git rev-parse --abbrev-ref HEAD\` and \`git remote get-url origin\`.
   - For a bug: exact error text, the smallest reproduction, and expected vs. actual behavior.
   - Environment when relevant: OS, runtime version (e.g. \`node --version\`), and the tool/app version.

3. **Draft the issue** using the template below. Keep the title one specific line — name the symptom
   or the change, not the area ("Login 500s when email has a +tag", not "Login problem").

4. **Confirm, then file.** Show the user the drafted title + body and confirm the target repo. Only
   after they approve, create it:
   - Preferred: \`gh issue create --title "<title>" --body-file <tmpfile>\` (works when the GitHub CLI
     is authenticated). Add \`--label bug\` / \`--label enhancement\` when the repo has those labels.
   - Fallback: build a prefilled URL — \`https://github.com/<owner>/<repo>/issues/new?title=<enc>&body=<enc>\`
     (URL-encode both) — and give it to the user to open.
   - Never open an issue without the user's explicit go-ahead; it's outward-facing.

5. **Report** the created issue number/URL, or the prefilled URL if you used the fallback.

## Issue body template

\`\`\`markdown
## Summary
<one paragraph: what this is and why it matters>

## Context
- Repo / branch: <repo> @ <branch>
- Environment: <OS, runtime version, app version — when relevant>

## Details
<for a bug: steps to reproduce, expected vs. actual, exact error output in a code block>
<for a feature/task: the desired behavior and any constraints discussed>

## References
<links, file paths (path:line), related issues/PRs>
\`\`\`

## Guardrails

- Don't invent reproduction steps or error text — if you don't have them, say so and ask.
- Redact secrets/tokens from any pasted logs before they go into the issue.
- One issue per distinct problem. If the session surfaced several, propose splitting them.
`,
  },
};

export const SKILL_CATALOG: SkillEntry[] = [ANALYZE_SESSION_CREATE_ISSUE];

export function findSkill(name: string): SkillEntry | undefined {
  return SKILL_CATALOG.find((s) => s.name === name);
}
