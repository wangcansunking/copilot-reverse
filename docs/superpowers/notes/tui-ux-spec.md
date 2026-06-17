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

---

# M2 — Provider Management UX

> All surfaces below are slash-command output (strings pushed into scrollback)
> and an inline interactive panel driven by `useInput`. No new Ink deps.
> Color rules from §6 apply throughout.

---

## 11. `/providers` — List View

Running `/providers` with no arguments prints the current provider table into
scrollback:

```
providers  (2 configured)

  #  name          type        enabled  health   priority
  1  copilot       copilot     yes      ready    high
  2  openai-proxy  openai      yes      unknown  normal
```

**Column layout** (fixed-width, space-separated):

| Column | Width | Value |
|--------|-------|-------|
| `#` (priority rank) | 3 | right-aligned integer |
| `name` | 16 | left-aligned, truncated |
| `type` | 12 | `copilot` / `openai` / `anthropic` / `custom` |
| `enabled` | 8 | `yes` (green) / `no` (gray) |
| `health` | 10 | colored by worker state convention (see §6) + `unknown` = gray |
| `priority` | — | `high` / `normal` / `low` (plain) |

Header line: `providers  (N configured)` — `N` in cyan if > 0, red if 0.
If no providers: `no providers configured — use /providers add` in gray.

**Health values and colors:**

| Health string | Ink color |
|---------------|-----------|
| `ready` | `"green"` |
| `starting` | `"yellow"` |
| `crashed` | `"redBright"` |
| `unhealthy` | `"red"` |
| `unknown` | `"gray"` |
| `disabled` | `"gray"` |

---

## 12. Slash Sub-commands

Provider management uses sub-commands of `/providers`. This avoids a
full-screen panel mode and keeps the REPL flow: every interaction is a
slash command that prints output lines or opens a short inline form.

```
/providers              list all providers (§11)
/providers add          open inline Add form (§13)
/providers edit <name>  open inline Edit form pre-filled with existing values (§13)
/providers remove <name> confirm + remove (§14)
/providers enable <name>  set enabled=true; print confirmation
/providers disable <name> set enabled=false; print confirmation
/providers up <name>    move one step higher in priority order
/providers down <name>  move one step lower in priority order
```

`/help` output in M2 adds one entry for `/providers` (with description
`manage providers`); the sub-commands are documented in `/providers help`
output, not the main `/help` table, to keep that table concise.

```
/providers help output:
  /providers                list providers
  /providers add            add a new provider
  /providers edit <name>    edit a provider
  /providers remove <name>  remove a provider
  /providers enable <name>  enable a provider
  /providers disable <name> disable a provider
  /providers up <name>      increase priority
  /providers down <name>    decrease priority
```

Unknown sub-commands print: `unknown providers sub-command (try /providers help)`
in gray.

---

## 13. Inline Add / Edit Form

`/providers add` and `/providers edit <name>` render a multi-field form
**inline in the scrollback region** — not a full-screen takeover. The form
is a `<Box flexDirection="column">` appended below the slash echo line.

### Form layout

```
  provider name:    copilot-work█
  type:             copilot
  base URL:         (leave blank for default)
  model map:        * → gpt-4o
  priority:         normal
  enabled:          yes

  [Enter] confirm  [Esc] cancel  [Tab] next field
```

- The active field shows a block cursor (`█`) at the end of the value.
- Inactive fields show their current value in gray.
- The hint line at the bottom is always gray.

### Fields

| Field | Type | Values / notes |
|-------|------|----------------|
| `provider name` | text | Unique identifier; alphanumeric + hyphens; max 32 chars |
| `type` | cycle | `copilot` → `openai` → `anthropic` → `custom` (Left/Right arrows or Space to cycle) |
| `base URL` | text | Leave blank to use the type's default endpoint; shown in gray when blank |
| `model map` | text | Comma-separated `from→to` pairs, e.g. `*→gpt-4o, claude-*→gpt-4o`; single line |
| `priority` | cycle | `high` → `normal` → `low` (Left/Right or Space) |
| `enabled` | cycle | `yes` → `no` (Left/Right or Space) |

### Keyboard in form mode

| Key | Action |
|-----|--------|
| Printable chars | Edit active text field |
| Backspace | Remove last char of active text field |
| Tab / Down arrow | Move to next field |
| Shift+Tab / Up arrow | Move to previous field |
| Left / Right arrows | Cycle value on cycle fields |
| Space | Cycle value on cycle fields |
| Enter | On last field or any field: confirm and submit |
| Escape | Cancel without saving; print `cancelled` in gray |

### Validation and submission

On confirm, validate before saving:

