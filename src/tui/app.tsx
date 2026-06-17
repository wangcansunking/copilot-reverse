import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Repl, type CommandHint } from "./repl.js";
import { SetupWizard, type SetupClient } from "./setup/wizard.js";
import type { Scope, ApplyResult } from "./setup/apply.js";
import { theme } from "./theme.js";
import type { Registry } from "./slash/registry.js";
import type { WorkerState, StatusResponse } from "../shared/control-types.js";

type Entry =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "system"; text: string }
  | { type: "card"; title: string; tone: "info" | "ok" | "error"; lines: string[] }
  | { type: "help"; commands: CommandHint[] };

const stateColor: Record<WorkerState, string> = {
  ready: theme.ready, starting: theme.starting, crashed: theme.crashed, unhealthy: theme.unhealthy,
};

export interface AppProps {
  registry: Registry;
  title: string;
  workerState?: WorkerState;
  model?: string;
  clients?: { claude: boolean; codex: boolean };
  statusSource?: () => Promise<StatusResponse>;
  onChat?: (text: string, print: (line: string) => void) => Promise<void>;
  setup?: {
    loadModels: () => Promise<string[]>;
    apply: (client: SetupClient, scope: Scope, model: string) => Promise<ApplyResult>;
  };
}

const okDot = (ok: boolean) => (ok ? theme.ready : theme.muted);

// Each command result renders as a bordered card; OK/FAIL lines become a ✓/✗ checklist (step feel).
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
  registry, title, workerState = "starting", model = "—",
  clients = { claude: false, codex: false }, statusSource, onChat, setup,
}: AppProps) {
  const cmds: CommandHint[] = registry.list().map((c) => ({ name: c.name, describe: c.describe }));
  const [entries, setEntries] = useState<Entry[]>([
    { type: "system", text: "Type a message to chat with the assistant, or /help for commands." },
  ]);
  const [state, setState] = useState<WorkerState>(workerState);
  const [clientState, setClientState] = useState(clients);
  const [wizard, setWizard] = useState<SetupClient | null>(null);
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

  async function handle(line: string) {
    add({ type: "user", text: `› ${line}` });
    const t = line.trim();
    if (setup && (t === "/setup-claude" || t === "/setup-codex")) {
      setWizard(t === "/setup-claude" ? "claude" : "codex");
      return;
    }
    if (line.startsWith("/")) {
      if (line.trim() === "/help") { add({ type: "help", commands: cmds }); return; }
      const out = await registry.run(line);
      const tone: "info" | "ok" | "error" =
        out.some((l) => /fail|error|unknown/i.test(l)) ? "error" : out.some((l) => /^OK /.test(l)) ? "ok" : "info";
      add({ type: "card", title: line.trim(), tone, lines: out });
    } else if (onChat) {
      await onChat(line, (l) => add({ type: "assistant", text: l }));
    } else {
      add({ type: "system", text: "(assistant not available — use /help)" });
    }
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
          return <Text key={i} color={color}>{e.text}</Text>;
        })}
      </Box>

      {wizard && setup ? (
        <SetupWizard
          client={wizard}
          loadModels={setup.loadModels}
          apply={(scope, m) => setup.apply(wizard, scope, m)}
          onDone={(result, m) => {
            setClientState((c) => ({ ...c, [wizard]: true }));
            setWizard(null);
            add({ type: "card", title: `setup ${wizard}`, tone: "ok", lines: [`✓ model ${m}`, `wrote ${result.path}`, `keys: ${result.changed.join(", ") || "(no change)"}`] });
          }}
          onCancel={() => { setWizard(null); add({ type: "system", text: "setup cancelled" }); }}
        />
      ) : (
        <Repl onSubmit={handle} commands={cmds} />
      )}

      <Box paddingX={1}>
        <Text color={theme.muted}>model </Text><Text color={theme.accent}>{model}</Text>
        <Text color={theme.muted}>  ·  daemon </Text><Text color={stateColor[state]}>{state}</Text>
        <Text color={theme.muted}>  ·  claude </Text><Text color={okDot(clientState.claude)}>{clientState.claude ? "✓" : "○"}</Text>
        <Text color={theme.muted}> codex </Text><Text color={okDot(clientState.codex)}>{clientState.codex ? "✓" : "○"}</Text>
        <Text color={theme.muted}>  ·  /help for commands</Text>
      </Box>
    </Box>
  );
}
