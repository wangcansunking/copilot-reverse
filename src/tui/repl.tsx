import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.js";

export interface CommandHint { name: string; describe: string }

// Input with a Claude-Code-style slash-command autocomplete dropdown.
// Editing is end-of-line (append/backspace) for reliability; arrows navigate the
// suggestion list, Tab completes the highlighted command, Enter submits.
export function Repl({ onSubmit, commands = [] }: { onSubmit: (line: string) => void; commands?: CommandHint[] }) {
  const [value, setValue] = useState("");
  const [sel, setSel] = useState(0);

  const typingCommand = value.startsWith("/") && !value.includes(" ");
  const matches = typingCommand ? commands.filter((c) => c.name.startsWith(value)).slice(0, 8) : [];
  const selIdx = matches.length ? ((sel % matches.length) + matches.length) % matches.length : 0;

  useInput((input, key) => {
    if (key.return) {
      const line = value;
      setValue(""); setSel(0);
      if (line.trim()) onSubmit(line);
      return;
    }
    if (key.tab && matches.length) { setValue(matches[selIdx].name + " "); setSel(0); return; }
    if (matches.length && (key.upArrow || key.downArrow)) { setSel((s) => s + (key.upArrow ? -1 : 1)); return; }
    if (key.backspace || key.delete) { setValue((v) => v.slice(0, -1)); setSel(0); return; }
    if (input && !key.ctrl && !key.meta) { setValue((v) => v + input); setSel(0); }
  });

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text color={theme.prompt}>{"› "}</Text>
        <Text>{value}</Text>
        <Text inverse> </Text>
        {value.length === 0 && <Text color={theme.muted}> type a message · / for commands</Text>}
      </Box>
      {matches.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {matches.map((c, i) => (
            <Text key={c.name}>
              <Text color={i === selIdx ? theme.accent : theme.muted}>{i === selIdx ? "❯ " : "  "}</Text>
              <Text color={i === selIdx ? theme.accent : theme.output} bold={i === selIdx}>{c.name.padEnd(16)}</Text>
              <Text color={theme.muted}>{c.describe}</Text>
            </Text>
          ))}
          <Text color={theme.muted}>  ↑↓ navigate · tab complete · enter run</Text>
        </Box>
      )}
    </Box>
  );
}
