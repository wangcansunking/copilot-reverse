import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Select } from "../../src/tui/components/select.js";

const items = [
  { label: "a", value: "a" },
  { label: "b", value: "b" },
  { label: "c", value: "c" },
];

const ESC = String.fromCharCode(27);
const DOWN = ESC + "[B";
const UP = ESC + "[A";

describe("Select", () => {
  it("down arrow moves the highlight; enter submits the highlighted item", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<Select items={items} onSubmit={onSubmit} />);
    await new Promise((r) => setTimeout(r, 30));
    stdin.write(DOWN); // -> index 1 (b)
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("\r"); // enter
    await new Promise((r) => setTimeout(r, 20));
    expect(onSubmit).toHaveBeenCalledWith({ label: "b", value: "b" });
  });

  it("wraps with up arrow from the top", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<Select items={items} onSubmit={onSubmit} />);
    await new Promise((r) => setTimeout(r, 30));
    stdin.write(UP); // 0 -> wraps to last (c)
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 20));
    expect(onSubmit).toHaveBeenCalledWith({ label: "c", value: "c" });
  });

  it("windows a long list (bounded height) and still selects deep items", async () => {
    const long = Array.from({ length: 20 }, (_, i) => ({ label: `m${i}`, value: `m${i}` }));
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<Select items={long} onSubmit={onSubmit} />);
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 10; i++) { stdin.write(DOWN); await new Promise((r) => setTimeout(r, 5)); }
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toMatch(/more/); // list is windowed, not fully rendered
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 20));
    expect(onSubmit).toHaveBeenCalledWith({ label: "m10", value: "m10" });
  });
});
