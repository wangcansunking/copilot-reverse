import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Small user-preferences store (e.g. the chosen chat model), persisted across launches.
const file = (dir: string) => join(dir, "prefs.json");

export function readChatModel(dir: string): string | null {
  if (!existsSync(file(dir))) return null;
  try { return (JSON.parse(readFileSync(file(dir), "utf8")) as { chatModel?: string }).chatModel ?? null; }
  catch { return null; }
}

export function writeChatModel(dir: string, model: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let cur: Record<string, unknown> = {};
  if (existsSync(file(dir))) { try { cur = JSON.parse(readFileSync(file(dir), "utf8")) as Record<string, unknown>; } catch { cur = {}; } }
  writeFileSync(file(dir), JSON.stringify({ ...cur, chatModel: model }));
}
