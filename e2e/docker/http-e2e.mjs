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

    // Access modes (#25): the worker auth gate reads network.json LAZILY per request, so we can flip
    // the posture on disk without a restart and assert the gate's behavior over real HTTP. /openai/models
    // is gated but needs no upstream call, so these are deterministic on a dummy token. We restore
    // localhost at the end so the golden round-trips below run unauthenticated as before.
    log("\n[access-modes] LAN mode requires a key; localhost stays open");
    const NET = join(DATA_DIR, "network.json");
    const withKey = (k) => ({ authorization: `Bearer ${k}` });
    // localhost (default): open, no key needed.
    check("localhost: /openai/models open (no key)", (await fetch(wrkUrl("/openai/models"))).status === 200);
    // Flip to LAN with a key — every request must now carry it.
    writeFileSync(NET, JSON.stringify({ mode: "lan", key: "e2e-secret" }));
    check("lan: no key → 401", (await fetch(wrkUrl("/openai/models"))).status === 401);
    check("lan: wrong key → 401", (await fetch(wrkUrl("/openai/models"), { headers: withKey("nope") })).status === 401);
    // Same-length wrong key: rejected by the constant-time compare, not the length short-circuit.
    check("lan: same-length wrong key → 401", (await fetch(wrkUrl("/openai/models"), { headers: withKey("e2e-secres") })).status === 401);
    check("lan: valid Bearer key → 200", (await fetch(wrkUrl("/openai/models"), { headers: withKey("e2e-secret") })).status === 200);
    check("lan: valid x-api-key → 200", (await fetch(wrkUrl("/openai/models"), { headers: { "x-api-key": "e2e-secret" } })).status === 200);
    check("lan: /healthz stays OPEN (supervisor probe)", (await fetch(wrkUrl("/healthz"))).status === 200);
    // Gate runs BEFORE the json body parser: a keyless request with a >20mb body is rejected 401 (gate)
    // — NOT 413 (parser) — proving an unauthenticated LAN client can't make the worker buffer a huge body.
    const huge = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "x".repeat(21 * 1024 * 1024) }] });
    check("lan: oversized keyless body → 401 (gate before body parser, not 413)", (await jpost(wrkUrl("/openai/chat/completions"), huge)).s === 401);
    // Fail-closed: LAN with no key configured refuses ALL requests (503), never an open proxy.
    writeFileSync(NET, JSON.stringify({ mode: "lan" }));
    check("lan + no key → 503 fail-closed", (await fetch(wrkUrl("/openai/models"), { headers: withKey("anything") })).status === 503);
    // Restore the safe default for the golden round-trips.
    writeFileSync(NET, JSON.stringify({ mode: "localhost", key: "e2e-secret" }));
    check("back to localhost: open again (no key)", (await fetch(wrkUrl("/openai/models"))).status === 200);

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
