# llm-maestro TUI — UX Spec

> Implementable with plain Ink primitives: `Box`, `Text`, `useInput`.
> No external UI deps beyond `ink` and `react`.

---

## 1. App Layout

```
┌──────────────────────────────────────────────────────────┐
│ llm-maestro                                   [worker: ready] │
├──────────────────────────────────────────────────────────┤
│ (scrollback region — fills all remaining height)         │
│                                                          │
│  › /status                                               │
│  worker: ready                                           │
│  llm-maestro — type /help, or talk to the assistant      │
│                                                          │
│  › how is the proxy doing?                               │
│  The worker is ready. No restart events in the last…     │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ › _                                                      │
└──────────────────────────────────────────────────────────┘
```

**Structure (Ink `flexDirection: "column"`):**

1. `HeaderBar` — single fixed line: app name left, worker state badge right.
2. `Scrollback` — a `Box` holding up to 200 rendered output lines (older entries
   fall off the top). Each line is one `<Text>` component. No horizontal scroll;
   long lines truncate at terminal width with a trailing `…`.
3. `Repl` — always pinned at the bottom: `cyan "› "` prompt + user input buffer.

The 200-line cap (`lines.slice(-200)`) is enforced in `App` state; no virtual
scrolling required in M1.

---

## 2. REPL Prompt

- Prompt character: `›` (U+203A), followed by a space, in **cyan**.
- User's typed characters echo immediately in the default (white) color.
- On `Enter`: the input is appended to scrollback as `› <typed text>` (cyan
  prompt + white input) before the command result lines appear. The buffer clears.
- On `Backspace`/`Delete`: remove last character from buffer.
- Ctrl/Meta key combos are ignored (no accidental control sequences).

### Input routing

| Prefix | Route |
|--------|-------|
| `/` | SlashRouter → produces string lines appended to scrollback |
| anything else | Assistant (`onChat`) → streams text lines into scrollback |

If the assistant is not yet wired (M1a), non-slash input produces the muted
notice: `(assistant not available yet — use /help)`.

---

## 3. Output Line Types

All output is plain `<Text>` lines appended to the scrollback array. Colors signal
semantics:

| Line type | Color | Example |
|-----------|-------|---------|
| User echo | `cyan "› "` + white | `› /doctor` |
| Slash command output | white (default) | `worker: ready` |
| `OK` check marker | **green** | `OK  github-auth: token present` |
| `FAIL` check marker | **red** | `FAIL worker: worker is crashed` |
| Assistant streaming text | white | streamed token-by-token (each token appended) |
| System notice / hint | **gray** (`#888`) | `llm-maestro — type /help…` |
| Error / exception | **red** | `assistant error: fetch failed` |
| Daemon transition | **amber** (yellow) | `daemon starting…` |

Lines do not have icons or bullets; keep it plain text.

---

## 4. Slash Output Formatting Conventions

### `/status`

```
worker: ready
  crash  exit=1  signal received (last 60 chars of stderr)
  crash  exit=1  out of memory
```

First line: `worker: <state>` — state word colored by worker state convention
(see §6). Subsequent lines: one per restart event (up to 5), indented two
spaces, format `<reason>  exit=<code|->\  <stderrTail>`.

### `/doctor`

```
OK   github-auth: token present
OK   worker: worker is ready
FAIL copilot-token: exchange failed: 401
```

`OK  ` (green, 4 chars fixed-width) or `FAIL` (red, 4 chars) followed by
`<check-name>: <detail>`. Column widths are fixed-width-padded so the colon
column aligns: `name.padEnd(16)`.

### `/help`

```
/status         show worker status + restart history
/doctor         run health checks
/restart        restart the worker
/stop           stop the worker
/start          start the worker
/logs           recent restart events
/metrics        show request metrics
/setup-claude   print Claude Code config
/setup-codex    print Codex/OpenAI config
/setup-status   show configured endpoints
/quit           exit maestro
/help           list commands
```

Two columns: command name left-padded to 16 chars, description. Sorted
alphabetically (registry insertion order is fine for M1).

### `/logs`

```
2026-06-17T04:12:00.000Z  crash  signal received\nfatal error…
2026-06-17T04:10:55.000Z  crash  ENOMEM
```

One line per restart event, newest-first (already the DB ordering). Format:
`<ISO8601>  <reason>  <stderrTail[:80]>`. If no events: `no restart events`
in gray.

