#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { App } from "../tui/app.js";
import { buildRegistry } from "../tui/slash/commands.js";
import { DaemonClient } from "../tui/daemon-client.js";
import { runDeviceLogin } from "./auth.js";
import { ensureDaemon, spawnSupervisor, probeSupervisor } from "../daemon/lifecycle.js";
import { runAssistantTurn } from "../tui/assistant/runtime.js";
import { makeOnChat } from "../tui/assistant/on-chat.js";
import { readGhToken } from "../shared/creds.js";
import { dataDir } from "../shared/paths.js";
import { defaultConfig } from "../shared/config.js";

async function launchTui(): Promise<void> {
  const cfg = defaultConfig();
  // First-run login + daemon-start run as plain stdout, before Ink takes over (UX spec §7-8).
  if (!readGhToken(dataDir())) {
    console.log("No GitHub login found — starting device-code login.");
    await runDeviceLogin(dataDir());
  }
  console.log("daemon starting…");
  await ensureDaemon({ spawn: spawnSupervisor, probe: () => probeSupervisor(), retries: 40, delayMs: 250 });

  const base = `http://${cfg.bindHost}:${cfg.supervisorPort}`;
  const client = new DaemonClient(base);
  const endpoint = { host: cfg.bindHost, port: cfg.workerPort, apiKey: "maestro-local" };
  let app: { unmount: () => void } | undefined;
  const registry = buildRegistry({ client, quit: () => app?.unmount() }, endpoint);
  const onChat = makeOnChat(
    { client, workerBaseUrl: `http://${cfg.bindHost}:${cfg.workerPort}`, apiKey: "maestro-local", model: "claude-opus-4-8" },
    runAssistantTurn,
  );
  app = render(React.createElement(App, { registry, title: "llm-maestro", onChat }));
}

const program = new Command();
program.name("maestro").description("llm-maestro: interactive Copilot proxy").version("0.0.1");
program.command("login").description("GitHub device-code login").action(() => runDeviceLogin(dataDir()));
program.action(() => { void launchTui(); });
program.parseAsync(process.argv);
