import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Repl } from "./repl.js";
import { theme } from "./theme.js";
import type { Registry } from "./slash/registry.js";
import type { WorkerState, StatusResponse } from "../shared/control-types.js";

type LineKind = "user" | "assistant" | "output" | "system" | "error";
interface Line { kind: LineKind; text: string }

const stateColor: Record<WorkerState, string> = {
  ready: theme.ready, starting: theme.starting, crashed: theme.crashed, unhealthy: theme.unhealthy,
};
const kindColor: Record<LineKind, string> = {
  user: theme.user, assistant: theme.assistant, output: theme.output, system: theme.muted, error: theme.error,
};

export interface AppProps {
  registry: Registry;
  title: string;
  workerState?: WorkerState;
  model?: string;
  clients?: { claude: boolean; codex: boolean };
  // when provided, the header + HUD poll it for live worker/daemon status.
  statusSource?: () => Promise<StatusResponse>;
  onChat?: (text: string, print: (line: string) => void) => Promise<void>;
}

const okDot = (ok: boolean) => (ok ? theme.ready : theme.muted);

export function App({
  registry, title, workerState = "starting", model = "—",
  clients = { claude: false, codex: false }, statusSource, onChat,
}: AppProps) {
  const [lines, setLines] = useState<Line[]>([
    { kind: "system", text: "Type a message to chat with the assistant, or /help for commands." },
  ]);
  const [state, setState] = useState<WorkerState>(workerState);
  const push = (kind: LineKind, text: string) => setLines((p) => [...p, { kind, text }].slice(-200));

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
    push("user", `› ${line}`);
    if (line.startsWith("/")) {
      const out = await registry.run(line);
      for (const l of out) push(/fail|error|unknown/i.test(l) ? "error" : "output", l);
    } else if (onChat) {
      await onChat(line, (l) => push("assistant", l));
    } else {
      push("system", "(assistant not available — use /help)");
    }
  }

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" paddingX={1}>
        <Text color={theme.accent} bold>✳ {title}</Text>
        <Text color={theme.muted}>worker: <Text color={stateColor[state]}>{state}</Text></Text>
      </Box>

      <Box flexDirection="column" paddingX={1} marginTop={1} marginBottom={1}>
        {lines.map((l, i) => (<Text key={i} color={kindColor[l.kind]}>{l.text}</Text>))}
      </Box>

      <Repl onSubmit={handle} commands={registry.list().map((c) => ({ name: c.name, describe: c.describe }))} />

      <Box paddingX={1}>
        <Text color={theme.muted}>model </Text><Text color={theme.accent}>{model}</Text>
        <Text color={theme.muted}>  ·  daemon </Text><Text color={stateColor[state]}>{state}</Text>
        <Text color={theme.muted}>  ·  claude </Text><Text color={okDot(clients.claude)}>{clients.claude ? "✓" : "○"}</Text>
        <Text color={theme.muted}> codex </Text><Text color={okDot(clients.codex)}>{clients.codex ? "✓" : "○"}</Text>
        <Text color={theme.muted}>  ·  /help for commands</Text>
      </Box>
    </Box>
  );
}
