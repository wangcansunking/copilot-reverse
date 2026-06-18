// Live model list from Copilot. Falls back to a curated list if the endpoint is unavailable.
const MODELS_URL = "https://api.githubcopilot.com/models";
const FALLBACK = ["gpt-4o", "gpt-4o-mini", "claude-sonnet-4-6", "claude-opus-4-8", "o3-mini"];

const HEADERS = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "editor-version": "vscode/1.95.0",
  "copilot-integration-id": "vscode-chat",
});

export async function fetchCopilotModels(token: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  try {
    const res = await fetchFn(MODELS_URL, { headers: HEADERS(token) });
    if (!res.ok) return FALLBACK;
    const data = (await res.json()) as { data?: { id?: string }[] };
    const ids = [...new Set((data.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x)))];
    return ids.length ? ids : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

interface ModelEntry { id?: string; capabilities?: { limits?: { max_prompt_tokens?: number; max_context_window_tokens?: number } } }

// Map of model id -> its real input/context window, used to size auto-compaction per model.
// Returns {} on failure so callers fall back to a conservative default.
export async function fetchModelLimits(token: string, fetchFn: typeof fetch = fetch): Promise<Record<string, number>> {
  try {
    const res = await fetchFn(MODELS_URL, { headers: HEADERS(token) });
    if (!res.ok) return {};
    const data = (await res.json()) as { data?: ModelEntry[] };
    const out: Record<string, number> = {};
    for (const m of data.data ?? []) {
      const limit = m.capabilities?.limits?.max_prompt_tokens ?? m.capabilities?.limits?.max_context_window_tokens;
      if (m.id && typeof limit === "number") out[m.id] = limit;
    }
    return out;
  } catch {
    return {};
  }
}
