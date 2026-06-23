#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { App } from "../tui/app.js";
import { buildRegistry } from "../tui/slash/commands.js";
import { DaemonClient } from "../tui/daemon-client.js";
import { runDeviceLogin } from "./auth.js";
import { probeSupervisor } from "../daemon/lifecycle.js";
import { startSupervisor } from "../supervisor/index.js";
import { runAssistantTurn } from "../tui/assistant/runtime.js";
import { makeOnChat } from "../tui/assistant/on-chat.js";
import { readGhToken, clearGhToken } from "../shared/creds.js";
import { readClientSetup, writeClientSetup } from "../shared/client-setup.js";
import { readChatModel, writeChatModel } from "../shared/prefs.js";
import { CopilotTokenStore, isCopilotTokenValid } from "../providers/copilot/token.js";
import { fetchCopilotModels, fetchModelLimits } from "../providers/copilot/models.js";
import { applyClaude, applyCodex, resetClaude, resetCodex, CLAUDE_ENV_KEYS, CODEX_ENV_KEYS, type Scope } from "../tui/setup/apply.js";
import { readClientStatus } from "../tui/setup/status.js";
import { applyCodexToml } from "../tui/setup/codex-toml.js";
import type { SetupClient } from "../tui/setup/wizard.js";
import { claudeCopilotReverseEnv } from "../tui/setup/clients.js";
import { dataDir } from "../shared/paths.js";
import { defaultConfig } from "../shared/config.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_MODEL = "gpt-4o"; // a valid Copilot model id; pass-through routing uses it as-is
// Conservative context budget that drives the assistant's auto-compaction. Sized below the
// common Copilot prompt window (gpt-4o ≈ 128K) so the engine compacts before the upstream
// rejects an over-long turn. TODO: read each model's real max_prompt_tokens from /models.
const DEFAULT_MAX_INPUT_TOKENS = 110_000;

async function launchTui(): Promise<void> {
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
    appVersion: "0.1.0",
    platform: `${process.platform} node-${process.version}`,
    resetClient,
    // Re-run device-code login, then restart the worker so it picks up the new token.
    login: async () => {
      const lines: string[] = [];
      await runDeviceLogin(dataDir(), fetch, (m) => lines.push(m));
      await client.restart().catch(() => {});
      lines.push("worker restarting with the new token");
      return lines;
    },
    // Clear the stored token and restart the worker (it will report unauthenticated until re-login).
    logout: async () => {
      clearGhToken(dataDir());
      await client.restart().catch(() => {});
      return ["signed out — GitHub token removed", "run /login to sign in again"];
    },
  });
  // Filled in below once we have a token; the assistant prefers a model's real window over the default.
  const modelLimits: Record<string, number> = {};
  const tokenStore = new CopilotTokenStore(readGhToken(dataDir())!);
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
  // assume the default 200K (which makes a 1M model read "context 100%" far too early). For Codex
  // we write BOTH a .env (legacy) and ~/.codex/config.toml (the native Codex config, with the
  // model's context window) so either Codex setup style works.
  const applyClient = (clientKind: SetupClient, scope: Scope, model: string) => {
    if (clientKind === "claude") {
      const r = applyClaude(scope, claudeCopilotReverseEnv(anthropicBase, "copilot-reverse-local", model, modelLimits[model]));
      writeClientSetup(dataDir(), { ...readClientSetup(dataDir()), claude: true });
      return r;
    }
    const r = applyCodex(scope, { OPENAI_BASE_URL: openaiBase, OPENAI_API_KEY: "copilot-reverse-local", OPENAI_MODEL: model });
    applyCodexToml({ baseUrl: openaiBase, model, contextWindow: modelLimits[model] });
    writeClientSetup(dataDir(), { ...readClientSetup(dataDir()), codex: true });
    return r;
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
  );

  const persistedModel = readChatModel(dataDir());

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
    }),
  );
}

const program = new Command();
program.name("copilot-reverse").description("copilot-reverse: interactive Copilot proxy").version("0.1.0");
program.command("login").description("GitHub device-code login").action(() => runDeviceLogin(dataDir()));
program.action(() => { void launchTui(); });
program.parseAsync(process.argv);
