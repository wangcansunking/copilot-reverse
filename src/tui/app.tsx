import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { loadingVerb } from "../shared/format.js";
import { Repl, type CommandHint } from "./repl.js";
import { SetupWizard, type SetupClient } from "./setup/wizard.js";
import { ModelScreen } from "./screens/model.js";
import { ConfigScreen, type ConfigInfo } from "./screens/config.js";
import { WebIqKeyScreen } from "./screens/webiq-key.js";
import type { StatusSummary } from "./status-summary.js";
import type { Scope, ApplyResult } from "./setup/apply.js";
import type { ClientStatus } from "./setup/status.js";
import { theme } from "./theme.js";
import type { Registry } from "./slash/registry.js";
import type { WorkerState, StatusResponse } from "../shared/control-types.js";

type Entry =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string; streaming?: boolean; startedAt?: number }
  | { type: "system"; text: string }
  | { type: "card"; title: string; tone: "info" | "ok" | "error"; lines: string[] }
  | { type: "help"; commands: CommandHint[] };

type Screen = { kind: "model" } | { kind: "setup"; client: SetupClient } | { kind: "config" } | { kind: "webiq-key" } | null;

const stateColor: Record<WorkerState, string> = {
  ready: theme.ready, starting: theme.starting, crashed: theme.crashed, unhealthy: theme.unhealthy,
};

const EMPTY_STATUS: ClientStatus = { claude: { user: false, project: false }, codex: { user: false, project: false } };
const SPINNER = ["✶", "✸", "✹", "✺", "✹", "✷"];

// Startup overview card. GitHub shows a login STATE (no real token expiry exists), web search shows
// whether a WebIQ key is configured with the command to fix it when not.
function statusCard(s: StatusSummary): Entry {
  const gh = s.github === "connected" ? "✓ connected" : s.github === "expired" ? "✗ expired — run /login" : "✗ signed out — run /login";
  const web = s.webSearch === "ready" ? "✓ ready" : "✗ not configured — run /web-search-support";
  const clients = `claude ${s.clients.claude ? "✓" : "○"}  codex ${s.clients.codex ? "✓" : "○"}`;
  const tone: "ok" | "error" = s.github === "connected" ? "ok" : "error";
  return { type: "card", title: "status", tone, lines: [
    `GitHub login   ${gh}`,
    `web search     ${web}`,
    `worker         ${s.worker}`,
    `clients        ${clients}`,
  ] };
}

const fmtElapsed = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

export interface AppProps {
  registry: Registry;
  title: string;
  workerState?: WorkerState;
  initialModel?: string;
  statusSource?: () => Promise<StatusResponse>;
  readStatus?: () => ClientStatus;            // reads the real config files (per user/project scope)
  modelLimits?: Record<string, number>;       // model id -> context window, shown in the picker
  onChat?: (text: string, print: (line: string) => void, model?: string, abort?: AbortController) => Promise<void>;
  loadModels?: () => Promise<string[]>;
  setup?: { apply: (client: SetupClient, scope: Scope, model: string) => Promise<ApplyResult> };
  info?: ConfigInfo;
  onModelChange?: (model: string) => void;
  pickModelOnStart?: boolean;
  // Device-code login. `show` pushes the verification URL + code to the UI immediately; the
  // returned promise resolves with a completion message once the user authorizes. The two-phase
  // shape is required: a single blocking call would hide the code behind the token poll.
  login?: (show: (lines: string[]) => void) => Promise<string[]>;
  // Persist a WebIQ API key entered via /web-search-support (enables gateway web_search/web_fetch).
  saveWebIqKey?: (key: string) => void;
  // Whether web search is configured (a WebIQ key is present). Read live so the HUD reflects it.
  webSearchReady?: () => boolean;
  // One-time status overview shown as the first card on startup.
  startupStatus?: StatusSummary;
}

function OutputCard({ title, lines, tone }: { title: string; lines: string[]; tone: "info" | "ok" | "error" }) {
  const border = tone === "error" ? theme.error : tone === "ok" ? theme.ready : theme.border;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>{title}</Text>
      {lines.map((l, i) => {
        const m = /^(OK|FAIL)\s+(.*)$/.exec(l);
        if (m) {
          const ok = m[1] === "OK";
          return (
            <Text key={i}>
              <Text color={ok ? theme.ready : theme.error}>{ok ? "✓ " : "✗ "}</Text>
              <Text color={theme.output}>{m[2]}</Text>
            </Text>
          );
        }
        return <Text key={i} color={theme.output}>{l}</Text>;
      })}
    </Box>
  );
}

