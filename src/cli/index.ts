#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { App } from "../tui/app.js";
import { buildRegistry } from "../tui/slash/commands.js";
import { DaemonClient } from "../tui/daemon-client.js";
import { runDeviceLogin, beginDeviceLogin } from "./auth.js";
import { probeSupervisor } from "../daemon/lifecycle.js";
import { startSupervisor } from "../supervisor/index.js";
import { runAssistantTurn } from "../tui/assistant/runtime.js";
import { makeOnChat } from "../tui/assistant/on-chat.js";
import { readGhToken, clearGhToken } from "../shared/creds.js";
import { writeWebIqKey, readWebIqKey, clearWebIqKey, readWebSearchMode, writeWebSearchMode, resolveWebSearchBackend } from "../shared/webiq-key.js";
import { readClientSetup, writeClientSetup } from "../shared/client-setup.js";
import { readChatModel, writeChatModel } from "../shared/prefs.js";
import { CopilotTokenStore, isCopilotTokenValid } from "../providers/copilot/token.js";
import { fetchCopilotModels, fetchModelLimits } from "../providers/copilot/models.js";
import { applyClaude, applyCodex, resetClaude, resetCodex, CLAUDE_ENV_KEYS, CODEX_ENV_KEYS, type Scope } from "../tui/setup/apply.js";
import { readClientStatus } from "../tui/setup/status.js";
import { summarizeStatus } from "../tui/status-summary.js";
import { applyCodexToml } from "../tui/setup/codex-toml.js";
import type { SetupClient } from "../tui/setup/wizard.js";
import { claudeCopilotReverseEnv } from "../tui/setup/clients.js";
import { dataDir } from "../shared/paths.js";
import { defaultConfig } from "../shared/config.js";
import { APP_VERSION } from "../version.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_MODEL = "gpt-4o"; // a valid Copilot model id; pass-through routing uses it as-is
// Conservative context budget that drives the assistant's auto-compaction. Sized below the
// common Copilot prompt window (gpt-4o ≈ 128K) so the engine compacts before the upstream
// rejects an over-long turn. TODO: read each model's real max_prompt_tokens from /models.
const DEFAULT_MAX_INPUT_TOKENS = 110_000;

// Process-level backstop. The TUI and the supervisor run in ONE process, so a stray throw or an
// unhandled rejection anywhere (a dead SSE socket, a bad creds read, an SDK stream) would otherwise
// terminate the whole app and drop the user back to the shell — especially on Node ≥15, where an
// unhandled rejection is fatal by default. We log to a file (Ink owns stdout, so console writes would
// corrupt the render) and keep running; the specific throw sites are also guarded at their source.
function installProcessBackstop(): void {
  const log = (kind: string, err: unknown) => {
    const e = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    try {
      mkdirSync(dataDir(), { recursive: true });
      appendFileSync(join(dataDir(), "crash.log"), `[${new Date().toISOString()}] ${kind}: ${e}\n`);
    } catch { /* logging must never itself crash the backstop */ }
  };
  process.on("unhandledRejection", (reason) => log("unhandledRejection", reason));
  process.on("uncaughtException", (err) => log("uncaughtException", err));
}

