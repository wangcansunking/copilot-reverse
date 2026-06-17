# llm-maestro M1 — Interface Freeze

> Status: FROZEN for M1 (a–d). Owner: `architect`. Date: 2026-06-17.
> Source of truth: spec `docs/superpowers/specs/2026-06-16-llm-maestro-design.md` (v2) + plan `docs/superpowers/plans/2026-06-17-llm-maestro-m1-tui.md`.

This document lists the cross-cutting interfaces that **every** task must code against without local
re-invention. `frontend` (TUI: daemon-client, slash, panels, assistant glue) and `backend` (core, providers,
worker, supervisor) both depend on these shapes. **Do not change a frozen shape in a single task.** If a change
is genuinely required, message `architect` first; a change here ripples across 4+ tasks.

The plan code blocks are the canonical implementation. Where the plan and this doc agree, the plan wins on
detail; where I call out a **DISCREPANCY**, treat this doc as the resolution and apply the noted fix.

---

## 0. Module boundary map (who imports what)

```
shared/control-types.ts   <-- TUI daemon-client, supervisor/api, assistant/tools, slash
shared/ipc.ts             <-- worker/index, supervisor/monitor
shared/config.ts          <-- everywhere (ports, modelMap, restart policy)
core/canonical.ts         <-- core/*-inbound, providers/*, worker/*  (the universal currency)
core/openai-inbound.ts    <-- worker/openai-server
core/anthropic-inbound.ts <-- worker/anthropic-server
providers/types.ts        <-- worker/router, providers/copilot/adapter
```

The **canonical representation** (`core/canonical.ts`) is the hub. All four edges — OpenAI in, Anthropic in,
Copilot out, and the assistant's dogfood path — translate to/from canonical and **never** to each other directly.

---

## 1. Canonical types — `src/core/canonical.ts` (Task 3) — FROZEN

These are the universal currency. Every adapter and inbound translator targets exactly these shapes.

```ts
export interface TextBlock { type: "text"; text: string }
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
export interface ToolResultBlock { type: "tool_result"; toolUseId: string; content: string }
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface CanonicalMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
}
export interface CanonicalTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>; // JSON Schema
}
export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  tools?: CanonicalTool[];
}
export interface CanonicalResponse {
  id: string;
  model: string;
  content: ContentBlock[];                                  // text and/or tool_use blocks
  finishReason: "stop" | "length" | "tool_use" | "error";
  usage: { promptTokens: number; completionTokens: number };
}

export type CanonicalChunk =
  | { kind: "text"; delta: string; done: false }
  | { kind: "tool_use_start"; index: number; id: string; name: string; done: false }
  | { kind: "tool_use_delta"; index: number; argsDelta: string; done: false }
  | { kind: "done"; done: true; finishReason?: CanonicalResponse["finishReason"] };

export function textContent(s: string): ContentBlock[];
export function joinText(blocks: ContentBlock[]): string;
```

**Invariants — do not violate:**

1. **`toolUseId` naming.** Canonical uses camelCase `toolUseId` on `ToolResultBlock`. OpenAI wire is
   `tool_call_id`; Anthropic wire is `tool_use_id`. The translators do the rename. Never leak a wire name
   into canonical.
2. **`tool_use` block fields are `{ id, name, input }`** — `input` is the *parsed* object (`unknown`), never a
   JSON string. Stringification happens only at the wire edges.
3. **Streaming tool args are deltas, not parsed.** `tool_use_delta.argsDelta` is a raw partial-JSON string
   fragment. The translator accumulates by `index`; it does **not** parse mid-stream.
4. **`finishReason` is the canonical enum** (`stop | length | tool_use | error`). Each wire edge maps it to its
   own vocabulary (see §5).
5. **`role: "tool"`** is canonical's carrier for a tool result turn. Both inbound translators set it when a
   message contains a `tool_result` block; the Copilot adapter maps it back to OpenAI `role: "tool"`.

---

## 2. Control-API types — `src/shared/control-types.ts` (Task 2) — FROZEN

