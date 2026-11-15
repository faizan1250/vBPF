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

  it("returns empty for BTF-debug plus AST dump with no compiler error", () => {
    // Fixture mirrors eval direct-17 / novel-19 dry-run failures: only
    // banners, BTF debug, and AST fragments, no actionable ERROR.
    const raw = [
      "[DEBUG] libbpf: loading kernel BTF '/sys/kernel/btf/vmlinux': 0",
      "WARNING: BPFTRACE_STRLEN is deprecated. Use BPFTRACE_MAX_STRLEN instead.",
      "WARNING: BPFTRACE_MAP_KEYS_MAX is deprecated. Use BPFTRACE_MAX_MAP_KEYS instead.",
      "[DEBUG] libbpf: loading kernel BTF '/sys/kernel/btf/vmlinux': 0",
      "AST after: parser",
      "",
      "---",
      "",
      "Program",
      "tracepoint:block:block_rq_issue",
      "=",
      "map: @start :: type[none, ctx: 0]",
      ".",
      "dereference",
      "builtin: args :: type[none, ctx: 0]",
      "dev",
      ".",
      "dereference",
      "builtin: args :: type[none, ctx: 0]",
      "sector",
      "builtin: nsecs :: type[none, ctx: 0]",
      "=",
      "~",
    ].join("\n");
    expect(shapeError(raw)).toBe("");
  });

  it("surfaces a buried ERROR past BTF-debug and AST headers", () => {
    const raw = [
      "[DEBUG] libbpf: loading kernel BTF '/sys/kernel/btf/vmlinux': 0",
      "WARNING: BPFTRACE_STRLEN is deprecated. Use BPFTRACE_MAX_STRLEN instead.",
      "AST after: parser",
      "---",
      "Program",
      "stdin:1:9-14: ERROR: unknown tracepoint arg args->nope",
      "@x = args->nope;",
      "      ~~~~~",
      "tracepoint:block:block_rq_issue",
      "map: @x :: type[count, ctx: 0]",
    ].join("\n");
    const shaped = shapeError(raw);
    expect(shaped).toBe(
      "stdin:1:9-14: ERROR: unknown tracepoint arg args->nope",
    );
    expect(shaped).not.toContain("libbpf");
    expect(shaped).not.toContain("AST");
    expect(shaped).not.toContain("Program");
  });

  it("drops caret, source echo, and bare probe lines without an ERROR", () => {
    const raw = [
      "@is_write[args->dev, args->sector] = (args->rwbs[0] == 'W');",
      "~",
      "tracepoint:block:block_rq_issue",
      "interval:s:1",
      "BEGIN",
      "call: count :: type[count, ctx: 0]",
      "dereference",
    ].join("\n");
    expect(shapeError(raw)).toBe("");
  });

  it("keeps non-ERROR actionable rejections (blocked call, too many)", () => {
    expect(shapeError("blocked call: system is forbidden")).toBe(
      "blocked call: system is forbidden",
    );
    expect(
      shapeError(
        "wildcard expands to too many probes: tracepoint:sys:* (99 exceeds max 50)",
      ),
    ).toContain("too many probes");
  });

  it("keeps dry-run infrastructure failures", () => {
    expect(shapeError("dry-run not supported by this bpftrace version")).toBe(
      "dry-run not supported by this bpftrace version",
    );
    expect(shapeError("dry-run failed")).toBe("dry-run failed");
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

  it("returns empty for AST-dump-only dry-run output", () => {
    const out = shapeFeedbackErrors([
      "[DEBUG] libbpf: loading kernel BTF '/sys/kernel/btf/vmlinux': 0",
      "WARNING: BPFTRACE_STRLEN is deprecated. Use BPFTRACE_MAX_STRLEN instead.",
      "WARNING: BPFTRACE_MAP_KEYS_MAX is deprecated. Use BPFTRACE_MAX_MAP_KEYS instead.",
      "[DEBUG] libbpf: loading kernel BTF '/sys/kernel/btf/vmlinux': 0",
      "AST after: parser",
      "---",
      "Program",
      "tracepoint:block:block_rq_complete",
      "=",
      "map: @ops :: type[none, ctx: 0]",
      "call: str :: type[none, ctx: 0]",
      ".",
      "dereference",
      "builtin: args :: type[none, ctx: 0]",
      "rwbs",
      "call: count :: type[none, ctx: 0]",
      "interval:s:1",
      "call: print :: type[none, ctx: 0]",
    ]);
    expect(out).toEqual([]);
  });

  it("shapes a buried ERROR with hint and no AST fragments", () => {
    const out = shapeFeedbackErrors([
      "[DEBUG] libbpf: loading kernel BTF '/sys/kernel/btf/vmlinux': 0",
      "WARNING: BPFTRACE_STRLEN is deprecated. Use BPFTRACE_MAX_STRLEN instead.",
      "AST after: parser",
      "---",
      "Program",
      "stdin:2:5-11: ERROR: undefined variable @start",
      "@y = @start + 1;",
      "      ~~~~~~",
      "map: @y :: type[none, ctx: 0]",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("ERROR: undefined variable @start");
    expect(out[0]).toContain("@ prefix");
    expect(out[0]).not.toContain("libbpf");
    expect(out[0]).not.toContain("Program");
    expect(out[0]).not.toContain("---");
  });
});
