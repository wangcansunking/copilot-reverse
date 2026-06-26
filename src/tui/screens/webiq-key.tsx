import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";

// Masked single-line input for the WebIQ API key. Mirrors the Repl's end-of-line editing (append /
// backspace), but renders bullets instead of the secret. Enter submits a non-empty key; Esc cancels.
export function WebIqKeyScreen({ onSubmit, onCancel }: { onSubmit: (key: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  useInput((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) { const k = value.trim(); if (k) onSubmit(k); else onCancel(); return; }
    if (key.backspace || key.delete) { setValue((v) => v.slice(0, -1)); return; }
    if (input && !key.ctrl && !key.meta) setValue((v) => v + input);
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>web search support — paste your WebIQ API key</Text>
      <Text color={theme.muted}>enables web_search / web_fetch for connected clients · enter to save · esc to cancel</Text>
      <Box>
        <Text color={theme.prompt}>{"key › "}</Text>
        <Text>{"•".repeat(value.length)}</Text>
        <Text inverse> </Text>
      </Box>
    </Box>
  );
}