The TUI⇄Supervisor contract. `frontend` codes `daemon-client.ts`, slash commands, panels, and assistant tools
against these; `backend` returns exactly these from `supervisor/api.ts`.

```ts
export type WorkerState = "starting" | "ready" | "crashed" | "unhealthy";

export interface RestartRow {
  ts: number;
  reason: string;
  exitCode: number | null;
  stderrTail: string;
  markedUnhealthy: 0 | 1;          // SQLite-style int flag, NOT boolean
}
export interface StatusResponse {
  workerState: WorkerState;
  restarts: RestartRow[];
}
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface MetricSample {
  ts: number;
  endpoint: string;
  model: string;
  status: number;
  latencyMs: number;
}
```

### 2.1 Control-API HTTP envelope — FROZEN

`DaemonClient` (Task 15) and `supervisor/api.ts` (Task 12) MUST agree on these exact response envelopes:

| Method | Path             | Response body                          |
|--------|------------------|----------------------------------------|
| GET    | `/api/status`    | `StatusResponse` (bare, not wrapped)   |
| POST   | `/api/restart`   | `{ ok: true }`                         |
| POST   | `/api/stop`      | `{ ok: true }`                         |
| POST   | `/api/start`     | `{ ok: true }`                         |
| GET    | `/api/doctor`    | `{ checks: DoctorCheck[] }`            |
| GET    | `/api/requests`  | `{ requests: MetricSample[] }`         |
| GET    | `/api/events`    | SSE; `event: <name>\ndata: <json>\n\n` |

**Note the asymmetry (intentional, frozen):** `/api/status` returns the object bare; `/api/doctor` and
`/api/requests` wrap in `{ checks }` / `{ requests }`. `DaemonClient.status()` reads the body directly;
`.doctor()` reads `.checks`; `.requests()` reads `.requests`. Keep it consistent on both ends.

### 2.2 SSE control events (`/api/events`)

Event names emitted by `supervisor/index.ts` via the `EventBus`:

- `hello` → `{ state: WorkerState }`  (sent once on connect)
- `state` → `{ state: WorkerState }`
- `crash` → `{ exitCode: number | null, backoffMs, markedUnhealthy, crashesInWindow }`
- `metric` → `MetricSample`  (a full sample incl `ts`)

`frontend` MetricsPanel/LogsPanel subscribe to `eventsUrl()` and switch on these names.

---

## 3. IPC types — `src/shared/ipc.ts` (Task 2) — FROZEN

Worker (child) ⇄ Supervisor (parent) over Node `child_process` IPC.

```ts
export type WorkerToSupervisor =
  | { type: "ready"; port: number }
  | { type: "heartbeat"; ts: number }
  | { type: "request-metric"; endpoint: string; model: string; status: number; latencyMs: number }
  | { type: "error"; message: string; stack?: string };
export type SupervisorToWorker = { type: "ping" } | { type: "shutdown" };
```

**Contract notes:**

- `request-metric` carries the metric **without `ts`** — the supervisor stamps `ts: Date.now()` when it records
  to SQLite and re-broadcasts. So the worker's `MetricSink` (Task 8) signature is
  `(m: { endpoint; model; status; latencyMs }) => void` — **no `ts`**. The supervisor adds it.
- The worker sends `ready` *after* `server.listen` succeeds; the monitor uses `ready` to reset the backoff
  counter and flip `WorkerState → "ready"`.
- `shutdown` is the graceful path (worker closes server, exits 0); a hard `kill()` follows as backstop.

---

## 4. Provider adapter interface — `src/providers/types.ts` (Task 4) — FROZEN

```ts
export interface ProviderAdapter {
  readonly name: string;
  complete(req: CanonicalRequest): Promise<CanonicalResponse>;
  stream(req: CanonicalRequest): AsyncIterable<CanonicalChunk>;
}
```

Both inbound endpoints drive a provider purely through this interface via the `Router` (Task 7). The router
remaps `model` *before* calling the adapter (`router.resolveModel()`), so the adapter receives an
already-resolved Copilot model id in `req.model`. New providers in M2 implement this same interface — keep it
provider-agnostic.

---

