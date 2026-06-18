import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Repl, type CommandHint } from "./repl.js";
import { SetupWizard, type SetupClient } from "./setup/wizard.js";
import { ModelScreen } from "./screens/model.js";
import { ConfigScreen, type ConfigInfo } from "./screens/config.js";
import type { Scope, ApplyResult } from "./setup/apply.js";
import { theme } from "./theme.js";
import type { Registry } from "./slash/registry.js";
import type { WorkerState, StatusResponse } from "../shared/control-types.js";

type Entry =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string; streaming?: boolean }
  | { type: "system"; text: string }
  | { type: "card"; title: string; tone: "info" | "ok" | "error"; lines: string[] }
  | { type: "help"; commands: CommandHint[] };

type Screen = { kind: "model" } | { kind: "setup"; client: SetupClient } | { kind: "config" } | null;

const stateColor: Record<WorkerState, string> = {
  ready: theme.ready, starting: theme.starting, crashed: theme.crashed, unhealthy: theme.unhealthy,
};

export interface AppProps {
  registry: Registry;
  title: string;
  workerState?: WorkerState;
  initialModel?: string;
  clients?: { claude: boolean; codex: boolean };
  statusSource?: () => Promise<StatusResponse>;
  onChat?: (text: string, print: (line: string) => void, model?: string) => Promise<void>;
  loadModels?: () => Promise<string[]>;
  setup?: { apply: (client: SetupClient, scope: Scope, model: string) => Promise<ApplyResult> };
  info?: ConfigInfo;
  onModelChange?: (model: string) => void;
  pickModelOnStart?: boolean;
}

const okDot = (ok: boolean) => (ok ? theme.ready : theme.muted);

function OutputCard({ title, lines, tone }: { title: string; lines: string[]; tone: "info" | "ok" | "error" }) {
  const border = tone === "error" ? theme.error : tone === "ok" ? theme.ready : theme.border;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>{title}</Text>
      {lines.map((l, i) => {
        const m = /^(OK|FAIL)\s+(.*)$/.exec(l);
        if (m) {
          const ok = m[1] === "OK";
          return (
            <Text key={i}>
              <Text color={ok ? theme.ready : theme.error}>{ok ? "✓ " : "✗ "}</Text>
              <Text color={theme.output}>{m[2]}</Text>
            </Text>
          );
        }
        return <Text key={i} color={theme.output}>{l}</Text>;
      })}
    </Box>
  );
}

