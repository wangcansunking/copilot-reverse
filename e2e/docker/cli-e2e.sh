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
# Single-segment version id (claude-sonnet-5): the generalised name/badge mapping must surface it with a
# friendly display + [1m] badge from its REAL upstream 1M window — never a bare id. Guarded softly: if
# Copilot ever drops sonnet-5 from this account's list the case notes it instead of hard-failing.
if echo "$MODELS" | jq -e '.data[] | select(.id|startswith("claude-sonnet-5"))' >/dev/null 2>&1; then
  check "picker advertises sonnet-5 with friendly name" 'echo "$MODELS" | jq -e ".data[] | select(.id==\"claude-sonnet-5[1m]\") | select(.display_name==\"Sonnet 5\")" >/dev/null' "sonnet-5 entry: $(echo "$MODELS" | jq -rc '.data[]|select(.id|startswith("claude-sonnet-5"))')"
else
  note "sonnet-5 not in this account's model list -> skipping sonnet-5 picker assertion"
  record "picker advertises sonnet-5 with friendly name" "SKIP" "claude-sonnet-5 absent from upstream /models"
fi

# --- 8) canonical opus [1m] picker id answers end-to-end (real 1M model, real Copilot) -----------
note "claude -p with canonical opus [1m] -> answers via Copilot"
OPUS=$(ANTHROPIC_MODEL="claude-opus-4-8[1m]" claude -p "Reply with exactly: OPUS_OK" --output-format json 2>/dev/null | jq -r '.result // empty')
check "canonical opus [1m] id resolves to Copilot + answers" 'echo "$OPUS" | grep -q "OPUS_OK"' "claude (claude-opus-4-8[1m]) replied: \`${OPUS}\`"

# --- 8b) canonical sonnet-5 [1m] picker id answers end-to-end (single-segment 1M model, real Copilot) --
# The generalised mapping's headline model: a real `claude -p` turn on ANTHROPIC_MODEL=claude-sonnet-5[1m]
# must strip [1m], resolve the single-segment id back to Copilot's claude-sonnet-5, and answer. Proves the
# new id shape works the whole way through the CLI, not just in a /models JSON blob. Skips (not fails) if
# this account can't see sonnet-5, keeping forks/limited-token runs green.
if echo "$MODELS" | jq -e '.data[] | select(.id|startswith("claude-sonnet-5"))' >/dev/null 2>&1; then
  note "claude -p with canonical sonnet-5 [1m] -> answers via Copilot"
  SON=$(ANTHROPIC_MODEL="claude-sonnet-5[1m]" claude -p "Reply with exactly: SONNET5_OK" --output-format json 2>/dev/null | jq -r '.result // empty')
  check "canonical sonnet-5 [1m] id resolves to Copilot + answers" 'echo "$SON" | grep -q "SONNET5_OK"' "claude (claude-sonnet-5[1m]) replied: \`${SON}\`"
else
  note "sonnet-5 absent from upstream -> skipping sonnet-5 round-trip"
  record "canonical sonnet-5 [1m] id resolves to Copilot + answers" "SKIP" "claude-sonnet-5 absent from upstream /models"
fi

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

# --- 11) a Claude model must NEVER surface a "Responses API" error (#45) --------------------------
# The bug: a big Claude turn (pasted history, and worse WITH an image) could hit a /chat 400 whose body
# matched the responses-only hint regex, so the adapter's safety net retried the SAME request on
# /responses — which is gpt-5-class only and rejects every Claude id with
#   "model claude-opus-4.8 does not support Responses API"
# masking the real /chat error. Claude Code itself only ever calls /anthropic/v1/messages; the bogus
# /responses hop was entirely internal to the proxy. These two cases drive the REAL claude CLI the way
# the user did and assert the turn both (a) answers and (b) NEVER emits that Responses-API string.