## 5. The translation contract (the riskiest piece) — FROZEN

This is the heart of M1b/M1c. Three vocabularies, one canonical hub. **Memorize the three-column mapping.**

### 5.1 `finishReason` / `stop_reason` mapping

| Canonical     | OpenAI `finish_reason` | Anthropic `stop_reason` |
|---------------|------------------------|-------------------------|
| `stop`        | `stop`                 | `end_turn`              |
| `length`      | `length`               | `max_tokens`            |
| `tool_use`    | `tool_calls`           | `tool_use`              |
| `error`       | `error` (502 body)     | `api_error` (502 body)  |

### 5.2 Tool definition mapping (request direction)

| Canonical `CanonicalTool` | OpenAI `tools[]`                         | Anthropic `tools[]`        |
|---------------------------|------------------------------------------|----------------------------|
| `name`                    | `function.name`                          | `name`                     |
| `description`             | `function.description`                   | `description`              |
| `parameters` (JSON Schema)| `function.parameters`                    | `input_schema`             |
| (wrapper)                 | `{ type: "function", function: {...} }`  | flat object                |

### 5.3 Tool result mapping (request direction)

| Canonical `ToolResultBlock`         | OpenAI message                                   | Anthropic content block                          |
|-------------------------------------|--------------------------------------------------|--------------------------------------------------|
| `{ type, toolUseId, content }`      | `{ role:"tool", tool_call_id, content }`         | `{ type:"tool_result", tool_use_id, content }`   |

Canonical message `role` becomes `"tool"` whenever any block is a `tool_result` (set by both inbound
translators in their respective `*RequestToCanonical`).

### 5.4 Streaming tool-call SSE mapping — THE CRITICAL CONTRACT

This is the single most error-prone path (flagged in spec §9). All three streaming wire formats map through the
**same two canonical chunk kinds**. The mapping MUST be:

```
                          tool start                         tool args delta
                          ----------                         ----------------
CANONICAL CHUNK    tool_use_start                      tool_use_delta
                   { index, id, name }                 { index, argsDelta }

OpenAI SSE delta   tool_calls:[{ index, id,            tool_calls:[{ index,
(chat.completion     type:"function",                    function:{ arguments:<frag> } }]
 .chunk)             function:{ name, arguments:"" } }]

Anthropic SSE      content_block_start                 content_block_delta
                   { index, content_block:             { index, delta:{
                     { type:"tool_use",                   type:"input_json_delta",
                       id, name, input:{} } }              partial_json:<frag> } }
```

**The accumulate-by-index rule (both inbound + the Copilot adapter source):**

- The Copilot adapter (`stream()`, Task 6) reads OpenAI-shaped SSE from Copilot and emits canonical chunks. It
  tracks a `Set<number>` of started tool indices: the **first** time it sees a `tool_calls[i]` fragment that
  carries `function.name`, it emits `tool_use_start` for index `i`; every fragment with
  `function.arguments` emits `tool_use_delta`. **One `tool_use_start` per index, ever.**
- **The Anthropic streaming framing lives in the ENDPOINT (`anthropic-server.ts`, Task 21), not in a
  per-chunk helper.** The endpoint owns block lifecycle (open/stop) and **block-index allocation** via the
  open-order rule below. The canonical `chunk.index` is the **Copilot/canonical** tool index and is
  **NOT** used directly as the Anthropic block index (doing so collides with a text preamble — that was the
  bug fixed in fe2f6ca). The endpoint maps Copilot index → Anthropic index through a `Map`.
- The OpenAI inbound translator (`canonicalChunkToOpenAISSE`, Task 3) does the symmetric thing: emits
  `arguments:""` on start, then `arguments:<frag>` on delta, both under `tool_calls[{ index }]`. OpenAI's wire
  index **is** `chunk.index` directly (no remap) — OpenAI has no leading text block reserving an index.
