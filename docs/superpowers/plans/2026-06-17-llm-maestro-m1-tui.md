# llm-maestro M1 Implementation Plan (TUI-centric)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `maestro` — an interactive Ink TUI that logs into GitHub Copilot, auto-launches a self-healing proxy daemon exposing OpenAI **and** Anthropic compatible endpoints backed by Copilot, drives management via slash commands **and** a claude-agent-sdk assistant that dogfoods maestro's own Anthropic endpoint, and renders metrics/errors in the terminal.

**Architecture:** Single TypeScript ESM npm package. Three runtime roles: (1) **TUI** (Ink) — the `maestro` process; (2) **Supervisor** — long-lived control plane (control REST/SSE API + SQLite + worker supervision); (3) **Worker** — data plane proxy (OpenAI + Anthropic inbound → canonical Anthropic-Messages representation → Copilot adapter). The TUI auto-spawns the Supervisor; the Supervisor forks/monitors the Worker with backoff + circuit-breaker. The assistant runs claude-agent-sdk with `ANTHROPIC_BASE_URL` pointed at the Worker's Anthropic endpoint, with in-process tools that call the Supervisor control API.

**Tech Stack:** Node 20+ (ESM), TypeScript, Vitest, Express, better-sqlite3, Commander, Ink + React, `@anthropic-ai/claude-agent-sdk`, global `fetch`. Copilot integration uses community-documented (unofficial) GitHub OAuth + Copilot endpoints — flagged in code and README.

**Phasing:** M1a scaffolding + OpenAI proxy + self-healing daemon + minimal TUI. M1b Anthropic inbound + tool-use translation. M1c assistant. M1d setup/metrics/logs. Each phase ends green and runnable.

> **Note on packaging:** Spec calls for a pnpm workspace; for M1 we use a single package with module folders to cut setup friction. Workspace split is deferred.

---

## File Structure

```
package.json                      # ESM, bin: maestro -> dist/cli/index.js
tsconfig.json                     # ESM, strict (excludes tui at lib-check? no — TS+react jsx)
vitest.config.ts
src/
  shared/{paths,config,ipc,creds,control-types}.ts
  core/
    canonical.ts                  # internal types incl tool_use/tool_result + chunks
    openai-inbound.ts             # OpenAI <-> canonical (incl tools)
    anthropic-inbound.ts          # Anthropic <-> canonical (incl tool-use) [M1b]
  providers/copilot/{auth,token,adapter}.ts
  worker/{router,openai-server,anthropic-server,server,index}.ts
  supervisor/{db,monitor,events,api,index}.ts
  daemon/lifecycle.ts             # spawn/ensure supervisor, health probe
  cli/{index,auth}.ts
  tui/
    daemon-client.ts
    app.tsx  repl.tsx
    slash/{registry,commands}.ts
    panels/{status,logs,metrics}.tsx
    assistant/{runtime,tools,stream-view}.ts   # [M1c]
    setup/clients.ts              # generate Claude Code / Codex config [M1d]
tests/                            # mirror src/
```

---

# Phase M1a — Skeleton: TUI + login + OpenAI proxy + self-healing daemon

## Task 1: Scaffolding

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/shared/paths.ts`; Test `tests/shared/paths.test.ts`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "llm-maestro",
  "version": "0.0.1",
  "type": "module",
  "bin": { "maestro": "dist/cli/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "dev": "tsx src/cli/index.ts"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
    "better-sqlite3": "^11.0.0",
    "commander": "^12.0.0",
    "express": "^4.19.0",
    "ink": "^5.0.0",
    "react": "^18.3.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/express": "^4.17.0",
    "@types/node": "^20.0.0",
    "@types/react": "^18.3.0",
    "@types/supertest": "^6.0.0",
    "ink-testing-library": "^4.0.0",
    "supertest": "^7.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false
  },
  "include": ["src"],
  "exclude": ["tests"]
}
```

- [ ] **Step 3: `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.{ts,tsx}"] },
});
```

- [ ] **Step 4: `.gitignore`**

```
node_modules
dist
*.log
```

- [ ] **Step 5: failing test `tests/shared/paths.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { dataDir, dbPath, configPath } from "../../src/shared/paths.js";

describe("paths", () => {
  it("nests db/config under the data dir", () => {
    expect(dataDir("/home/u")).toBe(join("/home/u", ".llm-maestro"));
    expect(dbPath("/home/u")).toBe(join("/home/u", ".llm-maestro", "maestro.db"));
    expect(configPath("/home/u")).toBe(join("/home/u", ".llm-maestro", "config.json"));
  });
});
```

- [ ] **Step 6: run → FAIL** — `npm install && npx vitest run tests/shared/paths.test.ts` → module not found.

- [ ] **Step 7: implement `src/shared/paths.ts`**

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(home: string = homedir()): string {
  return join(home, ".llm-maestro");
}
export function dbPath(home?: string): string {
  return join(dataDir(home), "maestro.db");
}
export function configPath(home?: string): string {
  return join(dataDir(home), "config.json");
}
```

- [ ] **Step 8: run → PASS**

- [ ] **Step 9: commit** — `git add -A && git commit -m "chore: scaffold llm-maestro (ESM + Ink) with paths util"`

---

## Task 2: shared config, IPC, control-API types

**Files:** Create `src/shared/config.ts`, `src/shared/ipc.ts`, `src/shared/control-types.ts`; Test `tests/shared/config.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from "vitest";
import { defaultConfig, mergeConfig } from "../../src/shared/config.js";

