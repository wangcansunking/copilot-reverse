import React from "react";
import { Box, Text } from "ink";
import { aggregate } from "./metrics-agg.js";
import type { MetricSample } from "../../shared/control-types.js";

export function MetricsPanel({ samples }: { samples: MetricSample[] }) {
  const a = aggregate(samples);
  return (
    <Box flexDirection="column">
      <Text>requests: {a.total}  errors: {a.errors}</Text>
      {a.byModel.map((r) => (
        <Text key={r.model}>  {r.model.padEnd(20)} n={r.count} avg={r.avgMs}ms</Text>
      ))}
    </Box>
  );
}
