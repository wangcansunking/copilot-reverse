import React, { useState } from "react";
import { Box, Text } from "ink";
import { Repl } from "./repl.js";
import type { Registry } from "./slash/registry.js";
import type { WorkerState } from "../shared/control-types.js";

export interface AppProps {
  registry: Registry;
  title: string;
  // current worker state for the header badge; defaults to "starting".
  workerState?: WorkerState;
  // optional natural-language handler (wired in M1c); default echoes a hint.
  onChat?: (text: string, print: (line: string) => void) => Promise<void>;
}

// UX spec §6 — worker-state word color mapping.
const stateColor: Record<WorkerState, string> = {
  ready: "green",
  starting: "yellow",
  crashed: "redBright",
  unhealthy: "red",
};

function HeaderBar({ title, workerState }: { title: string; workerState: WorkerState }) {
  return (
    <Box justifyContent="space-between">
      <Text>{title}</Text>
      <Text>
        worker: <Text color={stateColor[workerState]}>{workerState}</Text>
      </Text>
    </Box>
  );
}

export function App({ registry, title, workerState = "starting", onChat }: AppProps) {
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
      <HeaderBar title={title} workerState={workerState} />
      <Box flexDirection="column">
        {lines.map((l, i) => (
          <Text key={i}>{l}</Text>
        ))}
      </Box>
      <Repl onSubmit={handle} />
    </Box>
  );
}
