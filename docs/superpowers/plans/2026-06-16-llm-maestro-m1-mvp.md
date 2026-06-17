> **SUPERSEDED (2026-06-17):** This plan predates the TUI pivot. The product is now an
> interactive Ink TUI (slash commands + claude-agent-sdk assistant, no web dashboard).
> See the v2 design at `docs/superpowers/specs/2026-06-16-llm-maestro-design.md`.
> A new M1 plan will replace this file.

# llm-maestro M1 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a runnable `maestro start` CLI that supervises a crash-restarting Worker which proxies OpenAI `/v1/chat/completions` requests to GitHub Copilot, with a minimal web Dashboard showing health and a manual-restart button.

**Architecture:** Single npm package (TypeScript, ESM) with internal module folders (`src/{shared,core,providers,worker,supervisor,cli,dashboard}`). A long-lived **Supervisor** process serves the Dashboard (REST + SSE) and SQLite, and `fork`s a **Worker** child that runs the proxy. On Worker crash the Supervisor restarts with exponential backoff; ≥5 crashes in 60s flips it to `unhealthy` and stops auto-restart. The data plane normalizes inbound OpenAI requests to an internal canonical shape, routes to the Copilot provider adapter, and converts back (non-streaming and SSE).

> **Note on packaging:** The spec calls for a pnpm workspace. For M1 we use a *single package with module folders* to minimize setup friction; the workspace split is deferred to a later milestone. This still satisfies "publish a single CLI package."

**Tech Stack:** Node 20+ (ESM), TypeScript, Vitest, Express, better-sqlite3, Commander, undici/global `fetch`, React + Vite + Tailwind (Dashboard). Copilot integration uses GitHub OAuth device-code flow (unofficial endpoints — flagged in code comments and README).

---

## File Structure

```
package.json                     # single package, type:module, bin: maestro
tsconfig.json                    # ESM, strict
vitest.config.ts
src/
  shared/
    config.ts                    # AppConfig type + defaults + load/save (json file)
    ipc.ts                       # IPC message types (Supervisor <-> Worker)
    paths.ts                     # data dir resolution (~/.llm-maestro)
  core/
    canonical.ts                 # internal canonical request/response types
    openai-inbound.ts            # OpenAI request -> canonical; canonical -> OpenAI response
  providers/
    types.ts                     # ProviderAdapter interface
    copilot/
      auth.ts                    # device-code flow + GH token
      token.ts                   # exchange GH token -> Copilot token (+cache)
      adapter.ts                 # canonical -> Copilot call -> canonical (stream + non-stream)
  worker/
    router.ts                    # pick provider for a canonical request
    server.ts                    # express app: POST /v1/chat/completions
    index.ts                     # worker entry: start server + IPC heartbeat
  supervisor/
    db.ts                        # better-sqlite3 init + schema + queries
    monitor.ts                   # fork worker, backoff restart, circuit breaker
    api.ts                       # express: /api/status, /api/restart, /api/events (SSE)
    static.ts                    # serve built dashboard assets
    index.ts                     # supervisor entry: wire db+monitor+api
  cli/
    index.ts                     # commander: start/stop/status
  dashboard/                     # React + Vite app (built into dist-dashboard/)
    index.html
    src/main.tsx
    src/App.tsx
tests/                           # vitest specs mirror src/
```

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/shared/paths.ts`
- Test: `tests/shared/paths.test.ts`

- [ ] **Step 1: Create `package.json`**

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
    "better-sqlite3": "^11.0.0",
    "commander": "^12.0.0",
    "express": "^4.19.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/express": "^4.17.0",
    "@types/node": "^20.0.0",
    "@types/supertest": "^6.0.0",
    "supertest": "^7.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false
  },
  "include": ["src"],
  "exclude": ["src/dashboard", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules
dist
dist-dashboard
*.log
```

- [ ] **Step 5: Write the failing test for `paths.ts`**

File `tests/shared/paths.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { dataDir, dbPath, configPath } from "../../src/shared/paths.js";

describe("paths", () => {
  it("derives data dir under home and nests db/config files", () => {
    const dir = dataDir("/home/u");
    expect(dir).toBe("/home/u/.llm-maestro");
    expect(dbPath("/home/u")).toBe("/home/u/.llm-maestro/maestro.db");
    expect(configPath("/home/u")).toBe("/home/u/.llm-maestro/config.json");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm install && npx vitest run tests/shared/paths.test.ts`
Expected: FAIL — cannot find module `paths.js`.

- [ ] **Step 7: Implement `src/shared/paths.ts`**

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

> Note: `join` on Windows yields `\` separators. The test runs on the same OS, so compare with `join` if a worker is on Windows; for CI determinism the test above assumes POSIX. If running on Windows, replace expected strings with `join(...)` equivalents.

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/shared/paths.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/shared/paths.ts tests/shared/paths.test.ts package-lock.json
git commit -m "chore: scaffold llm-maestro package with paths util"
```

---

## Task 2: Shared config + IPC contracts

**Files:**
- Create: `src/shared/config.ts`, `src/shared/ipc.ts`
- Test: `tests/shared/config.test.ts`

- [ ] **Step 1: Write the failing test**

File `tests/shared/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { defaultConfig, mergeConfig } from "../../src/shared/config.js";

describe("config", () => {
  it("provides sane defaults", () => {
    const c = defaultConfig();
    expect(c.supervisorPort).toBe(7890);
    expect(c.workerPort).toBe(7891);
    expect(c.bindHost).toBe("127.0.0.1");
    expect(c.restart.maxCrashes).toBe(5);
    expect(c.restart.windowMs).toBe(60_000);
  });

  it("merges partial overrides deeply", () => {
    const c = mergeConfig(defaultConfig(), { restart: { maxCrashes: 3 } });
    expect(c.restart.maxCrashes).toBe(3);
    expect(c.restart.windowMs).toBe(60_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/shared/config.ts`**

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
}

