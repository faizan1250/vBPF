import { describe, expect, it } from "vitest";

import { errorToMarker } from "./monaco.js";

describe("errorToMarker", () => {
  it("maps explicit line numbers", () => {
    expect(errorToMarker("a\nb", "syntax error at line 2")).toEqual({
      line: 2,
      text: "syntax error at line 2",
    });
  });
  it("maps probe names to their line", () => {
    const script = "BEGIN { }\ntracepoint:foo:bar { }";
    expect(errorToMarker(script, "probe not found: tracepoint:foo:bar").line).toBe(2);
  });
  it("falls back to line 1", () => {
    expect(errorToMarker("BEGIN { }", "mystery failure").line).toBe(1);
  });
});
