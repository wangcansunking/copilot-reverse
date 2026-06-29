import { describe, it, expect } from "vitest";
import { ToolCallExtractor, type ExtractEvent } from "../../src/core/tool-xml.js";

// Drive the extractor with a list of chunks and collect every emitted event (feed + final flush).
function run(chunks: string[]): ExtractEvent[] {
  const ex = new ToolCallExtractor();
  const events: ExtractEvent[] = [];
  for (const c of chunks) events.push(...ex.feed(c));
  events.push(...ex.flush());
  return events;
}
const text = (e: ExtractEvent[]) => e.filter((x) => x.kind === "text").map((x) => (x as any).text).join("");
const tools = (e: ExtractEvent[]) => e.filter((x) => x.kind === "tool").map((x) => (x as any).tool);

describe("ToolCallExtractor", () => {
  it("passes plain text through untouched", () => {
    const e = run(["hello ", "world, no tools here"]);
    expect(text(e)).toBe("hello world, no tools here");
    expect(tools(e)).toHaveLength(0);
  });

  it("extracts a single inline tool call (function_calls wrapper)", () => {
    const e = run([
      'let me check. <function_calls><invoke name="Bash"><parameter name="command">ls -la</parameter></invoke></function_calls> done',
    ]);
    expect(text(e)).toBe("let me check.  done");
    const t = tools(e);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ name: "Bash", input: { command: "ls -la" } });
    expect(t[0].id).toMatch(/^call_/);
  });

  it("handles a bare <invoke> with no wrapper", () => {
    const e = run(['<invoke name="now"><parameter name="tz">utc</parameter></invoke>']);
    expect(tools(e)).toEqual([expect.objectContaining({ name: "now", input: { tz: "utc" } })]);
    expect(text(e)).toBe("");
  });

  it("parses multiple parameters and coerces JSON scalar types", () => {
    const e = run([
      '<invoke name="cfg"><parameter name="count">42</parameter><parameter name="on">true</parameter><parameter name="label">hi there</parameter></invoke>',
    ]);
    expect(tools(e)[0].input).toEqual({ count: 42, on: true, label: "hi there" });
  });

  it("reconstructs a tool call split across many chunks (incl. a split sentinel)", () => {
    const e = run(["pre <fun", "ction_calls><invoke name=\"Read\"><para", 'meter name="path">/etc/hosts</parameter></invoke></function_calls> post']);
    expect(text(e)).toBe("pre  post");
    expect(tools(e)).toEqual([expect.objectContaining({ name: "Read", input: { path: "/etc/hosts" } })]);
  });

  it("does not hold back ordinary text containing a lone '<'", () => {
    const e = run(["a < b and c < d"]);
    expect(text(e)).toBe("a < b and c < d");
    expect(tools(e)).toHaveLength(0);
  });

  it("flushes an unclosed/incomplete block back out as text (never swallowed)", () => {
    const e = run(['oops <invoke name="Bash"><parameter name="command">rm -rf /tmp/x']);
    expect(text(e)).toBe('oops <invoke name="Bash"><parameter name="command">rm -rf /tmp/x');
    expect(tools(e)).toHaveLength(0);
  });

  // Parse-faithful: a closed block that yields NO tool (empty name, malformed body) must pass
  // through as text, not be swallowed. Swallowing produces a turn with no text and no tool, which
  // loops the model into endless empty "call:" emissions.
  it("passes an empty-name invoke through as text (does not swallow)", () => {
    const e = run(['<invoke name=""><parameter name="x">1</parameter></invoke>']);
    expect(tools(e)).toHaveLength(0);
    expect(text(e)).toBe('<invoke name=""><parameter name="x">1</parameter></invoke>');
  });

  it("passes a closed-but-unparseable block through as text", () => {
    const e = run(["<function_calls>garbage no invoke</function_calls>"]);
    expect(tools(e)).toHaveLength(0);
    expect(text(e)).toBe("<function_calls>garbage no invoke</function_calls>");
  });

  // The user's SSE concern: an empty invoke split across chunks must wait for the close tag, not
  // parse mid-stream. Only after the block is fully closed does it pass through as text.
  it("waits for the close tag on a split empty invoke, then emits as text", () => {
    const ex = new ToolCallExtractor();
    expect(ex.feed('<invoke name="">part')).toHaveLength(0); // unclosed: hold, never emit
    const e = [...ex.feed("ial</invoke>"), ...ex.flush()];
    expect(tools(e)).toHaveLength(0);
    expect(text(e)).toBe('<invoke name="">partial</invoke>');
  });

  it("handles two tool calls inside one wrapper", () => {
    const e = run([
      '<function_calls><invoke name="a"><parameter name="x">1</parameter></invoke><invoke name="b"><parameter name="y">2</parameter></invoke></function_calls>',
    ]);
    const t = tools(e);
    expect(t.map((x) => x.name)).toEqual(["a", "b"]);
    expect(t[0].input).toEqual({ x: 1 });
    expect(t[1].input).toEqual({ y: 2 });
  });

  it("still extracts when the namespace prefix is present (antml:)", () => {
    // Build tags via concatenation so no literal close-tag appears in source; ns = "antml:".
    const ns = "antml:", P = "parameter", I = "invoke";
    const xml = `<${ns}${I} name="Bash"><${ns}${P} name="command">echo hi</${ns}${P}></${ns}${I}>`;
    const e = run([xml]);
    expect(tools(e)).toEqual([expect.objectContaining({ name: "Bash", input: { command: "echo hi" } })]);
  });

  // Regression: Copilot streams Claude's antml-namespaced tool call token by token, so the opening
  // sentinel `<invoke` is routinely split across chunks. The partial tail MUST be held back; if
  // it leaks as text the remainder no longer matches the trigger and the whole call renders literally.
  describe("antml sentinel split across chunks (regression)", () => {
    const ns = "antml:", P = "parameter", I = "invoke", FC = "function_calls";
    const invoke =
      `<${ns}${I} name="TaskUpdate">` +
      `<${ns}${P} name="status">completed</${ns}${P}>` +
      `<${ns}${P} name="taskId">20</${ns}${P}>` +
      `</${ns}${I}>`;
    const expectTaskUpdate = (e: ExtractEvent[]) => {
      expect(text(e)).toBe("");
      expect(tools(e)).toEqual([expect.objectContaining({ name: "TaskUpdate", input: { status: "completed", taskId: 20 } })]);
    };

    // Split at every position inside the opening `<invoke` sentinel — each must reconstruct.
    for (let cut = 1; cut <= `<${ns}${I}`.length; cut++) {
      it(`bare invoke split after ${cut} char(s)`, () => {
        expectTaskUpdate(run([invoke.slice(0, cut), invoke.slice(cut)]));
      });
    }

    it("wrapper sentinel <function_calls> split after '<'", () => {
      const wrapped = `<${ns}${FC}>` + invoke + `</${ns}${FC}>`;
      const cut = "<".length;
      expectTaskUpdate(run([wrapped.slice(0, cut), wrapped.slice(cut)]));
    });
  });
});