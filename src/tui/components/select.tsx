import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";

export interface SelectItem { label: string; value: string }

// Arrow-navigable single-select list. Only one Select should be mounted at a time
// (its useInput captures keystrokes).
export function Select({ items, onSubmit, onCancel }: {
  items: SelectItem[];
  onSubmit: (item: SelectItem) => void;
  onCancel?: () => void;
}) {
  const [idx, setIdx] = useState(0);
  useInput((_input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (key.return) onSubmit(items[idx]);
    else if (key.escape) onCancel?.();
  });
  return (
    <Box flexDirection="column">
      {items.map((it, i) => (
        <Text key={it.value} color={i === idx ? theme.accent : theme.output} bold={i === idx}>
          {i === idx ? "❯ " : "  "}{it.label}
        </Text>
      ))}
      <Text color={theme.muted}>↑↓ select · enter confirm · esc cancel</Text>
    </Box>
  );
}
