import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { staticValidate } from "./validator.js";
import { lexScript } from "./validator.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RECIPES_DIR = join(REPO_ROOT, "recipes");
const NDJSON_PATH = join(
  REPO_ROOT,
  "eval",
  "reports",
  "2026-11-10-live-real-scripts.ndjson",
);

const SKIP = { catalog: { mode: "skip" } } as const;

describe("lexer default-deny corpus", () => {
  const cases: Array<[string, string, string, string]> = [
    [
      "system direct",
      'BEGIN { system("id"); }',
      "BLOCKED_CALL",
      "blocked call: system",
    ],
    [
      "signal direct",
      "BEGIN { signal(9); }",
      "BLOCKED_CALL",
      "blocked call: signal",
    ],
    [
      "override direct",
      "BEGIN { override(0); }",
      "BLOCKED_CALL",
      "blocked call: override",
    ],
    [
      "cat direct",
      'BEGIN { cat("/etc/passwd"); }',
      "BLOCKED_CALL",
      "blocked call: cat",
    ],
    [
      "system block comment",
      'BEGIN { system/*x*/("id"); }',
      "BLOCKED_CALL",
      "blocked call: system",
    ],
    [
      "cat line comment",
      'BEGIN { cat//c\n("/etc/shadow"); }',
      "BLOCKED_CALL",
      "blocked call: cat",
    ],
    [
      "cat multi comment",
      'BEGIN { cat /*a*/ /*b\nc*/ ("/etc/shadow"); }',
      "BLOCKED_CALL",
      "blocked call: cat",
    ],
    [
      "signal block comment",
      "BEGIN { signal/*x*/(9); }",
      "BLOCKED_CALL",
      "blocked call: signal",
    ],
    [
      "override block comment",
      "BEGIN { override/*x*/(0); }",
      "BLOCKED_CALL",
      "blocked call: override",
    ],
    [
      "split ident sys tem",
      'BEGIN { sys/*a*/tem("id"); }',
      "UNKNOWN_CALL",
      "unknown function call: tem",
    ],
    [
      "split ident ca t",
      'BEGIN { ca/*a*/t("/etc/shadow"); }',
      "UNKNOWN_CALL",
      "unknown function call: t",
    ],
    [
      "real call after comment",
      'BEGIN { /* system("id"); */ signal(9); }',
      "BLOCKED_CALL",
      "blocked call: signal",
    ],
    [
      "real call after line comment",
      '// system("id")\nBEGIN { signal(9); }',
      "BLOCKED_CALL",
      "blocked call: signal",
    ],
    [
      "call between strings",
      'BEGIN { printf("/*"); cat("/etc/shadow"); printf("*/"); }',
      "BLOCKED_CALL",
      "blocked call: cat",
    ],
    [
      "continuation inside cat",
      'BEGIN { ca\\\nt("/etc/shadow"); }',
      "BLOCKED_CALL",
      "blocked call: cat",
    ],
    [
      "continuation crlf inside cat",
      'BEGIN { ca\\\r\nt("/etc/shadow"); }',
      "BLOCKED_CALL",
      "blocked call: cat",
    ],
    [
      "continuation before paren",
      'BEGIN { cat\\\n("/etc/shadow"); }',
      "BLOCKED_CALL",
      "blocked call: cat",
    ],
    [
      "continuation inside system",
      'BEGIN { sys\\\ntem("id"); }',
      "BLOCKED_CALL",
      "blocked call: system",
    ],
    [
      "tab before paren",
      'BEGIN { system\t("id"); }',
      "BLOCKED_CALL",
      "blocked call: system",
    ],
    [
      "newline before paren",
      'BEGIN { system\n("id"); }',
      "BLOCKED_CALL",
      "blocked call: system",
    ],
    [
      "crlf before paren",
      'BEGIN { system\r\n("id"); }',
      "BLOCKED_CALL",
      "blocked call: system",
    ],
    [
      "spaces before paren",
      'BEGIN { system   ("id"); }',
      "BLOCKED_CALL",
      "blocked call: system",
    ],
    [
      "mixed whitespace before paren",
      "BEGIN { signal\t\n (9); }",
      "BLOCKED_CALL",
      "blocked call: signal",
    ],
    [
      "comment packed call",
      'BEGIN {cat/***/("x");}',
      "BLOCKED_CALL",
      "blocked call: cat",
    ],
    [
      "macro-blocked inside probe",
      'BEGIN { macro system("id"); }',
      "BLOCKED_CALL",
      "blocked call: system",
    ],
    [
      "macro-blocked comment-split inside probe",
      'BEGIN { macro /*x*/ system("id"); }',
      "BLOCKED_CALL",
      "blocked call: system",
    ],
    [
      "uppercase system",
      'BEGIN { SYSTEM("id"); }',
      "UNKNOWN_CALL",
      "unknown function call: SYSTEM",
    ],
    [
      "capitalized system",
      'BEGIN { System("id"); }',
      "UNKNOWN_CALL",
      "unknown function call: System",
    ],
    [
      "capitalized cat",
      'BEGIN { Cat("/etc/passwd"); }',
      "UNKNOWN_CALL",
      "unknown function call: Cat",
    ],
    [
      "uppercase printf",
      'BEGIN { PRINTF("x"); }',
      "UNKNOWN_CALL",
      "unknown function call: PRINTF",
    ],
    [
      "exec",
      'BEGIN { exec("id"); }',
      "UNKNOWN_CALL",
      "unknown function call: exec",
    ],
    [
      "popen",
      'BEGIN { popen("id", "r"); }',
      "UNKNOWN_CALL",
      "unknown function call: popen",
    ],
    [
      "open",
      'BEGIN { open("/etc/passwd", 0); }',
      "UNKNOWN_CALL",
      "unknown function call: open",
    ],
    [
      "read",
      "BEGIN { read(0, buf, 1); }",
      "UNKNOWN_CALL",
      "unknown function call: read",
    ],
    [
      "write",
      "BEGIN { write(1, buf, 1); }",
      "UNKNOWN_CALL",
      "unknown function call: write",
    ],
    [
      "malloc",
      "BEGIN { malloc(16); }",
      "UNKNOWN_CALL",
      "unknown function call: malloc",
    ],
    [
      "free",
      "BEGIN { free(ptr); }",
      "UNKNOWN_CALL",
      "unknown function call: free",
    ],
    [
      "unlink",
      'BEGIN { unlink("/tmp/x"); }',
      "UNKNOWN_CALL",
      "unknown function call: unlink",
    ],
    [
      "strstr",
      'BEGIN { @x = strstr(comm, "a"); }',
      "UNKNOWN_CALL",
      "unknown function call: strstr",
    ],
    [
      "memcpy",
      "BEGIN { memcpy(dst, src, 8); }",
      "UNKNOWN_CALL",
      "unknown function call: memcpy",
    ],
    [
      "nested system in printf",
      'BEGIN { printf("%d", system("id")); }',
      "BLOCKED_CALL",
      "blocked call: system",
    ],
    [
      "nested system in count",
      'BEGIN { @x = count(system("id")); }',
      "BLOCKED_CALL",
      "blocked call: system",
    ],
    [
      "space split sys tem",
      'BEGIN { sys tem("id"); }',
      "UNKNOWN_CALL",
      "unknown function call: tem",
    ],
    [
      "space split ca t",
      'BEGIN { ca t("/etc/shadow"); }',
      "UNKNOWN_CALL",
      "unknown function call: t",
    ],
    [
      "include",
      "#include <stdio.h>\nBEGIN {}",
      "VALIDATION_FAILED",
      "blocked syntax: preprocessor directives are forbidden",
    ],
    [
      "define",
      "#define FOO 1\nBEGIN {}",
      "VALIDATION_FAILED",
      "blocked syntax: preprocessor directives are forbidden",
    ],
    [
      "spaced include",
      "  #  include <x>\nBEGIN {}",
      "VALIDATION_FAILED",
      "blocked syntax: preprocessor directives are forbidden",
    ],
    [
      "pragma",
      "#pragma once\nBEGIN {}",
      "VALIDATION_FAILED",
      "blocked syntax: preprocessor directives are forbidden",
    ],
    [
      "shebang",
      "#!/usr/bin/bpftrace\nBEGIN {}",
      "VALIDATION_FAILED",
      "blocked syntax: preprocessor directives are forbidden",
    ],
    [
      "trailing define",
      "BEGIN {}\n#define HACK 1",
      "VALIDATION_FAILED",
      "blocked syntax: preprocessor directives are forbidden",
    ],
    [
      "exec directive",
      "#exec cat\nBEGIN {}",
      "VALIDATION_FAILED",
      "blocked syntax: preprocessor directives are forbidden",
    ],
    [
      "comment inside directive",
      "#/*c*/define X 1\nBEGIN {}",
      "VALIDATION_FAILED",
      "blocked syntax: preprocessor directives are forbidden",
    ],
    [
      "unclosed block comment",
      "BEGIN { /*",
      "VALIDATION_FAILED",
      "blocked syntax: unclosed block comment",
    ],
    [
      "unterminated string eof",
      'BEGIN { "unterminated',
      "VALIDATION_FAILED",
      "blocked syntax: unterminated string literal",
    ],
    [
      "unterminated string call",
      'BEGIN { printf("x); }',
      "VALIDATION_FAILED",
      "blocked syntax: unterminated string literal",
    ],
    [
      "nul byte",
      "BEGIN {\x00 @x = count(); }",
      "VALIDATION_FAILED",
      "blocked syntax: invalid control character",
    ],
    [
      "escape byte",
      "BEGIN {\x1b @x = count(); }",
      "VALIDATION_FAILED",
      "blocked syntax: invalid control character",
    ],
    [
      "del byte",
      "BEGIN {\x7f @x = count(); }",
      "VALIDATION_FAILED",
      "blocked syntax: invalid control character",
    ],
    [
      "fullwidth parens",
      'BEGIN { system\uFF08"id"\uFF09; }',
      "VALIDATION_FAILED",
      "blocked syntax: non-ASCII characters are not allowed",
    ],
    [
      "lookalike es",
      "BEGIN { \u0441ount = count(); }",
      "VALIDATION_FAILED",
      "blocked syntax: non-ASCII characters are not allowed",
    ],
    [
      "lookalike call rejected",
      'BEGIN { \u0455ystem("id"); }',
      "UNKNOWN_CALL",
      "blocked syntax: non-ASCII characters are not allowed",
    ],
    [
      "nesting flood",
      `BEGIN { @x = ${"(".repeat(200)}1${")".repeat(200)}; }`,
      "VALIDATION_FAILED",
      "script too complex: nesting too deep",
    ],
  ];

  it("rejects at least 60 bypass attempts", () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
    for (const [name, script, code, want] of cases) {
      const res = staticValidate(script, SKIP);
      expect(res.errors.length, name).toBeGreaterThan(0);
      expect(res.errors.join("; "), name).toContain(want);
      expect(res.code, name).toBe(code);
    }
  });

  it("caps tokens at the lexer layer", () => {
    // Unreachable through staticValidate (the 8 KiB size check fires first).
    const over = lexScript(`BEGIN { @a = ${"1,".repeat(6000)}0; }`);
    expect(over.errs.join("; ")).toContain(
      "script too complex: token limit exceeded",
    );
    const ok = lexScript("BEGIN { @x = count(); }");
    expect(ok.errs).toEqual([]);
    expect(ok.toks.length).toBeGreaterThan(0);
  });
});

