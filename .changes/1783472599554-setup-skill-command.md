---
bump: minor
---
feat(skills): add `/setup-skill` — install a bundled agent skill into Claude Code (`~/.claude/skills/` global or `./.claude/skills/` project) via an interactive picker. Ships one curated skill, `analyze-session-create-issue`, which walks the agent through turning a session into a well-formed GitHub issue. Installs are idempotent and non-destructive to other skills.
