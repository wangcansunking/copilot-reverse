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
