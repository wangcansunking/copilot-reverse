// A self-contained, dependency-free dashboard page served at GET /. It polls the existing
// control API (/api/status, /api/requests, /api/doctor) every 2s and renders worker health,
// request metrics, and — most usefully — recent request errors with their messages.
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>llm-maestro dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0b0e14; color: #c7d0e0; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 16px 20px; border-bottom: 1px solid #1c2230; }
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
</style>
</head>
<body>
<header>
  <h1>✳ llm-maestro</h1>
  <span class="muted">worker <span id="state" class="badge">…</span></span>
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
async function getJson(p) { const r = await fetch(p); if (!r.ok) throw new Error(p + " -> " + r.status); return r.json(); }

function renderState(s) {
  const el = document.getElementById("state");
  el.textContent = s;
  el.className = "badge " + (s === "ready" ? "pill-ready" : "pill-bad");
}
function renderDoctor(checks) {
  const el = document.getElementById("doctor");
  if (!checks.length) { el.innerHTML = '<span class="empty">no checks</span>'; return; }
  el.innerHTML = "<table>" + checks.map((c) =>
    '<tr><td class="' + (c.ok ? "ok" : "bad") + '">' + (c.ok ? "✓" : "✗") + "</td><td>" + esc(c.name) + '</td><td class="muted">' + esc(c.detail) + "</td></tr>"
  ).join("") + "</table>";
}
function renderRequests(reqs) {
  const total = reqs.length, errors = reqs.filter((r) => r.status >= 400).length;
  document.getElementById("metrics").innerHTML =
    '<div>total <b>' + total + '</b> &nbsp; errors <b class="' + (errors ? "bad" : "ok") + '">' + errors + "</b></div>";

  const errs = reqs.filter((r) => r.status >= 400).slice(0, 30);
  document.getElementById("errors").innerHTML = errs.length
    ? "<table><tr><th>time</th><th>status</th><th>endpoint</th><th>model</th><th>error</th></tr>" + errs.map((r) =>
        "<tr><td>" + fmt(r.ts) + '</td><td class="bad">' + r.status + "</td><td>" + esc(r.endpoint) + "</td><td>" + esc(r.model) + '</td><td class="err">' + esc(r.error || "(no message)") + "</td></tr>"
      ).join("") + "</table>"
    : '<span class="empty">no request errors — everything\\'s green ✓</span>';

  const recent = reqs.slice(0, 30);
  document.getElementById("requests").innerHTML = recent.length
    ? "<table><tr><th>time</th><th>status</th><th>endpoint</th><th>model</th><th>ms</th></tr>" + recent.map((r) =>
        "<tr><td>" + fmt(r.ts) + '</td><td class="' + (r.status >= 400 ? "bad" : "ok") + '">' + r.status + "</td><td>" + esc(r.endpoint) + "</td><td>" + esc(r.model) + "</td><td>" + r.latencyMs + "</td></tr>"
      ).join("") + "</table>"
    : '<span class="empty">no requests yet</span>';
}
async function tick() {
  try {
    const [status, reqs, doctor] = await Promise.all([
      getJson("/api/status"), getJson("/api/requests"), getJson("/api/doctor"),
    ]);
    renderState(status.workerState);
    renderDoctor(doctor.checks || []);
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
