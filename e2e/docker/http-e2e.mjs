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

const HOST = "127.0.0.1";
const SUP = 7890, WRK = 7891;
const supUrl = (p) => `http://${HOST}:${SUP}${p}`;
const wrkUrl = (p) => `http://${HOST}:${WRK}${p}`;
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
    check("dashboard HTML at /", (await fetch(supUrl("/"))).headers.get("content-type")?.includes("html"));
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
    } else log("\n[golden] SKIPPED (no real token)");
  } finally { sup.kill(); }
  log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"} (${passes} passed)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("http-e2e crashed:", e); process.exit(2); });
