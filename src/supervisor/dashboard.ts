// A self-contained, dependency-free dashboard served at GET /. It polls the control API
// (/api/status, /api/requests, /api/doctor, /api/clients, /api/models) every 2s and renders worker
// health, GitHub login, web-search backend, the advertised model list, per-scope client config, and —
// most usefully — recent request errors with their messages.
//
// Parity with the TUI is deliberate: a request counts as an error when `status >= 400 OR error != null`
// (the shared isError rule), so a runaway-tagged 200 (a degenerate stream cut early) shows here too,
// not only in /logs + /metrics. /api/doctor is polled WITHOUT ?ping so the 2s cadence never fires real
// model requests; per-model connectivity is the on-demand TUI /doctor's job.
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>copilot-reverse dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0b0e14; color: #c7d0e0; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 16px 20px; border-bottom: 1px solid #1c2230; flex-wrap: wrap; }
  h1 { font-size: 16px; margin: 0; color: #8ab4f8; }
  .muted { color: #6b7689; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 20px; }
  section { background: #11151f; border: 1px solid #1c2230; border-radius: 8px; padding: 14px 16px; }
  section.wide { grid-column: 1 / -1; }
  h2 { font-size: 13px; margin: 0 0 10px; color: #9aa7bd; text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #161b27; vertical-align: top; }
  th { color: #6b7689; font-weight: 600; }
  .badge { padding: 1px 8px; border-radius: 999px; font-size: 12px; }
  .ok { color: #6ee7b7; } .bad { color: #f87171; } .warn { color: #fbbf24; }
  .err { color: #f87171; white-space: pre-wrap; word-break: break-word; }
  .pill-ready { background: #064e3b; color: #6ee7b7; }
  .pill-bad { background: #4c1d24; color: #f87171; }
  .empty { color: #6b7689; font-style: italic; }
  .chip { display: inline-block; padding: 1px 8px; margin: 2px 4px 2px 0; border-radius: 6px; background: #161b27; font-size: 12px; }
  .chip.tag { color: #8ab4f8; }
  .kv { display: flex; gap: 8px; } .kv .k { color: #6b7689; min-width: 92px; }
</style>
</head>
<body>
<header>
  <h1>✳ copilot-reverse</h1>
  <span class="muted">worker <span id="state" class="badge">…</span></span>
  <span class="muted">github <span id="gh">…</span></span>
  <span class="muted">web search <span id="web">…</span></span>
  <span class="muted" id="updated"></span>
</header>
<main>
  <section>
    <h2>Health</h2>
    <div id="doctor"><span class="empty">loading…</span></div>
  </section>
  <section>
    <h2>Requests</h2>
    <div id="metrics"><span class="empty">loading…</span></div>
  </section>
  <section>
    <h2>Clients</h2>
    <div id="clients"><span class="empty">loading…</span></div>
  </section>
  <section>
    <h2>Models</h2>
    <div id="models"><span class="empty">loading…</span></div>
  </section>
  <section class="wide">
    <h2>Recent errors</h2>
    <div id="errors"><span class="empty">loading…</span></div>
  </section>
  <section class="wide">
    <h2>Recent requests</h2>
    <div id="requests"><span class="empty">loading…</span></div>
  </section>
</main>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const fmt = (ts) => new Date(ts).toLocaleTimeString();
// Parity with the TUI's shared isError: a runaway-tagged 200 (error set, stream cut) is an error too.
const isErr = (r) => r.status >= 400 || r.error != null;
async function getJson(p) { const r = await fetch(p); if (!r.ok) throw new Error(p + " -> " + r.status); return r.json(); }

function pill(el, label, ok) {
  el.textContent = label;
  el.className = "badge " + (ok ? "pill-ready" : "pill-bad");
}
function renderState(s) { pill(document.getElementById("state"), s, s === "ready"); }
function renderGithub(gh) {
  const el = document.getElementById("gh");
  if (!gh) { el.textContent = "…"; el.className = "muted"; return; }
  const ok = gh.ok;
  el.textContent = ok ? "✓ connected" : (gh.hasToken ? "✗ expired — /login" : "✗ signed out — /login");
  el.className = ok ? "ok" : "bad";
}
function renderWeb(checks) {
  const c = (checks || []).find((x) => x.name === "web-search");
  const el = document.getElementById("web");
  if (!c) { el.textContent = "…"; el.className = "muted"; return; }
  el.textContent = c.detail; el.className = c.ok ? "ok" : "bad";
}
function renderDoctor(checks) {
  const el = document.getElementById("doctor");
  if (!checks.length) { el.innerHTML = '<span class="empty">no checks</span>'; return; }
  el.innerHTML = "<table>" + checks.map((c) =>
    '<tr><td class="' + (c.ok ? "ok" : "bad") + '">' + (c.ok ? "✓" : "✗") + "</td><td>" + esc(c.name) + '</td><td class="muted">' + esc(c.detail) + "</td></tr>"
  ).join("") + "</table>";
}
function scopeCell(s, model) { return s ? '<span class="ok">✓ ' + esc((model || "on").replace(/\\[1m\\]$/, "")) + "</span>" : '<span class="muted">○</span>'; }
function renderClients(cl) {
  const el = document.getElementById("clients");
  if (!cl || (!cl.claude && !cl.codex)) { el.innerHTML = '<span class="empty">no client config</span>'; return; }
  const row = (name, c) => "<tr><td>" + name + "</td><td>" + scopeCell(c.user, c.userModel) + "</td><td>" + scopeCell(c.project, c.projectModel) + "</td></tr>";
  el.innerHTML = "<table><tr><th>client</th><th>user</th><th>project</th></tr>" + row("claude", cl.claude) + row("codex", cl.codex) + "</table>";
}
function renderModels(models) {
  const el = document.getElementById("models");
  if (!models || !models.length) { el.innerHTML = '<span class="empty">discovery unavailable</span>'; return; }
  el.innerHTML = '<div class="muted">' + models.length + " advertised</div>" + models.map((m) => {
    const oneM = /\\[1m\\]$/.test(m.id);
    return '<span class="chip">' + esc((m.display_name || m.id)) + (oneM ? ' <span class="tag">1M</span>' : "") + "</span>";
  }).join("");
}
function renderRequests(reqs) {
  const total = reqs.length, errors = reqs.filter(isErr).length;
  document.getElementById("metrics").innerHTML =
    '<div>total <b>' + total + '</b> &nbsp; errors <b class="' + (errors ? "bad" : "ok") + '">' + errors + "</b></div>";

  const errs = reqs.filter(isErr).slice(0, 30);
  document.getElementById("errors").innerHTML = errs.length
    ? "<table><tr><th>time</th><th>status</th><th>endpoint</th><th>model</th><th>error</th></tr>" + errs.map((r) =>
        "<tr><td>" + fmt(r.ts) + '</td><td class="bad">' + r.status + "</td><td>" + esc(r.endpoint) + "</td><td>" + esc(r.model) + '</td><td class="err">' + esc(r.error || "(no message)") + "</td></tr>"
      ).join("") + "</table>"
    : '<span class="empty">no request errors — everything\\'s green ✓</span>';

  const recent = reqs.slice(0, 30);
  document.getElementById("requests").innerHTML = recent.length
    ? "<table><tr><th>time</th><th>status</th><th>endpoint</th><th>model</th><th>ms</th></tr>" + recent.map((r) =>
        "<tr><td>" + fmt(r.ts) + '</td><td class="' + (isErr(r) ? "bad" : "ok") + '">' + r.status + "</td><td>" + esc(r.endpoint) + "</td><td>" + esc(r.model) + "</td><td>" + r.latencyMs + "</td></tr>"
      ).join("") + "</table>"
    : '<span class="empty">no requests yet</span>';
}
async function tick() {
  try {
    // Light doctor only (no ?ping) — the 2s cadence must never fire real model requests.
    const [status, reqs, doctor, clients, models] = await Promise.all([
      getJson("/api/status"), getJson("/api/requests"), getJson("/api/doctor"),
      getJson("/api/clients"), getJson("/api/models"),
    ]);
    renderState(status.workerState);
    renderGithub(status.github);
    renderDoctor(doctor.checks || []);
    renderWeb(doctor.checks || []);
    renderClients(clients);
    renderModels(models.models || []);
    renderRequests(reqs.requests || []);
    document.getElementById("updated").textContent = "updated " + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById("updated").textContent = "control API unreachable: " + e.message;
  }
}
tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
}
