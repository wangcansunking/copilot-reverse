import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export function Repl({ onSubmit }: { onSubmit: (line: string) => void }) {
  const [value, setValue] = useState("");
  useInput((input, key) => {
    if (key.return) { const line = value; setValue(""); if (line.trim()) onSubmit(line); return; }
    if (key.backspace || key.delete) { setValue((v) => v.slice(0, -1)); return; }
    if (input && !key.ctrl && !key.meta) setValue((v) => v + input);
  });
  return (
    <Box>
      <Text color="cyan">{"› "}</Text>
      <Text>{value}</Text>
    </Box>
  );
}