- There is **no per-chunk Anthropic SSE helper**. The endpoint (`anthropic-server.ts`) is the **single source of
  truth** for Anthropic streaming framing. (The former `canonicalChunkToAnthropicSSE` helper was DELETED — see
  §7/D5 — because it emitted raw `chunk.index` framing, the exact collision the endpoint avoids, and was a
  latent trap.) If a future endpoint needs per-chunk encoding, extract it from the endpoint with explicit index
  allocation (§5.4.1) — do not resurrect a stateless helper that owns indices.

#### 5.4.1 Anthropic block-index allocation — OPEN-ORDER (shipped fe2f6ca, FROZEN)

The endpoint allocates Anthropic `content_block` indices **in the order blocks first open**, starting at 0:

- `let next = 0`; a `textIndex?: number`; a `Map<copilotIndex, anthropicIndex>` for tools; an `openedOrder[]`.
- First `text` chunk → if `textIndex` unset, `textIndex = next++`, push to `openedOrder`, emit
  `content_block_start{type:"text"}` at `textIndex`; route **all** `text_delta` to `textIndex`.
- `tool_use_start(chunk.index)` → if unseen, `i = next++`, `map.set(chunk.index, i)`, push to `openedOrder`,
  emit `content_block_start{type:"tool_use", id, name, input:{}}` at `i`. (Open-once via the map.)
- `tool_use_delta(chunk.index)` → **resolve** `i = map.get(chunk.index)` and emit `input_json_delta` at `i`.
  Never recompute the index; never use `chunk.index` directly.
- `done` → emit `content_block_stop` for each `openedOrder` index **ascending**, then `message_delta`
  (with mapped `stop_reason`) then `message_stop`.

This is contiguous-from-0 in every case: **pure-text** `[text 0]`, **pure-tool** `[tool 0]`, **mixed preamble**
`[text 0, tool 1]`, **multi-tool+text** `[text 0, tool 1, tool 2, …]`. No gaps, no collisions. A static
`chunk.index + 1` map is **wrong** — it breaks the pure-tool case (gap at 0). Use open-order allocation.

**Frame ordering the Anthropic endpoint MUST emit (Task 21), in order:**

1. `event: message_start` — once, before any chunk. Carries `{ message: { id, type:"message", role:"assistant",
   model, content:[], stop_reason:null, usage:{...} } }`.
2. **Lazily** opened `content_block_start` frames — emitted on the first chunk that needs each block, with
   open-order index allocation per §5.4.1. **No block is pre-opened.**
3. `content_block_delta` frames (text → `text_delta`; tool → `input_json_delta`), each at its allocated index.
4. On the `done` chunk: a `content_block_stop` per opened block (ascending index), then
   `event: message_delta` `{ delta:{ stop_reason }, usage }`, then `event: message_stop`.

> **D3 + mixed text/tool collision — RESOLVED (shipped fe2f6ca, verified by `architect` 2026-06-17).**
> The original plan pre-opened a text block at index 0 and let tool blocks reuse `chunk.index`, which produced
> (a) a phantom empty text block on pure-tool turns and (b) a hard index collision on mixed preamble+tool turns
> (the common M1c dogfood pattern: the assistant emits text, then calls a tool). Both are fixed by the open-order
> allocation in §5.4.1: no pre-opened block; lazy per-block open; Copilot→Anthropic index mapping via a `Map`;
> `content_block_stop` per opened index before the terminal frames.
>
> **Verification on record:** `tests/worker/anthropic-server.test.ts` is 6/6 green and covers all four cases —
> pure-text (text@0), pure-tool (tool@0), mixed (text@0, tool@1, `text_delta`@0, `input_json_delta`@1, two
> stops ascending, `stop_reason:"tool_use"`), and text+2tools (`[0,1,2]`). Full suite green under Node 20;
> `tsc --noEmit` clean. `architect` read `anthropic-server.ts` + the tests and re-ran the suite independently
> before M1b sign-off (initial verify at fe2f6ca: 26 files / 64 tests; after multi-tool test + helper deletion
> at 0d4aec2: 28 files / 68 tests).

### 5.5 Non-streaming tool-use round-trip

- `canonicalToOpenAIResponse` (Task 3): `tool_use` blocks → `message.tool_calls[]`
  (`{ index, id, type:"function", function:{ name, arguments: JSON.stringify(input) } }`); text → `message.content`
  (or `null` when only tool calls). `finish_reason` per §5.1.