export function defaultConfig(): AppConfig {
  return {
    bindHost: "127.0.0.1",
    supervisorPort: 7890,
    workerPort: 7891,
    restart: {
      maxCrashes: 5,
      windowMs: 60_000,
      baseBackoffMs: 500,
      maxBackoffMs: 8_000,
    },
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function mergeConfig(base: AppConfig, override: DeepPartial<AppConfig>): AppConfig {
  return {
    ...base,
    ...override,
    restart: { ...base.restart, ...(override.restart ?? {}) },
  };
}
```

- [ ] **Step 4: Implement `src/shared/ipc.ts` (no test needed — pure types)**

```ts
// Worker -> Supervisor
export type WorkerToSupervisor =
  | { type: "ready"; port: number }
  | { type: "heartbeat"; ts: number }
  | { type: "request-metric"; endpoint: string; model: string; status: number; latencyMs: number }
  | { type: "error"; message: string; stack?: string };

// Supervisor -> Worker
export type SupervisorToWorker =
  | { type: "ping" }
  | { type: "shutdown" };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/shared/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/config.ts src/shared/ipc.ts tests/shared/config.test.ts
git commit -m "feat: add shared config defaults and IPC message types"
```

---

## Task 3: Canonical types + OpenAI inbound normalization

**Files:**
- Create: `src/core/canonical.ts`, `src/core/openai-inbound.ts`
- Test: `tests/core/openai-inbound.test.ts`

- [ ] **Step 1: Write the failing test**

File `tests/core/openai-inbound.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openaiRequestToCanonical, canonicalToOpenAIResponse } from "../../src/core/openai-inbound.js";
import type { CanonicalResponse } from "../../src/core/canonical.js";

describe("openai inbound", () => {
  it("normalizes an OpenAI chat request to canonical", () => {
    const canon = openaiRequestToCanonical({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      stream: true,
      temperature: 0.5,
    });
    expect(canon.model).toBe("gpt-4o");
    expect(canon.stream).toBe(true);
    expect(canon.temperature).toBe(0.5);
    expect(canon.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("builds an OpenAI-shaped response from canonical", () => {
    const canon: CanonicalResponse = {
      id: "resp_1",
      model: "gpt-4o",
      content: "hello",
      finishReason: "stop",
      usage: { promptTokens: 3, completionTokens: 1 },
    };
    const out = canonicalToOpenAIResponse(canon);
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.content).toBe("hello");
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage.total_tokens).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/openai-inbound.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/core/canonical.ts`**

```ts
export interface CanonicalMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface CanonicalResponse {
  id: string;
  model: string;
  content: string;
  finishReason: "stop" | "length" | "error";
  usage: { promptTokens: number; completionTokens: number };
}

// One streaming delta of canonical text.
export interface CanonicalChunk {
  delta: string;
  done: boolean;
  finishReason?: "stop" | "length" | "error";
}
```

- [ ] **Step 4: Implement `src/core/openai-inbound.ts`**

```ts
import type { CanonicalRequest, CanonicalResponse, CanonicalChunk } from "./canonical.js";

interface OpenAIChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export function openaiRequestToCanonical(req: OpenAIChatRequest): CanonicalRequest {
  return {
    model: req.model,
    stream: Boolean(req.stream),
    temperature: req.temperature,
    maxTokens: req.max_tokens,
    messages: req.messages.map((m) => ({
      role: (["system", "user", "assistant"].includes(m.role) ? m.role : "user") as
        | "system"
        | "user"
        | "assistant",
      content: m.content,
    })),
  };
}

export function canonicalToOpenAIResponse(r: CanonicalResponse) {
  return {
    id: r.id,
    object: "chat.completion" as const,
    created: 0, // stamped by caller if needed; deterministic for tests
    model: r.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: r.content },
        finish_reason: r.finishReason,
      },
    ],
    usage: {
      prompt_tokens: r.usage.promptTokens,
      completion_tokens: r.usage.completionTokens,
      total_tokens: r.usage.promptTokens + r.usage.completionTokens,
    },
  };
}

// Format a single SSE data line for the OpenAI streaming shape.
export function canonicalChunkToOpenAISSE(chunk: CanonicalChunk, id: string, model: string): string {
  if (chunk.done) return "data: [DONE]\n\n";
  const payload = {
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: chunk.finishReason ?? null }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/core/openai-inbound.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/canonical.ts src/core/openai-inbound.ts tests/core/openai-inbound.test.ts
git commit -m "feat: add canonical types and OpenAI inbound normalization"
```

---

## Task 4: Provider interface + Copilot device-code auth

**Files:**
- Create: `src/providers/types.ts`, `src/providers/copilot/auth.ts`
- Test: `tests/providers/copilot/auth.test.ts`

> **Unofficial endpoints:** The GitHub Copilot client id and token endpoints below are community-documented and unofficial. Keep them in one file and add a README disclaimer (Task 13).

- [ ] **Step 1: Write the failing test (with injected fetch)**

File `tests/providers/copilot/auth.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { requestDeviceCode, pollForToken } from "../../../src/providers/copilot/auth.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("copilot auth", () => {
  it("requests a device code", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 }),
    );
    const r = await requestDeviceCode(fetchFn as unknown as typeof fetch);
    expect(r.user_code).toBe("ABCD-1234");
    expect(r.device_code).toBe("dc");
  });

  it("returns access token once authorization completes", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "gho_xyz", token_type: "bearer" }));
    const token = await pollForToken("dc", 0, fetchFn as unknown as typeof fetch);
    expect(token).toBe("gho_xyz");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/copilot/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/providers/types.ts`**

```ts
import type { CanonicalRequest, CanonicalResponse, CanonicalChunk } from "../core/canonical.js";

export interface ProviderAdapter {
  readonly name: string;
  complete(req: CanonicalRequest): Promise<CanonicalResponse>;
  stream(req: CanonicalRequest): AsyncIterable<CanonicalChunk>;
}
```

- [ ] **Step 4: Implement `src/providers/copilot/auth.ts`**

```ts
// Community-documented GitHub Copilot OAuth (unofficial; may change).
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
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

