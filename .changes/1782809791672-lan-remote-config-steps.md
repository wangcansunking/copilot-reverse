---
bump: minor
---
feat(tui): LAN switch now shows paste-ready remote client config (Claude + Codex)

Switching `/network` to LAN used to dump the URL + key and a one-line "send it as
`Authorization: Bearer`" hint, leaving the user to hand-assemble each remote machine's config and
guess which slot the key goes in. The LAN success card now renders **paste-ready config blocks** for
both clients, with the key already in the correct place:

- **Claude** → `~/.claude/settings.json` `env` block (key in `ANTHROPIC_API_KEY`)
- **Codex** → `~/.codex/config.toml` provider block (key in `experimental_bearer_token`)

Blocks are built by a new pure helper (`tui/setup/remote-config.ts`) that reuses the same
`claudeCopilotReverseEnv` / codex-toml shape local `/setup` writes, so a remote config matches what
local setup produces — only the LAN host + real key replace loopback + the local placeholder. Each
block uses the model this machine has pinned for that client (falling back to sensible defaults) and
its real context window when known (Claude `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, Codex
`model_context_window`), so the remote client sizes context like the local one instead of assuming a
default ~200K window for a 1M model. If the LAN IPv4 can't be determined, the card falls back to a
`<this-machine-LAN-IP>` placeholder instead of crashing.
