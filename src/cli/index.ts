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
import { readClientSetup } from "../shared/client-setup.js";
import { dataDir } from "../shared/paths.js";
import { defaultConfig } from "../shared/config.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_MODEL = "claude-opus-4-8";

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
  const endpoint = { host: cfg.bindHost, port: cfg.workerPort, apiKey: "maestro-local" };
  let app: { unmount: () => void } | undefined;
  const quit = () => { stopSupervisor?.(); app?.unmount(); process.exit(0); };
  const registry = buildRegistry({ client, quit }, endpoint);
  const onChat = makeOnChat(
    { client, workerBaseUrl: `http://${cfg.bindHost}:${cfg.workerPort}`, apiKey: "maestro-local", model: DEFAULT_MODEL },
    runAssistantTurn,
  );

  app = render(
    React.createElement(App, {
      registry,
      title: "llm-maestro",
      model: DEFAULT_MODEL,
      clients: readClientSetup(dataDir()),
      statusSource: () => client.status(),
      onChat,
    }),
  );
}

const program = new Command();
program.name("maestro").description("llm-maestro: interactive Copilot proxy").version("0.0.1");
program.command("login").description("GitHub device-code login").action(() => runDeviceLogin(dataDir()));
program.action(() => { void launchTui(); });
program.parseAsync(process.argv);
