import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { loadingVerb } from "../shared/format.js";
import { Repl, type CommandHint } from "./repl.js";
import { SetupWizard, type SetupClient } from "./setup/wizard.js";
import { ModelScreen } from "./screens/model.js";
import { ConfigScreen, type ConfigInfo } from "./screens/config.js";
import { WebIqKeyScreen } from "./screens/webiq-key.js";
import { NetworkScreen, type NetworkInfo, type NetworkAction } from "./screens/network.js";
import { summarizeStatus, githubLoginState, type StatusSummary, type GithubLoginState } from "./status-summary.js";
import type { Scope, ApplyResult } from "./setup/apply.js";
import type { ClientStatus } from "./setup/status.js";
import { theme } from "./theme.js";
import type { Registry } from "./slash/registry.js";
import { aggregate, recentErrors, type Aggregate } from "./panels/metrics-agg.js";
import type { WorkerState, StatusResponse, MetricSample } from "../shared/control-types.js";
import type { WebSearchBackend } from "../shared/webiq-key.js";

type Entry =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string; streaming?: boolean; startedAt?: number }
  | { type: "system"; text: string }
  | { type: "card"; title: string; tone: "info" | "ok" | "error"; lines: string[] }
  | { type: "metrics"; agg: Aggregate; errors: string[] }
  | { type: "help"; commands: CommandHint[] };

type Screen = { kind: "model" } | { kind: "setup"; client: SetupClient } | { kind: "config" } | { kind: "webiq-key" } | { kind: "network" } | null;

const stateColor: Record<WorkerState, string> = {
  ready: theme.ready, starting: theme.starting, crashed: theme.crashed, unhealthy: theme.unhealthy,
};

const EMPTY_STATUS: ClientStatus = { claude: { user: false, project: false }, codex: { user: false, project: false } };
const SPINNER = ["✶", "✸", "✹", "✺", "✹", "✷"];