### `/metrics`

```
requests: 142  errors: 3
  gpt-4o               n=139  avg=312ms
  claude-opus-4-8      n=3    avg=490ms
```

Header line then one model row per known model: name left-padded to 20 chars,
count and average latency. If no requests: `no requests yet` in gray.

### `/setup-claude` / `/setup-codex`

Multi-line instructions exactly as returned by `clients.ts`. Each line on its
own row, no special color.

---

## 5. Panels

Panels are rendered as slash command output (strings pushed into scrollback)
for M1. A future M2 could render them as persistent `<Box>` regions. The spec
below describes what the output contains so `frontend` knows what to build.

### StatusPanel (from `/status`)

Columns: worker state (colored), restart count, last restart reason + snippet.
Single-shot fetch from `DaemonClient.status()`.

### LogsPanel (from `/logs`)

Chronological list of restart events from `StatusResponse.restarts`. Ordered
newest-first. Each row: ISO timestamp, reason, exit code, first 80 chars of
stderr tail.

### MetricsPanel (from `/metrics`)

Aggregated via `metrics-agg.ts`. Rows: model name (20 chars), request count,
average latency ms. Header shows total requests and error count.

---

## 6. Color Conventions

These are the only colors used across the TUI. Map them to Ink `color` prop
values:

| Semantic | Ink color string | When used |
|----------|-----------------|-----------|
| Prompt / interactive | `"cyan"` | `›` prompt glyph |
| Worker state: ready | `"green"` | state word in `/status`, header badge |
| Worker state: starting | `"yellow"` | state word (amber approximation) |
| Worker state: crashed | `"redBright"` | state word |
| Worker state: unhealthy | `"red"` | state word |
| Health check OK | `"green"` | `OK  ` prefix |
| Health check FAIL | `"red"` | `FAIL` prefix |
| Error lines | `"red"` | exception/error messages |
| Muted / hints | `"gray"` | system notices, empty-state messages |
| Default output | (no color prop) | slash command results, assistant text |

No background colors. No bold or italic (Ink supports it but we keep it plain
so it looks good on both dark and light terminals).

---

## 7. First-Run Login Experience

If `readGhToken(dataDir())` returns null, the TUI process prints to stdout
**before** launching Ink:

```
No GitHub login found — starting device-code login.

Open https://github.com/login/device and enter code: AB-12

GitHub authorization complete.
```

- The first and last lines come from `runDeviceLogin`'s `log` callback
  (plain `console.log`, outside Ink).
- The middle line contains the verification URL and the user code; the user
  code should be visually prominent (uppercase, space-separated pair).
- After `writeGhToken` completes, `launchTui` continues to daemon startup.

No Ink rendering occurs during this phase — it is purely stdout/readline so
the device-code URL is copy-pasteable.

---

## 8. Daemon-Starting Transition

After login, `ensureDaemon` probes up to 40 times with 250 ms delay (10 s
total). While it probes, the CLI prints (again, plain stdout before Ink):

```
daemon starting…
```

Once `ensureDaemon` resolves `"started"` or `"already-running"`, Ink takes
over and the App component renders. The `daemon starting…` line stays in the
terminal scroll history above the Ink output — that is fine and expected.

If `ensureDaemon` throws (`"did not become healthy"`), the process prints the
error and exits with code 1; no TUI is rendered.

---

## 9. Assistant Streaming

When the user types a natural-language prompt (no `/` prefix) and the
assistant is wired (M1c+):

- Each text token from `runAssistantTurn` is appended as a **new line** or
  appended to the last partial line — keep it simple: call `print(token)` for
  each text block received.
- Tool-call side effects (e.g. restart triggered) are silent at the TUI level
  unless the assistant narrates them in its text.
- If the assistant errors, one red line is appended: `assistant error: <message>`.

Streaming is simulated by appending lines incrementally as `print()` calls
arrive; Ink re-renders on each state change.

---

## 10. Keyboard Shortcuts

In M1 only `useInput` in `Repl` is active:

| Key | Action |
|-----|--------|
| Printable chars | Append to input buffer |
| Backspace / Delete | Remove last character |
| Enter | Submit line; clear buffer |
| Ctrl+C | Handled by Ink/Node default (exits process) |

No other shortcuts in M1. Tab-completion, history, and Ctrl+L (clear) are
deferred to M2.