- `canonicalToAnthropicResponse` (Task 20): `tool_use` blocks → `content[]` entries
  `{ type:"tool_use", id, name, input }` (input stays an object); text → `{ type:"text", text }`.
  `stop_reason` per §5.1; `usage:{ input_tokens, output_tokens }`.

---

## 6. Assistant dogfood contract — Tasks 22/23 — FROZEN

The assistant (`claude-agent-sdk`) routes through maestro's **own** Anthropic endpoint. This is the dogfood
loop and exercises §5 end-to-end.

- **Action handlers** (`buildActions`, Task 22) are plain async fns `(args) => Promise<string>`, defined over a
  `Pick<DaemonClient, "status" | "restart" | "doctor" | "requests">`. They are SDK-agnostic and unit-tested
  without the SDK. Keys: `get_status`, `restart_worker`, `run_doctor`, `recent_requests`.
- **Runtime** (`runtime.ts`, Task 23) wraps each action as an SDK `tool()` and runs `query()` with:
  - `process.env.ANTHROPIC_BASE_URL = http://<bindHost>:<workerPort>`  (the Anthropic inbound — §5.4 path)
  - `process.env.ANTHROPIC_API_KEY = <maestro server key>`  (worker accepts/ignores in M1)
  - `options.model = "claude-opus-4-8"` → router `modelMap` remaps to a Copilot model id.
- **SDK SURFACE — VERIFIED (frontend, 2026-06-17; `tsc --noEmit` clean).** Installed version is
  `@anthropic-ai/claude-agent-sdk` **v0.1.77**. Export names `query`, `tool`, `createSdkMcpServer` present, no
  drift. Option shapes confirmed against the installed `.d.ts`:
  `query({ prompt, options: { model, mcpServers, systemPrompt, permissionMode } })` and
  `createSdkMcpServer({ name, tools })` match as-is. **ONE drift, fixed:** `tool()` takes a Zod **raw shape**
  (`AnyZodRawShape`), not a `ZodObject` — runtime passes `empty.shape` (where `empty = z.object({})`), which is
  the correct type for an empty input schema. Task 23 was NOT marked DONE_WITH_CONCERNS (compiles clean). The
  in-process tools are intentionally **no-arg** (empty input schema) — `get_status`/`restart_worker`/
  `run_doctor`/`recent_requests` take no parameters; do not invent params.
- **Dogfood loop wiring VERIFIED (`architect` static review of `runtime.ts`, 2026-06-17):** `ANTHROPIC_BASE_URL`
  is set to the **local** worker endpoint (not external), API key = maestro key, and assistant `text` blocks
  stream to the `print` callback. **Live end-to-end dogfood** (a real SDK turn through `/v1/messages` → Copilot)
  is validated at Task 27 — it depends on the §5.4 streaming fix (now shipped fe2f6ca), since the agent commonly
  emits text preamble then a tool call (the mixed-stream path).
  > Non-blocking note: `runAssistantTurn` mutates `process.env` globally; fine for M1's single-assistant use,
  > revisit if M2 runs concurrent turns.
- **Why this stresses §5:** the SDK's agent loop sends Anthropic `tools` + receives `tool_use` content blocks
  (streaming `content_block_start` / `input_json_delta`) and sends back `tool_result` blocks. Every clause of
  §5.2/§5.3/§5.4 must be correct or the loop stalls. This is why §5.4 is the riskiest code in M1.

---

## 7. Discrepancies found in the plan (resolutions — apply these)

These are real inconsistencies I found across tasks. Resolution is binding; the owning agent applies the fix.

- **D1 — `MetricSink` has no `ts` (Tasks 8 vs 2/10).** `control-types.MetricSample` includes `ts`, but the
  worker's `MetricSink` and IPC `request-metric` deliberately omit `ts` (supervisor stamps it). This is **by
  design** — see §3. Owners must NOT add `ts` to the worker-side metric callback. Flagging so nobody "fixes"
  the apparent mismatch by adding `ts` in the worker. (Resolution: keep as-is, documented in §3.)

