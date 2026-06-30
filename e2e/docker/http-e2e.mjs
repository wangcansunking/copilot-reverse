// Real, in-container HTTP edge-case e2e for copilot-reverse.
//
// NOT a mock. Boots the REAL worker proxy (:7891) and the REAL supervisor control API (:7890), then
// drives them over HTTP exactly like a client + the TUI do. The cases here exercise paths that REJECT
// before any upstream call — malformed body, oversized body, bad route, count_tokens, supervision
// lifecycle, and the crash-guard regressions — so a DUMMY token is enough and no Copilot quota is
// spent. A couple of golden round-trips fire a real request only when a real token is mounted.
//
// Exit 0 = all asserted; non-zero = a failure. Mirrors heartbeat-e2e.mjs's check harness.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";

const HOST = "127.0.0.1";
const SUP = 7890, WRK = 7891;
const supUrl = (p) => `http://${HOST}:${SUP}${p}`;
const wrkUrl = (p) => `http://${HOST}:${WRK}${p}`;
const wrkUrl2 = (port, p) => `http://${HOST}:${port}${p}`; // loopback URL for an ad-hoc worker on `port`
const TOKEN_FILE = process.env.TOKEN_FILE || "/run/secrets/creds.json";
const DATA_DIR = `${process.env.HOME || "/root"}/.copilot-reverse`;

function realToken() {
  try { const t = JSON.parse(readFileSync(TOKEN_FILE, "utf8"))?.ghToken; return typeof t === "string" && t ? t : null; }
  catch { return null; }
}
const log = (...a) => console.log(...a);
let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; log(`  ✓ ${name}`); } else { failures++; log(`  ✗ ${name} — ${detail ?? ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ready(url, n = 60) { for (let i = 0; i < n; i++) { try { if ((await fetch(url)).ok) return true; } catch {} await sleep(250); } return false; }
async function jget(u) { const r = await fetch(u); return { s: r.status, j: await r.json().catch(() => null) }; }
async function jpost(u, body, h) { const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json", ...h }, body }); return { s: r.status, t: await r.text() }; }

// The host's primary non-loopback IPv4 (e.g. the container's eth0 address), or null. Used to prove the
// bind boundary: a worker bound to 127.0.0.1 must be UNREACHABLE on this address, while one bound to
// 0.0.0.0 must be reachable on it.
function nonLoopbackIPv4() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return null;
}
// Raw-TCP reachability probe — distinguishes "kernel accepted the connection" (socket is bound on this
// address) from "connection refused / timed out" (no socket on this address). fetch() can't tell these
// apart as cleanly: a refused TCP connect is the exact "can't even connect" boundary localhost mode
// relies on. Returns "open" | "refused" | "timeout".
function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(r); } };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => finish("open"));
    sock.on("timeout", () => finish("timeout"));
    sock.on("error", () => finish("refused")); // ECONNREFUSED (no listener on this addr) / EHOSTUNREACH
  });
}
// Boot a standalone worker on a chosen BIND_HOST + port with an isolated data dir, wait for /healthz on
// loopback, run `fn`, then kill it. Lets us exercise the bind boundary without disturbing the main
// supervisor-managed worker on :7891.
async function withWorker({ bindHost, port, mode, key }, fn) {
  const home = join(DATA_DIR, `..`, `cr-bind-${port}`);
  const data = join(home, ".copilot-reverse");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "creds.json"), JSON.stringify({ ghToken: "ghu_dummy0000000000000000000000000000000" }));
  writeFileSync(join(data, "network.json"), JSON.stringify({ mode, ...(key ? { key } : {}) }));
  const child = spawn("node", ["dist/worker/index.js"], { stdio: "inherit", env: { ...process.env, HOME: home, USERPROFILE: home, WORKER_PORT: String(port), BIND_HOST: bindHost } });
  try {
    if (!(await ready(`http://127.0.0.1:${port}/healthz`))) throw new Error(`worker(${bindHost}:${port}) never up`);
    return await fn();
  } finally { child.kill(); await sleep(200); }
}

