import { describe, it, expect } from "vitest";
import { openCommandFor } from "../../src/shared/open-url.js";

describe("openCommandFor", () => {
  it("uses cmd start on Windows", () => {
    expect(openCommandFor("http://x", "win32")).toEqual({ command: "cmd", args: ["/c", "start", "", "http://x"] });
  });
  it("uses open on macOS", () => {
    expect(openCommandFor("http://x", "darwin")).toEqual({ command: "open", args: ["http://x"] });
  });
  it("uses xdg-open elsewhere", () => {
    expect(openCommandFor("http://x", "linux")).toEqual({ command: "xdg-open", args: ["http://x"] });
  });
});
