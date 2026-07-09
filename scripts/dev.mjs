#!/usr/bin/env node
// `npm run dev` entry. Runs the TUI under the "dev" profile so it gets its own ports (7990/7991) and
// data dir (~/.copilot-reverse-dev), fully isolated from an installed prod instance — no port clash,
// no shared token/db/access-key. The dev data dir is seeded once from prod on first boot (see
// ensureProfileSeeded) so you don't have to re-/login. Set COPILOT_REVERSE_PROFILE yourself to run a
// different named profile. We spawn tsx in a child so this works identically on cmd.exe and POSIX
// shells (inline VAR=val prefixes don't work on Windows cmd).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src", "cli", "index.ts");
const env = { ...process.env, COPILOT_REVERSE_PROFILE: process.env.COPILOT_REVERSE_PROFILE || "dev" };

// Resolve the tsx CLI entry from its package "bin" so we don't depend on a shell finding it on PATH,
// nor hardcode its internal dist layout.
const require = createRequire(import.meta.url);
const tsxPkg = require.resolve("tsx/package.json");
const binField = require(tsxPkg).bin;
const binRel = typeof binField === "string" ? binField : binField.tsx;
const tsx = join(dirname(tsxPkg), binRel);

const child = spawn(process.execPath, [tsx, entry, ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