describe("config", () => {
  it("defaults", () => {
    const c = defaultConfig();
    expect(c.supervisorPort).toBe(7890);
    expect(c.workerPort).toBe(7891);
    expect(c.bindHost).toBe("127.0.0.1");
    expect(c.restart.maxCrashes).toBe(5);
    expect(c.modelMap["*"]).toBe("gpt-4o");
  });
  it("deep merges", () => {
    const c = mergeConfig(defaultConfig(), { restart: { maxCrashes: 3 } });
    expect(c.restart.maxCrashes).toBe(3);
    expect(c.restart.windowMs).toBe(60_000);
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/shared/config.ts`**

```ts
export interface RestartPolicy {
  maxCrashes: number;
  windowMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}
export interface AppConfig {
  bindHost: string;
  supervisorPort: number;
  workerPort: number;
  restart: RestartPolicy;
  // model remap: client model name -> Copilot model id. "*" is the fallback.
  modelMap: Record<string, string>;
}

export function defaultConfig(): AppConfig {
  return {
    bindHost: "127.0.0.1",
    supervisorPort: 7890,
    workerPort: 7891,
    restart: { maxCrashes: 5, windowMs: 60_000, baseBackoffMs: 500, maxBackoffMs: 8_000 },
    modelMap: { "*": "gpt-4o" },
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export function mergeConfig(base: AppConfig, o: DeepPartial<AppConfig>): AppConfig {
  return {
    ...base,
    ...o,
    restart: { ...base.restart, ...(o.restart ?? {}) },
    modelMap: { ...base.modelMap, ...(o.modelMap ?? {}) },
  };
}
```

- [ ] **Step 4: implement `src/shared/ipc.ts` (pure types)**

```ts
export type WorkerToSupervisor =
  | { type: "ready"; port: number }
  | { type: "heartbeat"; ts: number }
  | { type: "request-metric"; endpoint: string; model: string; status: number; latencyMs: number }
  | { type: "error"; message: string; stack?: string };
export type SupervisorToWorker = { type: "ping" } | { type: "shutdown" };
```

- [ ] **Step 5: implement `src/shared/control-types.ts` (pure types — the TUI⇄Supervisor contract)**

```ts
export type WorkerState = "starting" | "ready" | "crashed" | "unhealthy";

export interface RestartRow {
  ts: number;
  reason: string;
  exitCode: number | null;
  stderrTail: string;
  markedUnhealthy: 0 | 1;
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

- [ ] **Step 6: run → PASS**

- [ ] **Step 7: commit** — `git commit -am "feat: shared config, IPC, and control-API types"`

---

## Task 3: canonical types + OpenAI inbound (incl tools)

**Files:** Create `src/core/canonical.ts`, `src/core/openai-inbound.ts`; Test `tests/core/openai-inbound.test.ts`

> Canonical carries tool calls so M1b/M1c can translate them. M1a exercises only text, but the types are defined now to avoid churn.

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from "vitest";
import {
  openaiRequestToCanonical,
  canonicalToOpenAIResponse,
  canonicalChunkToOpenAISSE,
} from "../../src/core/openai-inbound.js";
import type { CanonicalResponse } from "../../src/core/canonical.js";

describe("openai inbound", () => {
  it("normalizes request incl tools", () => {
    const c = openaiRequestToCanonical({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      stream: true,
      tools: [{ type: "function", function: { name: "now", description: "time", parameters: { type: "object", properties: {} } } }],
    });
    expect(c.model).toBe("gpt-4o");
    expect(c.stream).toBe(true);
    expect(c.tools?.[0].name).toBe("now");
    expect(c.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
  });

  it("builds OpenAI response from canonical text", () => {
    const r: CanonicalResponse = {
      id: "r1", model: "gpt-4o",
      content: [{ type: "text", text: "hello" }],
      finishReason: "stop",
      usage: { promptTokens: 3, completionTokens: 1 },
    };
    const out = canonicalToOpenAIResponse(r);
    expect(out.choices[0].message.content).toBe("hello");
    expect(out.usage.total_tokens).toBe(4);
  });

  it("formats a text SSE chunk and DONE", () => {
    expect(canonicalChunkToOpenAISSE({ kind: "text", delta: "he", done: false }, "id", "m")).toContain('"content":"he"');
    expect(canonicalChunkToOpenAISSE({ kind: "done", done: true }, "id", "m")).toBe("data: [DONE]\n\n");
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/core/canonical.ts`**

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
  content: ContentBlock[]; // text and/or tool_use
  finishReason: "stop" | "length" | "tool_use" | "error";
  usage: { promptTokens: number; completionTokens: number };
}

// Streaming deltas. Tool-call deltas accumulate by index in the translator.
export type CanonicalChunk =
  | { kind: "text"; delta: string; done: false }
  | { kind: "tool_use_start"; index: number; id: string; name: string; done: false }
  | { kind: "tool_use_delta"; index: number; argsDelta: string; done: false }
  | { kind: "done"; done: true; finishReason?: CanonicalResponse["finishReason"] };

export function textContent(s: string): ContentBlock[] {
  return [{ type: "text", text: s }];
}
export function joinText(blocks: ContentBlock[]): string {
  return blocks.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");
}
```

- [ ] **Step 4: implement `src/core/openai-inbound.ts`**

```ts
import type { CanonicalRequest, CanonicalResponse, CanonicalChunk, CanonicalMessage, ContentBlock } from "./canonical.js";
import { joinText } from "./canonical.js";

interface OpenAIMsg { role: string; content?: string | null; tool_calls?: any[]; tool_call_id?: string }
interface OpenAITool { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } }
interface OpenAIChatRequest {
  model: string; messages: OpenAIMsg[]; stream?: boolean;
  temperature?: number; max_tokens?: number; tools?: OpenAITool[];
}

function msgToCanonical(m: OpenAIMsg): CanonicalMessage {
  const role = (["system", "user", "assistant", "tool"].includes(m.role) ? m.role : "user") as CanonicalMessage["role"];
  const content: ContentBlock[] = [];
  if (m.role === "tool" && m.tool_call_id) {
    content.push({ type: "tool_result", toolUseId: m.tool_call_id, content: m.content ?? "" });
  } else {
    if (m.content) content.push({ type: "text", text: m.content });
    for (const tc of m.tool_calls ?? []) {
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) });
    }
  }
  return { role, content };
}
function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return {}; } }

export function openaiRequestToCanonical(req: OpenAIChatRequest): CanonicalRequest {
  return {
    model: req.model,
    stream: Boolean(req.stream),
    temperature: req.temperature,
    maxTokens: req.max_tokens,
    tools: req.tools?.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })),
    messages: req.messages.map(msgToCanonical),
  };
}

export function canonicalToOpenAIResponse(r: CanonicalResponse) {
  const toolCalls = r.content
    .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
    .map((b, i) => ({ index: i, id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
  return {
    id: r.id, object: "chat.completion" as const, created: 0, model: r.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: joinText(r.content) || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: r.finishReason === "tool_use" ? "tool_calls" : r.finishReason,
    }],
    usage: { prompt_tokens: r.usage.promptTokens, completion_tokens: r.usage.completionTokens, total_tokens: r.usage.promptTokens + r.usage.completionTokens },
  };
}

export function canonicalChunkToOpenAISSE(chunk: CanonicalChunk, id: string, model: string): string {
  if (chunk.done) return "data: [DONE]\n\n";
  let delta: Record<string, unknown> = {};
  if (chunk.kind === "text") delta = { content: chunk.delta };
  else if (chunk.kind === "tool_use_start") delta = { tool_calls: [{ index: chunk.index, id: chunk.id, type: "function", function: { name: chunk.name, arguments: "" } }] };
  else if (chunk.kind === "tool_use_delta") delta = { tool_calls: [{ index: chunk.index, function: { arguments: chunk.argsDelta } }] };
  const payload = { id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: null }] };
  return `data: ${JSON.stringify(payload)}\n\n`;
}
```

- [ ] **Step 5: run → PASS**

- [ ] **Step 6: commit** — `git commit -am "feat: canonical types and OpenAI inbound with tool-call mapping"`

---

## Task 4: Copilot device-code auth

**Files:** Create `src/providers/copilot/auth.ts`, `src/providers/types.ts`; Test `tests/providers/copilot/auth.test.ts`

> **Unofficial endpoints** — community-documented; keep them in one file; README disclaimer in Task 24.

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { requestDeviceCode, pollForToken } from "../../../src/providers/copilot/auth.js";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("copilot auth", () => {
  it("requests a device code", async () => {
    const f = vi.fn(async () => json({ device_code: "dc", user_code: "AB-12", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 }));
    const r = await requestDeviceCode(f as unknown as typeof fetch);
    expect(r.user_code).toBe("AB-12");
  });
  it("polls until authorized", async () => {
    const f = vi.fn().mockResolvedValueOnce(json({ error: "authorization_pending" })).mockResolvedValueOnce(json({ access_token: "gho_x" }));
    expect(await pollForToken("dc", 0, f as unknown as typeof fetch)).toBe("gho_x");
    expect(f).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/providers/types.ts`**

```ts
import type { CanonicalRequest, CanonicalResponse, CanonicalChunk } from "../core/canonical.js";
export interface ProviderAdapter {
  readonly name: string;
  complete(req: CanonicalRequest): Promise<CanonicalResponse>;
  stream(req: CanonicalRequest): AsyncIterable<CanonicalChunk>;
}
```

- [ ] **Step 4: implement `src/providers/copilot/auth.ts`**

```ts
// Community-documented GitHub Copilot OAuth (unofficial; may change).
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

export interface DeviceCode {
  device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number;
}

export async function requestDeviceCode(fetchFn: typeof fetch = fetch): Promise<DeviceCode> {
  const res = await fetchFn(DEVICE_CODE_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
  });
  if (!res.ok) throw new Error(`device code request failed: ${res.status}`);
  return (await res.json()) as DeviceCode;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function pollForToken(deviceCode: string, intervalMs: number, fetchFn: typeof fetch = fetch): Promise<string> {
  for (;;) {
    const res = await fetchFn(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const data = (await res.json()) as { access_token?: string; error?: string };
    if (data.access_token) return data.access_token;
    if (data.error && data.error !== "authorization_pending" && data.error !== "slow_down") throw new Error(`authorization failed: ${data.error}`);
    await sleep(intervalMs);
  }
}
```

- [ ] **Step 5: run → PASS**

- [ ] **Step 6: commit** — `git commit -am "feat: provider interface + Copilot device-code auth"`

---

## Task 5: Copilot token store

**Files:** Create `src/providers/copilot/token.ts`; Test `tests/providers/copilot/token.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { CopilotTokenStore } from "../../../src/providers/copilot/token.js";
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("CopilotTokenStore", () => {
  it("caches until near expiry", async () => {
    const now = 1_000_000;
    const f = vi.fn(async () => json({ token: "cop_1", expires_at: 1_000 + now / 1000 }));
    const s = new CopilotTokenStore("gho", f as unknown as typeof fetch, () => now);
    expect(await s.get()).toBe("cop_1");
    expect(await s.get()).toBe("cop_1");
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("refreshes after expiry", async () => {
    let now = 0;
    const f = vi.fn().mockResolvedValueOnce(json({ token: "cop_1", expires_at: 100 })).mockResolvedValueOnce(json({ token: "cop_2", expires_at: 10_000 }));
    const s = new CopilotTokenStore("gho", f as unknown as typeof fetch, () => now);
    expect(await s.get()).toBe("cop_1");
    now = 200_000;
    expect(await s.get()).toBe("cop_2");
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/providers/copilot/token.ts`**

```ts
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
interface CopilotTokenResponse { token: string; expires_at: number }

export class CopilotTokenStore {
  private cached?: { token: string; expiresAtMs: number };
  constructor(private ghToken: string, private fetchFn: typeof fetch = fetch, private nowMs: () => number = () => Date.now()) {}
  async get(): Promise<string> {
    const skewMs = 60_000;
    if (this.cached && this.cached.expiresAtMs - skewMs > this.nowMs()) return this.cached.token;
    const res = await this.fetchFn(COPILOT_TOKEN_URL, { headers: { authorization: `token ${this.ghToken}`, accept: "application/json" } });
    if (!res.ok) throw new Error(`copilot token exchange failed: ${res.status}`);
    const data = (await res.json()) as CopilotTokenResponse;
    this.cached = { token: data.token, expiresAtMs: data.expires_at * 1000 };
    return data.token;
  }
}
```

- [ ] **Step 4: run → PASS**

- [ ] **Step 5: commit** — `git commit -am "feat: Copilot token exchange with cache + refresh"`

---

## Task 6: Copilot adapter (complete + stream, incl tool calls)

**Files:** Create `src/providers/copilot/adapter.ts`; Test `tests/providers/copilot/adapter.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { CopilotAdapter } from "../../../src/providers/copilot/adapter.js";
import type { CanonicalRequest } from "../../../src/core/canonical.js";

const tokenStore = { get: async () => "cop" };
const base: CanonicalRequest = { model: "gpt-4o", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], stream: false };

describe("CopilotAdapter", () => {
  it("completes non-stream", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({
      id: "c1", choices: [{ message: { content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    const r = await a.complete(base);
    expect(r.content).toEqual([{ type: "text", text: "hello" }]);
    const init = f.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer cop");
  });
  it("streams text deltas", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"he"}}]}\n\n' + 'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' + "data: [DONE]\n\n";
    const f = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const a = new CopilotAdapter(tokenStore, f as unknown as typeof fetch);
    let out = "";
    for await (const c of a.stream({ ...base, stream: true })) if (c.kind === "text") out += c.delta;
    expect(out).toBe("hello");
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/providers/copilot/adapter.ts`**

```ts
import type { ProviderAdapter } from "../types.js";
import type { CanonicalRequest, CanonicalResponse, CanonicalChunk, CanonicalMessage, ContentBlock } from "../../core/canonical.js";

const CHAT_URL = "https://api.githubcopilot.com/chat/completions";
interface TokenSource { get(): Promise<string> }

// Canonical messages -> OpenAI wire messages (Copilot is OpenAI-shaped).
function toWireMessages(messages: CanonicalMessage[]) {
  return messages.map((m) => {
    const text = m.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("");
    const toolUses = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    const toolResult = m.content.find((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");
    if (m.role === "tool" && toolResult) return { role: "tool", tool_call_id: toolResult.toolUseId, content: toolResult.content };
    const out: any = { role: m.role, content: text || null };
    if (toolUses.length) out.tool_calls = toolUses.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input) } }));
    return out;
  });
}

function buildBody(req: CanonicalRequest) {
  const body: any = { model: req.model, messages: toWireMessages(req.messages), stream: req.stream, temperature: req.temperature, max_tokens: req.maxTokens };
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  return body;
}
function headers(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json", "editor-version": "vscode/1.95.0", "copilot-integration-id": "vscode-chat" };
}

export class CopilotAdapter implements ProviderAdapter {
  readonly name = "copilot";
  constructor(private tokenStore: TokenSource, private fetchFn: typeof fetch = fetch) {}

  async complete(req: CanonicalRequest): Promise<CanonicalResponse> {
    const token = await this.tokenStore.get();
    const res = await this.fetchFn(CHAT_URL, { method: "POST", headers: headers(token), body: JSON.stringify(buildBody({ ...req, stream: false })) });
    if (!res.ok) throw new Error(`copilot completion failed: ${res.status}`);
    const data = (await res.json()) as any;
    const choice = data.choices[0];
    const content: ContentBlock[] = [];
    if (choice.message.content) content.push({ type: "text", text: choice.message.content });
    for (const tc of choice.message.tool_calls ?? []) content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) });
    return {
      id: data.id ?? "cmpl", model: req.model, content,
      finishReason: choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason === "length" ? "length" : "stop",
      usage: { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 },
    };
  }

  async *stream(req: CanonicalRequest): AsyncIterable<CanonicalChunk> {
    const token = await this.tokenStore.get();
    const res = await this.fetchFn(CHAT_URL, { method: "POST", headers: headers(token), body: JSON.stringify(buildBody({ ...req, stream: true })) });
    if (!res.ok || !res.body) throw new Error(`copilot stream failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const startedTools = new Set<number>();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const evt of events) {
        const line = evt.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") { yield { kind: "done", done: true, finishReason: "stop" }; return; }
        let json: any;
        try { json = JSON.parse(payload); } catch { continue; }
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) yield { kind: "text", delta: delta.content, done: false };
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          if (!startedTools.has(idx) && tc.function?.name) { startedTools.add(idx); yield { kind: "tool_use_start", index: idx, id: tc.id ?? `call_${idx}`, name: tc.function.name, done: false }; }
          if (tc.function?.arguments) yield { kind: "tool_use_delta", index: idx, argsDelta: tc.function.arguments, done: false };
        }
      }
    }
    yield { kind: "done", done: true, finishReason: "stop" };
  }
}
function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return {}; } }
```

- [ ] **Step 4: run → PASS**

- [ ] **Step 5: commit** — `git commit -am "feat: Copilot adapter (complete + SSE stream + tool calls)"`

---

## Task 7: worker router (single provider + model map)

**Files:** Create `src/worker/router.ts`; Test `tests/worker/router.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from "vitest";
import { Router } from "../../src/worker/router.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

const fake: ProviderAdapter = { name: "copilot", complete: async () => ({ id: "x", model: "m", content: [], finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } }), async *stream() {} };

describe("Router", () => {
  it("maps model names via modelMap with * fallback", () => {
    const r = new Router([fake], { "claude-opus-4-8": "gpt-4o", "*": "gpt-4o-mini" });
    expect(r.resolveModel("claude-opus-4-8")).toBe("gpt-4o");
    expect(r.resolveModel("whatever")).toBe("gpt-4o-mini");
  });
  it("returns the only provider", () => {
    expect(new Router([fake], { "*": "gpt-4o" }).pick("x").name).toBe("copilot");
  });
  it("throws with no providers", () => {
    expect(() => new Router([], { "*": "gpt-4o" }).pick("x")).toThrow(/no provider/i);
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/worker/router.ts`**

```ts
import type { ProviderAdapter } from "../providers/types.js";

// M1: single provider. Model name is remapped to the provider's actual id.
export class Router {
  constructor(private providers: ProviderAdapter[], private modelMap: Record<string, string>) {}
  resolveModel(requested: string): string {
    return this.modelMap[requested] ?? this.modelMap["*"] ?? requested;
  }
  pick(_model: string): ProviderAdapter {
    const p = this.providers[0];
    if (!p) throw new Error("no provider registered");
    return p;
  }
}
```

- [ ] **Step 4: run → PASS**

- [ ] **Step 5: commit** — `git commit -am "feat: worker router with model remapping"`

---

## Task 8: worker OpenAI endpoint

**Files:** Create `src/worker/openai-server.ts`, `src/worker/server.ts`; Test `tests/worker/openai-server.test.ts`

> `server.ts` assembles the Express app and mounts endpoint modules; M1a mounts OpenAI only. M1b adds Anthropic.

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

const provider: ProviderAdapter = {
  name: "copilot",
  complete: async () => ({ id: "c1", model: "gpt-4o", content: [{ type: "text", text: "hello" }], finishReason: "stop", usage: { promptTokens: 2, completionTokens: 1 } }),
  async *stream() { yield { kind: "text", delta: "he", done: false } as const; yield { kind: "text", delta: "llo", done: false } as const; yield { kind: "done", done: true, finishReason: "stop" } as const; },
};
const app = () => createWorkerApp(new Router([provider], { "*": "gpt-4o" }), () => {});

describe("worker OpenAI endpoint", () => {
  it("non-stream completion", async () => {
    const res = await request(app()).post("/v1/chat/completions").send({ model: "x", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("hello");
  });
  it("SSE stream", async () => {
    const res = await request(app()).post("/v1/chat/completions").send({ model: "x", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain('"content":"he"');
    expect(res.text).toContain("data: [DONE]");
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/worker/openai-server.ts`**

```ts
import { type Express } from "express";
import type { Router } from "./router.js";
import type { MetricSink } from "./server.js";
import { openaiRequestToCanonical, canonicalToOpenAIResponse, canonicalChunkToOpenAISSE } from "../core/openai-inbound.js";

export function mountOpenAI(app: Express, router: Router, onMetric: MetricSink): void {
  app.post("/v1/chat/completions", async (req, res) => {
    const start = Date.now();
    const canon = openaiRequestToCanonical(req.body);
    canon.model = router.resolveModel(canon.model);
    const provider = router.pick(canon.model);
    const metric = (status: number) => onMetric({ endpoint: "/v1/chat/completions", model: canon.model, status, latencyMs: Date.now() - start });
    try {
      if (canon.stream) {
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        const id = `chatcmpl-${canon.model}`;
        for await (const chunk of provider.stream(canon)) res.write(canonicalChunkToOpenAISSE(chunk, id, canon.model));
        res.end();
        metric(200);
      } else {
        res.json(canonicalToOpenAIResponse(await provider.complete(canon)));
        metric(200);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.status(502).json({ error: { message } });
      else res.end();
      metric(502);
    }
  });
}
```

- [ ] **Step 4: implement `src/worker/server.ts`**

```ts
import express, { type Express } from "express";
import type { Router } from "./router.js";
import { mountOpenAI } from "./openai-server.js";

export type MetricSink = (m: { endpoint: string; model: string; status: number; latencyMs: number }) => void;

export function createWorkerApp(router: Router, onMetric: MetricSink): Express {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  mountOpenAI(app, router, onMetric);
  return app;
}
```

- [ ] **Step 5: run → PASS**

- [ ] **Step 6: commit** — `git commit -am "feat: worker app with OpenAI chat endpoint (stream + non-stream)"`

---

## Task 9: worker entry (creds + IPC heartbeat)

**Files:** Create `src/shared/creds.ts`, `src/worker/index.ts`; Test `tests/shared/creds.test.ts`

- [ ] **Step 1: failing test (creds)**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGhToken, writeGhToken } from "../../src/shared/creds.js";

describe("creds", () => {
  it("round-trips a token", () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    writeGhToken("gho_abc", d);
    expect(readGhToken(d)).toBe("gho_abc");
  });
  it("null when absent", () => {
    expect(readGhToken(mkdtempSync(join(tmpdir(), "m-")))).toBeNull();
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/shared/creds.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// M1: plaintext token in the data dir (0600). Encryption-at-rest is M2.
const file = (dir: string) => join(dir, "creds.json");
export function writeGhToken(token: string, dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir), JSON.stringify({ ghToken: token }), { mode: 0o600 });
}
export function readGhToken(dir: string): string | null {
  if (!existsSync(file(dir))) return null;
  return (JSON.parse(readFileSync(file(dir), "utf8")) as { ghToken?: string }).ghToken ?? null;
}
```

- [ ] **Step 4: run → PASS**

- [ ] **Step 5: implement `src/worker/index.ts` (glue; exercised by Task 23 smoke)**

```ts
import { createWorkerApp } from "./server.js";
import { Router } from "./router.js";
import { CopilotAdapter } from "../providers/copilot/adapter.js";
import { CopilotTokenStore } from "../providers/copilot/token.js";
import { readGhToken } from "../shared/creds.js";
import { dataDir } from "../shared/paths.js";
import { defaultConfig } from "../shared/config.js";
import type { WorkerToSupervisor } from "../shared/ipc.js";

function send(msg: WorkerToSupervisor): void { if (process.send) process.send(msg); }

const cfg = defaultConfig();
const port = Number(process.env.WORKER_PORT ?? cfg.workerPort);
const host = process.env.BIND_HOST ?? cfg.bindHost;

const gh = readGhToken(dataDir());
if (!gh) { send({ type: "error", message: "no GitHub token; run `maestro` and /login first" }); process.exit(1); }

const router = new Router([new CopilotAdapter(new CopilotTokenStore(gh))], cfg.modelMap);
const app = createWorkerApp(router, (m) => send({ type: "request-metric", ...m }));
const server = app.listen(port, host, () => send({ type: "ready", port }));
const hb = setInterval(() => send({ type: "heartbeat", ts: Date.now() }), 5_000);

process.on("message", (m: { type?: string }) => { if (m?.type === "shutdown") { clearInterval(hb); server.close(() => process.exit(0)); } });
process.on("uncaughtException", (e) => { send({ type: "error", message: e.message, stack: e.stack }); process.exit(1); });
```

- [ ] **Step 6: commit** — `git commit -am "feat: worker entry with creds loader and IPC heartbeat"`

---

## Task 10: SQLite store

**Files:** Create `src/supervisor/db.ts`; Test `tests/supervisor/db.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from "vitest";
import { openDb, recordRestart, listRestarts, recordRequest, recentRequests } from "../../src/supervisor/db.js";

describe("db", () => {
  it("restart events newest-first", () => {
    const db = openDb(":memory:");
    recordRestart(db, { ts: 1, reason: "crash", exitCode: 1, stderrTail: "boom", backoffMs: 500, markedUnhealthy: 0 });
    recordRestart(db, { ts: 2, reason: "crash", exitCode: 1, stderrTail: "b2", backoffMs: 1000, markedUnhealthy: 1 });
    const rows = listRestarts(db, 10);
    expect(rows[0].ts).toBe(2);
    expect(rows[0].markedUnhealthy).toBe(1);
  });
  it("request log newest-first", () => {
    const db = openDb(":memory:");
    recordRequest(db, { ts: 5, endpoint: "/v1/chat/completions", model: "gpt-4o", status: 200, latencyMs: 12 });
    expect(recentRequests(db, 10)[0].model).toBe("gpt-4o");
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/supervisor/db.ts`**

```ts
import Database from "better-sqlite3";
import type { RestartRow, MetricSample } from "../shared/control-types.js";
export type Db = Database.Database;

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS restart_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, reason TEXT NOT NULL,
      exit_code INTEGER, stderr_tail TEXT NOT NULL, backoff_ms INTEGER NOT NULL, marked_unhealthy INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, endpoint TEXT NOT NULL,
      model TEXT NOT NULL, status INTEGER NOT NULL, latency_ms INTEGER NOT NULL);
  `);
  return db;
}

export function recordRestart(db: Db, e: RestartRow & { backoffMs: number }): void {
  db.prepare(`INSERT INTO restart_events (ts, reason, exit_code, stderr_tail, backoff_ms, marked_unhealthy)
    VALUES (@ts, @reason, @exitCode, @stderrTail, @backoffMs, @markedUnhealthy)`).run(e);
}
export function listRestarts(db: Db, limit: number): RestartRow[] {
  return db.prepare(`SELECT ts, reason, exit_code as exitCode, stderr_tail as stderrTail, marked_unhealthy as markedUnhealthy
    FROM restart_events ORDER BY ts DESC LIMIT ?`).all(limit) as RestartRow[];
}
export function recordRequest(db: Db, m: Omit<MetricSample, "ts"> & { ts: number }): void {
  db.prepare(`INSERT INTO request_log (ts, endpoint, model, status, latency_ms) VALUES (@ts, @endpoint, @model, @status, @latencyMs)`).run(m);
}
export function recentRequests(db: Db, limit: number): MetricSample[] {
  return db.prepare(`SELECT ts, endpoint, model, status, latency_ms as latencyMs FROM request_log ORDER BY ts DESC LIMIT ?`).all(limit) as MetricSample[];
}
```

- [ ] **Step 4: run → PASS**

- [ ] **Step 5: commit** — `git commit -am "feat: SQLite store for restart events + request log"`

---

## Task 11: supervisor monitor (backoff + circuit breaker)

**Files:** Create `src/supervisor/monitor.ts`; Test `tests/supervisor/monitor.test.ts`

> Restart policy is pure logic and unit-tested without spawning. `WorkerMonitor`'s `fork` wiring is exercised by Task 23's smoke test.

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from "vitest";
import { RestartController } from "../../src/supervisor/monitor.js";
import { defaultConfig } from "../../src/shared/config.js";

describe("RestartController", () => {
  it("exponential backoff capped", () => {
    const c = new RestartController(defaultConfig().restart, () => 0);
    expect(c.onCrash().backoffMs).toBe(500);
    expect(c.onCrash().backoffMs).toBe(1000);
    expect(c.onCrash().backoffMs).toBe(2000);
  });
  it("unhealthy after maxCrashes in window", () => {
    let now = 0;
    const c = new RestartController(defaultConfig().restart, () => now);
    let last = c.onCrash();
    for (let i = 0; i < 4; i++) { now += 1000; last = c.onCrash(); }
    expect(last.markedUnhealthy).toBe(true);
  });
  it("healthy when spread beyond window", () => {
    let now = 0;
    const c = new RestartController(defaultConfig().restart, () => now);
    for (let i = 0; i < 4; i++) { now += 20_000; c.onCrash(); }
    expect(c.onCrash().markedUnhealthy).toBe(false);
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/supervisor/monitor.ts`**

```ts
import { fork, type ChildProcess } from "node:child_process";
import type { RestartPolicy, AppConfig } from "../shared/config.js";
import type { WorkerToSupervisor } from "../shared/ipc.js";
import type { WorkerState } from "../shared/control-types.js";

export interface RestartDecision { backoffMs: number; markedUnhealthy: boolean; crashesInWindow: number }

export class RestartController {
  private crashTimes: number[] = [];
  private consecutive = 0;
  constructor(private policy: RestartPolicy, private now: () => number = () => Date.now()) {}
  onCrash(): RestartDecision {
    const t = this.now();
    this.crashTimes.push(t);
    this.crashTimes = this.crashTimes.filter((ct) => t - ct < this.policy.windowMs);
    this.consecutive += 1;
    const backoffMs = Math.min(this.policy.baseBackoffMs * 2 ** (this.consecutive - 1), this.policy.maxBackoffMs);
    return { backoffMs, markedUnhealthy: this.crashTimes.length >= this.policy.maxCrashes, crashesInWindow: this.crashTimes.length };
  }
  reset(): void { this.consecutive = 0; }
}

export interface MonitorHooks {
  onStateChange(s: WorkerState): void;
  onCrash(d: RestartDecision, exitCode: number | null, stderrTail: string): void;
  onWorkerMessage(m: WorkerToSupervisor): void;
}

export class WorkerMonitor {
  private child?: ChildProcess;
  private controller: RestartController;
  private stderrTail = "";
  private state: WorkerState = "starting";
  private stopped = false;
  constructor(private config: AppConfig, private workerEntry: string, private hooks: MonitorHooks) {
    this.controller = new RestartController(config.restart);
  }
  start(): void { this.spawn(); }
  currentState(): WorkerState { return this.state; }
  private set(s: WorkerState): void { this.state = s; this.hooks.onStateChange(s); }
  private spawn(): void {
    this.set("starting");
    const child = fork(this.workerEntry, [], {
      env: { ...process.env, WORKER_PORT: String(this.config.workerPort), BIND_HOST: this.config.bindHost },
      stdio: ["ignore", "inherit", "pipe", "ipc"],
    });
    this.child = child;
    this.stderrTail = "";
    child.stderr?.on("data", (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-4000); });
    child.on("message", (m: WorkerToSupervisor) => {
      if (m.type === "ready") { this.controller.reset(); this.set("ready"); }
      this.hooks.onWorkerMessage(m);
    });
    child.on("exit", (code) => {
      if (this.stopped) return;
      const d = this.controller.onCrash();
      this.hooks.onCrash(d, code, this.stderrTail);
      if (d.markedUnhealthy) { this.set("unhealthy"); return; }
      this.set("crashed");
      setTimeout(() => this.spawn(), d.backoffMs);
    });
  }
  restartManually(): void {
    this.controller.reset(); this.stopped = false;
    if (this.child && !this.child.killed) { this.child.removeAllListeners("exit"); this.child.kill(); }
    this.spawn();
  }
  stop(): void { this.stopped = true; this.child?.send?.({ type: "shutdown" }); this.child?.kill(); }
}
```

- [ ] **Step 4: run → PASS**

- [ ] **Step 5: commit** — `git commit -am "feat: supervisor monitor (backoff restart + circuit breaker)"`

---

## Task 12: supervisor event bus + control API

**Files:** Create `src/supervisor/events.ts`, `src/supervisor/api.ts`; Test `tests/supervisor/events.test.ts`, `tests/supervisor/api.test.ts`

- [ ] **Step 1: failing test (events)**

```ts
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../../src/supervisor/events.js";

describe("EventBus", () => {
  it("broadcasts and unsubscribes", () => {
    const bus = new EventBus();
    const a = vi.fn();
    const off = bus.subscribe(a);
    bus.emit("state", { x: 1 });
    off();
    bus.emit("state", { x: 2 });
    expect(a).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: implement `src/supervisor/events.ts`**

```ts
type Listener = (event: string, data: unknown) => void;
export class EventBus {
  private listeners = new Set<Listener>();
  subscribe(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(event: string, data: unknown): void { for (const fn of this.listeners) fn(event, data); }
}
```

- [ ] **Step 3: failing test (api)**

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createControlApp } from "../../src/supervisor/api.js";
import { openDb, recordRestart, recordRequest } from "../../src/supervisor/db.js";

function fixture() {
  const db = openDb(":memory:");
  recordRestart(db, { ts: 1, reason: "crash", exitCode: 1, stderrTail: "boom", backoffMs: 500, markedUnhealthy: 0 });
  recordRequest(db, { ts: 2, endpoint: "/v1/chat/completions", model: "gpt-4o", status: 200, latencyMs: 9 });
  const calls: string[] = [];
  const app = createControlApp({
    db,
    getState: () => "ready",
    restart: () => calls.push("restart"),
    stop: () => calls.push("stop"),
    start: () => calls.push("start"),
    doctor: async () => [{ name: "copilot-auth", ok: true, detail: "token present" }],
    subscribe: () => () => {},
  });
  return { app, calls };
}

describe("control api", () => {
  it("status", async () => {
    const res = await request(fixture().app).get("/api/status");
    expect(res.body.workerState).toBe("ready");
    expect(res.body.restarts[0].stderrTail).toBe("boom");
  });
  it("restart action", async () => {
    const fx = fixture();
    await request(fx.app).post("/api/restart");
    expect(fx.calls).toContain("restart");
  });
  it("doctor", async () => {
    const res = await request(fixture().app).get("/api/doctor");
    expect(res.body.checks[0].ok).toBe(true);
  });
  it("recent requests", async () => {
    const res = await request(fixture().app).get("/api/requests");
    expect(res.body.requests[0].model).toBe("gpt-4o");
  });
});
```

- [ ] **Step 4: run → FAIL**

- [ ] **Step 5: implement `src/supervisor/api.ts`**

```ts
import express, { type Express } from "express";
import { listRestarts, recentRequests, type Db } from "./db.js";
import type { WorkerState, DoctorCheck } from "../shared/control-types.js";

export interface ControlDeps {
  db: Db;
  getState: () => WorkerState;
  restart: () => void;
  stop: () => void;
  start: () => void;
  doctor: () => Promise<DoctorCheck[]>;
  subscribe: (send: (event: string, data: unknown) => void) => () => void;
}

export function createControlApp(deps: ControlDeps): Express {
  const app = express();
  app.use(express.json());
  app.get("/api/status", (_req, res) => res.json({ workerState: deps.getState(), restarts: listRestarts(deps.db, 50) }));
  app.post("/api/restart", (_req, res) => { deps.restart(); res.json({ ok: true }); });
  app.post("/api/stop", (_req, res) => { deps.stop(); res.json({ ok: true }); });
  app.post("/api/start", (_req, res) => { deps.start(); res.json({ ok: true }); });
  app.get("/api/doctor", async (_req, res) => res.json({ checks: await deps.doctor() }));
  app.get("/api/requests", (_req, res) => res.json({ requests: recentRequests(deps.db, 100) }));
  app.get("/api/events", (req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("hello", { state: deps.getState() });
    const off = deps.subscribe(send);
    req.on("close", off);
  });
  return app;
}
```

- [ ] **Step 6: run both tests → PASS**

- [ ] **Step 7: commit** — `git commit -am "feat: supervisor event bus + control REST/SSE API"`

---

## Task 13: supervisor entry wiring

**Files:** Create `src/supervisor/index.ts` (glue; exercised by Task 23). Modify none.

- [ ] **Step 1: implement `src/supervisor/index.ts`**

```ts
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { openDb, recordRestart, recordRequest } from "./db.js";
import { WorkerMonitor } from "./monitor.js";
import { EventBus } from "./events.js";
import { createControlApp } from "./api.js";
import { defaultConfig } from "../shared/config.js";
import { dataDir, dbPath } from "../shared/paths.js";
import { readGhToken } from "../shared/creds.js";
import type { WorkerState, DoctorCheck } from "../shared/control-types.js";

export function startSupervisor(): void {
  const config = defaultConfig();
  mkdirSync(dataDir(), { recursive: true });
  const db = openDb(dbPath());
  const bus = new EventBus();
  const workerEntry = join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "index.js");

  let state: WorkerState = "starting";
  const monitor = new WorkerMonitor(config, workerEntry, {
    onStateChange: (s) => { state = s; bus.emit("state", { state: s }); },
    onCrash: (d, exitCode, stderrTail) => {
      recordRestart(db, { ts: Date.now(), reason: d.markedUnhealthy ? "unhealthy" : "crash", exitCode, stderrTail, backoffMs: d.backoffMs, markedUnhealthy: d.markedUnhealthy ? 1 : 0 });
      bus.emit("crash", { exitCode, ...d });
    },
    onWorkerMessage: (m) => {
      if (m.type === "request-metric") {
        recordRequest(db, { ts: Date.now(), endpoint: m.endpoint, model: m.model, status: m.status, latencyMs: m.latencyMs });
        bus.emit("metric", { ts: Date.now(), endpoint: m.endpoint, model: m.model, status: m.status, latencyMs: m.latencyMs });
      }
    },
  });

  const doctor = async (): Promise<DoctorCheck[]> => [
    { name: "github-auth", ok: Boolean(readGhToken(dataDir())), detail: readGhToken(dataDir()) ? "token present" : "run /login" },
    { name: "worker", ok: state === "ready", detail: `worker is ${state}` },
  ];

  const app = createControlApp({
    db, getState: () => state,
    restart: () => monitor.restartManually(),
    stop: () => monitor.stop(),
    start: () => monitor.start(),
    doctor,
    subscribe: (send) => bus.subscribe(send),
  });

  app.listen(config.supervisorPort, config.bindHost, () => monitor.start());
  process.on("SIGINT", () => { monitor.stop(); process.exit(0); });
  process.on("SIGTERM", () => { monitor.stop(); process.exit(0); });
}

// Allow `node dist/supervisor/index.js` to boot the daemon directly.
if (process.argv[1] && process.argv[1].endsWith(join("supervisor", "index.js"))) startSupervisor();
```

- [ ] **Step 2: commit** — `git commit -am "feat: supervisor entry wiring (db + monitor + control api + doctor)"`

---

## Task 14: daemon lifecycle (ensure-running)

**Files:** Create `src/daemon/lifecycle.ts`; Test `tests/daemon/lifecycle.test.ts`

> Pure-ish: the health probe is injectable so we can unit-test `ensureDaemon` without spawning.

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { ensureDaemon } from "../../src/daemon/lifecycle.js";

describe("ensureDaemon", () => {
  it("does not spawn when already healthy", async () => {
    const spawn = vi.fn();
    const probe = vi.fn(async () => true);
    const r = await ensureDaemon({ spawn, probe, retries: 3, delayMs: 0 });
    expect(r).toBe("already-running");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("spawns then waits until healthy", async () => {
    const spawn = vi.fn();
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const r = await ensureDaemon({ spawn, probe, retries: 5, delayMs: 0 });
    expect(r).toBe("started");
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("throws if never healthy", async () => {
    await expect(ensureDaemon({ spawn: vi.fn(), probe: async () => false, retries: 2, delayMs: 0 })).rejects.toThrow(/did not become healthy/i);
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/daemon/lifecycle.ts`**

```ts
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { defaultConfig } from "../shared/config.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface EnsureOptions {
  spawn: () => void;
  probe: () => Promise<boolean>;
  retries: number;
  delayMs: number;
}

export async function ensureDaemon(opts: EnsureOptions): Promise<"already-running" | "started"> {
  if (await opts.probe()) return "already-running";
  opts.spawn();
  for (let i = 0; i < opts.retries; i++) {
    await sleep(opts.delayMs);
    if (await opts.probe()) return "started";
  }
  throw new Error("daemon did not become healthy in time");
}

// Real implementations wired by the CLI/TUI.
export function spawnSupervisor(): void {
  const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "supervisor", "index.js");
  const child = nodeSpawn(process.execPath, [entry], { detached: true, stdio: "ignore" });
  child.unref();
}

export async function probeSupervisor(fetchFn: typeof fetch = fetch): Promise<boolean> {
  const cfg = defaultConfig();
  try {
    const res = await fetchFn(`http://${cfg.bindHost}:${cfg.supervisorPort}/api/status`);
    return res.ok;
  } catch { return false; }
}
```

- [ ] **Step 4: run → PASS**

- [ ] **Step 5: commit** — `git commit -am "feat: daemon lifecycle ensure/spawn/probe"`

---

## Task 15: TUI daemon-client

**Files:** Create `src/tui/daemon-client.ts`; Test `tests/tui/daemon-client.test.ts`

- [ ] **Step 1: failing test (inject fetch)**

```ts
import { describe, it, expect, vi } from "vitest";
import { DaemonClient } from "../../src/tui/daemon-client.js";
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("DaemonClient", () => {
  it("reads status", async () => {
    const f = vi.fn(async () => json({ workerState: "ready", restarts: [] }));
    const c = new DaemonClient("http://x", f as unknown as typeof fetch);
    expect((await c.status()).workerState).toBe("ready");
  });
  it("posts restart", async () => {
    const f = vi.fn(async () => json({ ok: true }));
    await new DaemonClient("http://x", f as unknown as typeof fetch).restart();
    expect((f.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });
  it("runs doctor", async () => {
    const f = vi.fn(async () => json({ checks: [{ name: "x", ok: true, detail: "d" }] }));
    expect((await new DaemonClient("http://x", f as unknown as typeof fetch).doctor())[0].ok).toBe(true);
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/tui/daemon-client.ts`**

```ts
import type { StatusResponse, DoctorCheck, MetricSample } from "../shared/control-types.js";

export class DaemonClient {
  constructor(private base: string, private fetchFn: typeof fetch = fetch) {}
  private async post(path: string): Promise<void> { await this.fetchFn(`${this.base}${path}`, { method: "POST" }); }
  async status(): Promise<StatusResponse> { return (await (await this.fetchFn(`${this.base}/api/status`)).json()) as StatusResponse; }
  async restart(): Promise<void> { return this.post("/api/restart"); }
  async stop(): Promise<void> { return this.post("/api/stop"); }
  async start(): Promise<void> { return this.post("/api/start"); }
  async doctor(): Promise<DoctorCheck[]> { return ((await (await this.fetchFn(`${this.base}/api/doctor`)).json()) as { checks: DoctorCheck[] }).checks; }
  async requests(): Promise<MetricSample[]> { return ((await (await this.fetchFn(`${this.base}/api/requests`)).json()) as { requests: MetricSample[] }).requests; }
  eventsUrl(): string { return `${this.base}/api/events`; }
}
```

- [ ] **Step 4: run → PASS**

- [ ] **Step 5: commit** — `git commit -am "feat: TUI daemon control client"`

---

## Task 16: slash registry + commands

**Files:** Create `src/tui/slash/registry.ts`, `src/tui/slash/commands.ts`; Test `tests/tui/slash.test.ts`

> Commands return plain strings (lines to print) so they're testable without rendering. Side effects go through an injected `DaemonClient`-shaped context.

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { buildRegistry } from "../../src/tui/slash/commands.js";

function ctx() {
  return {
    client: {
      status: vi.fn(async () => ({ workerState: "ready", restarts: [{ ts: 1, reason: "crash", exitCode: 1, stderrTail: "boom", markedUnhealthy: 0 as const }] })),
      restart: vi.fn(async () => {}), stop: vi.fn(async () => {}), start: vi.fn(async () => {}),
      doctor: vi.fn(async () => [{ name: "github-auth", ok: true, detail: "ok" }]),
      requests: vi.fn(async () => []),
    },
    quit: vi.fn(),
  };
}

describe("slash commands", () => {
  it("dispatches /status", async () => {
    const reg = buildRegistry(ctx() as any);
    const out = await reg.run("/status");
    expect(out.join("\n")).toMatch(/worker: ready/i);
  });
  it("/restart calls client", async () => {
    const c = ctx();
    await buildRegistry(c as any).run("/restart");
    expect(c.client.restart).toHaveBeenCalled();
  });
  it("/doctor lists checks", async () => {
    const out = await buildRegistry(ctx() as any).run("/doctor");
    expect(out.join("\n")).toMatch(/github-auth.*ok/i);
  });
  it("/help lists commands", async () => {
    const out = await buildRegistry(ctx() as any).run("/help");
    expect(out.join("\n")).toMatch(/\/status/);
  });
  it("unknown command", async () => {
    const out = await buildRegistry(ctx() as any).run("/nope");
    expect(out.join("\n")).toMatch(/unknown/i);
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/tui/slash/registry.ts`**

```ts
export interface SlashContext {
  client: {
    status(): Promise<import("../../shared/control-types.js").StatusResponse>;
    restart(): Promise<void>; stop(): Promise<void>; start(): Promise<void>;
    doctor(): Promise<import("../../shared/control-types.js").DoctorCheck[]>;
    requests(): Promise<import("../../shared/control-types.js").MetricSample[]>;
  };
  quit: () => void;
}
export interface SlashCommand {
  name: string;
  describe: string;
  run(args: string[], ctx: SlashContext): Promise<string[]>;
}
export class Registry {
  private cmds = new Map<string, SlashCommand>();
  constructor(private ctx: SlashContext) {}
  add(cmd: SlashCommand): this { this.cmds.set(cmd.name, cmd); return this; }
  list(): SlashCommand[] { return [...this.cmds.values()]; }
  async run(line: string): Promise<string[]> {
    const [name, ...args] = line.trim().split(/\s+/);
    const cmd = this.cmds.get(name);
    if (!cmd) return [`unknown command: ${name} (try /help)`];
    return cmd.run(args, this.ctx);
  }
}
```

- [ ] **Step 4: implement `src/tui/slash/commands.ts`**

```ts
import { Registry, type SlashContext } from "./registry.js";

export function buildRegistry(ctx: SlashContext): Registry {
  const reg = new Registry(ctx);
  reg.add({ name: "/status", describe: "show worker status + restart history", run: async (_a, c) => {
    const s = await c.client.status();
    const lines = [`worker: ${s.workerState}`];
    for (const r of s.restarts.slice(0, 5)) lines.push(`  ${r.reason} exit=${r.exitCode ?? "-"} ${r.stderrTail.slice(0, 60)}`);
    return lines;
  } });
  reg.add({ name: "/doctor", describe: "run health checks", run: async (_a, c) => (await c.client.doctor()).map((x) => `${x.ok ? "OK " : "FAIL"} ${x.name}: ${x.detail}`) });
  reg.add({ name: "/restart", describe: "restart the worker", run: async (_a, c) => { await c.client.restart(); return ["restart requested"]; } });
  reg.add({ name: "/stop", describe: "stop the worker", run: async (_a, c) => { await c.client.stop(); return ["worker stopped"]; } });
  reg.add({ name: "/start", describe: "start the worker", run: async (_a, c) => { await c.client.start(); return ["worker started"]; } });
  reg.add({ name: "/logs", describe: "recent restart events", run: async (_a, c) => {
    const s = await c.client.status();
    return s.restarts.length ? s.restarts.map((r) => `${new Date(r.ts).toISOString()} ${r.reason} ${r.stderrTail.slice(0, 80)}`) : ["no restart events"];
  } });
  reg.add({ name: "/quit", describe: "exit maestro", run: async (_a, c) => { c.quit(); return ["bye"]; } });
  reg.add({ name: "/help", describe: "list commands", run: async () => reg.list().map((c) => `${c.name.padEnd(14)} ${c.describe}`) });
  return reg;
}
```

- [ ] **Step 5: run → PASS**

- [ ] **Step 6: commit** — `git commit -am "feat: TUI slash command registry + base commands"`

---

## Task 17: Ink TUI app + REPL

**Files:** Create `src/tui/app.tsx`, `src/tui/repl.tsx`; Test `tests/tui/app.test.tsx`

> Use `ink-testing-library`. The app takes the `Registry` injected so tests don't need a live daemon.

- [ ] **Step 1: failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../../src/tui/app.js";
import { Registry } from "../../src/tui/slash/registry.js";

function reg() {
  const r = new Registry({ client: {} as any, quit: vi.fn() });
  r.add({ name: "/ping", describe: "ping", run: async () => ["pong"] });
  return r;
}

describe("App", () => {
  it("renders a prompt and runs a slash command on submit", async () => {
    const { stdin, lastFrame } = render(<App registry={reg()} title="maestro" />);
    expect(lastFrame()).toContain("maestro");
    stdin.write("/ping");
    stdin.write("\r"); // Enter
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame()).toContain("pong");
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/tui/repl.tsx`**

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export function Repl({ onSubmit }: { onSubmit: (line: string) => void }) {
  const [value, setValue] = useState("");
  useInput((input, key) => {
    if (key.return) { const line = value; setValue(""); if (line.trim()) onSubmit(line); return; }
    if (key.backspace || key.delete) { setValue((v) => v.slice(0, -1)); return; }
    if (input && !key.ctrl && !key.meta) setValue((v) => v + input);
  });
  return (
    <Box>
      <Text color="cyan">{"› "}</Text>
      <Text>{value}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: implement `src/tui/app.tsx`**

```tsx
import React, { useState } from "react";
import { Box, Text } from "ink";
import { Repl } from "./repl.js";
import type { Registry } from "./slash/registry.js";

export interface AppProps {
  registry: Registry;
  title: string;
  // optional natural-language handler (wired in M1c); default echoes a hint.
  onChat?: (text: string, print: (line: string) => void) => Promise<void>;
}

export function App({ registry, title, onChat }: AppProps) {
  const [lines, setLines] = useState<string[]>([`${title} — type /help, or talk to the assistant`]);
  const print = (l: string) => setLines((prev) => [...prev, l].slice(-200));

  async function handle(line: string) {
    print(`› ${line}`);
    if (line.startsWith("/")) {
      const out = await registry.run(line);
      out.forEach(print);
    } else if (onChat) {
      await onChat(line, print);
    } else {
      print("(assistant not available yet — use /help)");
    }
  }

  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
      <Repl onSubmit={handle} />
    </Box>
  );
}
```

- [ ] **Step 5: run → PASS**

- [ ] **Step 6: commit** — `git commit -am "feat: Ink TUI app + REPL input"`

---

## Task 18: CLI entry + device login flow

**Files:** Create `src/cli/auth.ts`, `src/cli/index.ts`; Test `tests/cli/auth.test.ts`

- [ ] **Step 1: failing test (auth)**

```ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeviceLogin } from "../../src/cli/auth.js";
import { readGhToken } from "../../src/shared/creds.js";
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("runDeviceLogin", () => {
  it("walks device flow and persists token", async () => {
    const d = mkdtempSync(join(tmpdir(), "m-"));
    const f = vi.fn()
      .mockResolvedValueOnce(json({ device_code: "dc", user_code: "AB-12", verification_uri: "https://github.com/login/device", interval: 0, expires_in: 900 }))
      .mockResolvedValueOnce(json({ access_token: "gho_z" }));
    const log = vi.fn();
    await runDeviceLogin(d, f as unknown as typeof fetch, log);
    expect(readGhToken(d)).toBe("gho_z");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("AB-12"));
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/cli/auth.ts`**

```ts
import { requestDeviceCode, pollForToken } from "../providers/copilot/auth.js";
import { writeGhToken } from "../shared/creds.js";

export async function runDeviceLogin(dir: string, fetchFn: typeof fetch = fetch, log: (m: string) => void = console.log): Promise<void> {
  const code = await requestDeviceCode(fetchFn);
  log(`\nOpen ${code.verification_uri} and enter code: ${code.user_code}\n`);
  const token = await pollForToken(code.device_code, code.interval * 1000, fetchFn);
  writeGhToken(token, dir);
  log("GitHub authorization complete.");
}
```

- [ ] **Step 4: run → PASS**

- [ ] **Step 5: implement `src/cli/index.ts` (glue — launches TUI by default)**

```ts
#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { App } from "../tui/app.js";
import { buildRegistry } from "../tui/slash/commands.js";
import { DaemonClient } from "../tui/daemon-client.js";
import { runDeviceLogin } from "./auth.js";
import { ensureDaemon, spawnSupervisor, probeSupervisor } from "../daemon/lifecycle.js";
import { readGhToken } from "../shared/creds.js";
import { dataDir } from "../shared/paths.js";
import { defaultConfig } from "../shared/config.js";

async function launchTui(): Promise<void> {
  const cfg = defaultConfig();
  if (!readGhToken(dataDir())) {
    console.log("No GitHub login found — starting device-code login.");
    await runDeviceLogin(dataDir());
  }
  await ensureDaemon({ spawn: spawnSupervisor, probe: () => probeSupervisor(), retries: 40, delayMs: 250 });
  const base = `http://${cfg.bindHost}:${cfg.supervisorPort}`;
  const client = new DaemonClient(base);
  let app: { unmount: () => void } | undefined;
  const registry = buildRegistry({ client, quit: () => app?.unmount() });
  app = render(React.createElement(App, { registry, title: "llm-maestro" }));
}

const program = new Command();
program.name("maestro").description("llm-maestro: interactive Copilot proxy").version("0.0.1");
program.command("login").description("GitHub device-code login").action(() => runDeviceLogin(dataDir()));
program.action(() => { void launchTui(); });
program.parseAsync(process.argv);
```

- [ ] **Step 6: commit** — `git commit -am "feat: CLI entry launches TUI; login command; daemon auto-spawn"`

---

## Task 19: M1a smoke test + checkpoint

**Files:** Create `tests/e2e/m1a-smoke.test.ts`

- [ ] **Step 1: write the smoke test (control plane end-to-end, fake worker via direct deps)**

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createControlApp } from "../../src/supervisor/api.js";
import { openDb, recordRestart } from "../../src/supervisor/db.js";
import { EventBus } from "../../src/supervisor/events.js";

describe("M1a control-plane e2e", () => {
  it("status, restart action, and SSE wiring", async () => {
    const db = openDb(":memory:");
    const bus = new EventBus();
    let state: "starting" | "ready" = "starting";
    const app = createControlApp({
      db, getState: () => state,
      restart: () => { state = "ready"; recordRestart(db, { ts: Date.now(), reason: "manual", exitCode: null, stderrTail: "", backoffMs: 0, markedUnhealthy: 0 }); bus.emit("state", { state }); },
      stop: () => {}, start: () => {}, doctor: async () => [{ name: "x", ok: true, detail: "ok" }],
      subscribe: (s) => bus.subscribe(s),
    });
    expect((await request(app).get("/api/status")).body.workerState).toBe("starting");
    await request(app).post("/api/restart");
    const after = await request(app).get("/api/status");
    expect(after.body.workerState).toBe("ready");
    expect(after.body.restarts).toHaveLength(1);
  });
});
```

- [ ] **Step 2: run full suite** — `npx vitest run` → all green.

- [ ] **Step 3: build** — `npm run build` → no TS errors; `dist/cli/index.js` exists.

- [ ] **Step 4: manual check (documented)**

```bash
node dist/cli/index.js login        # device-code in browser
node dist/cli/index.js              # launches TUI; /doctor, /status, /restart
# In another shell:
curl http://127.0.0.1:7891/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```
Expected: TUI shows worker `ready`; curl returns an OpenAI-shaped Copilot completion.

- [ ] **Step 5: commit** — `git commit -am "test: M1a smoke; checkpoint phase a"`

---

# Phase M1b — Anthropic inbound + tool-use translation

## Task 20: Anthropic inbound (request/response/stream incl tool-use)

**Files:** Create `src/core/anthropic-inbound.ts`; Test `tests/core/anthropic-inbound.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from "vitest";
import { anthropicRequestToCanonical, canonicalToAnthropicResponse, canonicalChunkToAnthropicSSE } from "../../src/core/anthropic-inbound.js";
import type { CanonicalResponse } from "../../src/core/canonical.js";

describe("anthropic inbound", () => {
  it("normalizes request incl tools + tool_result", () => {
    const c = anthropicRequestToCanonical({
      model: "claude-opus-4-8", max_tokens: 100, stream: true,
      system: "be brief",
      tools: [{ name: "now", description: "t", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "now", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "12:00" }] },
      ],
    });
    expect(c.model).toBe("claude-opus-4-8");
    expect(c.stream).toBe(true);
    expect(c.messages[0].role).toBe("system");
    expect(c.tools?.[0].name).toBe("now");
    expect(c.messages[3].content[0]).toEqual({ type: "tool_result", toolUseId: "tu1", content: "12:00" });
  });

  it("builds anthropic response with tool_use block", () => {
    const r: CanonicalResponse = {
      id: "r1", model: "claude-opus-4-8",
      content: [{ type: "text", text: "calling" }, { type: "tool_use", id: "tu1", name: "now", input: { x: 1 } }],
      finishReason: "tool_use", usage: { promptTokens: 5, completionTokens: 2 },
    };
    const out = canonicalToAnthropicResponse(r);
    expect(out.type).toBe("message");
    expect(out.stop_reason).toBe("tool_use");
    expect(out.content[1]).toEqual({ type: "tool_use", id: "tu1", name: "now", input: { x: 1 } });
    expect(out.usage.output_tokens).toBe(2);
  });

  it("emits anthropic SSE frames for a text delta and stop", () => {
    const frames = canonicalChunkToAnthropicSSE({ kind: "text", delta: "he", done: false }, { index: 0 });
    expect(frames).toContain("content_block_delta");
    expect(frames).toContain('"text":"he"');
    expect(canonicalChunkToAnthropicSSE({ kind: "done", done: true, finishReason: "stop" }, { index: 0 })).toContain("message_stop");
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/core/anthropic-inbound.ts`**

```ts
import type { CanonicalRequest, CanonicalResponse, CanonicalChunk, CanonicalMessage, ContentBlock } from "./canonical.js";
import { joinText } from "./canonical.js";

interface AnthropicBlock { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }
interface AnthropicMsg { role: "user" | "assistant"; content: string | AnthropicBlock[] }
interface AnthropicTool { name: string; description?: string; input_schema: Record<string, unknown> }
interface AnthropicRequest {
  model: string; max_tokens: number; stream?: boolean; temperature?: number;
  system?: string; tools?: AnthropicTool[]; messages: AnthropicMsg[];
}

function blocksToCanonical(content: string | AnthropicBlock[]): ContentBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const out: ContentBlock[] = [];
  for (const b of content) {
    if (b.type === "text" && b.text != null) out.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: b.id!, name: b.name!, input: b.input });
    else if (b.type === "tool_result") out.push({ type: "tool_result", toolUseId: b.tool_use_id!, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content) });
  }
  return out;
}

export function anthropicRequestToCanonical(req: AnthropicRequest): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  if (req.system) messages.push({ role: "system", content: [{ type: "text", text: req.system }] });
  for (const m of req.messages) {
    const content = blocksToCanonical(m.content);
    const isToolResult = content.some((b) => b.type === "tool_result");
    messages.push({ role: isToolResult ? "tool" : m.role, content });
  }
  return {
    model: req.model, stream: Boolean(req.stream), temperature: req.temperature, maxTokens: req.max_tokens,
    tools: req.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })),
    messages,
  };
}

export function canonicalToAnthropicResponse(r: CanonicalResponse) {
  const content = r.content.map((b) =>
    b.type === "text" ? { type: "text", text: b.text } :
    b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, input: b.input } :
    { type: "text", text: "" });
  const stop = r.finishReason === "tool_use" ? "tool_use" : r.finishReason === "length" ? "max_tokens" : "end_turn";
  return {
    id: r.id, type: "message" as const, role: "assistant" as const, model: r.model,
    content, stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: r.usage.promptTokens, output_tokens: r.usage.completionTokens },
  };
}

// Stateless per-chunk SSE. Caller emits message_start once before the first chunk (see worker server).
export function canonicalChunkToAnthropicSSE(chunk: CanonicalChunk, state: { index: number }): string {
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (chunk.done) {
    return frame("message_delta", { type: "message_delta", delta: { stop_reason: chunk.finishReason === "tool_use" ? "tool_use" : "end_turn" }, usage: { output_tokens: 0 } })
      + frame("message_stop", { type: "message_stop" });
  }
  if (chunk.kind === "text") {
    return frame("content_block_delta", { type: "content_block_delta", index: state.index, delta: { type: "text_delta", text: chunk.delta } });
  }
  if (chunk.kind === "tool_use_start") {
    return frame("content_block_start", { type: "content_block_start", index: chunk.index, content_block: { type: "tool_use", id: chunk.id, name: chunk.name, input: {} } });
  }
  // tool_use_delta
  return frame("content_block_delta", { type: "content_block_delta", index: chunk.index, delta: { type: "input_json_delta", partial_json: chunk.argsDelta } });
}
```

- [ ] **Step 4: run → PASS**

- [ ] **Step 5: commit** — `git commit -am "feat: Anthropic inbound translation incl tool-use"`

---

## Task 21: worker Anthropic endpoint

**Files:** Create `src/worker/anthropic-server.ts`; Modify `src/worker/server.ts` (mount it); Test `tests/worker/anthropic-server.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

const provider: ProviderAdapter = {
  name: "copilot",
  complete: async () => ({ id: "c1", model: "m", content: [{ type: "text", text: "hello" }], finishReason: "stop", usage: { promptTokens: 2, completionTokens: 1 } }),
  async *stream() { yield { kind: "text", delta: "he", done: false } as const; yield { kind: "done", done: true, finishReason: "stop" } as const; },
};
const app = () => createWorkerApp(new Router([provider], { "*": "gpt-4o" }), () => {});

describe("worker Anthropic endpoint", () => {
  it("non-stream message", async () => {
    const res = await request(app()).post("/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("message");
    expect(res.body.content[0].text).toBe("hello");
  });
  it("SSE message stream begins with message_start", async () => {
    const res = await request(app()).post("/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.text).toContain("message_start");
    expect(res.text).toContain('"text":"he"');
    expect(res.text).toContain("message_stop");
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/worker/anthropic-server.ts`**

```ts
import { type Express } from "express";
import type { Router } from "./router.js";
import type { MetricSink } from "./server.js";
import { anthropicRequestToCanonical, canonicalToAnthropicResponse, canonicalChunkToAnthropicSSE } from "../core/anthropic-inbound.js";

export function mountAnthropic(app: Express, router: Router, onMetric: MetricSink): void {
  app.post("/v1/messages", async (req, res) => {
    const start = Date.now();
    const canon = anthropicRequestToCanonical(req.body);
    canon.model = router.resolveModel(canon.model);
    const provider = router.pick(canon.model);
    const metric = (status: number) => onMetric({ endpoint: "/v1/messages", model: canon.model, status, latencyMs: Date.now() - start });
    try {
      if (canon.stream) {
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        const id = `msg_${canon.model}`;
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model: canon.model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
        const state = { index: 0 };
        for await (const chunk of provider.stream(canon)) res.write(canonicalChunkToAnthropicSSE(chunk, state));
        res.end();
        metric(200);
      } else {
        res.json(canonicalToAnthropicResponse(await provider.complete(canon)));
        metric(200);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.status(502).json({ type: "error", error: { type: "api_error", message } });
      else res.end();
      metric(502);
    }
  });
}
```

- [ ] **Step 4: modify `src/worker/server.ts` — mount Anthropic**

Add the import and call inside `createWorkerApp`, after `mountOpenAI`:

```ts
import { mountAnthropic } from "./anthropic-server.js";
// ...inside createWorkerApp, after mountOpenAI(app, router, onMetric):
  mountAnthropic(app, router, onMetric);
```

- [ ] **Step 5: run → PASS** (re-run `tests/worker/openai-server.test.ts` too — still green)

- [ ] **Step 6: commit** — `git commit -am "feat: worker Anthropic /v1/messages endpoint (stream + non-stream)"`

---

# Phase M1c — Conversational assistant (claude-agent-sdk, dogfooded)

## Task 22: assistant tools (in-process)

**Files:** Create `src/tui/assistant/tools.ts`; Test `tests/tui/assistant-tools.test.ts`

> **SDK surface note:** `@anthropic-ai/claude-agent-sdk` exposes `tool(name, description, zodSchema, handler)` and `createSdkMcpServer({ name, tools })`. Before implementing, the worker MUST verify the installed package's exports (`node -e "console.log(Object.keys(require('@anthropic-ai/claude-agent-sdk')))"`) and adjust names if they differ. To keep this task testable independent of the SDK, we define the **action handlers** as plain functions here and wrap them with the SDK in Task 23.

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { buildActions } from "../../src/tui/assistant/tools.js";

function client() {
  return {
    status: vi.fn(async () => ({ workerState: "ready", restarts: [] })),
    restart: vi.fn(async () => {}),
    doctor: vi.fn(async () => [{ name: "github-auth", ok: true, detail: "ok" }]),
    requests: vi.fn(async () => []),
  };
}

describe("assistant actions", () => {
  it("get_status returns worker state text", async () => {
    const a = buildActions(client() as any);
    expect(await a.get_status({})).toMatch(/ready/);
  });
  it("restart_worker calls client and confirms", async () => {
    const c = client();
    const a = buildActions(c as any);
    expect(await a.restart_worker({})).toMatch(/restart/i);
    expect(c.restart).toHaveBeenCalled();
  });
  it("run_doctor summarizes checks", async () => {
    const a = buildActions(client() as any);
    expect(await a.run_doctor({})).toMatch(/github-auth/);
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/tui/assistant/tools.ts`**

```ts
import type { DaemonClient } from "../daemon-client.js";

// Plain action handlers — wrapped as SDK tools in runtime.ts.
// Each takes a parsed-args object and returns a short text result for the model.
export function buildActions(client: Pick<DaemonClient, "status" | "restart" | "doctor" | "requests">) {
  return {
    async get_status(_args: Record<string, never>): Promise<string> {
      const s = await client.status();
      return `worker is ${s.workerState}; ${s.restarts.length} restart event(s) recorded`;
    },
    async restart_worker(_args: Record<string, never>): Promise<string> {
      await client.restart();
      return "restart requested; worker is restarting";
    },
    async run_doctor(_args: Record<string, never>): Promise<string> {
      const checks = await client.doctor();
      return checks.map((c) => `${c.ok ? "OK" : "FAIL"} ${c.name}: ${c.detail}`).join("; ");
    },
    async recent_requests(_args: Record<string, never>): Promise<string> {
      const reqs = await client.requests();
      if (!reqs.length) return "no requests logged yet";
      return reqs.slice(0, 10).map((r) => `${r.endpoint} ${r.model} ${r.status} ${r.latencyMs}ms`).join("; ");
    },
  };
}
export type AssistantActions = ReturnType<typeof buildActions>;
```

- [ ] **Step 4: run → PASS**

- [ ] **Step 5: commit** — `git commit -am "feat: assistant action handlers over the daemon client"`

---

## Task 23: assistant runtime (claude-agent-sdk, dogfood)

**Files:** Create `src/tui/assistant/runtime.ts` (glue; verified by manual check in Task 27); Test none (SDK integration — covered by manual smoke).

> This is integration glue against `@anthropic-ai/claude-agent-sdk`. The worker MUST run the export-check from Task 22 first and reconcile names. The structure below matches the SDK's documented `query()` + `createSdkMcpServer` + `tool()` surface; if an option name differs in the installed version, adjust and note it as DONE_WITH_CONCERNS.

- [ ] **Step 1: implement `src/tui/assistant/runtime.ts`**

```ts
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { buildActions, type AssistantActions } from "./tools.js";
import type { DaemonClient } from "../daemon-client.js";

export interface AssistantConfig {
  client: DaemonClient;
  workerBaseUrl: string;   // e.g. http://127.0.0.1:7891  (Anthropic inbound)
  apiKey: string;          // maestro server key (worker ignores/accepts in M1)
  model: string;           // e.g. claude-opus-4-8 (router remaps to a Copilot model)
}

const empty = z.object({});

function sdkTools(actions: AssistantActions) {
  return [
    tool("get_status", "Get the proxy worker status and restart history", empty, async () => ({ content: [{ type: "text", text: await actions.get_status({}) }] })),
    tool("restart_worker", "Restart the proxy worker", empty, async () => ({ content: [{ type: "text", text: await actions.restart_worker({}) }] })),
    tool("run_doctor", "Run maestro health checks", empty, async () => ({ content: [{ type: "text", text: await actions.run_doctor({}) }] })),
    tool("recent_requests", "List recent proxied requests", empty, async () => ({ content: [{ type: "text", text: await actions.recent_requests({}) }] })),
  ];
}

// Runs one assistant turn, streaming assistant text to `print`.
export async function runAssistantTurn(cfg: AssistantConfig, prompt: string, print: (line: string) => void): Promise<void> {
  // Dogfood: route the agent SDK through maestro's own Anthropic endpoint -> Copilot.
  process.env.ANTHROPIC_BASE_URL = cfg.workerBaseUrl;
  process.env.ANTHROPIC_API_KEY = cfg.apiKey;

  const actions = buildActions(cfg.client);
  const mcp = createSdkMcpServer({ name: "maestro", tools: sdkTools(actions) });

  const response = query({
    prompt,
    options: {
      model: cfg.model,
      mcpServers: { maestro: mcp },
      systemPrompt: "You are maestro's built-in assistant. Use the maestro tools to inspect and control the local proxy. Be concise.",
      permissionMode: "bypassPermissions",
    },
  });

  for await (const message of response) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") print(block.text);
      }
    }
  }
}
```

- [ ] **Step 2: build** — `npm run build` (compiles against the installed SDK types; fix any export/option name drift surfaced here).

- [ ] **Step 3: commit** — `git commit -am "feat: assistant runtime via claude-agent-sdk, dogfooding maestro endpoint"`

---

## Task 24: wire assistant into the TUI

**Files:** Modify `src/cli/index.ts` (pass `onChat`); Test `tests/cli/onchat.test.ts`

> We unit-test the `onChat` wiring via a small injectable factory so we don't need the live SDK.

- [ ] **Step 1: failing test (factory)**

Create `src/tui/assistant/on-chat.ts` and test it:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeOnChat } from "../../src/tui/assistant/on-chat.js";

describe("makeOnChat", () => {
  it("forwards text + print to the turn runner", async () => {
    const runner = vi.fn(async (_cfg, prompt: string, print: (l: string) => void) => { print(`echo:${prompt}`); });
    const printed: string[] = [];
    const onChat = makeOnChat({ client: {} as any, workerBaseUrl: "http://x", apiKey: "k", model: "m" }, runner as any);
    await onChat("hello", (l) => printed.push(l));
    expect(printed).toContain("echo:hello");
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/tui/assistant/on-chat.ts`**

```ts
import type { AssistantConfig } from "./runtime.js";

type TurnRunner = (cfg: AssistantConfig, prompt: string, print: (l: string) => void) => Promise<void>;

export function makeOnChat(cfg: AssistantConfig, runner: TurnRunner) {
  return async (text: string, print: (line: string) => void): Promise<void> => {
    try {
      await runner(cfg, text, print);
    } catch (err) {
      print(`assistant error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
```

- [ ] **Step 4: run → PASS**

- [ ] **Step 5: modify `src/cli/index.ts` — build and pass `onChat`**

In `launchTui`, after constructing `client` and before `render`, add:

```ts
import { runAssistantTurn } from "../tui/assistant/runtime.js";
import { makeOnChat } from "../tui/assistant/on-chat.js";
// ...
  const onChat = makeOnChat(
    { client, workerBaseUrl: `http://${cfg.bindHost}:${cfg.workerPort}`, apiKey: "maestro-local", model: "claude-opus-4-8" },
    runAssistantTurn,
  );
  app = render(React.createElement(App, { registry, title: "llm-maestro", onChat }));
```

- [ ] **Step 6: build** — `npm run build` → no errors.

- [ ] **Step 7: commit** — `git commit -am "feat: wire claude-agent-sdk assistant into the TUI REPL"`

---

# Phase M1d — Setup, metrics, logs

## Task 25: client setup generators + slash commands

**Files:** Create `src/tui/setup/clients.ts`; Modify `src/tui/slash/commands.ts`; Test `tests/tui/setup.test.ts`

- [ ] **Step 1: failing test**

```ts
import { describe, it, expect } from "vitest";
import { claudeCodeConfig, codexConfig } from "../../src/tui/setup/clients.js";

describe("client setup", () => {
  it("claude code points ANTHROPIC_BASE_URL at the worker", () => {
    const c = claudeCodeConfig({ host: "127.0.0.1", port: 7891, apiKey: "k" });
    expect(c.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:7891");
    expect(c.env.ANTHROPIC_API_KEY).toBe("k");
    expect(c.instructions).toMatch(/ANTHROPIC_BASE_URL/);
  });
  it("codex points at the OpenAI endpoint", () => {
    const c = codexConfig({ host: "127.0.0.1", port: 7891, apiKey: "k" });
    expect(c.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:7891/v1");
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/tui/setup/clients.ts`**

```ts
export interface Endpoint { host: string; port: number; apiKey: string }
export interface ClientSetup { env: Record<string, string>; instructions: string }

export function claudeCodeConfig(e: Endpoint): ClientSetup {
  const base = `http://${e.host}:${e.port}`;
  return {
    env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: e.apiKey },
    instructions: `Set these env vars for Claude Code:\n  ANTHROPIC_BASE_URL=${base}\n  ANTHROPIC_API_KEY=${e.apiKey}`,
  };
}
export function codexConfig(e: Endpoint): ClientSetup {
  const base = `http://${e.host}:${e.port}/v1`;
  return {
    env: { OPENAI_BASE_URL: base, OPENAI_API_KEY: e.apiKey },
    instructions: `Set these env vars for Codex / OpenAI clients:\n  OPENAI_BASE_URL=${base}\n  OPENAI_API_KEY=${e.apiKey}`,
  };
}
```

- [ ] **Step 4: modify `src/tui/slash/commands.ts` — add setup commands**

Add inside `buildRegistry` (the worker host/port/key come from a config passed into `buildRegistry`; extend its signature):

```ts
// Extend SlashContext consumption: buildRegistry(ctx, endpoint) where endpoint = {host,port,apiKey}.
// (Update the call site in commands' factory + cli/index.ts accordingly.)
  reg.add({ name: "/setup-claude", describe: "print Claude Code config", run: async () => claudeCodeConfig(endpoint).instructions.split("\n") });
  reg.add({ name: "/setup-codex", describe: "print Codex/OpenAI config", run: async () => codexConfig(endpoint).instructions.split("\n") });
  reg.add({ name: "/setup-status", describe: "show configured endpoints", run: async () => [`OpenAI: http://${endpoint.host}:${endpoint.port}/v1`, `Anthropic: http://${endpoint.host}:${endpoint.port}`] });
```

Update `buildRegistry` signature to `buildRegistry(ctx: SlashContext, endpoint: Endpoint)` and add `import { claudeCodeConfig, codexConfig, type Endpoint } from "../setup/clients.js";`. Update the test in Task 16 (`tests/tui/slash.test.ts`) to pass a dummy endpoint `{ host: "127.0.0.1", port: 7891, apiKey: "k" }` as the second arg, and update `cli/index.ts` call site: `buildRegistry({ client, quit }, { host: cfg.bindHost, port: cfg.workerPort, apiKey: "maestro-local" })`.

- [ ] **Step 5: run → PASS** (Task 16 test updated)

- [ ] **Step 6: commit** — `git commit -am "feat: client setup generators + /setup-claude /setup-codex /setup-status"`

---

## Task 26: metrics ring buffer + SSE + /metrics

**Files:** Modify `src/supervisor/index.ts` (push metric events — already done in Task 13); Create `src/tui/panels/metrics.tsx`; Test `tests/tui/metrics-agg.test.ts`

> The panel subscribes to `/api/events` (`metric` events) and aggregates client-side. We unit-test the pure aggregator; the React panel is thin.

- [ ] **Step 1: failing test (aggregator)**

```ts
import { describe, it, expect } from "vitest";
import { aggregate } from "../../src/tui/panels/metrics-agg.js";
import type { MetricSample } from "../../src/shared/control-types.js";

const s = (model: string, status: number, ms: number): MetricSample => ({ ts: 0, endpoint: "/v1/chat/completions", model, status, latencyMs: ms });

describe("metrics aggregate", () => {
  it("counts, errors, and avg latency per model", () => {
    const a = aggregate([s("gpt-4o", 200, 10), s("gpt-4o", 200, 30), s("gpt-4o", 502, 5)]);
    expect(a.total).toBe(3);
    expect(a.errors).toBe(1);
    const row = a.byModel.find((r) => r.model === "gpt-4o")!;
    expect(row.count).toBe(3);
    expect(row.avgMs).toBe(15);
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement `src/tui/panels/metrics-agg.ts`**

```ts
import type { MetricSample } from "../../shared/control-types.js";

export interface ModelRow { model: string; count: number; avgMs: number }
export interface Aggregate { total: number; errors: number; byModel: ModelRow[] }

export function aggregate(samples: MetricSample[]): Aggregate {
  const map = new Map<string, { count: number; sum: number }>();
  let errors = 0;
  for (const s of samples) {
    if (s.status >= 400) errors++;
    const m = map.get(s.model) ?? { count: 0, sum: 0 };
    m.count++; m.sum += s.latencyMs;
    map.set(s.model, m);
  }
  return {
    total: samples.length,
    errors,
    byModel: [...map.entries()].map(([model, v]) => ({ model, count: v.count, avgMs: Math.round(v.sum / v.count) })),
  };
}
```

- [ ] **Step 4: implement `src/tui/panels/metrics.tsx`**

```tsx
import React from "react";
import { Box, Text } from "ink";
import { aggregate } from "./metrics-agg.js";
import type { MetricSample } from "../../shared/control-types.js";

export function MetricsPanel({ samples }: { samples: MetricSample[] }) {
  const a = aggregate(samples);
  return (
    <Box flexDirection="column">
      <Text>requests: {a.total}  errors: {a.errors}</Text>
      {a.byModel.map((r) => (
        <Text key={r.model}>  {r.model.padEnd(20)} n={r.count} avg={r.avgMs}ms</Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 5: run → PASS**

- [ ] **Step 6: add `/metrics` slash command** — in `src/tui/slash/commands.ts`, add a command that fetches `/api/requests` and prints the aggregate:

```ts
import { aggregate } from "../panels/metrics-agg.js";
  reg.add({ name: "/metrics", describe: "show request metrics", run: async (_a, c) => {
    const a = aggregate(await c.client.requests());
    return [`requests: ${a.total}  errors: ${a.errors}`, ...a.byModel.map((r) => `  ${r.model} n=${r.count} avg=${r.avgMs}ms`)];
  } });
```

- [ ] **Step 7: run Task 16 test → PASS** (new command doesn't break `/help`)

- [ ] **Step 8: commit** — `git commit -am "feat: metrics aggregation + /metrics command + Ink panel"`

---

## Task 27: M1 full smoke + README + final build

**Files:** Create `tests/e2e/m1-smoke.test.ts`, `README.md`; Modify `package.json` if needed.

- [ ] **Step 1: write the full proxy smoke (worker app with a fake provider, both protocols)**

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

const provider: ProviderAdapter = {
  name: "copilot",
  complete: async (req) => ({ id: "c1", model: req.model, content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }),
  async *stream() { yield { kind: "text", delta: "ok", done: false } as const; yield { kind: "done", done: true, finishReason: "stop" } as const; },
};
const app = () => createWorkerApp(new Router([provider], { "claude-opus-4-8": "gpt-4o", "*": "gpt-4o" }), () => {});

describe("M1 proxy smoke", () => {
  it("OpenAI endpoint", async () => {
    const r = await request(app()).post("/v1/chat/completions").send({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(r.body.choices[0].message.content).toBe("ok");
  });
  it("Anthropic endpoint remaps model", async () => {
    const r = await request(app()).post("/v1/messages").send({ model: "claude-opus-4-8", max_tokens: 50, messages: [{ role: "user", content: "hi" }] });
    expect(r.body.content[0].text).toBe("ok");
    expect(r.body.model).toBe("gpt-4o"); // remapped before reaching the provider
  });
});
```

- [ ] **Step 2: run full suite** — `npx vitest run` → all green.

- [ ] **Step 3: build** — `npm run build` → no TS errors.

- [ ] **Step 4: manual end-to-end (documented)**

```bash
node dist/cli/index.js            # login if needed, TUI launches, daemon auto-starts
# In the TUI:
#   /doctor            -> github-auth OK, worker ready
#   /setup-claude      -> prints ANTHROPIC_BASE_URL + key
#   how is the proxy?  -> assistant answers via get_status (dogfooded through Copilot)
#   /metrics           -> shows request counts
# External client:
curl http://127.0.0.1:7891/v1/messages -H 'content-type: application/json' \
  -d '{"model":"claude-opus-4-8","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
```
Expected: Anthropic-shaped response from Copilot; assistant turn works (validates the dogfood loop end-to-end).

- [ ] **Step 5: create `README.md`**

```markdown
# llm-maestro

Interactive terminal app that turns your GitHub Copilot subscription into local
OpenAI- and Anthropic-compatible endpoints, with a self-healing daemon and a
built-in assistant.

> **Disclaimer:** The GitHub Copilot integration uses community-documented,
> unofficial endpoints, for use with your own Copilot subscription only. It may
> break if GitHub changes these endpoints.

## Quick start

\`\`\`bash
npx llm-maestro      # device-code login, then the TUI launches
\`\`\`

In the TUI: `/help`, `/doctor`, `/setup-claude`, `/setup-codex`, `/metrics`, or
just talk to the assistant in natural language.

Point clients at:
- OpenAI: \`http://127.0.0.1:7891/v1\`
- Anthropic: \`http://127.0.0.1:7891\`

## Architecture (M1)

- **TUI** (Ink) — the `maestro` process: REPL + slash commands + claude-agent-sdk
  assistant (which dogfoods maestro's own Anthropic endpoint).
- **Supervisor** (:7890) — control API + SQLite + self-healing worker supervision.
- **Worker** (:7891) — OpenAI \`/v1/chat/completions\` + Anthropic \`/v1/messages\`
  → Copilot, with tool-use translation both ways.

## Development

\`\`\`bash
npm install && npm test && npm run build
\`\`\`
```

- [ ] **Step 6: commit** — `git commit -am "test: M1 proxy smoke; docs: README"`

---

## Self-Review

**Spec coverage (M1a–d):**
- npm CLI launches interactive TUI → Tasks 17, 18. ✓
- device-code login on first run → Tasks 4, 18. ✓
- auto-launch + self-healing daemon (backoff + circuit breaker) → Tasks 11, 13, 14, 18. ✓
- OpenAI inbound (stream + non-stream + tools) → Tasks 3, 8. ✓
- Anthropic inbound + tool-use translation (stream + non-stream) → Tasks 20, 21. ✓
- model remap (claude-* → Copilot) → Tasks 2, 7; verified end-to-end Task 27. ✓
- slash commands (/status /doctor /start /stop /restart /logs /help /quit /setup-* /metrics) → Tasks 16, 25, 26. ✓
- claude-agent-sdk assistant dogfooding maestro → Tasks 22, 23, 24; loop validated Task 27. ✓
- metrics in TUI (no web) → Tasks 26; SQLite-backed → Tasks 10, 13. ✓
- error/restart history in TUI → Tasks 12 (/api/status), 16 (/logs). ✓
- bind 127.0.0.1; safe-header-only logging (M1 logs metadata only, never body) → Task 2 config; request_log schema (Task 10) stores no body. ✓

**Deferred (out of M1, per spec §8):** multi-provider/fallback/fuzzy matching, provider management UI, credential encryption, config hot-reload, deep metrics (percentiles, expandable request detail). These are M2/M3.

**Type consistency:** `CanonicalRequest/Response/Chunk/ContentBlock` (Task 3) consumed unchanged in Tasks 6, 8, 20, 21. `WorkerToSupervisor` (Task 2) produced in Task 9, consumed in Tasks 11, 13. `WorkerState`/`RestartRow`/`MetricSample`/`DoctorCheck` (Task 2 control-types) used consistently in Tasks 10–13, 15, 16, 26. `RestartController.onCrash()` → `{backoffMs, markedUnhealthy, crashesInWindow}` consumed in Tasks 11, 13. `DaemonClient` methods (Task 15) consumed in Tasks 16, 22. `AssistantConfig` (Task 23) consumed in Task 24. `Endpoint` (Task 25) consumed in Tasks 25, and the updated `buildRegistry` signature is reflected in Task 16's test + the CLI call site (Task 25 step 4). ✓

**Known integration risk (flagged, not a placeholder):** Task 23 wires the real `@anthropic-ai/claude-agent-sdk`; its exact export/option names must be verified against the installed version (export-check in Task 22's note + build steps in Tasks 23/24). The dogfood loop is validated by Task 27's manual step. The `/v1/messages` subset implemented in Task 21 is intentionally minimal; if the SDK requires additional frames (e.g. `content_block_stop`, ping events), add them in Task 21's server and extend `tests/worker/anthropic-server.test.ts` — note this in the implementer report.

**Placeholder scan:** No TBD/TODO; every code step has complete code. Glue entries (`worker/index.ts`, `supervisor/index.ts`, `cli/index.ts`, `assistant/runtime.ts`) are explicitly marked as exercised by smoke/manual steps, with real code provided.
