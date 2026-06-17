# llm-maestro

Interactive terminal app that turns your GitHub Copilot subscription into local
OpenAI- and Anthropic-compatible endpoints, with a self-healing daemon and a
built-in assistant.

> **Disclaimer:** The GitHub Copilot integration uses community-documented,
> unofficial endpoints, for use with your own Copilot subscription only. It may
> break if GitHub changes these endpoints.

## Quick start

```bash
npx llm-maestro      # device-code login, then the TUI launches
```

In the TUI: `/help`, `/doctor`, `/setup-claude`, `/setup-codex`, `/metrics`, or
just talk to the assistant in natural language.

Point clients at:
- OpenAI: `http://127.0.0.1:7891/v1`
- Anthropic: `http://127.0.0.1:7891`

## Architecture (M1)

- **TUI** (Ink) — the `maestro` process: REPL + slash commands + claude-agent-sdk
  assistant (which dogfoods maestro's own Anthropic endpoint).
- **Supervisor** (:7890) — control API + SQLite + self-healing worker supervision.
- **Worker** (:7891) — OpenAI `/v1/chat/completions` + Anthropic `/v1/messages`
  → Copilot, with tool-use translation both ways.

## Development

```bash
npm install && npm test && npm run build
```

> **Build/test note:** use Node 20. `better-sqlite3` has no prebuilt binary for
> Node 25 and will fail to compile there; Node 20 installs from a prebuild.

### Test notes

- **TUI input tests** (`tests/tui/app.test.tsx`): the test waits ~30 ms after
  `render()` before writing to `stdin`. This is not flakiness padding — Ink's
  `useInput` subscribes to stdin asynchronously after mount, so writes issued in
  the same tick as `render()` are dropped. The delay lets the subscription
  attach; assertions are otherwise unchanged.