describe("lexer benign calls", () => {
  it("never flags names inside strings or comments, and accepts the allowlist", () => {
    const accepts = [
      'BEGIN { printf("system(signal(override(cat("); }',
      "// system( signal( override( cat(\nBEGIN { @x = count(); }",
      "/* system( signal( override( cat( */ BEGIN { @x = count(); }",
      'BEGIN { printf("/*"); printf("*/"); @x = count(); }',
      'BEGIN { printf("http://x /*y*/"); }',
      'BEGIN { printf\\\n("x"); }',
      "BEGIN { $cat = 1; @system = count(); print(@system); }",
      "BEGIN { @override[comm] = count(); }",
      "BEGIN { if (1) { @x = count(); } }",
      "BEGIN { for ($i = 0; $i < 1; $i++) { @x = count(); } }",
      'BEGIN { printf("\u0441\u0438\u0441\u0442\u0435\u043c"); }',
      "// \u0441\u0438\u0441\u0442\u0435\u043c(\nBEGIN { @x = count(); }",
      ...[
        "printf",
        "print",
        "count",
        "sum",
        "avg",
        "min",
        "max",
        "stats",
        "hist",
        "lhist",
        "delete",
        "clear",
        "zero",
        "str",
        "strncmp",
        "strlen",
        "buf",
        "ntop",
        "kstack",
        "ustack",
        "ksym",
        "usym",
        "time",
        "join",
        "exit",
        "cgroup_path",
        "cgroupid",
      ].map((name) => `BEGIN { @r = ${name}(1); }`),
    ];
    for (const script of accepts) {
      expect(staticValidate(script, SKIP).errors, script).toEqual([]);
    }
  });
});

describe("lexer accepts committed scripts", () => {
  it("accepts every recipe body", () => {
    const files = readdirSync(RECIPES_DIR).filter((f) => f.endsWith(".bt"));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) {
      const body = readFileSync(join(RECIPES_DIR, f), "utf8");
      expect(staticValidate(body, SKIP).errors, f).toEqual([]);
    }
  });

  it("accepts every committed eval script", () => {
    const lines = readFileSync(NDJSON_PATH, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(20);
    for (const line of lines) {
      const script = (JSON.parse(line) as { script: string }).script;
      expect(staticValidate(script, SKIP).errors, line.slice(0, 80)).toEqual(
        [],
      );
    }
  });
});
