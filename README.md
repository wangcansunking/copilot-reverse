# copilot-reverse

Interactive terminal app that turns your GitHub Copilot subscription into local
OpenAI- and Anthropic-compatible endpoints, with a self-healing daemon and a
built-in assistant.

> **New here? Read the [User Guide](GUIDE.md) — a 60-second start, no jargon.**

> **Disclaimer:** The GitHub Copilot integration uses community-documented,
> unofficial endpoints, for use with your own Copilot subscription only. It may
> break if GitHub changes these endpoints.

![copilot-reverse dashboard](images/dashboard.png)

## Quick start

```bash
npx copilot-reverse      # device-code login, then the TUI launches
```

In the TUI: `/help`, `/doctor`, `/setup-claude`, `/setup-codex`, `/metrics`, or
just talk to the assistant in natural language.

Point clients at:
- OpenAI: `http://127.0.0.1:7891/v1`
- Anthropic: `http://127.0.0.1:7891`

## Architecture (M1)

- **TUI** (Ink) — the `copilot-reverse` process: REPL + slash commands + claude-agent-sdk
  assistant (which dogfoods copilot-reverse's own Anthropic endpoint).
- **Supervisor** (:7890) — control API + SQLite + self-healing worker supervision.
- **Worker** (:7891) — OpenAI `/v1/chat/completions` + Anthropic `/v1/messages`
  → Copilot, with tool-use translation both ways.

## Development

Requires Node >=20.

```bash
npm install && npm test && npm run build
```

### End-to-end tests

The [`e2e/`](e2e/) folder holds cross-module end-to-end scenarios (real worker + supervisor +
TUI wiring, fake Copilot provider). The case catalog is [`e2e/cases.md`](e2e/cases.md) and the
latest run is [`e2e/RESULTS.md`](e2e/RESULTS.md).

**Every code change must keep the full e2e suite green.** `npm test` runs it (the suite is
included in the default vitest run); `npm run test:e2e` runs only the e2e cases. After a change,
re-run and update `e2e/RESULTS.md`.

### Test notes

- **TUI input tests** (`tests/tui/app.test.tsx`): the test waits ~30 ms after
  `render()` before writing to `stdin`. This is not flakiness padding — Ink's
  `useInput` subscribes to stdin asynchronously after mount, so writes issued in
  the same tick as `render()` are dropped. The delay lets the subscription
  attach; assertions are otherwise unchanged.