- **D2 — `recordRestart` row vs `RestartRow` type (Task 10).** `recordRestart` takes
  `RestartRow & { backoffMs }` but `RestartRow.markedUnhealthy` is `0 | 1` while the supervisor passes a
  computed `markedUnhealthy ? 1 : 0` (Task 13) — consistent. `listRestarts` SELECT must alias columns to the
  camelCase `RestartRow` field names (`exit_code as exitCode`, etc.) — already correct in Task 10. No change;
  just don't drift the column aliases.

- **D3 — Anthropic streaming index collision (Task 21) — RESOLVED (shipped fe2f6ca, verified 2026-06-17).**
  Two bugs: a phantom text block on pure-tool turns, and a hard text/tool index collision on mixed
  preamble+tool turns (the common M1c dogfood pattern). Fixed via **open-order block-index allocation** in
  `anthropic-server.ts` — see §5.4.1 for the frozen convention. Verified: pure-text/pure-tool/mixed all
  contiguous-from-0; `tests/worker/anthropic-server.test.ts` 5/5; full suite 26/64 green under Node 20; tsc
  clean. `architect` read the code + tests and re-ran the suite before M1b sign-off. (Note: the static
  `chunk.index + 1` map I first proposed was wrong — it breaks pure-tool; open-order is the correct fix,
  per team-lead.)

- **D5 — `canonicalChunkToAnthropicSSE` helper / endpoint framing duplication — RESOLVED by DELETION**
  (architect decision 2026-06-17, supersedes the earlier "demotion" plan). After D3 the endpoint owns all
  Anthropic streaming framing (allocation + open/stop), leaving the standalone helper dead on the streaming path
  AND emitting raw `index: chunk.index` for tool blocks — the exact collision the endpoint was built to avoid.
  Keeping it (even reference-only with a comment) was a latent trap: any "route the endpoint through the helper"
  refactor reintroduces the mixed-turn collision with green unit tests, and it already caused a false-alarm
  review. Verified zero production importers (only its own unit test). Resolution: **`canonicalChunkToAnthropicSSE`
  and its SSE unit test are deleted**; `anthropicRequestToCanonical` + `canonicalToAnthropicResponse` remain
  (live, used by the endpoint). The endpoint (`anthropic-server.ts`, §5.4 / §5.4.1) is now the literal single
  source of truth for Anthropic streaming framing. **CLOSED 2026-06-17 (commit 6bb992a):** `architect` verified
  grep-clean — zero `canonicalChunkToAnthropicSSE` references in `src/` or `tests/` (remaining hits are doc-only,
  this freeze + the superseded plan code blocks); `tsc --noEmit` clean; `anthropic-inbound.test.ts` 2/2 (request
  + response retained, SSE test removed) and `anthropic-server.test.ts` 6/6 green.

- **D4 — `tool_use_delta` before `tool_use_start` safety (Task 6).** The Copilot adapter must guarantee
  ordering: emit `tool_use_start` (on first fragment carrying `function.name`) **before** any
  `tool_use_delta` for that index. The plan's code does this via the `startedTools` Set, but note the edge
  case: if Copilot ever sends `arguments` in the *same* fragment as `name`, the adapter emits start THEN delta
  in that iteration — correct. If Copilot sends `arguments` with no prior `name` (shouldn't happen), the delta
  would have no start. `backend` should treat a missing-name first fragment as opening with a synthetic
  `id`/empty name only if observed; for M1, the plan's behavior is accepted. Verify against live Copilot SSE
  during Task 6.

---

## 8. Change protocol

Any change to a shape in §1–§4, the envelope in §2.1, or the mapping in §5 is a **freeze break**: message
`architect` before editing, and `architect` updates this doc + notifies `frontend`/`backend`/`pm`. Additive,
backward-compatible fields (new optional property) are low-risk but still announce them. The §5.4 streaming
mapping is the one place where a silent change will break the dogfood loop without failing unit tests — treat
it as the most load-bearing contract in M1.
