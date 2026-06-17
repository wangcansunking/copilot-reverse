import { Registry, type SlashContext } from "./registry.js";

export function buildRegistry(ctx: SlashContext): Registry {
  const reg = new Registry(ctx);
  reg.add({ name: "/status", describe: "show worker status + restart history", run: async (_a, c) => {
    const s = await c.client.status();
    const lines = [`worker: ${s.workerState}`];
    for (const r of s.restarts.slice(0, 5)) lines.push(`  ${r.reason} exit=${r.exitCode ?? "-"} ${r.stderrTail.slice(0, 60)}`);
    return lines;
  } });
  reg.add({ name: "/doctor", describe: "run health checks", run: async (_a, c) => (await c.client.doctor()).map((x) => `${x.ok ? "OK " : "FAIL"} ${x.name}: ${x.detail}`) });
  reg.add({ name: "/restart", describe: "restart the worker", run: async (_a, c) => { await c.client.restart(); return ["restart requested"]; } });
  reg.add({ name: "/stop", describe: "stop the worker", run: async (_a, c) => { await c.client.stop(); return ["worker stopped"]; } });
  reg.add({ name: "/start", describe: "start the worker", run: async (_a, c) => { await c.client.start(); return ["worker started"]; } });
  reg.add({ name: "/logs", describe: "recent restart events", run: async (_a, c) => {
    const s = await c.client.status();
    return s.restarts.length ? s.restarts.map((r) => `${new Date(r.ts).toISOString()} ${r.reason} ${r.stderrTail.slice(0, 80)}`) : ["no restart events"];
  } });
  reg.add({ name: "/quit", describe: "exit maestro", run: async (_a, c) => { c.quit(); return ["bye"]; } });
  reg.add({ name: "/help", describe: "list commands", run: async () => reg.list().map((c) => `${c.name.padEnd(14)} ${c.describe}`) });
  return reg;
}