// Startup overview card. GitHub shows a login STATE (no real token expiry exists). Web search shows
// the resolved backend: "via WebIQ", "via Copilot (native)", or "unavailable — run /webiq".
// `extra` appends detail lines (e.g. worker restart history for /status).
function statusCard(s: StatusSummary, extra: string[] = [], clients?: ClientStatus): Entry {
  const gh = s.github === "connected" ? "✓ connected" : s.github === "expired" ? "✗ expired — run /login" : "✗ signed out — run /login";
  const web = s.webSearch === "webiq" ? "✓ via WebIQ" : s.webSearch === "copilot" ? "✓ via Copilot (native)" : "✗ unavailable — run /webiq";
  // Per-scope + model when we have the file-derived detail; else fall back to the simple flag.
  const scope = (sc?: { on: boolean; model?: string }) => sc?.on ? `✓ ${sc.model ? sc.model.replace(/\[1m\]$/, "") : "on"}` : "○";
  const clientsLine = clients
    ? `claude u:${scope({ on: clients.claude.user, model: clients.claude.userModel })} p:${scope({ on: clients.claude.project, model: clients.claude.projectModel })} · codex u:${scope({ on: clients.codex.user, model: clients.codex.userModel })} p:${scope({ on: clients.codex.project, model: clients.codex.projectModel })}`
    : `claude ${s.clients.claude ? "✓" : "○"}  codex ${s.clients.codex ? "✓" : "○"}`;
  const tone: "ok" | "error" = s.github === "connected" ? "ok" : "error";
  return { type: "card", title: "status", tone, lines: [
    `GitHub login   ${gh}`,
    `web search     ${web}`,
    `worker         ${s.worker}`,
    `clients        ${clientsLine}`,
    ...extra,
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
  metricsSource?: () => Promise<MetricSample[]>; // recent request samples for the styled /metrics card
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
  // Web search backend control. /webiq opts into Microsoft Web IQ (enableWebiq stores the key + flips
  // mode); disableWebiq (/webiq clean) clears the key. webSearchBackend reports the RESOLVED active
  // backend (copilot | webiq | unavailable), read live so the HUD/status reflect it.
  enableWebiq?: (key: string) => void;
  disableWebiq?: () => void;
  webSearchBackend?: () => WebSearchBackend;
  // Network access mode control. networkInfo reads the LIVE posture (mode + key + LAN URL) for the
  // /network panel and HUD. setAccessMode flips localhost↔lan (restarting the worker to re-bind the
  // socket) and returns the resulting info; rotateKey mints a fresh key. All optional so a host that
  // doesn't wire them simply hides the surface.
  networkInfo?: () => NetworkInfo;
  setAccessMode?: (mode: "localhost" | "lan") => Promise<NetworkInfo>;
  rotateKey?: () => Promise<NetworkInfo>;
  // One-time status overview shown as the first card on startup.
  startupStatus?: StatusSummary;
  // "What's new" banner shown a few launches then suppressed; the cli decides via prefs and passes
  // pre-filtered lines (omit to show nothing). onSeen records one view so it eventually stops.
  changeBanner?: { lines: string[] };
  onChangeSeen?: () => void;
  // Live GitHub login check for /status (a real token-exchange check). Defaults to the startup value.
  githubStatus?: () => Promise<GithubLoginState>;
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

// Styled /metrics: a colored summary row of chips, then an aligned per-model table. Numbers carry
// the accent/state colors; labels are dimmed — so the eye lands on counts and cost, not boilerplate.
function MetricsCard({ agg, errors }: { agg: Aggregate; errors: string[] }) {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
  const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
  const top = [...agg.byModel].sort((a, b) => b.count - a.count);
  const w = Math.min(22, Math.max(8, ...top.map((r) => r.model.replace(/^claude-/, "").length)));
  const m = (s: string) => s.replace(/^claude-/, "").slice(0, w).padEnd(w);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginBottom={1}>
      <Text color={theme.accent} bold>metrics</Text>
      <Text>
        <Text color={theme.ready} bold>{agg.total}</Text><Text color={theme.muted}> reqs  </Text>
        <Text color={agg.errors ? theme.error : theme.muted} bold>{agg.errors}</Text><Text color={theme.muted}> err  </Text>
        <Text color={theme.assistant}>{k(agg.tokensIn)}↑ {k(agg.tokensOut)}↓</Text><Text color={theme.muted}>  est </Text>
        <Text color={theme.accent} bold>{usd(agg.costUsd)}</Text>
      </Text>
      <Text color={theme.border}>{"─".repeat(w + 26)}</Text>
      {top.map((r) => (
        <Text key={r.model}>
          <Text color={theme.output}>{m(r.model)}</Text>
          <Text color={theme.muted}>  n=</Text><Text color={theme.assistant}>{String(r.count).padEnd(4)}</Text>
          <Text color={theme.muted}>{String(r.avgMs).padStart(5)}ms  </Text>
          <Text color={theme.assistant}>{k(r.tokensIn)}/{k(r.tokensOut)}</Text>
          <Text color={theme.muted}> ~</Text><Text color={theme.accent}>{usd(r.costUsd)}</Text>
        </Text>
      ))}
      {errors.length > 0 && <Text color={theme.error}>recent errors:</Text>}
      {errors.map((e, i) => <Text key={i} color={theme.muted}>  {e}</Text>)}
      <Text color={theme.muted} dimColor>cost = list-price estimate (Copilot is flat-fee)</Text>
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

// HUD client cell: shows configured scopes read from the real config files, with the pinned model.
function ClientBadge({ name, status }: { name: string; status: { user: boolean; project: boolean; userModel?: string; projectModel?: string } }) {
  const short = (m?: string) => (m ? m.replace(/\[1m\]$/, "").replace(/^claude-/, "").slice(0, 14) : "");
  const cell = (label: string, on: boolean, model?: string) => (
    <Text color={on ? theme.ready : theme.muted}>{label}:{on ? `✓ ${short(model)}`.trimEnd() : "○"}</Text>
  );
  return (
    <Text color={theme.muted}>
      {name} {cell("u", status.user, status.userModel)} {cell("p", status.project, status.projectModel)}
    </Text>
  );
}

export function App({
  registry, title, workerState = "starting", initialModel = "—",
  statusSource, metricsSource, readStatus, modelLimits, onChat,
  loadModels, setup, info, onModelChange, pickModelOnStart, login, enableWebiq, disableWebiq, webSearchBackend, networkInfo, setAccessMode, rotateKey, startupStatus, githubStatus, changeBanner, onChangeSeen,
}: AppProps) {
  const cmds: CommandHint[] = registry.list().map((c) => ({ name: c.name, describe: c.describe }));
  const [entries, setEntries] = useState<Entry[]>(() => [
    ...(startupStatus ? [statusCard(startupStatus)] : []),
    ...(changeBanner ? [{ type: "card" as const, title: "what's new", tone: "info" as const, lines: changeBanner.lines }] : []),
    { type: "system", text: "Type a message to chat with the assistant, or /help for commands." },
  ]);
  useEffect(() => { if (changeBanner) onChangeSeen?.(); }, []);
  const [state, setState] = useState<WorkerState>(workerState);
  const [status, setStatus] = useState<ClientStatus>(() => readStatus?.() ?? EMPTY_STATUS);
  const [webBackend, setWebBackend] = useState<WebSearchBackend>(() => webSearchBackend?.() ?? "unavailable");
  // Network access posture (mode + key + LAN URL), read live; refreshed after a /network change.
  const [net, setNet] = useState<NetworkInfo | undefined>(() => networkInfo?.());
  // GitHub login state, kept fresh by the supervisor heartbeat surfaced through the 2s status poll.
  const [github, setGithub] = useState<GithubLoginState | undefined>(startupStatus?.github);
  const [model, setModel] = useState(initialModel);
  const [screen, setScreen] = useState<Screen>(pickModelOnStart && loadModels ? { kind: "model" } : null);
  const [, setNow] = useState(0); // ticks the live loading line while the assistant streams
  const abortRef = useRef<AbortController | null>(null); // current turn's interrupt handle
  const loginInFlight = useRef(false); // guards against starting a second device-login flow
  const add = (e: Entry) => setEntries((p) => [...p, e].slice(-100));
  const refreshStatus = () => { if (readStatus) setStatus(readStatus()); if (webSearchBackend) setWebBackend(webSearchBackend()); };

  // esc interrupts an in-flight assistant turn (the Repl doesn't use esc, so this is unambiguous).
  useInput((_input, key) => { if (key.escape) abortRef.current?.abort(); });

  useEffect(() => {
    if (!statusSource && !readStatus) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await statusSource?.();
        if (alive && s) {
          setState(s.workerState);
          if (s.github) setGithub(githubLoginState(s.github.hasToken, s.github.ok)); // live login badge
        }
      } catch { /* daemon momentarily down */ }
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
    // Web-search backend controls. "/webiq clean" clears the key; "/webiq" opens the key screen and
    // switches to the WebIQ backend on submit. After either, re-read the resolved backend for the HUD.
    if (t === "/webiq clean" && disableWebiq) {
      disableWebiq(); setWebBackend(webSearchBackend?.() ?? "unavailable");
      add({ type: "card", title: "/webiq", tone: "ok", lines: ["✓ WebIQ key cleared"] });
      return;
    }
    if (t === "/webiq" && enableWebiq) { setScreen({ kind: "webiq-key" }); return; }
    if (t === "/status" && (startupStatus || githubStatus || webSearchBackend)) {
      // Render the live status overview (same card as startup), then the worker restart history.
      // /status is an explicit "is my login OK right now?" — do the live check when wired (the cached
      // heartbeat can be up to ~60s stale), falling back to the cached/seed value only if it isn't.
      const ghState = githubStatus ? await githubStatus() : (github ?? startupStatus?.github ?? "signed-out");
      let worker = state, restarts: string[] = [];
      try {
        const s = await statusSource?.();
        if (s) { worker = s.workerState; restarts = s.restarts.slice(0, 5).map((r) => `  ${r.reason} exit=${r.exitCode ?? "-"} ${r.stderrTail.slice(0, 60)}`); }
      } catch { /* daemon momentarily down — show what we have */ }
      const summary = summarizeStatus({
        hasToken: ghState !== "signed-out", tokenValid: ghState === "connected",
        webSearch: webSearchBackend?.() ?? webBackend, worker,
        clients: { claude: status.claude.user || status.claude.project, codex: status.codex.user || status.codex.project },
      });
      add(statusCard(summary, restarts.length ? ["", "recent restarts:", ...restarts] : [], status));
      return;
    }
    if (t === "/config" && info) { setScreen({ kind: "config" }); return; }
    if (t === "/network" && networkInfo) { setNet(networkInfo()); setScreen({ kind: "network" }); return; }
    if (t === "/metrics" && metricsSource) {
      const reqs = await metricsSource();
      const agg = aggregate(reqs);
      const errs = recentErrors(reqs, 5).map((e) => `${e.status} ${e.model} — ${(e.error ?? "(no message)").slice(0, 80)}`);
      add({ type: "metrics", agg, errors: errs });
      return;
    }
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
        accessMode={net?.mode}
        onAction={(a) => {
          if (a === "model") setScreen({ kind: "model" });
          else if (a === "network" && networkInfo) { setNet(networkInfo()); setScreen({ kind: "network" }); }
          else if (a === "setup-claude") setScreen({ kind: "setup", client: "claude" });
          else if (a === "setup-codex") setScreen({ kind: "setup", client: "codex" });
          else setScreen(null);
        }}
      />
    );
  } else if (screen?.kind === "webiq-key" && enableWebiq) {
    body = (
      <WebIqKeyScreen
        onSubmit={(k) => { enableWebiq(k); setWebBackend(webSearchBackend?.() ?? "webiq"); setScreen(null); add({ type: "card", title: "/webiq", tone: "ok", lines: ["✓ WebIQ enabled — all web search now routes through Microsoft Web IQ"] }); }}
        onCancel={() => { setScreen(null); add({ type: "system", text: "webiq cancelled" }); }}
      />
    );
  } else if (screen?.kind === "network" && net) {
    const onNet = async (a: NetworkAction) => {
      if (a === "back") { setScreen(null); return; }
      try {
        if (a === "lan" && setAccessMode) {
          const r = await setAccessMode("lan"); setNet(r); setScreen(null);
          add({ type: "card", title: "/network", tone: "ok", lines: [
            "✓ LAN mode — the proxy is now reachable from other machines (worker restarting to re-bind)",
            r.lanUrl ? `LAN URL   ${r.lanUrl}` : "",
            r.key ? `key       ${r.key}` : "",
            "send the key as Authorization: Bearer <key> or x-api-key — requests without it are rejected (401)",
          ].filter(Boolean) });
        } else if (a === "localhost" && setAccessMode) {
          const r = await setAccessMode("localhost"); setNet(r); setScreen(null);
          add({ type: "card", title: "/network", tone: "ok", lines: ["✓ localhost mode — loopback only, private to this machine (worker restarting to re-bind)"] });
        } else if (a === "rotate" && rotateKey) {
          const r = await rotateKey(); setNet(r);
          add({ type: "card", title: "/network", tone: "ok", lines: [`✓ access key ${net.key ? "rotated" : "generated"}`, r.key ? `key  ${r.key}` : ""].filter(Boolean) });
        }
      } catch (e) {
        setScreen(null);
        add({ type: "card", title: "/network", tone: "error", lines: [`network change failed: ${e instanceof Error ? e.message : String(e)}`] });
      }
    };
    body = <NetworkScreen info={net} onAction={onNet} />;
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
          if (e.type === "metrics") return <MetricsCard key={i} agg={e.agg} errors={e.errors} />;
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
          // User turns get a clay-on-dark highlight bar so they stand out from muted system notes and
          // gray assistant output — a clear visual anchor for "this is what I said".
          if (e.type === "user") return <Box key={i} marginTop={1}><Text backgroundColor={theme.accent} color="black" bold>{` ${e.text.replace(/^›\s*/, "")} `}</Text></Box>;
          return <Text key={i} color={color}>{e.text}</Text>;
        })}
      </Box>

      {body}

      <Box flexDirection="column" paddingX={1}>
        <Box>
          {github && <><Text color={theme.muted}>github </Text><Text color={github === "connected" ? theme.ready : theme.error}>{github === "connected" ? "✓" : "✗ /login"}</Text></>}
          <Text color={theme.muted}>{github ? "  ·  " : ""}daemon </Text><Text color={stateColor[state]}>{state}</Text>
          {net && <><Text color={theme.muted}>  ·  net </Text><Text color={net.mode === "lan" ? theme.accent : theme.muted}>{net.mode === "lan" ? "⚠ LAN" : "localhost"}</Text></>}
        </Box>
        <Box>
          <Text color={theme.muted}>web </Text><Text color={webBackend === "unavailable" ? theme.muted : theme.ready}>{webBackend === "webiq" ? "✓ webiq" : webBackend === "copilot" ? "✓ copilot" : "✗ /webiq"}</Text>
          <Text color={theme.muted}>  ·  </Text><ClientBadge name="claude" status={status.claude} />
          <Text color={theme.muted}>  </Text><ClientBadge name="codex" status={status.codex} />
          <Text color={theme.muted}>  ·  /help</Text>
        </Box>
      </Box>
    </Box>
  );
}
