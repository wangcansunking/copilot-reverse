#!/usr/bin/env bash
# Real CLI end-to-end driver. Boots the copilot-reverse worker daemon, then runs the actual `claude`
# and `codex` CLIs against it with real prompts and asserts on their output. Exit 0 = all passed.
#
# What each check proves (black-box, real Copilot calls):
#   - codex exec  -> /openai/responses end-to-end (the Codex-only Responses path)
#   - claude -p   -> /anthropic/v1/messages end-to-end (the Claude path)
#   - claude web  -> the gateway web_search loop returns a grounded answer with no tool leak
#
# After the run it writes a markdown REPORT to $REPORT_PATH (default /out/report.md; also always to
# /tmp/cli-e2e-report.md). Mount -v <hostdir>:/out to capture the report on the host.
set -uo pipefail

PORT=7891
REPORT_PATH="${REPORT_PATH:-/out/report.md}"
fails=0
total=0
rows=""   # accumulates markdown table rows

note() { printf '\n=== %s ===\n' "$1"; }
# record <name> <PASS|FAIL|SKIP> <detail>
record() { rows="${rows}| ${1} | ${2} | ${3} |\n"; }
check() { # check <name> <test-expr> <detail-for-report>
  total=$((total+1))
  if eval "$2"; then echo "  PASS $1"; record "$1" "PASS" "${3:-}"; else echo "  FAIL $1"; fails=$((fails+1)); record "$1" "FAIL" "${3:-}"; fi
}

# --- preconditions ------------------------------------------------------------------------------
if [ ! -f /root/.copilot-reverse/creds.json ]; then
  echo "no GitHub token mounted at /root/.copilot-reverse/creds.json — cannot run real CLI e2e"
  echo "mount it read-only: -v \$HOME/.copilot-reverse/creds.json:/root/.copilot-reverse/creds.json:ro"
  exit 3
fi
CODEX_VER=$(codex --version 2>/dev/null | head -1)
CLAUDE_VER=$(claude --version 2>/dev/null | head -1)
APP_VER=$(node -e "console.log(require('/app/package.json').version)" 2>/dev/null)

# --- boot the worker daemon ---------------------------------------------------------------------
note "boot worker daemon (node dist/worker/index.js)"
WORKER_PORT=$PORT BIND_HOST=127.0.0.1 node dist/worker/index.js > /tmp/worker.log 2>&1 &
WPID=$!
ready=0
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$WPID" 2>/dev/null; then echo "worker exited early:"; cat /tmp/worker.log; exit 4; fi
  sleep 0.5
done
[ "$ready" = 1 ] && echo "  worker ready on :$PORT" || { echo "worker never became ready:"; cat /tmp/worker.log; exit 4; }

# --- 1) Codex via /openai/responses -------------------------------------------------------------
note "codex exec -> /openai/responses"
CODEX_OUT=$(cd /tmp && codex exec --skip-git-repo-check --sandbox read-only \
  "Reply with exactly the token: CODEX_OK and nothing else." 2>/tmp/codex.err)
CODEX_LINE=$(echo "$CODEX_OUT" | tail -1)
echo "  codex stdout: $CODEX_LINE"
check "codex round-trips through /openai/responses" 'echo "$CODEX_OUT" | grep -q "CODEX_OK"' "codex $CODEX_VER replied: \`${CODEX_LINE}\`"

# --- 2) Claude via /anthropic/v1/messages -------------------------------------------------------
note "claude -p -> /anthropic/v1/messages"
CLAUDE_JSON=$(claude -p "Reply with exactly the token: CLAUDE_OK and nothing else." --output-format json 2>/tmp/claude.err)
CLAUDE_TEXT=$(echo "$CLAUDE_JSON" | jq -r '.result // empty' 2>/dev/null)
echo "  claude result: $CLAUDE_TEXT"
check "claude round-trips through /anthropic/v1/messages" 'echo "$CLAUDE_TEXT" | grep -q "CLAUDE_OK"' "claude $CLAUDE_VER replied: \`${CLAUDE_TEXT}\`"