# (a) mainstream: a large pasted-history turn still answers (size alone must not trip mis-routing).
note "claude -p with a large pasted history -> answers, no Responses-API error"
BIGHIST=$(printf 'Here is a long transcript to summarize:\n'; for i in $(seq 1 400); do printf 'Turn %d: the user asked about topic %d and the assistant replied in detail about it.\n' "$i" "$i"; done)
BIGHIST="${BIGHIST}
When you are done reading, reply with exactly the token: BIGHIST_OK and nothing else."
BH_JSON=$(ANTHROPIC_MODEL="claude-opus-4-8[1m]" claude -p "$BIGHIST" --output-format json 2>/tmp/bighist.err)
BH_TEXT=$(echo "$BH_JSON" | jq -r '.result // empty' 2>/dev/null)
echo "  claude (big history) result: $(echo "$BH_TEXT" | tail -1)"
check "large history turn answers via Copilot" 'echo "$BH_TEXT" | grep -q "BIGHIST_OK"' "claude (claude-opus-4-8[1m], ~400-line history) replied: \`$(echo "$BH_TEXT" | tail -1)\`"
check "large history turn never hits the Responses API" '! { echo "$BH_JSON"; cat /tmp/bighist.err; } | grep -qi "does not support Responses API"' "no \`does not support Responses API\` leaked for a Claude turn"

# (b) the exact edge you hit: pasted history + a screenshot. Feed a real image the way Claude Code does
# — an Anthropic image block over /anthropic/v1/messages (the CLI can't attach a file in -p). Use a REAL
# 64x64 PNG (a solid red square), NOT a degenerate 1x1 that Copilot rejects as "Could not process image"
# — a proper image round-trips: Copilot Claude sees it and names the colour. This is the mainstream
# happy path (image turns work) AND the regression guard (a Claude turn NEVER emits the misleading
# "does not support Responses API"; before the fix, an image turn that 400'd on /chat with an
# `invalid_request_body` body was mis-retried on /responses, masking the real reason).
note "claude+image (pasted history + screenshot) -> Claude sees the image, never a Responses-API error"
# Build a valid 64x64 red PNG at runtime (deterministic bytes, no fixtures) and post it as a base64 image.
IMG_RESP=$(node -e '
const zlib=require("zlib");const W=64,H=64;
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const ty=Buffer.from(t);const cb=Buffer.concat([ty,d]);
  let c=~0;for(const b of cb){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^(0xEDB88320&-(c&1));}c=~c>>>0;const cr=Buffer.alloc(4);cr.writeUInt32BE(c>>>0);return Buffer.concat([l,ty,d,cr]);}
