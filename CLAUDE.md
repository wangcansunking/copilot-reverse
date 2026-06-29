# CLAUDE.md

Guidance for Claude Code when working in this repo.

## Workflow: prefer git worktrees

**For any new feature or bug fix, work in a dedicated git worktree — do not commit directly on `master`.**

- At the start of a feature/bugfix task, create a worktree (use the `EnterWorktree` tool, or `git worktree add`) and do all work there on a new branch.
- Keep `master` clean; open a PR from the worktree branch to merge.
- Small, single-file edits, docs-only tweaks, or quick investigations don't need a worktree — use judgment.
- When the work is merged or abandoned, remove the worktree.
- **After a PR merges:** exit the worktree, `git push origin --delete <branch>`, remove the worktree, delete the local branch, then fast-forward `master` to the merged commit (`git fetch origin && git merge --ff-only origin/master`) so the next task branches from latest.

## Commit hygiene

- Stage by explicit path (`git add <path>`). **Never** `git add -A` / `git add .` — the tree is shared and may hold unrelated changes.
- Create new commits; don't amend published ones.

## Releases: every change must ship a changeset

**Every PR that changes behavior MUST add a changeset, or it will never publish.** Release is changeset-driven: `release.yml` runs on push to `master`, and with no file in `.changes/` the release job is skipped — no version bump, no `npm publish`. PRs merged without one silently leave npm stale.

- Scaffold one: `node scripts/changesets.mjs new <patch|minor|major> <slug>`, then edit the body (it lands in `CHANGELOG.md`).
- Choose: `patch` = fix, `minor` = feature, `major` = breaking. Highest level among pending changesets wins.
- Exempt only: docs/test-only tweaks with no shipped behavior change.

## Dev essentials

Requires Node >=20.

- Install / verify: `npm install && npm test && npm run build`
- Run the app locally: `npm run dev` (tsx on `src/`, no build needed)
- Tests: `npm test` (vitest, includes e2e) · `npm run test:e2e` (e2e only)
- **Every change must keep the full e2e suite green.** After a change, re-run and update [`e2e/RESULTS.md`](e2e/RESULTS.md). Case catalog: [`e2e/cases.md`](e2e/cases.md).
- **Prefer adding a docker e2e case for every change.** The HTTP edge matrix (`e2e/docker/http-e2e.mjs`) drives the real worker+supervisor over HTTP — add an assertion there when a change touches request/response, metrics, or supervision so regressions are caught hermetically. Skip only when nothing observable changed (pure docs/refactor).

## Architecture (3 processes, one terminal app)

- **TUI** (Ink) — the `copilot-reverse` process: REPL + slash commands + a claude-agent-sdk assistant.
- **Supervisor** (:7890) — control API + SQLite + self-healing worker supervision.
- **Worker** (:7891) — OpenAI `/openai/chat/completions` + Anthropic `/anthropic/v1/messages` → Copilot, with tool-use translation both ways.

Data dir: `~/.copilot-reverse`.