function HelpCard({ commands }: { commands: CommandHint[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>Commands</Text>
      {commands.map((c) => (
        <Text key={c.name}>
          <Text color={theme.prompt}>{c.name.padEnd(16)}</Text>
          <Text color={theme.muted}>{c.describe}</Text>
        </Text>
      ))}
      <Text color={theme.muted}>tip: type / to autocomplete · plain text talks to the assistant</Text>
    </Box>
  );
}

// HUD client cell: shows configured scopes read from the real config files.
function ClientBadge({ name, status }: { name: string; status: { user: boolean; project: boolean } }) {
  const cell = (label: string, on: boolean) => (
    <Text color={on ? theme.ready : theme.muted}>{label}:{on ? "✓" : "○"}</Text>
  );
  return (
    <Text color={theme.muted}>
      {name} {cell("u", status.user)} {cell("p", status.project)}
    </Text>
  );
}

export function App({
  registry, title, workerState = "starting", initialModel = "—",
  statusSource, readStatus, modelLimits, onChat,
  loadModels, setup, info, onModelChange, pickModelOnStart, login, saveWebIqKey, webSearchReady, startupStatus,
}: AppProps) {
  const cmds: CommandHint[] = registry.list().map((c) => ({ name: c.name, describe: c.describe }));
  const [entries, setEntries] = useState<Entry[]>(() => [
    ...(startupStatus ? [statusCard(startupStatus)] : []),
    { type: "system", text: "Type a message to chat with the assistant, or /help for commands." },
  ]);
  const [state, setState] = useState<WorkerState>(workerState);
  const [status, setStatus] = useState<ClientStatus>(() => readStatus?.() ?? EMPTY_STATUS);
  const [webReady, setWebReady] = useState<boolean>(() => webSearchReady?.() ?? false);
  const [model, setModel] = useState(initialModel);
  const [screen, setScreen] = useState<Screen>(pickModelOnStart && loadModels ? { kind: "model" } : null);
  const [, setNow] = useState(0); // ticks the live loading line while the assistant streams
  const abortRef = useRef<AbortController | null>(null); // current turn's interrupt handle
  const loginInFlight = useRef(false); // guards against starting a second device-login flow
  const add = (e: Entry) => setEntries((p) => [...p, e].slice(-100));
  const refreshStatus = () => { if (readStatus) setStatus(readStatus()); if (webSearchReady) setWebReady(webSearchReady()); };

  // esc interrupts an in-flight assistant turn (the Repl doesn't use esc, so this is unambiguous).
  useInput((_input, key) => { if (key.escape) abortRef.current?.abort(); });

  useEffect(() => {
    if (!statusSource && !readStatus) return;
    let alive = true;
    const tick = async () => {
      try { const s = await statusSource?.(); if (alive && s) setState(s.workerState); } catch { /* daemon momentarily down */ }
      if (alive) refreshStatus(); // HUD reflects the real config files, even if edited externally
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [statusSource]);

  const streaming = entries.some((e) => e.type === "assistant" && e.streaming);
  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(() => setNow((n) => n + 1), 200);
    return () => clearInterval(id);
  }, [streaming]);

  function pickModel(m: string) {
    setModel(m);
    onModelChange?.(m);
    setScreen(null);
    add({ type: "card", title: "model", tone: "ok", lines: [`✓ chat model set to ${m}`] });
  }

  async function handle(line: string) {
    add({ type: "user", text: `› ${line}` });
    const t = line.trim();
    if (t === "/model" && loadModels) { setScreen({ kind: "model" }); return; }
    if (t === "/web-search-support" && saveWebIqKey) { setScreen({ kind: "webiq-key" }); return; }
    if (t === "/config" && info) { setScreen({ kind: "config" }); return; }
    if (t === "/login" && login) {
      // Show the verification URL + code right away, then resolve a completion card once the user
      // authorizes. Done as a special case (not a registry command) because the slash registry only
      // renders a command's final return value — it can't surface the code mid-poll. Guarded so a
      // double Enter doesn't start two device-code flows (polling a superseded code 401s).
      if (loginInFlight.current) { add({ type: "card", title: "/login", tone: "info", lines: ["already waiting for authorization…"] }); return; }
      loginInFlight.current = true;
      void login((lines) => add({ type: "card", title: "/login", tone: "info", lines }))
        .then((lines) => add({ type: "card", title: "/login", tone: "ok", lines }))
        .catch((e) => add({ type: "card", title: "/login", tone: "error", lines: [`login failed: ${e instanceof Error ? e.message : String(e)}`] }))
        .finally(() => { loginInFlight.current = false; });
      return;
    }
    if (setup && loadModels && (t === "/setup-claude" || t === "/setup-codex")) {
      setScreen({ kind: "setup", client: t === "/setup-claude" ? "claude" : "codex" });
      return;
    }
    if (line.startsWith("/")) {
      if (t === "/help") { add({ type: "help", commands: cmds }); return; }
      const out = await registry.run(line);
      const tone: "info" | "ok" | "error" =
        out.some((l) => /fail|error|unknown/i.test(l)) ? "error" : out.some((l) => /^OK /.test(l)) ? "ok" : "info";
      add({ type: "card", title: t, tone, lines: out });
      if (t === "/reset-claude" || t === "/reset-codex") refreshStatus(); // HUD follows the files
    } else if (onChat) {
      // Open one streaming bubble immediately (shows the live loading line), then append each
      // delta into it in place rather than spawning a new line per chunk.
      add({ type: "assistant", text: "", streaming: true, startedAt: Date.now() });
      const append = (chunk: string) =>
        setEntries((p) => {
          const copy = [...p];
          for (let i = copy.length - 1; i >= 0; i--) {
            const e = copy[i];
            if (e.type === "assistant" && e.streaming) { copy[i] = { ...e, text: e.text + chunk }; break; }
          }
          return copy;
        });
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        await onChat(line, append, model, ctrl);
      } finally {
        abortRef.current = null;
        setEntries((p) => p.map((e) => (e.type === "assistant" && e.streaming ? { ...e, streaming: false } : e)));
      }
    } else {
      add({ type: "system", text: "(assistant not available — use /help)" });
    }
  }

  const configured = (s: { user: boolean; project: boolean }) => s.user || s.project;

  let body: React.ReactNode;
  if (screen?.kind === "model" && loadModels) {
    body = <ModelScreen loadModels={loadModels} limits={modelLimits} current={model} onPick={pickModel} onCancel={() => setScreen(null)} />;
  } else if (screen?.kind === "setup" && setup && loadModels) {
    const client = screen.client;
    body = (
      <SetupWizard
        client={client}
        loadModels={loadModels}
        limits={modelLimits}
        apply={(scope, m) => setup.apply(client, scope, m)}
        onDone={(result, m) => {
          refreshStatus();
          setScreen(null);
          add({ type: "card", title: `setup ${client}`, tone: "ok", lines: [`✓ model ${m}`, `wrote ${result.path}`, `keys: ${result.changed.join(", ") || "(no change)"}`] });
        }}
        onCancel={() => { setScreen(null); add({ type: "system", text: "setup cancelled" }); }}
      />
    );
  } else if (screen?.kind === "config" && info) {
    body = (
      <ConfigScreen
        info={info}
        model={model}
        clients={{ claude: configured(status.claude), codex: configured(status.codex) }}
        onAction={(a) => {
          if (a === "model") setScreen({ kind: "model" });
          else if (a === "setup-claude") setScreen({ kind: "setup", client: "claude" });
          else if (a === "setup-codex") setScreen({ kind: "setup", client: "codex" });
          else setScreen(null);
        }}
      />
    );
  } else if (screen?.kind === "webiq-key" && saveWebIqKey) {
    body = (
      <WebIqKeyScreen
        onSubmit={(k) => { saveWebIqKey(k); setWebReady(true); setScreen(null); add({ type: "card", title: "/web-search-support", tone: "ok", lines: ["✓ WebIQ key saved — web search is now enabled for connected clients"] }); }}
        onCancel={() => { setScreen(null); add({ type: "system", text: "web-search-support cancelled" }); }}
      />
    );
  } else {
    body = <Repl onSubmit={handle} commands={cmds} />;
  }

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" paddingX={1}>
        <Text color={theme.accent} bold>✳ {title}</Text>
        <Text color={theme.muted}>worker: <Text color={stateColor[state]}>{state}</Text></Text>
      </Box>

      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {entries.map((e, i) => {
          if (e.type === "card") return <OutputCard key={i} title={e.title} lines={e.lines} tone={e.tone} />;
          if (e.type === "help") return <HelpCard key={i} commands={e.commands} />;
          const color = e.type === "user" ? theme.user : e.type === "assistant" ? theme.assistant : theme.muted;
          if (e.type === "assistant" && e.streaming) {
            const elapsed = e.startedAt ? Date.now() - e.startedAt : 0;
            const frame = SPINNER[Math.floor(Date.now() / 200) % SPINNER.length];
            const tokens = Math.ceil(e.text.length / 4);
            return (
              <Box key={i} flexDirection="column">
                <Text color={theme.accent}>✽ <Text color={theme.muted}>{frame} {loadingVerb(elapsed)}… (esc to interrupt · {fmtElapsed(elapsed)} · ↓ {fmtTokens(tokens)} tokens · thinking)</Text></Text>
                {e.text ? <Text color={color}>{e.text}</Text> : null}
              </Box>
            );
          }
          return <Text key={i} color={color}>{e.text}</Text>;
        })}
      </Box>

      {body}

      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Text color={theme.muted}>model </Text><Text color={theme.accent}>{model}</Text>
          <Text color={theme.muted}>  ·  daemon </Text><Text color={stateColor[state]}>{state}</Text>
          <Text color={theme.muted}>  ·  web </Text><Text color={webReady ? theme.ready : theme.muted}>{webReady ? "✓" : "✗ /web-search-support"}</Text>
        </Box>
        <Box>
          <ClientBadge name="claude" status={status.claude} />
          <Text color={theme.muted}>  </Text><ClientBadge name="codex" status={status.codex} />
          <Text color={theme.muted}>  ·  /help</Text>
        </Box>
      </Box>
    </Box>
  );
}