async function main() {
  const token = realToken();
  // A dummy token lets the worker boot and reject malformed/edge requests before any upstream call;
  // real round-trips only run if a real token was mounted.
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, "creds.json"), JSON.stringify({ ghToken: token || "ghu_dummy0000000000000000000000000000000" }));
  log(`\ncopilot-reverse — HTTP edge-case e2e\nreal token: ${token ? "yes" : "no (edge cases run on a dummy token; golden skipped)"}\n`);

  const sup = spawn("node", ["dist/supervisor/index.js"], { stdio: "inherit", env: process.env });
  try {
    if (!(await ready(supUrl("/api/status")))) throw new Error("supervisor never up");
    if (!(await ready(wrkUrl("/healthz")))) throw new Error("worker never up");

    log("[proxy] error & edge paths (no upstream call)");
    check("malformed JSON → 400", (await jpost(wrkUrl("/anthropic/v1/messages"), "{bad")).s === 400);
    check(">20mb body → 413", (await jpost(wrkUrl("/anthropic/v1/messages"), JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "x".repeat(21 * 1024 * 1024) }] }))).s === 413);
    check("unknown route → 404", (await fetch(wrkUrl("/nope"))).status === 404);
    check("/healthz ok", (await jget(wrkUrl("/healthz"))).j?.ok === true);
    check("/openai/models non-empty", (await jget(wrkUrl("/openai/models"))).j?.data?.length > 0);
    const models = (await jget(wrkUrl("/anthropic/v1/models"))).j?.data ?? [];
    check("/anthropic/v1/models non-empty", models.length > 0);
    // Model mapping: Claude families must surface as the DASHED canonical ids Claude Code's native
    // picker recognises (claude-opus-4-8) with a friendly display_name + [1m] badge for 1M models —
    // never Copilot's dotted ids. Holds on both the live list and the offline fallback.
    check("no dotted claude ids leak to picker", !models.some((m) => /claude-(opus|sonnet)-4\.[0-9]/.test(m.id)));
    const opus = models.find((m) => m.id.startsWith("claude-opus-4-8"));
    check("opus has friendly display_name", opus?.display_name === "Opus 4.8", opus?.display_name);
    check("opus carries [1m] 1M badge", opus?.id === "claude-opus-4-8[1m]", opus?.id);
    const ct = await jpost(wrkUrl("/anthropic/v1/messages/count_tokens"), JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }));
    check("count_tokens input_tokens>0", JSON.parse(ct.t).input_tokens > 0, ct.t);

    log("\n[supervisor] control lifecycle");
    check("status workerState=ready", (await jget(supUrl("/api/status"))).j?.workerState === "ready");
    const dashHtml = await (await fetch(supUrl("/"))).text();
    check("dashboard HTML at /", (await fetch(supUrl("/"))).headers.get("content-type")?.includes("html"));
    // The dashboard must pull real totals from the SQL rollup (/api/metrics), NOT the capped
    // /api/requests fetch that made it stick at "total 100" and render a flat dump of identical 200s.
    check("dashboard wires to /api/metrics (not capped /api/requests)", dashHtml.includes("/api/metrics") && /renderMetrics|byModel/.test(dashHtml), dashHtml.includes("/api/requests") ? "still references /api/requests for totals" : "");
    check("doctor checks[]", Array.isArray((await jget(supUrl("/api/doctor"))).j?.checks));
    check("requests[]", Array.isArray((await jget(supUrl("/api/requests"))).j?.requests));

    // Richer /doctor self-check + the dashboard's new data endpoints. Light /doctor (no ?ping) must be
    // upstream-free and carry the web-search + models checks (named), so it's safe for the 2s poll. The
    // dashboard now also pulls /api/clients (per-scope config) and /api/models (advertised, proxied).
    log("\n[doctor+dashboard] richer self-check + parity data endpoints");
    const doc = (await jget(supUrl("/api/doctor"))).j?.checks ?? [];
    const named = (n) => doc.find((c) => c.name === n);
    check("doctor has web-search check", !!named("web-search"), JSON.stringify(doc.map((c) => c.name)));
    check("doctor has models check", !!named("models"));
    check("doctor light has NO per-model ping checks", !doc.some((c) => String(c.name).startsWith("model:")));
    const docPing = (await jget(supUrl("/api/doctor?ping=1"))).j?.checks ?? [];
    // No client is configured in-container, so ping mode reports the informational note (not a crash).
    check("doctor ?ping returns checks", Array.isArray(docPing) && docPing.length >= doc.length);
    const clients = (await jget(supUrl("/api/clients"))).j;
    check("/api/clients has claude+codex", clients && "claude" in clients && "codex" in clients, JSON.stringify(clients));
    const mods = (await jget(supUrl("/api/models"))).j?.models;
    check("/api/models advertises models", Array.isArray(mods) && mods.length > 0, JSON.stringify((mods || []).slice(0, 2)));

    // /logs hardening: a real upstream failure (the dummy token 401s at Copilot) stores a metric
    // error, which /logs renders one-per-line inside a bordered card. A multi-line body (a 502 returns
    // an HTML page) once shattered that border. Drive a real failing request, read the REAL stored
    // metric back from the supervisor, then run it through the REAL TUI formatter (dist oneLine) the
    // /logs command uses — the rendered line must contain no newline, whatever the upstream sent.
    log("\n[/logs] stored request error renders as a single contained line");
    await jpost(wrkUrl("/anthropic/v1/messages"), JSON.stringify({ model: "gpt-4o", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }));
    await sleep(400);
    const { oneLine } = await import("../../dist/shared/format.js");
    const logged = (await jget(supUrl("/api/requests"))).j?.requests ?? [];
    const failed = logged.find((r) => r.status >= 400 || r.error != null);
    check("a failing request was logged", !!failed, JSON.stringify(logged[0] ?? {}).slice(0, 120));
    if (failed) {
      const rendered = `${new Date(failed.ts).toISOString()} ${failed.status} ${failed.endpoint} ${failed.model} — ${oneLine(failed.error, 160) || "(no message)"}`;
      check("/logs line has no embedded newline", !/\r?\n/.test(rendered), JSON.stringify(rendered).slice(0, 160));
    }

    // /api/metrics must roll up the WHOLE request_log in SQL, not a 100-row fetch. Insert >100 rows
    // straight into the supervisor's own DB (same file, WAL so a 2nd connection sees committed writes),
    // then assert the reported total exceeds 100 and the 24h window is bounded — the old /metrics capped
    // at 100 and "100 reqs" was a meaningless ceiling once you crossed it.
    log("\n[/metrics] real lifetime rollup over the whole request_log (not a 100-row cap)");
    const { openDb, recordRequest } = await import("../../dist/supervisor/db.js");
    const { dbPath } = await import("../../dist/shared/paths.js");
    const seedDb = openDb(dbPath());
    const baseTotal = (await jget(supUrl("/api/metrics"))).j?.all?.total ?? 0;
    const now = Date.now();
    for (let i = 0; i < 150; i++) recordRequest(seedDb, { ts: now - i * 1000, endpoint: "/anthropic/v1/messages", model: "gpt-4o", status: 200, latencyMs: 10, tokensIn: 2, tokensOut: 1 });
    recordRequest(seedDb, { ts: now - 3 * 24 * 60 * 60 * 1000, endpoint: "/anthropic/v1/messages", model: "gpt-4o", status: 502, latencyMs: 5, error: "old failure 3 days ago" });
    seedDb.close();
    const met = (await jget(supUrl("/api/metrics"))).j;
    check("/api/metrics counts >100 rows (no display cap)", met?.all?.total >= baseTotal + 151, `total=${met?.all?.total} base=${baseTotal}`);
    check("/api/metrics day window <= all-time", met?.day?.total <= met?.all?.total && met?.day?.total >= 150, `day=${met?.day?.total} all=${met?.all?.total}`);
    check("/api/metrics surfaces the old (pre-100) failure in recentErrors", (met?.recentErrors ?? []).some((e) => e.error === "old failure 3 days ago"), JSON.stringify((met?.recentErrors ?? []).map((e) => e.error)).slice(0, 160));
    await jpost(supUrl("/api/restart"), "{}"); await sleep(1500);
    check("worker ready after restart", (await jget(supUrl("/api/status"))).j?.workerState === "ready");

    log("\n[crash-guard] dead SSE clients + broadcast churn — daemon stays up (smoke; deterministic guard is in unit tests)");
    const ctrls = Array.from({ length: 4 }, () => { const c = new AbortController(); fetch(supUrl("/api/events"), { signal: c.signal }).catch(() => {}); return c; });
    await sleep(500); ctrls[1].abort(); ctrls[2].abort();
    for (let i = 0; i < 6; i++) { await jpost(supUrl("/api/restart"), "{}"); await sleep(150); }
    await sleep(1500);
    check("daemon survives dead-socket broadcast churn", (await jget(supUrl("/api/status"))).s === 200);
    ctrls.forEach((c) => { try { c.abort(); } catch {} });

    // Deterministic regression for the PR #8 crash: a throwing subscriber (a dead-socket SSE write)
    // must not escape EventBus.emit. Exercises the REAL EventBus from dist/; this FAILS on the reverted
    // guard, which the black-box churn above cannot reliably trigger over TCP.
    log("\n[crash-guard] EventBus isolates a throwing subscriber (real dist module)");
    const { EventBus } = await import("../../dist/supervisor/events.js");
    const bus = new EventBus(); let live = 0;
    bus.subscribe(() => { throw new Error("ERR_STREAM_DESTROYED"); });
    bus.subscribe(() => { live++; });
    let escaped = false; try { bus.emit("metric", { a: 1 }); bus.emit("metric", { a: 2 }); } catch { escaped = true; }
    check("throwing listener does not escape emit", !escaped);
    check("live subscriber still served after a peer throws", live > 0);

    // EADDRINUSE regression (the daemon-unhealthy crash loop): TWO independent failure modes that both
    // ended in "listen EADDRINUSE :7891" → repeated worker-crash → daemon marked unhealthy.
    //
    //   (a) ORPHAN: a forked worker does NOT die when its supervisor dies abnormally. The orphan keeps
    //       holding the port, so the NEXT supervisor's worker can't bind it. Fixed by the worker's
    //       'disconnect' guard (src/worker/index.ts): when the IPC channel to the parent drops, the
    //       worker exits and releases the port. We reproduce a dead parent deterministically by forking
    //       the REAL worker with an IPC channel (exactly as the supervisor does) and then dropping that
    //       channel — child.disconnect() fires the same 'disconnect' event a crashed supervisor would.
    //
    //   (b) RESTART RACE: restartManually() used to kill+respawn synchronously, racing the dying worker
    //       for the port. Fixed by deferring the spawn to the old child's exit. The 6× rapid restart
    //       loop above exercises it; the steady-state assert below proves it didn't wedge the daemon.
    log("\n[crash-guard] EADDRINUSE regression: orphaned worker releases its port when the IPC parent drops");
    {
      const { fork } = await import("node:child_process");
      const ORPHAN_PORT = 7898;
      const home = join(DATA_DIR, "..", "cr-orphan");
      const data = join(home, ".copilot-reverse");
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, "creds.json"), JSON.stringify({ ghToken: "ghu_dummy0000000000000000000000000000000" }));
      // fork() gives the child a Node IPC channel — so process.connected is true and the disconnect
      // guard is armed, just like a supervisor-spawned worker (plain spawn() would not arm it).
      const worker = fork("dist/worker/index.js", [], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        env: { ...process.env, HOME: home, USERPROFILE: home, WORKER_PORT: String(ORPHAN_PORT), BIND_HOST: "127.0.0.1" },
      });
      const up = await ready(`http://127.0.0.1:${ORPHAN_PORT}/healthz`);
      check("orphan-test worker came up on its port", up);
      check("port held while IPC parent is connected", (await tcpProbe("127.0.0.1", ORPHAN_PORT)) === "open");
      // Drop the IPC channel WITHOUT a {shutdown} message — the worker only sees 'disconnect', exactly
      // what an abnormally-dead supervisor leaves behind. With the guard it exits and frees the port.
      worker.disconnect();
      let freed = "open";
      for (let i = 0; i < 40; i++) { await sleep(250); if ((freed = await tcpProbe("127.0.0.1", ORPHAN_PORT)) !== "open") break; }
      check(`orphaned worker released :${ORPHAN_PORT} after its parent dropped (disconnect guard)`, freed !== "open", `probe=${freed}`);
      try { worker.kill("SIGKILL"); } catch {} // belt-and-suspenders if the guard ever regressed
    }

    // After everything above (incl. the 6× rapid restart loop), the daemon must still be ready and must
    // NOT have wedged into "unhealthy" — the end-state symptom the user reported. A restart that raced
    // the port would have logged worker-crash rows and, after maxCrashes, flipped workerState away from
    // ready. Assert the healthy steady state explicitly.
    log("\n[crash-guard] daemon is ready (not unhealthy) after restart churn");
    check("workerState ready (never wedged unhealthy)", (await jget(supUrl("/api/status"))).j?.workerState === "ready");

    // Access modes (#25): the worker auth gate reads network.json LAZILY per request, so we can flip
    // the posture on disk without a restart and assert the gate's behavior over real HTTP. These requests
    // all originate from 127.0.0.1 (this process), so they exercise the LOOPBACK side of the policy: a
    // local client is NEVER challenged for a key, in either mode. The genuinely-remote checks (where the
    // key IS required) are in the bind-boundary block below, driven over the container's LAN IP.
    log("\n[access-modes] loopback is never key-gated (localhost AND lan); only remote is");
    const NET = join(DATA_DIR, "network.json");
    const withKey = (k) => ({ authorization: `Bearer ${k}` });
    // localhost (default): open, no key needed.
    check("localhost: /openai/models open from loopback (no key)", (await fetch(wrkUrl("/openai/models"))).status === 200);
    // Flip to LAN. The LOCAL machine's own clients keep working with NO key — the behavior users expect
    // (their on-box Claude/Codex don't suddenly need the key when they share the proxy on the LAN).
    writeFileSync(NET, JSON.stringify({ mode: "lan", key: "e2e-secret" }));
    check("lan: loopback served WITHOUT a key (local client unaffected)", (await fetch(wrkUrl("/openai/models"))).status === 200);
    check("lan: loopback served even WITH a (wrong) key — local is exempt, key ignored", (await fetch(wrkUrl("/openai/models"), { headers: withKey("whatever") })).status === 200);
    check("lan: /healthz stays OPEN (supervisor probe)", (await fetch(wrkUrl("/healthz"))).status === 200);
    // Fail-closed only bites REMOTE callers (below); loopback stays open even with no key configured.
    writeFileSync(NET, JSON.stringify({ mode: "lan" }));
    check("lan + no key: loopback still served (fail-closed is for remote, not local)", (await fetch(wrkUrl("/openai/models"))).status === 200);
    // Restore the safe default for the golden round-trips.
    writeFileSync(NET, JSON.stringify({ mode: "localhost", key: "e2e-secret" }));
    check("back to localhost: open again from loopback (no key)", (await fetch(wrkUrl("/openai/models"))).status === 200);

    // The bind BOUNDARY — the kernel-level reason localhost mode is "you can't even connect", not 401.
    // A worker bound to 127.0.0.1 has no socket on any other interface, so a TCP connect to the host's
    // LAN IP is REFUSED (no listener) — the request never reaches the HTTP/auth layer at all. The same
    // worker bound to 0.0.0.0 (LAN mode's bind) IS reachable on that exact address. Same IP, same probe,
    // only the bind host changes: open↔refused proves the boundary, not just the config value.
    log("\n[access-modes] bind boundary: localhost is unreachable off-loopback; LAN binds all interfaces");
    const lanIp = nonLoopbackIPv4();
    if (!lanIp) {
      log("  ⊘ no non-loopback IPv4 in this container — skipping the reachability probe");
    } else {
      const PORT = 7899;
      // Sanity: loopback is reachable in BOTH binds (the worker is genuinely up either way).
      await withWorker({ bindHost: "127.0.0.1", port: PORT, mode: "localhost" }, async () => {
        check("localhost-bound: reachable on 127.0.0.1 (worker is up)", (await tcpProbe("127.0.0.1", PORT)) === "open");
        // The actual boundary: bound to 127.0.0.1 → NOT reachable on the LAN IP.
        const r = await tcpProbe(lanIp, PORT);
        check(`localhost-bound: UNREACHABLE on LAN ip ${lanIp} (connect refused, never hits HTTP)`, r !== "open", `probe=${r}`);
      });
      // LAN bind (0.0.0.0) → reachable on the very same LAN IP that was refused above.
      await withWorker({ bindHost: "0.0.0.0", port: PORT, mode: "lan", key: "e2e-secret" }, async () => {
        check(`lan-bound (0.0.0.0): reachable on LAN ip ${lanIp}`, (await tcpProbe(lanIp, PORT)) === "open");
        // REMOTE (over the LAN IP) is where the key is actually enforced. This is the true off-box path.
        const rem = (p, h) => fetch(`http://${lanIp}:${PORT}${p}`, h ? { headers: h } : undefined).then((r) => r.status).catch(() => 0);
        check("remote: no key → 401", (await rem("/openai/models")) === 401);
        check("remote: wrong key → 401", (await rem("/openai/models", withKey("nope"))) === 401);
        // Same length as "e2e-secret" (10 chars) → only the constant-time compare can reject it.
        check("remote: same-length wrong key → 401", (await rem("/openai/models", withKey("e2e-secres"))) === 401);
        check("remote: valid Bearer key → 200", (await rem("/openai/models", withKey("e2e-secret"))) === 200);
        check("remote: valid x-api-key → 200", (await rem("/openai/models", { "x-api-key": "e2e-secret" })) === 200);
        // Gate runs before the body parser: a keyless remote >20mb body → 401 (gate), not 413 (parser).
        const huge = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "x".repeat(21 * 1024 * 1024) }] });
        const big = await fetch(`http://${lanIp}:${PORT}/openai/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: huge }).then((r) => r.status).catch(() => 0);
        check("remote: oversized keyless body → 401 (gate before body parser, not 413)", big === 401);
        // CONTRAST: the SAME exposed worker still serves LOOPBACK with no key — only the network is gated.
        check("lan-bound: loopback STILL served without a key (local exempt on the same worker)", (await fetch(wrkUrl2(PORT, "/openai/models"))).status === 200);
      });
      // Fail-closed is a REMOTE property: an exposed worker with NO key configured refuses the network
      // (503) but still serves loopback. Proven on a fresh worker booted keyless in lan mode.
      await withWorker({ bindHost: "0.0.0.0", port: PORT, mode: "lan" }, async () => {
        const rem503 = await fetch(`http://${lanIp}:${PORT}/openai/models`, { headers: withKey("anything") }).then((r) => r.status).catch(() => 0);
        check("remote + no key configured → 503 fail-closed (never an open proxy)", rem503 === 503);
        check("lan-bound keyless: loopback still served (fail-closed is for remote only)", (await fetch(wrkUrl2(PORT, "/openai/models"))).status === 200);
      });
    }

    if (token) {
      log("\n[golden] real round-trips");
      const a = await jpost(wrkUrl("/anthropic/v1/messages"), JSON.stringify({ model: "gpt-4o", max_tokens: 16, messages: [{ role: "user", content: "say OK" }] }));
      check("anthropic /messages 200", a.s === 200, a.t.slice(0, 120));
      // The canonical [1m] id the picker hands back must resolve to a real Copilot model and answer —
      // proves the round-trip (dashed+[1m] -> dotted Copilot id) works end-to-end, not just in units.
      const c = await jpost(wrkUrl("/anthropic/v1/messages"), JSON.stringify({ model: "claude-opus-4-8[1m]", max_tokens: 16, messages: [{ role: "user", content: "say OK" }] }));
      check("canonical opus [1m] id resolves + 200", c.s === 200, c.t.slice(0, 120));
      // Token metrics: after a real round-trip the supervisor should log non-null in/out token counts.
      await sleep(500);
      const reqs = (await jget(supUrl("/api/requests"))).j?.requests ?? [];
      const top = reqs[0] ?? {};
      check("metric carries token counts", typeof top.tokensIn === "number" && typeof top.tokensOut === "number", JSON.stringify(top));

      // Extended thinking (#33): a `thinking`-enabled streaming request to a real Claude model must
      // carry a NATIVE Anthropic thinking block — content_block_start type:thinking + thinking_delta —
      // emitted before the answer text. Proves the reasoning round-trip end-to-end over real HTTP (effort
      // in -> upstream reasoning_text -> thinking block out). NOTE: the upstream decides PER TURN whether
      // to surface reasoning_text (it's non-deterministic — a trivial prompt may answer with none), so we
      // retry a few times and assert the path works on a turn that DOES reason; the answer must always
      // come through regardless. A run where no turn reasoned degrades to a logged note, never a failure.
      let sawThinking = false, sawAnswer = false, thinkSample = "";
      for (let attempt = 0; attempt < 4 && !sawThinking; attempt++) {
        const think = await jpost(wrkUrl("/anthropic/v1/messages"), JSON.stringify({
          model: "claude-opus-4-8[1m]", max_tokens: 600, stream: true,
          thinking: { type: "enabled", budget_tokens: 8000 },
          messages: [{ role: "user", content: "What is 17*23? Show your step-by-step reasoning, then state the answer." }],
        }));
        const tf = think.t.split("\n\n").map((b) => {
          const ev = b.split("\n").find((l) => l.startsWith("event: "))?.slice(7);
          const d = b.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
          try { return ev && d ? { ev, d: JSON.parse(d) } : null; } catch { return null; }
        }).filter(Boolean);
        const ts = tf.find((f) => f.ev === "content_block_start" && f.d.content_block?.type === "thinking");
        const tt = tf.filter((f) => f.ev === "content_block_delta" && f.d.delta?.type === "thinking_delta").map((f) => f.d.delta.thinking).join("");
        const ans = tf.filter((f) => f.ev === "content_block_delta" && f.d.delta?.type === "text_delta").map((f) => f.d.delta.text).join("");
        if (ans.includes("391")) sawAnswer = true;
        if (ts && tt.length > 0) { sawThinking = true; thinkSample = tt.slice(0, 60); }
      }
      check("thinking: answer delivered through the proxy (391)", sawAnswer);
      if (sawThinking) check("thinking: native thinking block + thinking_delta streamed (#33)", true, `thinking="${thinkSample}"`);
      else log(`  ⊘ thinking: upstream returned no reasoning in 4 attempts (non-deterministic) — path untested this run, answer ok`);
    } else log("\n[golden] SKIPPED (no real token)");
  } finally { sup.kill(); }
  log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"} (${passes} passed)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("http-e2e crashed:", e); process.exit(2); });