async function launchTui(): Promise<void> {
  installProcessBackstop();
  const cfg = defaultConfig();
  const existingToken = readGhToken(dataDir());
  if (!existingToken) {
    console.log("No GitHub login found — starting device-code login.");
    await runDeviceLogin(dataDir());
  } else if (!(await isCopilotTokenValid(existingToken))) {
    console.log("GitHub login expired — re-authenticating.");
    await runDeviceLogin(dataDir());
  }

  // Run the daemon IN-PROCESS — no separate console window pops up. Reuse one if already running.
  let stopSupervisor: (() => void) | undefined;
  if (!(await probeSupervisor())) {
    process.stdout.write("starting copilot-reverse…\n");
    stopSupervisor = startSupervisor().stop;
    for (let i = 0; i < 60 && !(await probeSupervisor()); i++) await delay(100);
  }

  const base = `http://${cfg.bindHost}:${cfg.supervisorPort}`;
  const client = new DaemonClient(base);
  const workerBase = `http://${cfg.bindHost}:${cfg.workerPort}`;
  // Per-protocol base URLs the worker now serves under: OpenAI clients -> /openai/*,
  // Anthropic clients (and the assistant's own dogfood SDK) -> /anthropic/*.
  const openaiBase = `${workerBase}/openai`;
  const anthropicBase = `${workerBase}/anthropic`;
  const endpoint = { host: cfg.bindHost, port: cfg.workerPort, apiKey: "copilot-reverse-local" };
  let app: { unmount: () => void } | undefined;
  const quit = () => { stopSupervisor?.(); app?.unmount(); process.exit(0); };
  // Restore a client's config: strip copilot-reverse's keys from BOTH scopes and clear the HUD flag.
  const resetClient = async (clientKind: SetupClient): Promise<string[]> => {
    const fn = clientKind === "claude" ? resetClaude : resetCodex;
    const keys = clientKind === "claude" ? CLAUDE_ENV_KEYS : CODEX_ENV_KEYS;
    const results = (["global", "project"] as Scope[]).map((scope) => fn(scope, keys));
    writeClientSetup(dataDir(), { ...readClientSetup(dataDir()), [clientKind]: false });
    const lines = results
      .filter((r) => r.changed.length)
      .map((r) => `removed ${r.changed.join(", ")} from ${r.path}`);
    return lines.length ? lines : [`no copilot-reverse ${clientKind} config found to remove`];
  };

  const registry = buildRegistry({ client, quit }, endpoint, {
    dashboardUrl: `http://${cfg.bindHost}:${cfg.supervisorPort}/`,
    reportRepo: cfg.reportRepo,
    appVersion: APP_VERSION,
    platform: `${process.platform} node-${process.version}`,
    resetClient,
    // Clear the stored token and restart the worker (it will report unauthenticated until re-login).
    logout: async () => {
      clearGhToken(dataDir());
      await client.restart().catch(() => {});
      return ["signed out — GitHub token removed", "run /login to sign in again"];
    },
  });
  // Two-phase /login for the TUI: surface the device code immediately, poll in the background, then
  // restart the worker so it picks up the new token. The blocking single-call form deadlocked the
  // Repl (the code stayed hidden behind the poll, so the user could never authorize it).
  const doLogin = async (show: (lines: string[]) => void): Promise<string[]> => {
    const { code, complete } = await beginDeviceLogin(dataDir());
    show([`Open ${code.verification_uri} and enter code: ${code.user_code}`, "waiting for authorization…"]);
    await complete();
    // Re-point the token store at the freshly written GitHub token; the old store still holds the
    // expired one and would 401 once its cached Copilot token rotates, breaking the model picker.
    tokenStore = new CopilotTokenStore(readGhToken(dataDir())!);
    await client.restart().catch(() => {});
    return ["GitHub authorization complete — worker restarting with the new token"];
  };
  // Filled in below once we have a token; the assistant prefers a model's real window over the default.
  const modelLimits: Record<string, number> = {};
  let tokenStore = new CopilotTokenStore(readGhToken(dataDir())!);
  const loadModels = async () => {
    const token = await tokenStore.get();
    const [ids, limits] = await Promise.all([fetchCopilotModels(token), fetchModelLimits(token)]);
    Object.assign(modelLimits, limits); // so the picker shows windows and auto-compaction is sized
    return ids;
  };
  // Pull each model's real context window in the background too, in case the picker never opens.
  void tokenStore.get().then((t) => fetchModelLimits(t)).then((m) => Object.assign(modelLimits, m)).catch(() => {});

  // Apply a client's config (shared by the /setup wizard and the assistant's setup_* tools).
  // For Claude Code we also write the selected model's real context window so the client doesn't
  // For Claude Code we also write the selected model's real context window so the client doesn't
  // assume the default 200K (which makes a 1M model read "context 100%" far too early). For Codex
  // the native config is ~/.codex/config.toml (what the standalone CLI actually reads); we also keep
  // a legacy .env for older OpenAI-style tooling, but report the config.toml path since that's the
  // one that matters.
  const applyClient = (clientKind: SetupClient, scope: Scope, model: string) => {
    if (clientKind === "claude") {
      const r = applyClaude(scope, claudeCopilotReverseEnv(anthropicBase, "copilot-reverse-local", model, modelLimits[model]));
      writeClientSetup(dataDir(), { ...readClientSetup(dataDir()), claude: true });
      return r;
    }
    applyCodex(scope, { OPENAI_BASE_URL: openaiBase, OPENAI_API_KEY: "copilot-reverse-local", OPENAI_MODEL: model }); // legacy .env
    const toml = applyCodexToml({ baseUrl: openaiBase, model, contextWindow: modelLimits[model], apiKey: "copilot-reverse-local" });
    writeClientSetup(dataDir(), { ...readClientSetup(dataDir()), codex: true });
    return toml; // the native config Codex reads — surface this path in the setup card
  };
  const setup = { apply: async (clientKind: SetupClient, scope: Scope, model: string) => applyClient(clientKind, scope, model) };

  const onChat = makeOnChat(
    {
      client, workerBaseUrl: anthropicBase, apiKey: "copilot-reverse-local", model: DEFAULT_MODEL,
      maxInputTokens: DEFAULT_MAX_INPUT_TOKENS, modelLimits,
      listModels: loadModels,
      setupClient: async (c, s, m) => applyClient(c, s, m),
    },
    (c, p, print, abort) => runAssistantTurn(c, p, print, undefined, abort),
    undefined,
    // Pre-flight auth gate: block a turn (with an actionable hint) when there's no GitHub token, or
    // the stored one no longer exchanges for a Copilot token — instead of firing a request that just
    // hangs until the turn timeout. Reuses the long-lived tokenStore so a valid login is a cached,
    // round-trip-free check between message bursts (its get() caches with a 60s skew).
    async () => {
      if (!readGhToken(dataDir())) return "you're signed out — run /login to sign in before chatting";
      try { await tokenStore.get(); return null; }
      catch { return "your GitHub login has expired — run /login to sign in again"; }
    },
  );

  const persistedModel = readChatModel(dataDir());

  // Startup overview. The token was already validated above (re-auth happens before we get here), so
  // GitHub is connected; web search readiness and configured clients are read from disk.
  const clientStatus = readClientStatus();
  const startupStatus = summarizeStatus({
    hasToken: Boolean(readGhToken(dataDir())),
    tokenValid: true,
    webSearch: resolveWebSearchBackend(readWebSearchMode(dataDir()), Boolean(readWebIqKey(dataDir()))),
    worker: "ready",
    clients: { claude: clientStatus.claude.user || clientStatus.claude.project, codex: clientStatus.codex.user || clientStatus.codex.project },
  });

  app = render(
    React.createElement(App, {
      registry,
      title: "copilot-reverse",
      initialModel: persistedModel ?? DEFAULT_MODEL,
      statusSource: () => client.status(),
      readStatus: () => readClientStatus(),
      modelLimits,
      onChat,
      loadModels,
      setup,
      info: {
        openai: openaiBase,
        anthropic: anthropicBase,
        supervisorPort: cfg.supervisorPort,
        workerPort: cfg.workerPort,
        dataDir: dataDir(),
      },
      onModelChange: (m: string) => writeChatModel(dataDir(), m),
      pickModelOnStart: !persistedModel,
      login: doLogin,
      enableWebiq: (k: string) => { writeWebIqKey(k, dataDir()); writeWebSearchMode(dataDir(), "webiq"); },
      disableWebiq: () => { clearWebIqKey(dataDir()); },
      webSearchBackend: () => resolveWebSearchBackend(readWebSearchMode(dataDir()), Boolean(readWebIqKey(dataDir()))),
      startupStatus,
      githubStatus: async () => {
        const token = readGhToken(dataDir());
        if (!token) return "signed-out";
        return (await isCopilotTokenValid(token)) ? "connected" : "expired";
      },
    }),
  );
}

const program = new Command();
program.name("copilot-reverse").description("copilot-reverse: interactive Copilot proxy").version(APP_VERSION);
program.command("login").description("GitHub device-code login").action(() => runDeviceLogin(dataDir()));
program.action(() => { void launchTui(); });
program.parseAsync(process.argv);
