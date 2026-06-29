import { randomUUID } from "node:crypto";

// Some models (Claude via the Copilot gateway, especially under long/tool-heavy turns) emit a tool
// call as TEXT — an inline `<function_calls><invoke name="…"><parameter …>…</invoke></function_calls>`
// block — instead of via the wire's structured `tool_calls`. When that happens the proxy would
// otherwise forward the XML verbatim and the client renders it as a literal message instead of
// running the tool. This extractor recovers those inline blocks back into structured tool calls.
//
// It is a streaming state machine: feed it text deltas, and it returns ordered events — plain text
// that is safe to forward, and reconstructed tool calls. It is deliberately conservative: it only
// enters capture mode on a distinctive opening sentinel, and on a stream that ends mid-block it
// flushes the buffer back out as text (never swallows content it couldn't fully parse).

export interface ExtractedTool {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export type ExtractEvent = { kind: "text"; text: string } | { kind: "tool"; tool: ExtractedTool };

// Opening sentinels that switch the parser into capture mode. The `antml:` namespaced variants are
// the un-stripped originals; the bare forms are what survives when the namespace prefix is dropped.
const TRIGGER_RE = /<(?:antml:)?(?:function_calls>|invoke\b)/;

// Longest suffix of `s` that is a proper prefix of a trigger token — text we must hold back because
// it might be the front of a sentinel split across chunk boundaries (e.g. "…<inv" then "oke name=").
// MUST list both the bare and the `antml:`-namespaced sentinels: Copilot streams Claude's tool call
// token by token, so an opening `<invoke` is routinely split (e.g. "…<a" then "ntml:invoke");
// if the namespaced forms are missing, that "<a" tail isn't recognized as a partial sentinel, leaks
// as text, and the remainder no longer matches the trigger — the whole call renders literally.
// Bare sentinel bodies, plus their namespaced variants built by inserting the prefix after "<" (the
// literal is assembled here rather than written inline so the namespace can't be stripped from source).
const NS = "antml" + ":";
const BARE_TOKENS = ["<function_calls>", "<invoke"];
const PREFIX_TOKENS = [...BARE_TOKENS, ...BARE_TOKENS.map((t) => "<" + NS + t.slice(1))];
function heldBackLen(s: string): number {
  let max = 0;
  for (const t of PREFIX_TOKENS) {
    for (let k = Math.min(s.length, t.length - 1); k > 0; k--) {
      if (s.endsWith(t.slice(0, k))) { if (k > max) max = k; break; }
    }
  }
  return max;
}

// Index just past a `</tag>` (or `</tag>`) close, or -1 if not yet present in `s`.
function closeIndex(s: string, tag: string): number {
  const m = new RegExp(`</(?:antml:)?${tag}>`).exec(s);
  return m ? m.index + m[0].length : -1;
}

// A scalar parameter value is raw text in the XML; recover its intended type by trying JSON, so
// `42`/`true`/`{"a":1}` become real values while a bare command string stays a string.
function coerce(raw: string): unknown {
  const v = raw.replace(/^\n/, "").replace(/\n$/, "");
  try { return JSON.parse(v); } catch { return v; }
}

function parseInvokes(block: string): ExtractedTool[] {
  const tools: ExtractedTool[] = [];
  const invokeRe = /<(?:antml:)?invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?invoke>/g;
  for (let m = invokeRe.exec(block); m; m = invokeRe.exec(block)) {
    const [, name, body] = m;
    const input: Record<string, unknown> = {};
    const paramRe = /<(?:antml:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?parameter>/g;
    for (let p = paramRe.exec(body); p; p = paramRe.exec(body)) input[p[1]] = coerce(p[2]);
    tools.push({ id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`, name, input });
  }
  return tools;
}

export class ToolCallExtractor {
  private buf = "";
  private capturing = false;

  feed(chunk: string): ExtractEvent[] {
    this.buf += chunk;
    const events: ExtractEvent[] = [];
    for (;;) {
      if (!this.capturing) {
        const m = TRIGGER_RE.exec(this.buf);
        if (!m) {
          // No trigger; emit everything except a possible partial-sentinel tail.
          const keep = heldBackLen(this.buf);
          const emit = this.buf.slice(0, this.buf.length - keep);
          if (emit) events.push({ kind: "text", text: emit });
          this.buf = keep ? this.buf.slice(this.buf.length - keep) : "";
          return events;
        }
        if (m.index > 0) events.push({ kind: "text", text: this.buf.slice(0, m.index) });
        this.buf = this.buf.slice(m.index);
        this.capturing = true;
      }
      const isWrapper = /^<(?:antml:)?function_calls>/.test(this.buf);
      const end = closeIndex(this.buf, isWrapper ? "function_calls" : "invoke");
      if (end < 0) return events; // incomplete block — wait for more data
      const block = this.buf.slice(0, end);
      const tools = parseInvokes(block);
      // Parse-faithful: a block that recovers no tools (empty/missing name="" or malformed body)
      // must NOT be swallowed — pass it through verbatim so the client sees exactly what the model
      // emitted. Swallowing yields a turn with neither text nor a tool, which loops the model.
      if (tools.length) for (const tool of tools) events.push({ kind: "tool", tool });
      else events.push({ kind: "text", text: block });
      this.buf = this.buf.slice(end);
      this.capturing = false; // a following <invoke> re-triggers via the passthrough branch
    }
  }

  // Stream ended. Anything still buffered is an incomplete block we couldn't parse — emit it as
  // text so nothing is silently dropped.
  flush(): ExtractEvent[] {
    const out: ExtractEvent[] = this.buf ? [{ kind: "text", text: this.buf }] : [];
    this.buf = "";
    this.capturing = false;
    return out;
  }
}
