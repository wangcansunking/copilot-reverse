import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Select } from "../components/select.js";
import { theme } from "../theme.js";

export function ModelScreen({ loadModels, current, onPick, onCancel }: {
  loadModels: () => Promise<string[]>;
  current: string;
  onPick: (model: string) => void;
  onCancel: () => void;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  useEffect(() => { loadModels().then(setModels).catch(() => setModels([])); }, []);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>select chat model</Text>
      {!models ? (
        <Text color={theme.muted}>loading models from Copilot…</Text>
      ) : (
        <Select
          items={models.map((m) => ({ label: m === current ? `${m}  (current)` : m, value: m }))}
          onSubmit={(v) => onPick(v.value)}
          onCancel={onCancel}
        />
      )}
    </Box>
  );
}
