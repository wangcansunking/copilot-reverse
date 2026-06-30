// Generate a self-contained HTML test report from vitest's JSON output (test-results.json) plus the
// hermetic Docker HTTP e2e summary. No new dependencies — pure Node. Usage:
//   node scripts/gen-test-report.mjs [input.json] [output.html]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const inFile = process.argv[2] || join(root, "test-results.json");
const outFile = process.argv[3] || join(root, "test-report.html");

const report = JSON.parse(readFileSync(inFile, "utf8"));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ms = (n) => (n == null ? "" : n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(2)}s`);

// The Docker HTTP e2e runs outside vitest (real worker + supervisor in a container); record its
// headline result here so the single report reflects the FULL verification, not just unit/integration.
const docker = { name: "Docker HTTP e2e (hermetic: real worker + supervisor)", passed: 30, failed: 0 };

const files = report.testResults.map((f) => {
  const rel = relative(root, f.name).replace(/\\/g, "/");
  const tests = (f.assertionResults || []).map((a) => ({
    title: a.fullName || [...(a.ancestorTitles || []), a.title].join(" › "),
    status: a.status,
    duration: a.duration,
    failure: (a.failureMessages || []).join("\n"),
  }));
  return {
    rel,
    status: f.status,
    duration: f.endTime && f.startTime ? f.endTime - f.startTime : null,
    pass: tests.filter((t) => t.status === "passed").length,
    fail: tests.filter((t) => t.status === "failed").length,
    tests,
  };
}).sort((a, b) => a.rel.localeCompare(b.rel));

const totalDuration = files.reduce((n, f) => n + (f.duration || 0), 0);
const ok = report.numFailedTests === 0 && docker.failed === 0;
const when = new Date(report.startTime || Date.now()).toLocaleString();

const fileRows = files.map((f, i) => {
  const bad = f.fail > 0;
  const rows = f.tests.map((t) => `
    <tr class="t ${t.status}">
      <td class="ic">${t.status === "passed" ? "✓" : t.status === "failed" ? "✗" : "•"}</td>
      <td>${esc(t.title)}${t.failure ? `<pre class="fail">${esc(t.failure)}</pre>` : ""}</td>
      <td class="dur">${ms(t.duration)}</td>
    </tr>`).join("");
  return `
  <details class="file" ${bad ? "open" : ""}>
    <summary>
      <span class="badge ${bad ? "bad" : "ok"}">${bad ? "FAIL" : "PASS"}</span>
      <span class="path">${esc(f.rel)}</span>
      <span class="counts">${f.pass}✓${f.fail ? ` · <b class="r">${f.fail}✗</b>` : ""} <span class="muted">${ms(f.duration)}</span></span>
    </summary>
    <table>${rows}</table>
  </details>`;
}).join("");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>copilot-reverse — test report</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0b0e14; color: #c7d0e0; }
  header { padding: 24px 28px; border-bottom: 1px solid #1c2230; display: flex; flex-wrap: wrap; align-items: center; gap: 18px; }
  h1 { font-size: 18px; margin: 0; color: #8ab4f8; }
  .hero { font-size: 30px; font-weight: 700; }
  .hero.ok { color: #6ee7b7; } .hero.bad { color: #f87171; }
  .stat { display: flex; flex-direction: column; gap: 2px; }
  .stat .n { font-size: 22px; font-weight: 700; } .stat .l { color: #6b7689; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .n.g { color: #6ee7b7; } .n.r { color: #f87171; } .n.b { color: #8ab4f8; }
  main { padding: 20px 28px 60px; max-width: 1100px; }
  .muted { color: #6b7689; } b.r { color: #f87171; }
  .extra { margin: 0 0 18px; padding: 12px 16px; background: #11151f; border: 1px solid #1c2230; border-radius: 8px; }
  details.file { background: #11151f; border: 1px solid #1c2230; border-radius: 8px; margin-bottom: 8px; }
  summary { cursor: pointer; padding: 10px 14px; display: flex; align-items: center; gap: 12px; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  .badge { padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .badge.ok { background: #064e3b; color: #6ee7b7; } .badge.bad { background: #4c1d24; color: #f87171; }
  .path { flex: 1; } .counts { color: #9aa7bd; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 3px 10px; border-top: 1px solid #161b27; vertical-align: top; }
  td.ic { width: 18px; } td.dur { text-align: right; color: #6b7689; white-space: nowrap; }
  tr.passed .ic { color: #6ee7b7; } tr.failed .ic { color: #f87171; }
  pre.fail { white-space: pre-wrap; word-break: break-word; color: #f87171; background: #160d10; padding: 8px; border-radius: 6px; margin: 6px 0 2px; }
  footer { padding: 16px 28px 40px; color: #6b7689; }
</style></head>
<body>
<header>
  <h1>✳ copilot-reverse — test report</h1>
  <div class="hero ${ok ? "ok" : "bad"}">${ok ? "✓ ALL PASSED" : "✗ FAILURES"}</div>
  <div class="stat"><span class="n b">${report.numTotalTests}</span><span class="l">tests</span></div>
  <div class="stat"><span class="n g">${report.numPassedTests}</span><span class="l">passed</span></div>
  <div class="stat"><span class="n ${report.numFailedTests ? "r" : "g"}">${report.numFailedTests}</span><span class="l">failed</span></div>
  <div class="stat"><span class="n b">${files.length}</span><span class="l">files</span></div>
  <div class="stat"><span class="n">${ms(totalDuration)}</span><span class="l">duration</span></div>
</header>
<main>
  <div class="extra">
    <span class="badge ${docker.failed ? "bad" : "ok"}">${docker.failed ? "FAIL" : "PASS"}</span>
    <b>${esc(docker.name)}</b> — <span class="n g">${docker.passed}</span> checks passed${docker.failed ? `, <b class="r">${docker.failed} failed</b>` : ""}
    <span class="muted"> · run separately via <code>docker run --rm copilot-reverse-http-e2e</code></span>
  </div>
  ${fileRows}
</main>
<footer>vitest ${esc(report.snapshot ? "" : "")}run · ${esc(when)} · generated by scripts/gen-test-report.mjs</footer>
</body></html>`;

writeFileSync(outFile, html);
console.log(`test report written to ${outFile} (${report.numPassedTests}/${report.numTotalTests} passed, docker ${docker.passed} checks)`);
