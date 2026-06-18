import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "../theme.js";

export interface SelectItem { label: string; value: string }

// Arrow-navigable single-select list with a bounded, scrolling window so long lists
// (e.g. the full Copilot model list) never overflow the terminal — the highlight stays
// visible as you navigate. Only one Select should be mounted at a time.
export function Select({ items, onSubmit, onCancel, windowSize = 8 }: {
  items: SelectItem[];
  onSubmit: (item: SelectItem) => void;
  onCancel?: () => void;
  windowSize?: number;
}) {
  const [idx, setIdx] = useState(0);
  useInput((_input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (key.return) onSubmit(items[idx]);
    else if (key.escape) onCancel?.();
  });

  const n = items.length;
  const w = Math.min(windowSize, n);
  // keep the selected row inside the window
  const start = Math.max(0, Math.min(idx - Math.floor(w / 2), n - w));
  const visible = items.slice(start, start + w);

  return (
    <Box flexDirection="column">
      {start > 0 && <Text color={theme.muted}>  ↑ {start} more</Text>}
      {visible.map((it, i) => {
        const real = start + i;
        const sel = real === idx;
        return (
          <Text key={it.value} color={sel ? theme.accent : theme.output} bold={sel}>
            {sel ? "❯ " : "  "}{it.label}
          </Text>
        );
      })}
      {start + w < n && <Text color={theme.muted}>  ↓ {n - start - w} more</Text>}
      <Text color={theme.muted}>↑↓ select · enter confirm · esc cancel  ({idx + 1}/{n})</Text>
    </Box>
  );
}
