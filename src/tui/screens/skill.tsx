import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Select } from "../components/select.js";
import { theme } from "../theme.js";
import type { Scope, ApplyResult } from "../setup/apply.js";
import { SKILL_CATALOG, type SkillEntry } from "../skills/catalog.js";

type Step = "pick" | "scope" | "applying" | "done" | "error";

export interface SkillScreenProps {
  // Install the chosen skill at the chosen scope. Injected so the App owns the real FS write (and tests
  // can stub it) — same split as the setup wizard's `apply`.
  install: (scope: Scope, entry: SkillEntry) => Promise<ApplyResult>;
  onDone: (result: ApplyResult, entry: SkillEntry, scope: Scope) => void;
  onCancel: () => void;
  catalog?: SkillEntry[]; // overridable for tests; defaults to the bundled catalog
}

function Dismiss({ onDismiss }: { onDismiss: () => void }) {
  useInput(() => onDismiss());
  return <Text color={theme.muted}>press any key to continue</Text>;
}

export function SkillScreen({ install, onDone, onCancel, catalog = SKILL_CATALOG }: SkillScreenProps) {
  const [step, setStep] = useState<Step>("pick");
  const [entry, setEntry] = useState<SkillEntry | null>(null);
  const [scope, setScope] = useState<Scope>("global");
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [err, setErr] = useState("");

  async function doInstall(s: Scope, e: SkillEntry) {
    setScope(s);
    setStep("applying");
    try { const r = await install(s, e); setResult(r); setStep("done"); }
    catch (x) { setErr(x instanceof Error ? x.message : String(x)); setStep("error"); }
  }

  const heading = step === "pick" ? "choose a skill" : step === "scope" ? "choose scope" : "";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>install skill{heading ? `  ·  ${heading}` : ""}</Text>

      {step === "pick" && (
        catalog.length === 0
          ? <Box flexDirection="column"><Text color={theme.muted}>no skills bundled</Text><Dismiss onDismiss={onCancel} /></Box>
          : <Select
              items={catalog.map((s) => ({ label: `${s.title}`, value: s.name }))}
              onSubmit={(v) => { const e = catalog.find((s) => s.name === v.value)!; setEntry(e); setStep("scope"); }}
              onCancel={onCancel}
            />
      )}

      {step === "scope" && entry && (
        <Box flexDirection="column">
          <Text color={theme.muted}>{entry.description}</Text>
          <Select
            items={[
              { label: "global   — this machine, all projects", value: "global" },
              { label: "project  — current directory only", value: "project" },
            ]}
            onSubmit={(v) => void doInstall(v.value as Scope, entry)}
            onCancel={onCancel}
          />
        </Box>
      )}

      {step === "applying" && <Text color={theme.muted}>installing…</Text>}

      {step === "done" && result && entry && (
        <Box flexDirection="column">
          <Text color={theme.ready}>✓ installed · {entry.title}</Text>
          <Text color={theme.output}>wrote {result.path}</Text>
          <Text color={theme.muted}>files: {result.changed.join(", ") || "(already up to date)"}</Text>
          <Dismiss onDismiss={() => onDone(result, entry, scope)} />
        </Box>
      )}

      {step === "error" && (
        <Box flexDirection="column">
          <Text color={theme.error}>failed: {err}</Text>
          <Dismiss onDismiss={onCancel} />
        </Box>
      )}
    </Box>
  );
}
