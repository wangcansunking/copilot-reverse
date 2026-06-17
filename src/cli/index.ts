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
import { readGhToken } from "../shared/creds.js";
import { readClientSetup, writeClientSetup } from "../shared/client-setup.js";
import { readChatModel, writeChatModel } from "../shared/prefs.js";
import { CopilotTokenStore } from "../providers/copilot/token.js";
import { fetchCopilotModels } from "../providers/copilot/models.js";
import { applyClaude, applyCodex, type Scope } from "../tui/setup/apply.js";
import type { SetupClient } from "../tui/setup/wizard.js";
import { dataDir } from "../shared/paths.js";
import { defaultConfig } from "../shared/config.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_MODEL = "gpt-4o"; // a valid Copilot model id; pass-through routing uses it as-is

async function launchTui(): Promise<void> {
  const cfg = defaultConfig();
  if (!readGhToken(dataDir())) {
    console.log("No GitHub login found — starting device-code login.");
    await runDeviceLogin(dataDir());
  }

  // Run the daemon IN-PROCESS — no separate console window pops up. Reuse one if already running.
  let stopSupervisor: (() => void) | undefined;
  if (!(await probeSupervisor())) {
    process.stdout.write("starting maestro…\n");
    stopSupervisor = startSupervisor().stop;
    for (let i = 0; i < 60 && !(await probeSupervisor()); i++) await delay(100);
  }

  const base = `http://${cfg.bindHost}:${cfg.supervisorPort}`;
  const client = new DaemonClient(base);
  const workerBase = `http://${cfg.bindHost}:${cfg.workerPort}`;
  const endpoint = { host: cfg.bindHost, port: cfg.workerPort, apiKey: "maestro-local" };
  let app: { unmount: () => void } | undefined;
  const quit = () => { stopSupervisor?.(); app?.unmount(); process.exit(0); };
  const registry = buildRegistry({ client, quit }, endpoint);
  const onChat = makeOnChat(
    { client, workerBaseUrl: workerBase, apiKey: "maestro-local", model: DEFAULT_MODEL },
    runAssistantTurn,
  );

  const tokenStore = new CopilotTokenStore(readGhToken(dataDir())!);
  const loadModels = async () => fetchCopilotModels(await tokenStore.get());
  const setup = {
    apply: async (clientKind: SetupClient, scope: Scope, model: string) => {
      const r = clientKind === "claude"
        ? applyClaude(scope, { ANTHROPIC_BASE_URL: workerBase, ANTHROPIC_API_KEY: "maestro-local", ANTHROPIC_MODEL: model })
        : applyCodex(scope, { OPENAI_BASE_URL: `${workerBase}/v1`, OPENAI_API_KEY: "maestro-local", OPENAI_MODEL: model });
      writeClientSetup(dataDir(), { ...readClientSetup(dataDir()), [clientKind]: true });
      return r;
    },
  };

  const persistedModel = readChatModel(dataDir());

  app = render(
    React.createElement(App, {
      registry,
      title: "llm-maestro",
      initialModel: persistedModel ?? DEFAULT_MODEL,
      clients: readClientSetup(dataDir()),
      statusSource: () => client.status(),
      onChat,
      loadModels,
      setup,
      info: {
        openai: `${workerBase}/v1`,
        anthropic: workerBase,
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
program.name("maestro").description("llm-maestro: interactive Copilot proxy").version("0.0.1");
program.command("login").description("GitHub device-code login").action(() => runDeviceLogin(dataDir()));
program.action(() => { void launchTui(); });
program.parseAsync(process.argv);
