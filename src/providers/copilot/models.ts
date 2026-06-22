// Live model list from Copilot. Falls back to a curated list if the endpoint is unavailable.
const MODELS_URL = "https://api.githubcopilot.com/models";
const FALLBACK = ["gpt-4o", "gpt-4o-mini", "claude-sonnet-4-6", "claude-opus-4-8", "o3-mini"];

const HEADERS = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "editor-version": "vscode/1.95.0",
  "copilot-integration-id": "vscode-chat",
});

const DEFAULT_TIMEOUT_MS = 8000;

// A stalled Copilot endpoint must never hang the model picker forever — abort after timeoutMs.
async function getModels(token: string, fetchFn: typeof fetch, timeoutMs: number): Promise<{ id?: string; capabilities?: { limits?: { max_prompt_tokens?: number; max_context_window_tokens?: number } } }[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(MODELS_URL, { headers: HEADERS(token), signal: ctrl.signal });
    if (!res.ok) return null;
    return ((await res.json()) as { data?: unknown[] }).data as never ?? [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCopilotModels(token: string, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string[]> {
  const data = await getModels(token, fetchFn, timeoutMs);
  if (!data) return FALLBACK;
  const ids = [...new Set(data.map((m) => m.id).filter((x): x is string => Boolean(x)))];
  return ids.length ? ids : FALLBACK;
}

// Map of model id -> its real input/context window, used to size auto-compaction per model and
// to show the window in the picker. Returns {} on failure/timeout so callers fall back gracefully.
export async function fetchModelLimits(token: string, fetchFn: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, number>> {
  const data = await getModels(token, fetchFn, timeoutMs);
  if (!data) return {};
  const out: Record<string, number> = {};
  for (const m of data) {
    // Prefer the headline context window (so a 1M model shows as 1M); fall back to the prompt budget.
    const limit = m.capabilities?.limits?.max_context_window_tokens ?? m.capabilities?.limits?.max_prompt_tokens;
    if (m.id && typeof limit === "number") out[m.id] = limit;
  }
  return out;
}