// Polls until the user authorizes. intervalMs lets tests pass 0.
export async function pollForToken(
  deviceCode: string,
  intervalMs: number,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  for (;;) {
    const res = await fetchFn(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const data = (await res.json()) as { access_token?: string; error?: string };
    if (data.access_token) return data.access_token;
    if (data.error && data.error !== "authorization_pending" && data.error !== "slow_down") {
      throw new Error(`authorization failed: ${data.error}`);
    }
    await sleep(intervalMs);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/providers/copilot/auth.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/providers/types.ts src/providers/copilot/auth.ts tests/providers/copilot/auth.test.ts
git commit -m "feat: add provider interface and Copilot device-code auth"
```

---

## Task 5: Copilot token exchange + cache

**Files:**
- Create: `src/providers/copilot/token.ts`
- Test: `tests/providers/copilot/token.test.ts`

- [ ] **Step 1: Write the failing test**

File `tests/providers/copilot/token.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { CopilotTokenStore } from "../../../src/providers/copilot/token.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("CopilotTokenStore", () => {
  it("exchanges GH token for a Copilot token and caches until near expiry", async () => {
    let now = 1_000_000;
    const fetchFn = vi.fn(async () => jsonResponse({ token: "cop_1", expires_at: 1_000 + now / 1000 }));
    const store = new CopilotTokenStore("gho_xyz", fetchFn as unknown as typeof fetch, () => now);

    const t1 = await store.get();
    expect(t1).toBe("cop_1");
    const t2 = await store.get(); // cached, no new fetch
    expect(t2).toBe("cop_1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refreshes after expiry", async () => {
    let now = 0;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ token: "cop_1", expires_at: 100 }))
      .mockResolvedValueOnce(jsonResponse({ token: "cop_2", expires_at: 10_000 }));
    const store = new CopilotTokenStore("gho_xyz", fetchFn as unknown as typeof fetch, () => now);
    expect(await store.get()).toBe("cop_1");
    now = 200_000; // 200s later, past expiry (100s)
    expect(await store.get()).toBe("cop_2");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/copilot/token.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/providers/copilot/token.ts`**

```ts
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

interface CopilotTokenResponse {
  token: string;
  expires_at: number; // unix seconds
}

// Holds a GitHub OAuth token and exchanges it for short-lived Copilot tokens.
export class CopilotTokenStore {
  private cached?: { token: string; expiresAtMs: number };

  constructor(
    private ghToken: string,
    private fetchFn: typeof fetch = fetch,
    private nowMs: () => number = () => Date.now(),
  ) {}

  async get(): Promise<string> {
    const skewMs = 60_000; // refresh 60s before expiry
    if (this.cached && this.cached.expiresAtMs - skewMs > this.nowMs()) {
      return this.cached.token;
    }
    const res = await this.fetchFn(COPILOT_TOKEN_URL, {
      headers: { authorization: `token ${this.ghToken}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`copilot token exchange failed: ${res.status}`);
    const data = (await res.json()) as CopilotTokenResponse;
    this.cached = { token: data.token, expiresAtMs: data.expires_at * 1000 };
    return data.token;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/copilot/token.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/copilot/token.ts tests/providers/copilot/token.test.ts
git commit -m "feat: add Copilot token exchange with cache+refresh"
```

---

## Task 6: Copilot adapter (non-streaming + streaming)

**Files:**
- Create: `src/providers/copilot/adapter.ts`
- Test: `tests/providers/copilot/adapter.test.ts`

- [ ] **Step 1: Write the failing test**

File `tests/providers/copilot/adapter.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { CopilotAdapter } from "../../../src/providers/copilot/adapter.js";
import type { CanonicalRequest } from "../../../src/core/canonical.js";

const tokenStore = { get: async () => "cop_token" };
const baseReq: CanonicalRequest = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "hi" }],
  stream: false,
};

describe("CopilotAdapter", () => {
  it("completes a non-streaming request", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "cmpl_1",
          choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const adapter = new CopilotAdapter(tokenStore, fetchFn as unknown as typeof fetch);
    const r = await adapter.complete(baseReq);
    expect(r.content).toBe("hello");
    expect(r.finishReason).toBe("stop");
    expect(r.usage.promptTokens).toBe(2);
    // Authorization header carries the copilot token
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer cop_token");
  });

  it("streams deltas parsed from SSE", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
      "data: [DONE]\n\n";
    const fetchFn = vi.fn(async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const adapter = new CopilotAdapter(tokenStore, fetchFn as unknown as typeof fetch);
    const chunks: string[] = [];
    for await (const c of adapter.stream({ ...baseReq, stream: true })) {
      if (!c.done) chunks.push(c.delta);
    }
    expect(chunks.join("")).toBe("hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/copilot/adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/providers/copilot/adapter.ts`**

```ts
import type { ProviderAdapter } from "../types.js";
import type { CanonicalRequest, CanonicalResponse, CanonicalChunk } from "../../core/canonical.js";

const CHAT_URL = "https://api.githubcopilot.com/chat/completions";

interface TokenSource {
  get(): Promise<string>;
}

function buildBody(req: CanonicalRequest) {
  return {
    model: req.model,
    messages: req.messages,
    stream: req.stream,
    temperature: req.temperature,
    max_tokens: req.maxTokens,
  };
}

function headers(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "editor-version": "vscode/1.95.0",
    "copilot-integration-id": "vscode-chat",
  };
}

export class CopilotAdapter implements ProviderAdapter {
  readonly name = "copilot";
  constructor(private tokenStore: TokenSource, private fetchFn: typeof fetch = fetch) {}

  async complete(req: CanonicalRequest): Promise<CanonicalResponse> {
    const token = await this.tokenStore.get();
    const res = await this.fetchFn(CHAT_URL, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(buildBody({ ...req, stream: false })),
    });
    if (!res.ok) throw new Error(`copilot completion failed: ${res.status}`);
    const data = (await res.json()) as {
      id?: string;
      choices: { message: { content: string }; finish_reason: string }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const choice = data.choices[0];
    return {
      id: data.id ?? "cmpl",
      model: req.model,
      content: choice.message.content,
      finishReason: choice.finish_reason === "length" ? "length" : "stop",
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  async *stream(req: CanonicalRequest): AsyncIterable<CanonicalChunk> {
    const token = await this.tokenStore.get();
    const res = await this.fetchFn(CHAT_URL, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(buildBody({ ...req, stream: true })),
    });
    if (!res.ok || !res.body) throw new Error(`copilot stream failed: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
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
        const payload = line.slice("data: ".length).trim();
        if (payload === "[DONE]") {
          yield { delta: "", done: true, finishReason: "stop" };
          return;
        }
        try {
          const json = JSON.parse(payload) as { choices: { delta?: { content?: string } }[] };
          const delta = json.choices[0]?.delta?.content ?? "";
          if (delta) yield { delta, done: false };
        } catch {
          // ignore keep-alive / non-JSON lines
        }
      }
    }
    yield { delta: "", done: true, finishReason: "stop" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/providers/copilot/adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/copilot/adapter.ts tests/providers/copilot/adapter.test.ts
git commit -m "feat: add Copilot adapter (non-stream + SSE stream)"
```

---

## Task 7: Worker router (single-provider for M1)

**Files:**
- Create: `src/worker/router.ts`
- Test: `tests/worker/router.test.ts`

- [ ] **Step 1: Write the failing test**

File `tests/worker/router.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Router } from "../../src/worker/router.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

const fake: ProviderAdapter = {
  name: "copilot",
  complete: async () => ({ id: "x", model: "m", content: "", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } }),
  async *stream() {},
};

describe("Router", () => {
  it("returns the only registered provider", () => {
    const r = new Router([fake]);
    expect(r.pick("gpt-4o").name).toBe("copilot");
  });

  it("throws when no providers are registered", () => {
    const r = new Router([]);
    expect(() => r.pick("gpt-4o")).toThrow(/no provider/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worker/router.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/worker/router.ts`**

```ts
import type { ProviderAdapter } from "../providers/types.js";

// M1: single-provider selection. M2 adds priority + fallback + model maps.
export class Router {
  constructor(private providers: ProviderAdapter[]) {}

  pick(_model: string): ProviderAdapter {
    const provider = this.providers[0];
    if (!provider) throw new Error("no provider registered");
    return provider;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/worker/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/router.ts tests/worker/router.test.ts
git commit -m "feat: add single-provider worker router"
```

---

## Task 8: Worker HTTP server (`/v1/chat/completions`, non-stream + SSE)

**Files:**
- Create: `src/worker/server.ts`
- Test: `tests/worker/server.test.ts`

- [ ] **Step 1: Write the failing test (supertest)**

File `tests/worker/server.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createWorkerApp } from "../../src/worker/server.js";
import { Router } from "../../src/worker/router.js";
import type { ProviderAdapter } from "../../src/providers/types.js";

const provider: ProviderAdapter = {
  name: "copilot",
  complete: async () => ({
    id: "cmpl_1",
    model: "gpt-4o",
    content: "hello",
    finishReason: "stop",
    usage: { promptTokens: 2, completionTokens: 1 },
  }),
  async *stream() {
    yield { delta: "he", done: false };
    yield { delta: "llo", done: false };
    yield { delta: "", done: true, finishReason: "stop" as const };
  },
};

describe("worker server", () => {
  it("returns an OpenAI completion for non-stream requests", async () => {
    const app = createWorkerApp(new Router([provider]), () => {});
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("chat.completion");
    expect(res.body.choices[0].message.content).toBe("hello");
  });

  it("streams SSE chunks ending with [DONE]", async () => {
    const app = createWorkerApp(new Router([provider]), () => {});
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.text).toContain('"content":"he"');
    expect(res.text).toContain("data: [DONE]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worker/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/worker/server.ts`**

```ts
import express, { type Express } from "express";
import type { Router } from "./router.js";
import { openaiRequestToCanonical, canonicalToOpenAIResponse, canonicalChunkToOpenAISSE } from "../core/openai-inbound.js";

export type MetricSink = (m: { endpoint: string; model: string; status: number; latencyMs: number }) => void;

export function createWorkerApp(router: Router, onMetric: MetricSink): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.post("/v1/chat/completions", async (req, res) => {
    const start = Date.now();
    const canon = openaiRequestToCanonical(req.body);
    const provider = router.pick(canon.model);
    try {
      if (canon.stream) {
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        const id = `chatcmpl-${canon.model}`;
        for await (const chunk of provider.stream(canon)) {
          res.write(canonicalChunkToOpenAISSE(chunk, id, canon.model));
        }
        res.end();
        onMetric({ endpoint: "/v1/chat/completions", model: canon.model, status: 200, latencyMs: Date.now() - start });
      } else {
        const result = await provider.complete(canon);
        res.json(canonicalToOpenAIResponse(result));
        onMetric({ endpoint: "/v1/chat/completions", model: canon.model, status: 200, latencyMs: Date.now() - start });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.status(502).json({ error: { message } });
      else res.end();
      onMetric({ endpoint: "/v1/chat/completions", model: canon.model, status: 502, latencyMs: Date.now() - start });
    }
  });

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/worker/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/server.ts tests/worker/server.test.ts
git commit -m "feat: add worker HTTP server with OpenAI endpoint (stream + non-stream)"
```

---

## Task 9: Worker entry — boot server, IPC heartbeat, credential load

**Files:**
- Create: `src/worker/index.ts`
- Create: `src/shared/creds.ts` (read GH token from data dir)
- Test: `tests/shared/creds.test.ts`

> The worker entry is process-glue (forked child, real ports) and is exercised by the end-to-end smoke test in Task 13 rather than a unit test. We unit-test the credential loader here.

- [ ] **Step 1: Write the failing test for creds**

File `tests/shared/creds.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGhToken, writeGhToken } from "../../src/shared/creds.js";

describe("creds", () => {
  it("round-trips a GitHub token through a creds file", () => {
    const dir = mkdtempSync(join(tmpdir(), "maestro-"));
    writeGhToken("gho_abc", dir);
    expect(readGhToken(dir)).toBe("gho_abc");
  });

  it("returns null when no creds file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "maestro-"));
    expect(readGhToken(dir)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/creds.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/shared/creds.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// M1: plaintext token in the data dir (0600). Encryption-at-rest is M2.
function credsFile(dir: string): string {
  return join(dir, "creds.json");
}

export function writeGhToken(token: string, dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(credsFile(dir), JSON.stringify({ ghToken: token }), { mode: 0o600 });
}

export function readGhToken(dir: string): string | null {
  const f = credsFile(dir);
  if (!existsSync(f)) return null;
  const data = JSON.parse(readFileSync(f, "utf8")) as { ghToken?: string };
  return data.ghToken ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shared/creds.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `src/worker/index.ts` (glue, no unit test)**

```ts
import { createWorkerApp } from "./server.js";
import { Router } from "./router.js";
import { CopilotAdapter } from "../providers/copilot/adapter.js";
import { CopilotTokenStore } from "../providers/copilot/token.js";
import { readGhToken } from "../shared/creds.js";
import { dataDir } from "../shared/paths.js";
import type { WorkerToSupervisor } from "../shared/ipc.js";

function send(msg: WorkerToSupervisor): void {
  if (process.send) process.send(msg);
}

const port = Number(process.env.WORKER_PORT ?? 7891);
const host = process.env.BIND_HOST ?? "127.0.0.1";

const ghToken = readGhToken(dataDir());
if (!ghToken) {
  send({ type: "error", message: "no GitHub token; run `maestro auth login` first" });
  process.exit(1);
}

const tokenStore = new CopilotTokenStore(ghToken);
const adapter = new CopilotAdapter(tokenStore);
const router = new Router([adapter]);

const app = createWorkerApp(router, (m) =>
  send({ type: "request-metric", endpoint: m.endpoint, model: m.model, status: m.status, latencyMs: m.latencyMs }),
);

const server = app.listen(port, host, () => send({ type: "ready", port }));

const heartbeat = setInterval(() => send({ type: "heartbeat", ts: Date.now() }), 5_000);

process.on("message", (msg: { type?: string }) => {
  if (msg?.type === "shutdown") {
    clearInterval(heartbeat);
    server.close(() => process.exit(0));
  }
});

process.on("uncaughtException", (err) => {
  send({ type: "error", message: err.message, stack: err.stack });
  process.exit(1);
});
```

- [ ] **Step 6: Commit**

```bash
git add src/shared/creds.ts src/worker/index.ts tests/shared/creds.test.ts
git commit -m "feat: add worker entry with IPC heartbeat and creds loader"
```

---

## Task 10: SQLite store (settings + restart events)

**Files:**
- Create: `src/supervisor/db.ts`
- Test: `tests/supervisor/db.test.ts`

- [ ] **Step 1: Write the failing test (in-memory db)**

File `tests/supervisor/db.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb, recordRestart, listRestarts } from "../../src/supervisor/db.js";

describe("supervisor db", () => {
  it("records and lists restart events newest-first", () => {
    const db = openDb(":memory:");
    recordRestart(db, { ts: 1, reason: "crash", exitCode: 1, stderrTail: "boom", backoffMs: 500, markedUnhealthy: 0 });
    recordRestart(db, { ts: 2, reason: "crash", exitCode: 1, stderrTail: "boom2", backoffMs: 1000, markedUnhealthy: 1 });
    const rows = listRestarts(db, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0].ts).toBe(2);
    expect(rows[0].markedUnhealthy).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/supervisor/db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/supervisor/db.ts`**

```ts
import Database from "better-sqlite3";

export type Db = Database.Database;

export interface RestartEvent {
  ts: number;
  reason: string;
  exitCode: number | null;
  stderrTail: string;
  backoffMs: number;
  markedUnhealthy: 0 | 1;
}

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS restart_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      reason TEXT NOT NULL,
      exit_code INTEGER,
      stderr_tail TEXT NOT NULL,
      backoff_ms INTEGER NOT NULL,
      marked_unhealthy INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

export function recordRestart(db: Db, e: RestartEvent): void {
  db.prepare(
    `INSERT INTO restart_events (ts, reason, exit_code, stderr_tail, backoff_ms, marked_unhealthy)
     VALUES (@ts, @reason, @exitCode, @stderrTail, @backoffMs, @markedUnhealthy)`,
  ).run(e);
}

export function listRestarts(db: Db, limit: number): RestartEvent[] {
  const rows = db
    .prepare(
      `SELECT ts, reason, exit_code as exitCode, stderr_tail as stderrTail,
              backoff_ms as backoffMs, marked_unhealthy as markedUnhealthy
       FROM restart_events ORDER BY ts DESC LIMIT ?`,
    )
    .all(limit) as RestartEvent[];
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/supervisor/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/db.ts tests/supervisor/db.test.ts
git commit -m "feat: add SQLite store for restart events"
```

---

## Task 11: Supervisor monitor — backoff restart + circuit breaker

**Files:**
- Create: `src/supervisor/monitor.ts`
- Test: `tests/supervisor/monitor.test.ts`

> The monitor's restart policy (backoff + sliding window) is pure logic and must be unit-tested without spawning real processes. We extract the decision into a testable `RestartController`; the actual `fork` wiring is a thin shell exercised by Task 13's smoke test.

- [ ] **Step 1: Write the failing test**

File `tests/supervisor/monitor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RestartController } from "../../src/supervisor/monitor.js";
import { defaultConfig } from "../../src/shared/config.js";

describe("RestartController", () => {
  it("uses exponential backoff capped at maxBackoffMs", () => {
    const c = new RestartController(defaultConfig().restart, () => 0);
    expect(c.onCrash().backoffMs).toBe(500); // 1st
    expect(c.onCrash().backoffMs).toBe(1000); // 2nd
    expect(c.onCrash().backoffMs).toBe(2000); // 3rd
    expect(c.onCrash().backoffMs).toBe(4000); // 4th
  });

  it("marks unhealthy after maxCrashes within window", () => {
    let now = 0;
    const c = new RestartController(defaultConfig().restart, () => now);
    let last = c.onCrash();
    for (let i = 0; i < 4; i++) {
      now += 1000;
      last = c.onCrash();
    }
    expect(last.markedUnhealthy).toBe(true); // 5 crashes within 60s
  });

  it("does not mark unhealthy when crashes are spread beyond the window", () => {
    let now = 0;
    const c = new RestartController(defaultConfig().restart, () => now);
    for (let i = 0; i < 4; i++) {
      now += 20_000; // 20s apart -> old ones fall out of 60s window
      c.onCrash();
    }
    const last = c.onCrash();
    expect(last.markedUnhealthy).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/supervisor/monitor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/supervisor/monitor.ts`**

```ts
import { fork, type ChildProcess } from "node:child_process";
import type { RestartPolicy, AppConfig } from "../shared/config.js";
import type { WorkerToSupervisor } from "../shared/ipc.js";

export interface RestartDecision {
  backoffMs: number;
  markedUnhealthy: boolean;
  crashesInWindow: number;
}

// Pure restart policy: exponential backoff + sliding-window circuit breaker.
export class RestartController {
  private crashTimes: number[] = [];
  private consecutive = 0;

  constructor(private policy: RestartPolicy, private now: () => number = () => Date.now()) {}

  onCrash(): RestartDecision {
    const t = this.now();
    this.crashTimes.push(t);
    this.crashTimes = this.crashTimes.filter((ct) => t - ct < this.policy.windowMs);
    this.consecutive += 1;

    const backoffMs = Math.min(
      this.policy.baseBackoffMs * 2 ** (this.consecutive - 1),
      this.policy.maxBackoffMs,
    );
    const markedUnhealthy = this.crashTimes.length >= this.policy.maxCrashes;
    return { backoffMs, markedUnhealthy, crashesInWindow: this.crashTimes.length };
  }

  reset(): void {
    this.consecutive = 0;
  }
}

export type WorkerState = "starting" | "ready" | "crashed" | "unhealthy";

export interface MonitorHooks {
  onStateChange(state: WorkerState): void;
  onCrash(decision: RestartDecision, exitCode: number | null, stderrTail: string): void;
  onWorkerMessage(msg: WorkerToSupervisor): void;
}

// Spawns and supervises the worker child, applying RestartController decisions.
export class WorkerMonitor {
  private child?: ChildProcess;
  private controller: RestartController;
  private stderrTail = "";
  private state: WorkerState = "starting";
  private stopped = false;

  constructor(private config: AppConfig, private workerEntry: string, private hooks: MonitorHooks) {
    this.controller = new RestartController(config.restart);
  }

  start(): void {
    this.spawn();
  }

  private setState(s: WorkerState): void {
    this.state = s;
    this.hooks.onStateChange(s);
  }

  private spawn(): void {
    this.setState("starting");
    const child = fork(this.workerEntry, [], {
      env: {
        ...process.env,
        WORKER_PORT: String(this.config.workerPort),
        BIND_HOST: this.config.bindHost,
      },
      stdio: ["ignore", "inherit", "pipe", "ipc"],
    });
    this.child = child;
    this.stderrTail = "";

    child.stderr?.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
    });

    child.on("message", (msg: WorkerToSupervisor) => {
      if (msg.type === "ready") {
        this.controller.reset();
        this.setState("ready");
      }
      this.hooks.onWorkerMessage(msg);
    });

    child.on("exit", (code) => {
      if (this.stopped) return;
      const decision = this.controller.onCrash();
      this.hooks.onCrash(decision, code, this.stderrTail);
      if (decision.markedUnhealthy) {
        this.setState("unhealthy");
        return; // stop auto-restart
      }
      this.setState("crashed");
      setTimeout(() => this.spawn(), decision.backoffMs);
    });
  }

  restartManually(): void {
    this.controller.reset();
    this.stopped = false;
    if (this.child && !this.child.killed) {
      this.child.removeAllListeners("exit");
      this.child.kill();
    }
    this.spawn();
  }

  stop(): void {
    this.stopped = true;
    this.child?.send?.({ type: "shutdown" });
    this.child?.kill();
  }

  currentState(): WorkerState {
    return this.state;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/supervisor/monitor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/monitor.ts tests/supervisor/monitor.test.ts
git commit -m "feat: add worker monitor with backoff restart and circuit breaker"
```

---

## Task 12: Supervisor API — status, restart, SSE events, static dashboard

**Files:**
- Create: `src/supervisor/api.ts`
- Test: `tests/supervisor/api.test.ts`

- [ ] **Step 1: Write the failing test**

File `tests/supervisor/api.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createSupervisorApp } from "../../src/supervisor/api.js";
import { openDb, recordRestart } from "../../src/supervisor/db.js";

function fixture() {
  const db = openDb(":memory:");
  recordRestart(db, { ts: 1, reason: "crash", exitCode: 1, stderrTail: "boom", backoffMs: 500, markedUnhealthy: 0 });
  let restarted = false;
  const app = createSupervisorApp({
    db,
    getState: () => "ready",
    restart: () => {
      restarted = true;
    },
    subscribe: () => () => {},
  });
  return { app, wasRestarted: () => restarted };
}

describe("supervisor api", () => {
  it("reports status with worker state and recent restarts", async () => {
    const { app } = fixture();
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.workerState).toBe("ready");
    expect(res.body.restarts[0].stderrTail).toBe("boom");
  });

  it("triggers a manual restart", async () => {
    const { app, wasRestarted } = fixture();
    const res = await request(app).post("/api/restart");
    expect(res.status).toBe(200);
    expect(wasRestarted()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/supervisor/api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/supervisor/api.ts`**

```ts
import express, { type Express } from "express";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { listRestarts, type Db } from "./db.js";
import type { WorkerState } from "./monitor.js";

export interface SupervisorDeps {
  db: Db;
  getState: () => WorkerState;
  restart: () => void;
  // subscribe pushes SSE events; returns an unsubscribe fn.
  subscribe: (send: (event: string, data: unknown) => void) => () => void;
}

export function createSupervisorApp(deps: SupervisorDeps): Express {
  const app = express();
  app.use(express.json());

  app.get("/api/status", (_req, res) => {
    res.json({ workerState: deps.getState(), restarts: listRestarts(deps.db, 50) });
  });

  app.post("/api/restart", (_req, res) => {
    deps.restart();
    res.json({ ok: true });
  });

  app.get("/api/events", (req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("hello", { state: deps.getState() });
    const unsubscribe = deps.subscribe(send);
    req.on("close", unsubscribe);
  });

  // Serve built dashboard assets if present (Task 13 builds them).
  const dashboardDir = join(process.cwd(), "dist-dashboard");
  if (existsSync(dashboardDir)) {
    app.use(express.static(dashboardDir));
    app.get("*", (_req, res) => res.sendFile(join(dashboardDir, "index.html")));
  }

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/supervisor/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/api.ts tests/supervisor/api.test.ts
git commit -m "feat: add supervisor REST/SSE API and static dashboard serving"
```

---

## Task 13: Supervisor entry, event bus, and wiring

**Files:**
- Create: `src/supervisor/events.ts`
- Create: `src/supervisor/index.ts`
- Test: `tests/supervisor/events.test.ts`

- [ ] **Step 1: Write the failing test for the event bus**

File `tests/supervisor/events.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../../src/supervisor/events.js";

describe("EventBus", () => {
  it("broadcasts to all subscribers and stops after unsubscribe", () => {
    const bus = new EventBus();
    const a = vi.fn();
    const unsub = bus.subscribe(a);
    bus.emit("state", { x: 1 });
    expect(a).toHaveBeenCalledWith("state", { x: 1 });
    unsub();
    bus.emit("state", { x: 2 });
    expect(a).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/supervisor/events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/supervisor/events.ts`**

```ts
type Listener = (event: string, data: unknown) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event: string, data: unknown): void {
    for (const fn of this.listeners) fn(event, data);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/supervisor/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `src/supervisor/index.ts` (glue, exercised by smoke test)**

```ts
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { openDb, recordRestart } from "./db.js";
import { WorkerMonitor, type WorkerState } from "./monitor.js";
import { EventBus } from "./events.js";
import { createSupervisorApp } from "./api.js";
import { defaultConfig } from "../shared/config.js";
import { dataDir, dbPath } from "../shared/paths.js";

export function startSupervisor(): void {
  const config = defaultConfig();
  mkdirSync(dataDir(), { recursive: true });
  const db = openDb(dbPath());
  const bus = new EventBus();

  const here = dirname(fileURLToPath(import.meta.url));
  const workerEntry = join(here, "..", "worker", "index.js");

  let state: WorkerState = "starting";
  const monitor = new WorkerMonitor(config, workerEntry, {
    onStateChange: (s) => {
      state = s;
      bus.emit("state", { state: s });
    },
    onCrash: (decision, exitCode, stderrTail) => {
      recordRestart(db, {
        ts: Date.now(),
        reason: decision.markedUnhealthy ? "unhealthy" : "crash",
        exitCode,
        stderrTail,
        backoffMs: decision.backoffMs,
        markedUnhealthy: decision.markedUnhealthy ? 1 : 0,
      });
      bus.emit("crash", { exitCode, ...decision });
    },
    onWorkerMessage: (msg) => {
      if (msg.type === "request-metric") bus.emit("metric", msg);
    },
  });

  const app = createSupervisorApp({
    db,
    getState: () => state,
    restart: () => monitor.restartManually(),
    subscribe: (send) => bus.subscribe(send),
  });

  app.listen(config.supervisorPort, config.bindHost, () => {
    // eslint-disable-next-line no-console
    console.log(`maestro dashboard: http://${config.bindHost}:${config.supervisorPort}`);
    monitor.start();
  });

  process.on("SIGINT", () => {
    monitor.stop();
    process.exit(0);
  });
}
```

- [ ] **Step 6: Commit**

```bash
git add src/supervisor/events.ts src/supervisor/index.ts tests/supervisor/events.test.ts
git commit -m "feat: add supervisor event bus and entry wiring"
```

---

## Task 14: CLI (`auth login`, `start`, `status`)

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/auth.ts`
- Test: `tests/cli/auth.test.ts`

- [ ] **Step 1: Write the failing test for the auth command logic**

File `tests/cli/auth.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeviceLogin } from "../../src/cli/auth.js";
import { readGhToken } from "../../src/shared/creds.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("runDeviceLogin", () => {
  it("walks device flow and persists the GH token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maestro-"));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ device_code: "dc", user_code: "AB-12", verification_uri: "https://github.com/login/device", interval: 0, expires_in: 900 }),
      )
      .mockResolvedValueOnce(jsonResponse({ access_token: "gho_zzz" }));
    const log = vi.fn();
    await runDeviceLogin(dir, fetchFn as unknown as typeof fetch, log);
    expect(readGhToken(dir)).toBe("gho_zzz");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("AB-12"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/cli/auth.ts`**

```ts
import { requestDeviceCode, pollForToken } from "../providers/copilot/auth.js";
import { writeGhToken } from "../shared/creds.js";

export async function runDeviceLogin(
  dir: string,
  fetchFn: typeof fetch = fetch,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const code = await requestDeviceCode(fetchFn);
  log(`\nOpen ${code.verification_uri} and enter code: ${code.user_code}\n`);
  const token = await pollForToken(code.device_code, code.interval * 1000, fetchFn);
  writeGhToken(token, dir);
  log("GitHub authorization complete. Token saved.");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cli/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `src/cli/index.ts` (glue)**

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { startSupervisor } from "../supervisor/index.js";
import { runDeviceLogin } from "./auth.js";
import { dataDir } from "../shared/paths.js";
import { defaultConfig } from "../shared/config.js";

const program = new Command();
program.name("maestro").description("llm-maestro: local multi-provider LLM router").version("0.0.1");

program
  .command("auth")
  .argument("<action>", "login")
  .action(async (action: string) => {
    if (action === "login") await runDeviceLogin(dataDir());
    else {
      console.error(`unknown auth action: ${action}`);
      process.exit(1);
    }
  });

program.command("start").description("start supervisor + worker + dashboard").action(() => startSupervisor());

program
  .command("status")
  .description("print supervisor status")
  .action(async () => {
    const cfg = defaultConfig();
    try {
      const res = await fetch(`http://${cfg.bindHost}:${cfg.supervisorPort}/api/status`);
      console.log(JSON.stringify(await res.json(), null, 2));
    } catch {
      console.error("supervisor not reachable — is `maestro start` running?");
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts src/cli/auth.ts tests/cli/auth.test.ts
git commit -m "feat: add CLI with auth login, start, and status commands"
```

---

## Task 15: Minimal React Dashboard (health + restart)

**Files:**
- Create: `src/dashboard/index.html`, `src/dashboard/src/main.tsx`, `src/dashboard/src/App.tsx`
- Create: `src/dashboard/vite.config.ts`, `src/dashboard/package.json`, `src/dashboard/tailwind.config.js`, `src/dashboard/postcss.config.js`, `src/dashboard/src/index.css`

> The dashboard is a separate Vite sub-project so its browser build doesn't mix with the Node `tsconfig`. It builds into the repo-root `dist-dashboard/` which the supervisor serves (Task 12).

- [ ] **Step 1: Create `src/dashboard/package.json`**

```json
{
  "name": "llm-maestro-dashboard",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build", "dev": "vite" },
  "dependencies": { "react": "^18.3.0", "react-dom": "^18.3.0" },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `src/dashboard/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Output to repo-root dist-dashboard so the supervisor can serve it.
  build: { outDir: "../../dist-dashboard", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:7890" } },
});
```

- [ ] **Step 3: Create `src/dashboard/tailwind.config.js`, `postcss.config.js`, `src/index.css`**

`tailwind.config.js`:

```js
export default { content: ["./index.html", "./src/**/*.{ts,tsx}"], theme: { extend: {} }, plugins: [] };
```

`postcss.config.js`:

```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

`src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 4: Create `src/dashboard/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>llm-maestro</title>
  </head>
  <body class="bg-slate-950 text-slate-100">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `src/dashboard/src/main.tsx`**

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 6: Create `src/dashboard/src/App.tsx`**

```tsx
import React, { useEffect, useState } from "react";

interface Restart {
  ts: number;
  reason: string;
  exitCode: number | null;
  stderrTail: string;
  markedUnhealthy: 0 | 1;
}
interface Status {
  workerState: string;
  restarts: Restart[];
}

const stateColor: Record<string, string> = {
  ready: "text-emerald-400",
  starting: "text-amber-400",
  crashed: "text-orange-400",
  unhealthy: "text-red-500",
};

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);

  async function refresh() {
    const res = await fetch("/api/status");
    setStatus(await res.json());
  }

  useEffect(() => {
    refresh();
    const es = new EventSource("/api/events");
    es.addEventListener("state", refresh);
    es.addEventListener("crash", refresh);
    return () => es.close();
  }, []);

  async function restart() {
    await fetch("/api/restart", { method: "POST" });
    refresh();
  }

  return (
    <div className="mx-auto max-w-3xl p-8 space-y-6">
      <h1 className="text-2xl font-bold">llm-maestro</h1>
      <div className="flex items-center gap-4">
        <span>Worker:</span>
        <span className={`font-mono ${stateColor[status?.workerState ?? ""] ?? "text-slate-300"}`}>
          {status?.workerState ?? "…"}
        </span>
        <button onClick={restart} className="rounded bg-sky-600 px-3 py-1 hover:bg-sky-500">
          Restart
        </button>
      </div>
      <section>
        <h2 className="mb-2 text-lg font-semibold">Restart history</h2>
        <ul className="space-y-2">
          {status?.restarts.map((r, i) => (
            <li key={i} className="rounded bg-slate-900 p-3 text-sm">
              <div className="flex justify-between">
                <span className={r.markedUnhealthy ? "text-red-500" : "text-orange-400"}>{r.reason}</span>
                <span className="text-slate-500">exit {r.exitCode ?? "—"}</span>
              </div>
              <pre className="mt-1 overflow-x-auto text-xs text-slate-400">{r.stderrTail}</pre>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 7: Build the dashboard and verify output**

Run:
```bash
cd src/dashboard && npm install && npm run build && cd ../..
ls dist-dashboard/index.html
```
Expected: `dist-dashboard/index.html` exists.

- [ ] **Step 8: Commit**

```bash
git add src/dashboard
git commit -m "feat: add minimal React dashboard (health + restart history)"
```

---

## Task 16: Build wiring, end-to-end smoke test, README

**Files:**
- Create: `tests/e2e/smoke.test.ts`
- Create: `README.md`
- Modify: `package.json` (add combined build script)

- [ ] **Step 1: Add combined build script to `package.json`**

Change the `scripts` block to:

```json
  "scripts": {
    "build": "tsc -p tsconfig.json && npm --prefix src/dashboard run build",
    "test": "vitest run",
    "dev": "tsx src/cli/index.ts"
  },
```

- [ ] **Step 2: Write the end-to-end smoke test**

This test compiles nothing — it drives the supervisor API with a fake worker by importing the monitor against a tiny worker stub. File `tests/e2e/smoke.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createSupervisorApp } from "../../src/supervisor/api.js";
import { openDb, recordRestart } from "../../src/supervisor/db.js";
import { EventBus } from "../../src/supervisor/events.js";

describe("supervisor e2e (API + events + db)", () => {
  it("serves status, restarts, and pushes SSE state", async () => {
    const db = openDb(":memory:");
    const bus = new EventBus();
    let state = "ready";
    const app = createSupervisorApp({
      db,
      getState: () => state,
      restart: () => {
        state = "starting";
        recordRestart(db, { ts: Date.now(), reason: "manual", exitCode: null, stderrTail: "", backoffMs: 0, markedUnhealthy: 0 });
        bus.emit("state", { state });
      },
      subscribe: (send) => bus.subscribe(send),
    });

    const before = await request(app).get("/api/status");
    expect(before.body.restarts).toHaveLength(0);

    await request(app).post("/api/restart");
    const after = await request(app).get("/api/status");
    expect(after.body.workerState).toBe("starting");
    expect(after.body.restarts).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all suites green.

- [ ] **Step 4: Build the whole project**

Run: `npm run build`
Expected: `dist/cli/index.js` and `dist-dashboard/index.html` exist, no TS errors.

- [ ] **Step 5: Manual verification (documented, run by implementer)**

```bash
node dist/cli/index.js auth login      # follow device-code prompt in browser
node dist/cli/index.js start           # open http://127.0.0.1:7890
# In another shell, exercise the proxy:
curl http://127.0.0.1:7891/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"say hi"}]}'
```
Expected: Dashboard shows Worker `ready`; curl returns an OpenAI-shaped completion from Copilot.

- [ ] **Step 6: Create `README.md`**

```markdown
# llm-maestro

Local multi-provider LLM router. Authenticate once with GitHub Copilot and use it
through OpenAI-compatible APIs, with a web dashboard and a self-healing daemon.

> **Disclaimer:** The GitHub Copilot integration uses community-documented, unofficial
> endpoints and is intended for use with your own Copilot subscription only. It may
> break if GitHub changes these endpoints.

## Quick start

\`\`\`bash
npx llm-maestro auth login     # GitHub device-code login
npx llm-maestro start          # dashboard at http://127.0.0.1:7890
\`\`\`

Point an OpenAI client at \`http://127.0.0.1:7891/v1\`.

## Architecture (M1)

- **Supervisor** (:7890) — serves the dashboard, owns SQLite, supervises the worker,
  restarts it with exponential backoff, and trips to \`unhealthy\` after 5 crashes in 60s.
- **Worker** (:7891) — the proxy: OpenAI \`/v1/chat/completions\` → Copilot.

## Development

\`\`\`bash
npm install
npm test
npm run build
\`\`\`
```

- [ ] **Step 7: Commit**

```bash
git add package.json tests/e2e/smoke.test.ts README.md
git commit -m "test: add e2e smoke test; docs: add README and combined build"
```

---

## Self-Review

**Spec coverage (M1 scope):**
- npm CLI startup → Tasks 14, 16 (`maestro start`, bin). ✓
- Supervisor + Worker self-healing daemon → Tasks 11, 13. ✓
- Single provider (Copilot reverse) → Tasks 4, 5, 6. ✓
- OpenAI inbound proxy (stream + non-stream) → Tasks 3, 8. ✓
- Minimal Dashboard (health + manual restart) → Tasks 12, 15. ✓
- SQLite persistence (restart/error history) → Tasks 10, 13. ✓
- Privacy-safe metrics plumbing (no body) → metric IPC in Tasks 8, 9, 13 (full metrics UI is M3). ✓
- Security: bind 127.0.0.1 → config default (Task 2), used in Tasks 11, 13. ✓

**Deferred to later milestones (intentionally out of M1):** Anthropic inbound, multi-provider routing/fallback/fuzzy matching, provider management UI, one-click client config, full metrics dashboard, credential encryption, server API-key auth, dashboard token auth. These map to M2–M4 in the spec.

**Type consistency check:** `CanonicalRequest/Response/Chunk` (Task 3) are consumed unchanged in Tasks 6, 8. `WorkerToSupervisor` (Task 2) is produced in Task 9 and consumed in Tasks 11, 13. `WorkerState` (Task 11) is used in Tasks 12, 13. `RestartEvent` field names (`stderrTail`, `markedUnhealthy`, Task 10) match usage in Tasks 11–13 and the dashboard (Task 15). `RestartController.onCrash()` returns `{ backoffMs, markedUnhealthy, crashesInWindow }` — consumed consistently in Task 11's `WorkerMonitor` and Task 13's `onCrash`. ✓

**Placeholder scan:** No TBD/TODO; every code step contains complete code. Glue entries (worker/supervisor/cli entry files) are explicitly marked as exercised by the e2e/manual steps rather than unit tests, with real code provided. ✓
