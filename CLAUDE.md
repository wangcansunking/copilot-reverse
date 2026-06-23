# CLAUDE.md

Guidance for Claude Code when working in this repo.

## Workflow: prefer git worktrees

**For any new feature or bug fix, work in a dedicated git worktree — do not commit directly on `master`.**

- At the start of a feature/bugfix task, create a worktree (use the `EnterWorktree` tool, or `git worktree add`) and do all work there on a new branch.
- Keep `master` clean; open a PR from the worktree branch to merge.
- Small, single-file edits, docs-only tweaks, or quick investigations don't need a worktree — use judgment.
- When the work is merged or abandoned, remove the worktree.

## Commit hygiene

- Stage by explicit path (`git add <path>`). **Never** `git add -A` / `git add .` — the tree is shared and may hold unrelated changes.
- Create new commits; don't amend published ones.

## Dev essentials

Requires Node >=20.

- Install / verify: `npm install && npm test && npm run build`
- Run the app locally: `npm run dev` (tsx on `src/`, no build needed)
- Tests: `npm test` (vitest, includes e2e) · `npm run test:e2e` (e2e only)
- **Every change must keep the full e2e suite green.** After a change, re-run and update [`e2e/RESULTS.md`](e2e/RESULTS.md). Case catalog: [`e2e/cases.md`](e2e/cases.md).

## Architecture (3 processes, one terminal app)

- **TUI** (Ink) — the `copilot-reverse` process: REPL + slash commands + a claude-agent-sdk assistant.
- **Supervisor** (:7890) — control API + SQLite + self-healing worker supervision.
- **Worker** (:7891) — OpenAI `/openai/chat/completions` + Anthropic `/anthropic/v1/messages` → Copilot, with tool-use translation both ways.

Data dir: `~/.copilot-reverse`.