# --- 3) Claude web search through the gateway loop ----------------------------------------------
# Requires a WebIQ key (mount webiq.json too); skip the grounding assertion if it's absent.
if [ -f /root/.copilot-reverse/webiq.json ] || [ -n "${WEBIQ_API_KEY:-}" ]; then
  note "claude web_search -> gateway loop (grounded answer, no tool leak)"
  # Headless claude blocks tools by default; allow WebSearch so it can actually call the gateway tool.
  WEB_JSON=$(claude -p "Use web search to find the latest stable Rust release version and reply with just the version number." \
    --allowedTools WebSearch --permission-mode acceptEdits --output-format json 2>/tmp/claude-web.err)
  WEB_TEXT=$(echo "$WEB_JSON" | jq -r '.result // empty' 2>/dev/null)
  WEB_ERR=$(echo "$WEB_JSON" | jq -r '.is_error // false' 2>/dev/null)
  echo "  claude web result: $WEB_TEXT"
  check "web search returns a grounded answer" 'echo "$WEB_TEXT" | grep -Eq "1\.[0-9]+"' "claude (gateway web_search) replied: \`${WEB_TEXT}\`"
  check "web search turn did not error" '[ "$WEB_ERR" != "true" ]' "is_error=${WEB_ERR}"
else
  note "claude web_search -> SKIPPED (no webiq.json mounted)"
  record "claude web search (gateway loop)" "SKIP" "no webiq.json mounted"
fi

# --- 4) edge: codex multi-line fidelity ---------------------------------------------------------
note "codex exec -> multi-line reply (responses framing under newlines)"
CODEX2=$(cd /tmp && codex exec --skip-git-repo-check --sandbox read-only \
  "Reply with exactly two lines: LINE_ONE then LINE_TWO and nothing else." 2>/dev/null | tr -d '\r')
check "codex preserves multi-line output" 'echo "$CODEX2" | grep -q "LINE_ONE" && echo "$CODEX2" | grep -q "LINE_TWO"' "codex replied: \`$(echo "$CODEX2" | tail -2 | tr "\n" " ")\`"

# --- 5) edge: claude constrained numeric answer (tool-free reasoning round-trip) -----------------
note "claude -p -> constrained numeric answer"
MATH=$(claude -p "What is 6 multiplied by 7? Reply with just the number." --output-format json 2>/dev/null | jq -r '.result // empty')
check "claude returns the right constrained answer" 'echo "$MATH" | grep -q "42"' "claude replied: \`${MATH}\`"

# --- 6) edge: a [1m] model id round-trips (suffix stripped before forwarding) --------------------
note "claude -p with a [1m] model id -> still answers"
ONEM=$(ANTHROPIC_MODEL="gpt-4o[1m]" claude -p "Reply with exactly: ONEM_OK" --output-format json 2>/dev/null | jq -r '.result // empty')
check "[1m] model id round-trips" 'echo "$ONEM" | grep -q "ONEM_OK"' "claude (gpt-4o[1m]) replied: \`${ONEM}\`"

# --- 7) model discovery: picker gets canonical ids claude code recognises ------------------------
# /anthropic/v1/models must advertise DASHED canonical ids (claude-opus-4-8) + a friendly display +
# [1m] badge — Copilot's dotted ids (claude-opus-4.8) would leave the native /model picker blank.
note "/anthropic/v1/models -> canonical ids + 1M badge"
MODELS=$(curl -sf "http://127.0.0.1:$PORT/anthropic/v1/models")
check "picker advertises dashed opus id + 1M badge" 'echo "$MODELS" | grep -q "claude-opus-4-8\[1m\]"' "models: $(echo "$MODELS" | jq -rc '[.data[].id]' 2>/dev/null)"
check "no dotted claude id leaks to picker" '! echo "$MODELS" | grep -Eq "claude-(opus|sonnet)-4\.[0-9]"' "dotted ids would blank the picker"