- `name` must be non-empty and unique (for add).
- `type` must be one of the four valid values.
- `base URL` if non-blank must start with `http://` or `https://`.
- `model map` entries must be parseable as `from→to` (or `from->to`).

Validation errors are printed as red lines immediately below the form:

```
  error: name is required
  error: base URL must start with http:// or https://
```

The form remains open for correction. On success, print:

```
  provider "copilot-work" added  (rank #3)
```

or for edit:

```
  provider "copilot-work" updated
```

Success lines are plain white. The form box is removed from the scrollback
(replaced by the confirmation line) — achieved by tracking the form's line
range in state and replacing those lines on submit.

---

## 14. Remove Confirmation

`/providers remove <name>` does not open a form. It prints a single
confirmation prompt inline:

```
  remove provider "openai-proxy"? [y/N] █
```

The prompt captures the next keypress via `useInput`:

- `y` or `Y`: remove and print `provider "openai-proxy" removed` in white.
- Any other key (including Enter with no input, `n`, Escape): print
  `cancelled` in gray.

The confirmation prompt is a single `<Text>` line; `useInput` is active only
while it is displayed (guarded by a `confirming` state flag). After the user
responds, `useInput` reverts to normal REPL mode.

If `<name>` is not found: `provider "openai-proxy" not found` in red.
If only one provider remains and it is enabled: print a yellow warning line
before confirming — `warning: removing the last enabled provider will stop all routing` —
then still allow removal.

---

## 15. Priority Reordering

`/providers up <name>` and `/providers down <name>` swap the named provider
one step in the priority list and immediately print the updated table (same
format as `/providers`, §11) so the user sees the new order.

```
  › /providers up openai-proxy
  moved "openai-proxy" to rank #1

  providers  (2 configured)

    #  name          type    enabled  health   priority
    1  openai-proxy  openai  yes      unknown  high
    2  copilot       copilot yes      ready    normal
```

If already at the top (`/providers up`) or bottom (`/providers down`): print
`"<name>" is already at the top` (or `bottom`) in gray. No table reprint.

---

## 16. Fuzzy-Match Feedback

When the worker resolves a requested model name through the model map (exact
match, glob match, or `*` fallback), it emits a resolution event. The
supervisor forwards this to the TUI via the SSE event bus as a `model-resolve`
event:

```json
{ "requested": "claude-opus-4-8", "resolved": "gpt-4o", "provider": "copilot", "via": "glob: claude-*" }
```

The TUI renders one gray hint line in the scrollback whenever a new resolution
is seen (deduplicated — only the first occurrence per session):

```
  model "claude-opus-4-8" → "gpt-4o" via copilot (matched claude-*)
```

Format: `model "<requested>" → "<resolved>" via <provider> (matched <pattern>)`
in gray. When the fallback `*` is used: `(fallback *)`. When exact match:
`(exact)`.

This line appears automatically, not in response to a slash command. It fires
once per unique `(requested, resolved, provider)` triple per session. The
deduplication set lives in TUI React state and is cleared on restart.

**`/providers` list also shows last-resolved column** (appended after the
existing columns, only if any resolutions have been seen this session):

```
  #  name     type     enabled  health  priority  last resolved
  1  copilot  copilot  yes      ready   high      claude-* → gpt-4o
```

If no resolutions yet, the column is omitted entirely.

---

## 17. `/providers` in `/help`

M2 `/help` output adds one row:

```
/providers      manage providers (try /providers help)
```

The existing M1 commands are unchanged. The `/help` column width (16 chars)
accommodates `/providers` (10 chars) without change.

---

## 18. Error States

All provider sub-commands that talk to the daemon can fail. On any
`DaemonClient` error (network, non-2xx), print:

```
  error: could not reach daemon: <message>
```

in red, same as other error lines (§3). No retry logic in the TUI — the user
can re-run the command.

---

## 19. M2 Keyboard Additions

The inline form (§13) and remove confirmation (§14) introduce new `useInput`
handling. These are scoped — `useInput` in form/confirm mode intercepts all
keys until the interaction completes, then hands back to the normal Repl
`useInput`. Both are guarded by a React state flag (`mode: "repl" | "form" |
"confirm"`) passed down from `App`.

New keys active only in `"form"` mode:

| Key | Action |
|-----|--------|
| Tab / Shift+Tab | Next / previous field |
| Up / Down arrows | Next / previous field |
| Left / Right arrows | Cycle field value |
| Space | Cycle field value |
| Escape | Cancel form |

New keys active only in `"confirm"` mode:

| Key | Action |
|-----|--------|
| `y` / `Y` | Confirm action |
| Any other | Cancel |

No new global shortcuts are added in M2. Tab-completion and history remain
deferred.