const sig=Buffer.from([137,80,78,71,13,10,26,10]);const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=2;
const raw=Buffer.alloc(H*(1+W*3));for(let y=0;y<H;y++){const o=y*(1+W*3);raw[o]=0;for(let x=0;x<W;x++){const p=o+1+x*3;raw[p]=200;raw[p+1]=30;raw[p+2]=30;}}
const png=Buffer.concat([sig,chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
const body=JSON.stringify({model:"claude-opus-4-8[1m]",max_tokens:64,messages:[{role:"user",content:[{type:"text",text:"A screenshot pasted after a long history. What colour is this square? Reply with one word."},{type:"image",source:{type:"base64",media_type:"image/png",data:png.toString("base64")}}]}]});
fetch("http://127.0.0.1:'"$PORT"'/anthropic/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>process.stdout.write(JSON.stringify({error:{message:String(e)}})));
' 2>/dev/null)
IMG_TEXT=$(echo "$IMG_RESP" | jq -r '[.content[]?|select(.type=="text")|.text]|join("")' 2>/dev/null)
IMG_ERR=$(echo "$IMG_RESP" | jq -r '.error.message // empty' 2>/dev/null)
echo "  claude (image turn) result: ${IMG_TEXT:-<err: $IMG_ERR>}"
check "claude image turn never hits the Responses API" '! echo "$IMG_RESP" | grep -qi "does not support Responses API"' "no \`does not support Responses API\` leaked for a Claude+image turn"
check "claude sees the image and names the colour (red)" 'echo "$IMG_TEXT" | grep -qi "red"' "claude (Claude id + real 64x64 image) replied: \`${IMG_TEXT:-<err: $IMG_ERR>}\`"

# --- 12) REAL codex tool-use loop (function_call <-> function_call_output through the proxy) -------
# The coverage bar names "a tool-call that must translate both ways" as a must-cover edge, yet every
# other codex/claude check is a plain-text turn. This drives a REAL agentic loop: codex must issue a
# shell tool_call, get its output back, and continue — the richest /openai/responses translation path
# (responses-inbound.ts function_call/function_call_output <-> canonical tool_use/tool_result). A
# regression here strands EVERY real Codex task with "stream closed before response.completed" while all
# hermetic checks stay green — the class already caught once (nameless tool -> Copilot 400).
# ORACLE = the FILESYSTEM: codex can only create the file by really running the tool through the proxy,
# so asserting the file exists + has the exact token is immune to codex's JSONL event-shape drifting.
note "codex tool loop -> writes a file via a real shell tool_call (fs oracle)"
rm -f /tmp/codex_proof.txt
CODEX_TOOL_OUT=$(cd /tmp && codex exec --skip-git-repo-check -s workspace-write \
  "Create a file named codex_proof.txt in the current directory whose contents are exactly CODEX_TOOL_OK, then reply DONE." 2>/tmp/codex-tool.err)
CODEX_PROOF=$(cat /tmp/codex_proof.txt 2>/dev/null)
echo "  codex_proof.txt contents: ${CODEX_PROOF:-<not created>}"
check "codex completes a real tool loop (file written through the proxy)" 'echo "$CODEX_PROOF" | grep -q "CODEX_TOOL_OK"' "codex wrote: \`${CODEX_PROOF:-<none>}\` (function_call -> shell -> function_call_output round-tripped)"

# --- 13) REAL claude vision: OCR round-trip + downscale keeps the image LEGIBLE -------------------
# Image downscale (PR #44) is otherwise only proven at the http count_tokens layer (token MATH on a
# noise image) — which structurally cannot prove Copilot READ the pixels, and the documented 1x1-PNG
# trap means a synthetic fixture can mask a real "Could not process image". This drives the real CLI
# the way a user attaching a screenshot does: claude reads an on-disk PNG via its Read tool and must
# report the text baked into it. Two fixtures, deterministically rendered in-container with Jimp:
#   - small legible token  -> exercises the byte short-circuit (image-resize.ts:101, no re-encode)
#   - large >1.5MB token   -> forces the decode + quality-ladder re-encode (image-resize.ts:107) and
#                             proves the shrink kept the letters LEGIBLE (not a smear) — the whole point
#                             of the 502 fix. (Distinct from case 11's colour-naming curl POST: this is
#                             the real Read-tool path + OCR + the re-encode ladder.)
vision_case() { # vision_case <png-path> <expected-token>
  local png="$1" tok="$2"
  local out
  out=$(claude -p "Read the image file at ${png} and reply with ONLY the exact text shown in the image, nothing else." \
    --allowedTools Read --permission-mode acceptEdits --output-format json 2>/tmp/vision.err | jq -r '.result // empty' 2>/dev/null)
  echo "  claude vision (${png##*/}) read: ${out:-<none>}"
  # tolerant + case-insensitive (the model may add whitespace); a hit proves it truly saw the pixels.
  if echo "$out" | grep -qi "$tok"; then
    check "claude vision OCR reads '${tok}' from ${png##*/}" 'true' "claude read the baked-in token through the Read-tool -> image -> Copilot vision path"
  else
    check "claude vision OCR reads '${tok}' from ${png##*/}" 'false' "expected \`${tok}\`, got \`${out:-<none>}\` (vision may be unentitled / Read blocked)"
  fi
}
# Render both fixtures with the bundled Jimp font (>=64x64 so neither trips the 1x1 rejection).
note "vision: render deterministic OCR fixtures (Jimp) then read them via the real claude CLI"
if node --input-type=module -e '
import { Jimp, loadFont } from "jimp";
import { SANS_64_BLACK, SANS_128_BLACK } from "jimp/fonts";
// small: 512x200 white canvas, clean token -> ~5KB PNG, stays under the 1.5MB byte gate (no re-encode).
{ const img = new Jimp({ width: 512, height: 200, color: 0xffffffff });
  const f = await loadFont(SANS_64_BLACK); img.print({ font: f, x: 40, y: 60, text: "VISION7" });
  await img.write("/tmp/vision_small.png"); }
// large: 2000x1400 high-entropy bg (PNG cant compress under 1.5MB) + big bold token that stays legible
// even after the max downscale -> forces encodeUnderBudget to actually decode + re-encode.
{ const W=2000,H=1400; const img = new Jimp({ width: W, height: H, color: 0xffffffff });
  for (let y=0;y<H;y+=2) for (let x=0;x<W;x+=2){ const v=(x*131+y*197)%256; img.setPixelColor((((v<<24)|(v<<16)|(v<<8)|0xff)>>>0), x, y); }
  const f = await loadFont(SANS_128_BLACK); img.print({ font: f, x: 120, y: 600, text: "BIGTEXT9" });
  await img.write("/tmp/vision_large.png"); }
' 2>/tmp/vision-gen.err; then
  vision_case /tmp/vision_small.png "VISION7"
  vision_case /tmp/vision_large.png "BIGTEXT9"
else
  note "vision: SKIPPED (fixture render failed)"
  record "claude vision OCR round-trip" "SKIP" "Jimp fixture render failed: $(head -1 /tmp/vision-gen.err 2>/dev/null)"
fi

# --- 14) unknown / typo'd model degrades gracefully (bounded is_error, never a hang or 502-mask) ---
# router.ts:26 forwards an unmatched id VERBATIM (modelMap is empty, fuzzy < 0.6 threshold on a nonsense
# id), so Copilot 400s it (model_not_supported). This is the ONE model-resolution branch with zero
# real-Copilot coverage (http-e2e cant reach it — its dummy token 401s before model validation). The
# north-star is "never freeze/mask a degenerate turn": a user typo must surface a bounded is_error and
# RETURN, not hang to the turn timeout. #50 P1 fix: the worker now classifies that upstream 400 as a
# TERMINAL invalid_request_error (not a retriable 502/api_error), so a client fails fast instead of
# retrying to its 90s deadline. The bounded wall-clock (timeout) IS the assertion that it didn't freeze.
note "unknown model id -> bounded is_error, returns (no hang)"
BAD_JSON=$(timeout 90 env ANTHROPIC_MODEL="not-a-real-model-xyz" claude -p "Reply with exactly: NOPE" --output-format json 2>/tmp/badmodel.err)
BAD_RC=$?
BAD_ISERR=$(echo "$BAD_JSON" | jq -r '.is_error // empty' 2>/dev/null)
echo "  unknown-model rc=$BAD_RC is_error=$BAD_ISERR"
# rc 124 = the timeout fired = it HUNG (the failure we guard against). Any other rc means it returned.
check "unknown model returns (did not hang to timeout)" '[ "$BAD_RC" != "124" ]' "claude returned rc=$BAD_RC within 90s (no freeze)"
check "unknown model surfaces a bounded error, not a masked hang" '[ "$BAD_ISERR" = "true" ] || echo "$BAD_JSON" | grep -qiE "error|not.?found|404"' "is_error=${BAD_ISERR}; a typo'd id degrades to a visible error"

# --- 15) native web_search hosted-tool passthrough via REAL codex (gpt-5 Responses) ---------------
# HOSTED_TOOL_TYPES (responses-inbound.ts:75) -> {type} passthrough is the ONLY production path for
# grounded Codex search; proven today only against the fake spy (EP-34) + as a unit. Drive it for real.
# SKIP (never fail) if the mounted token lacks native web_search entitlement (gpt-5-only) or the config
# knob shape drifted — keeps no-secret / forked / unentitled CI green.
note "codex native web_search -> grounded answer (SKIP if unentitled)"
CODEX_WEB=$(cd /tmp && codex exec --skip-git-repo-check -s read-only \
  -c model="gpt-5" -c features.web_search=true \
  "Use web search to find the latest stable Rust release version and reply with just the version number." 2>/tmp/codex-web.err)
CODEX_WEB_LINE=$(echo "$CODEX_WEB" | tail -1)
echo "  codex web result: $CODEX_WEB_LINE"
if echo "$CODEX_WEB" | grep -Eq "1\.[0-9]+"; then
  check "codex native web_search returns a grounded answer" 'true' "codex (gpt-5 + web_search) replied: \`${CODEX_WEB_LINE}\`"
elif { echo "$CODEX_WEB"; cat /tmp/codex-web.err; } | grep -qiE "web_search|not.?support|unsupport|entitl|unknown|invalid|403"; then
  note "codex web_search -> SKIPPED (not entitled / knob drifted)"
  record "codex native web_search (hosted-tool passthrough)" "SKIP" "gpt-5 web_search unentitled or config knob drifted: \`${CODEX_WEB_LINE}\`"
else
  check "codex native web_search returns a grounded answer" 'false' "expected a 1.x version, got \`${CODEX_WEB_LINE}\`"
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
