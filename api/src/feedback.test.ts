import { describe, expect, it } from "vitest";

import {
  SHAPED_ERROR_CAP,
  hintForError,
  shapeError,
  shapeFeedbackErrors,
} from "./feedback.js";

describe("shapeError", () => {
  it("strips ANSI codes and banners, keeping the first error", () => {
    const raw =
      "bpftrace v0.20.2\nstdin:1:22-30: ERROR: unknown tracepoint arg args->foo\nAttached 1 probe\n";
    expect(shapeError(`\u001b[31m${raw}\u001b[0m`)).toBe(
      "stdin:1:22-30: ERROR: unknown tracepoint arg args->foo",
    );
  });

  it("prefers located errors over noise lines", () => {
    const raw = [
      "Using BTF from /sys/kernel/btf/vmlinux",
      "AST dump: program ...",
      "stdin:3:5-12: ERROR: undefined variable @x",
    ].join("\n");
    expect(shapeError(raw)).toBe("stdin:3:5-12: ERROR: undefined variable @x");
  });

  it("caps very long output at ~300 chars", () => {
    const raw = `stdin:1:1-10: ERROR: ${"z".repeat(2000)}`;
    const shaped = shapeError(raw);
    expect(Array.from(shaped).length).toBeLessThanOrEqual(SHAPED_ERROR_CAP);
    expect(shaped).toContain("stdin:1:1-10: ERROR:");
  });

  it("returns empty for noise-only input", () => {
    expect(shapeError("Attached 2 probes\n")).toBe("");
  });
});

describe("hintForError", () => {
  it("maps each failure class to its hint", () => {
    expect(hintForError("unknown arg args->dev")).toContain("==ARG_FORMATS==");
    expect(hintForError("undefined variable @start")).toContain("@ prefix");
    expect(hintForError("string vs int comparison")).toContain("str()");
    expect(hintForError("probe not found: tracepoint:foo:bar")).toContain(
      "never invent probe names",
    );
    expect(hintForError("wildcard expands to too many probes")).toContain(
      "50 probes",
    );
    expect(hintForError("blocked call: system is forbidden")).toContain(
      "system/signal/override/cat",
    );
  });

  it("returns null when nothing matches", () => {
    expect(hintForError("dry-run temp file: boom")).toBeNull();
  });
});

describe("shapeFeedbackErrors", () => {
  it("keeps only the first error with one hint", () => {
    const out = shapeFeedbackErrors([
      "stdin:1:1-5: ERROR: unknown tracepoint arg args->nope",
      "stdin:2:1-5: ERROR: something else entirely",
      "Attached 1 probe",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("args->nope");
    expect(out[0]).toContain("Hint:");
    expect(out[0]).not.toContain("something else entirely");
  });

  it("finds the located error past libbpf and deprecation noise", () => {
    const out = shapeFeedbackErrors([
      "[DEBUG] libbpf: loading kernel BTF '/sys/kernel/btf/vmlinux': 0",
      "WARNING: BPFTRACE_STRLEN is deprecated. Use BPFTRACE_MAX_STRLEN instead.",
      "/tmp/vbpf-validate-2836523360.bt:5:60-61: ERROR: invalid character '''",
      "@is_write[args->dev, args->sector] = (args->rwbs[0] == 'W');",
      "~",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("ERROR: invalid character");
    expect(out[0]).toContain('double quotes ("W")');
    expect(out[0]).not.toContain("libbpf");
    expect(out[0]).not.toContain("deprecated");
  });

  it("passes hint-less errors through unchanged", () => {
    expect(shapeFeedbackErrors(["dry-run temp file: boom"])).toEqual([
      "dry-run temp file: boom",
    ]);
  });

  it("returns empty for empty or noise-only input", () => {
    expect(shapeFeedbackErrors([])).toEqual([]);
    expect(shapeFeedbackErrors(["Attached 1 probe"])).toEqual([]);
  });
});