function HelpCard({ commands }: { commands: CommandHint[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>Commands</Text>
      {commands.map((c) => (
        <Text key={c.name}>
          <Text color={theme.prompt}>{c.name.padEnd(16)}</Text>
          <Text color={theme.muted}>{c.describe}</Text>
        </Text>
      ))}
      <Text color={theme.muted}>tip: type / to autocomplete · plain text talks to the assistant</Text>
    </Box>
  );
}

export function App({
  registry, title, workerState = "starting", initialModel = "—",
  clients = { claude: false, codex: false }, statusSource, onChat,
  loadModels, setup, info, onModelChange, pickModelOnStart,
}: AppProps) {
  const cmds: CommandHint[] = registry.list().map((c) => ({ name: c.name, describe: c.describe }));
  const [entries, setEntries] = useState<Entry[]>([
    { type: "system", text: "Type a message to chat with the assistant, or /help for commands." },
  ]);
  const [state, setState] = useState<WorkerState>(workerState);
  const [clientState, setClientState] = useState(clients);
  const [model, setModel] = useState(initialModel);
  const [screen, setScreen] = useState<Screen>(pickModelOnStart && loadModels ? { kind: "model" } : null);
  const add = (e: Entry) => setEntries((p) => [...p, e].slice(-100));

  useEffect(() => {
    if (!statusSource) return;
    let alive = true;
    const tick = async () => {
      try { const s = await statusSource(); if (alive) setState(s.workerState); } catch { /* daemon momentarily down */ }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [statusSource]);

  function pickModel(m: string) {
    setModel(m);
    onModelChange?.(m);
    setScreen(null);
    add({ type: "card", title: "model", tone: "ok", lines: [`✓ chat model set to ${m}`] });
  }

  async function handle(line: string) {
    add({ type: "user", text: `› ${line}` });
    const t = line.trim();
    if (t === "/model" && loadModels) { setScreen({ kind: "model" }); return; }
    if (t === "/config" && info) { setScreen({ kind: "config" }); return; }
    if (setup && loadModels && (t === "/setup-claude" || t === "/setup-codex")) {
      setScreen({ kind: "setup", client: t === "/setup-claude" ? "claude" : "codex" });
      return;
    }
    if (line.startsWith("/")) {
      if (t === "/help") { add({ type: "help", commands: cmds }); return; }
      const out = await registry.run(line);
      const tone: "info" | "ok" | "error" =
        out.some((l) => /fail|error|unknown/i.test(l)) ? "error" : out.some((l) => /^OK /.test(l)) ? "ok" : "info";
      add({ type: "card", title: t, tone, lines: out });
      // reflect a successful reset in the HUD badge
      if (t === "/reset-claude") setClientState((c) => ({ ...c, claude: false }));
      else if (t === "/reset-codex") setClientState((c) => ({ ...c, codex: false }));
    } else if (onChat) {
      // Open one streaming bubble immediately (shows a loading indicator), then append each
      // delta into it in place rather than spawning a new line per chunk.
      add({ type: "assistant", text: "", streaming: true });
      const append = (chunk: string) =>
        setEntries((p) => {
          const copy = [...p];
          for (let i = copy.length - 1; i >= 0; i--) {
            const e = copy[i];
            if (e.type === "assistant" && e.streaming) { copy[i] = { ...e, text: e.text + chunk }; break; }
          }
          return copy;
        });
      try {
        await onChat(line, append, model);
      } finally {
        setEntries((p) => p.map((e) => (e.type === "assistant" && e.streaming ? { ...e, streaming: false } : e)));
      }
    } else {
      add({ type: "system", text: "(assistant not available — use /help)" });
    }
  }

  let body: React.ReactNode;
  if (screen?.kind === "model" && loadModels) {
    body = <ModelScreen loadModels={loadModels} current={model} onPick={pickModel} onCancel={() => setScreen(null)} />;
  } else if (screen?.kind === "setup" && setup && loadModels) {
    const client = screen.client;
    body = (
      <SetupWizard
        client={client}
        loadModels={loadModels}
        apply={(scope, m) => setup.apply(client, scope, m)}
        onDone={(result, m) => {
          setClientState((c) => ({ ...c, [client]: true }));
          setScreen(null);
          add({ type: "card", title: `setup ${client}`, tone: "ok", lines: [`✓ model ${m}`, `wrote ${result.path}`, `keys: ${result.changed.join(", ") || "(no change)"}`] });
        }}
        onCancel={() => { setScreen(null); add({ type: "system", text: "setup cancelled" }); }}
      />
    );
  } else if (screen?.kind === "config" && info) {
    body = (
      <ConfigScreen
        info={info}
        model={model}
        clients={clientState}
        onAction={(a) => {
          if (a === "model") setScreen({ kind: "model" });
          else if (a === "setup-claude") setScreen({ kind: "setup", client: "claude" });
          else if (a === "setup-codex") setScreen({ kind: "setup", client: "codex" });
          else setScreen(null);
        }}
      />
    );
  } else {
    body = <Repl onSubmit={handle} commands={cmds} />;
  }

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" paddingX={1}>
        <Text color={theme.accent} bold>✳ {title}</Text>
        <Text color={theme.muted}>worker: <Text color={stateColor[state]}>{state}</Text></Text>
      </Box>

      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {entries.map((e, i) => {
          if (e.type === "card") return <OutputCard key={i} title={e.title} lines={e.lines} tone={e.tone} />;
          if (e.type === "help") return <HelpCard key={i} commands={e.commands} />;
          const color = e.type === "user" ? theme.user : e.type === "assistant" ? theme.assistant : theme.muted;
          if (e.type === "assistant" && e.streaming) {
            // loading "…" before the first delta lands, then a "▍" cursor as text streams in
            return <Text key={i} color={color}>{e.text}<Text color={theme.muted}>{e.text ? "▍" : "…"}</Text></Text>;
          }
          return <Text key={i} color={color}>{e.text}</Text>;
        })}
      </Box>

      {body}

      <Box paddingX={1}>
        <Text color={theme.muted}>model </Text><Text color={theme.accent}>{model}</Text>
        <Text color={theme.muted}>  ·  daemon </Text><Text color={stateColor[state]}>{state}</Text>
        <Text color={theme.muted}>  ·  claude </Text><Text color={okDot(clientState.claude)}>{clientState.claude ? "✓" : "○"}</Text>
        <Text color={theme.muted}> codex </Text><Text color={okDot(clientState.codex)}>{clientState.codex ? "✓" : "○"}</Text>
        <Text color={theme.muted}>  ·  /help</Text>
      </Box>
    </Box>
  );
}
