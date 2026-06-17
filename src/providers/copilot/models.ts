// Live model list from Copilot. Falls back to a curated list if the endpoint is unavailable.
const MODELS_URL = "https://api.githubcopilot.com/models";
const FALLBACK = ["gpt-4o", "gpt-4o-mini", "claude-sonnet-4-6", "claude-opus-4-8", "o3-mini"];

export async function fetchCopilotModels(token: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  try {
    const res = await fetchFn(MODELS_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "editor-version": "vscode/1.95.0",
        "copilot-integration-id": "vscode-chat",
      },
    });
    if (!res.ok) return FALLBACK;
    const data = (await res.json()) as { data?: { id?: string }[] };
    const ids = [...new Set((data.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x)))];
    return ids.length ? ids : FALLBACK;
  } catch {
    return FALLBACK;
  }
}