# --- 8) canonical opus [1m] picker id answers end-to-end (real 1M model, real Copilot) -----------
note "claude -p with canonical opus [1m] -> answers via Copilot"
OPUS=$(ANTHROPIC_MODEL="claude-opus-4-8[1m]" claude -p "Reply with exactly: OPUS_OK" --output-format json 2>/dev/null | jq -r '.result // empty')
check "canonical opus [1m] id resolves to Copilot + answers" 'echo "$OPUS" | grep -q "OPUS_OK"' "claude (claude-opus-4-8[1m]) replied: \`${OPUS}\`"

# --- 9) the DEFAULT ANTHROPIC_MODEL setup writes must be a canonical dashed [1m] id ---------------
# Regression: setup once wrote Copilot's dotted id (claude-opus-4.8[1m]) which Claude Code's picker
# couldn't match -> stuck on "Opus 4 (1M)". setup must emit the DASHED canonical id, and that id must
# answer. Derive it from the real setup code so the test tracks whatever model setup defaults to.
note "default ANTHROPIC_MODEL (setup) -> dashed canonical + answers"
DEF=$(node -e 'import("/app/dist/tui/setup/clients.js").then(m=>process.stdout.write(m.claudeCopilotReverseEnv("b","k","claude-opus-4.8",1000000).ANTHROPIC_MODEL))')
check "setup default model is dashed canonical [1m]" '[ "$DEF" = "claude-opus-4-8[1m]" ]' "setup writes ANTHROPIC_MODEL=\`${DEF}\`"
DEFOUT=$(ANTHROPIC_MODEL="$DEF" claude -p "Reply with exactly: DEFAULT_OK" --output-format json 2>/dev/null | jq -r '.result // empty')
check "setup default model answers via Copilot" 'echo "$DEFOUT" | grep -q "DEFAULT_OK"' "claude ($DEF) replied: \`${DEFOUT}\`"

# --- 9b) MULTI-TURN: a resumed session remembers turn 1 (real conversation state through the proxy) --
# The truest "does a multi-turn conversation survive the proxy" check: turn 1 states a codeword, turn 2
# RESUMES that session (claude replays the full turn-1 exchange in `messages`) and must recall it. This
# exercises exactly what an interactive REPL does — the wire is identical — without a flaky PTY. If the
# proxy dropped prior turns in translation, turn 2 could not answer. The hermetic EP-39/40/41 gate locks
# the same history round-trip deterministically; this proves it end-to-end against live Copilot.
note "multi-turn: claude -p turn1 (set codeword) -> --resume turn2 (recall it)"
SID=$(claude -p "Remember this codeword for later: HORIZON. Just acknowledge with OK." \
  --output-format json 2>/tmp/mt1.err | jq -r '.session_id // empty')
echo "  captured session_id: ${SID:-<none>}"
if [ -n "$SID" ]; then
  MT2=$(claude -p --resume "$SID" "What was the codeword I gave you? Reply with just the word." \
    --output-format json 2>/tmp/mt2.err | jq -r '.result // empty')
  echo "  turn 2 recall: $MT2"
  check "resumed session recalls turn-1 codeword through the proxy" 'echo "$MT2" | grep -q "HORIZON"' "claude (--resume) recalled: \`${MT2}\`"
else
  # No session_id in the JSON envelope (older/newer CLI shape) — degrade gracefully, never hard-fail.
  note "multi-turn: SKIPPED (no session_id in claude -p JSON output)"
  record "resumed session recalls turn-1 codeword" "SKIP" "no session_id in claude -p JSON envelope"
fi

# --- 10) reasoning EFFORT is honored end-to-end (#33) --------------------------------------------
# Two halves of reality: (a) the proxy correctly reads the effort the user picks and reports it back,
# and (b) the real `claude --effort` CLI knob drives a working turn at every level.
#
# (a) Assertable signal over real HTTP: a request carrying the EXACT modern Claude Code wire shape
# (top-level output_config.effort + thinking:{type:adaptive}, NOT budget_tokens) must come back with
# the x-copilot-reverse-effort response header echoing the resolved effort. This is the deterministic
# proof that switching effort actually changes what the proxy forwards — output length can't be
# asserted (the upstream surfaces reasoning non-deterministically), but the resolved effort can.
note "effort: proxy reads + echoes the modern output_config.effort wire (real HTTP)"
EFF_FAIL=0
for LVL in low medium high xhigh max; do
  HDR=$(curl -s -D - -o /dev/null -X POST "http://127.0.0.1:$PORT/anthropic/v1/messages" \
    -H "content-type: application/json" \
    -d "{\"model\":\"claude-opus-4-8[1m]\",\"max_tokens\":16,\"output_config\":{\"effort\":\"$LVL\"},\"thinking\":{\"type\":\"adaptive\"},\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
    2>/dev/null | tr -d '\r' | grep -i "x-copilot-reverse-effort:" | awk '{print $2}')
  echo "  effort=$LVL -> header=$HDR"
  [ "$HDR" = "$LVL" ] || EFF_FAIL=1
done
check "every effort level is resolved + echoed in x-copilot-reverse-effort" '[ "$EFF_FAIL" = 0 ]' "low/medium/high/xhigh/max each round-trip through output_config.effort"

# A legacy client that still sends thinking.budget_tokens must also map to a sane effort (back-compat).
note "effort: legacy thinking.budget_tokens still maps (back-compat)"
LEG=$(curl -s -D - -o /dev/null -X POST "http://127.0.0.1:$PORT/anthropic/v1/messages" \
  -H "content-type: application/json" \
  -d "{\"model\":\"claude-opus-4-8[1m]\",\"max_tokens\":16,\"thinking\":{\"type\":\"enabled\",\"budget_tokens\":16000},\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
  2>/dev/null | tr -d '\r' | grep -i "x-copilot-reverse-effort:" | awk '{print $2}')
check "legacy budget_tokens=16000 maps to effort=high" '[ "$LEG" = "high" ]' "legacy thinking budget -> \`${LEG}\`"

# (b) The real CLI knob: `claude --effort max` must still produce a correct answer (high effort must
# not break a turn). We can't see its output length deterministically, so we assert the turn succeeds.
note "claude --effort max -> still answers correctly (real CLI knob)"
EFFMAX=$(claude --effort max -p "What is 6 times 7? Reply with just the number." --output-format json 2>/dev/null | jq -r '.result // empty')
check "claude --effort max returns the right answer" 'echo "$EFFMAX" | grep -q "42"' "claude (--effort max) replied: \`${EFFMAX}\`"

note "claude --effort low -> still answers correctly (real CLI knob)"
EFFLOW=$(claude --effort low -p "What is 6 times 7? Reply with just the number." --output-format json 2>/dev/null | jq -r '.result // empty')
check "claude --effort low returns the right answer" 'echo "$EFFLOW" | grep -q "42"' "claude (--effort low) replied: \`${EFFLOW}\`"

# --- teardown -----------------------------------------------------------------------------------
kill "$WPID" 2>/dev/null

# --- report -------------------------------------------------------------------------------------
status_line=$([ "$fails" = 0 ] && echo "✅ ALL PASSED" || echo "❌ ${fails} FAILED")
REPORT=$(cat <<EOF
# copilot-reverse — real CLI e2e report

**Result:** ${status_line}  ($((total - fails))/${total} checks passed)

Black-box end-to-end: the real \`claude\` and \`codex\` CLIs run inside the container against the
actual copilot-reverse worker daemon, making real Copilot (and WebIQ) calls.

| component | version |
|-----------|---------|
| copilot-reverse | ${APP_VER:-?} |
| codex CLI | ${CODEX_VER:-?} |
| claude CLI | ${CLAUDE_VER:-?} |

| check | status | detail |
|-------|--------|--------|
$(printf "%b" "$rows")
EOF
)
echo "$REPORT" > /tmp/cli-e2e-report.md
if mkdir -p "$(dirname "$REPORT_PATH")" 2>/dev/null && echo "$REPORT" > "$REPORT_PATH" 2>/dev/null; then
  echo ""; echo "report written to ${REPORT_PATH} (and /tmp/cli-e2e-report.md)"
else
  echo ""; echo "report written to /tmp/cli-e2e-report.md (mount -v <dir>:/out to capture it on the host)"
fi

note "summary"
echo "$status_line"
[ "$fails" = 0 ] && exit 0 || exit 1
