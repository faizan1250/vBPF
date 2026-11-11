package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func lexerTestCatalog(t *testing.T) *Catalog {
	t.Helper()
	cat := NewCatalog("", func(ctx context.Context) ([]string, error) {
		return []string{"BEGIN"}, nil
	})
	require.NoError(t, cat.Refresh(context.Background()))
	return cat
}

// Token-level lexer plus default-deny allowlist: every bypass smuggling a
// call through comments, strings, continuations, or odd whitespace is still
// rejected, and the verdict names the function.
func TestLexerDefaultDenyCorpus(t *testing.T) {
	cat := lexerTestCatalog(t)
	cases := []struct {
		name   string
		script string
		code   string
		want   string
	}{
		{"system direct", `BEGIN { system("id"); }`, "BLOCKED_CALL", "blocked call: system"},
		{"signal direct", `BEGIN { signal(9); }`, "BLOCKED_CALL", "blocked call: signal"},
		{"override direct", `BEGIN { override(0); }`, "BLOCKED_CALL", "blocked call: override"},
		{"cat direct", `BEGIN { cat("/etc/passwd"); }`, "BLOCKED_CALL", "blocked call: cat"},
		{"system block comment", `BEGIN { system/*x*/("id"); }`, "BLOCKED_CALL", "blocked call: system"},
		{"cat line comment", "BEGIN { cat//c\n(\"/etc/shadow\"); }", "BLOCKED_CALL", "blocked call: cat"},
		{"cat multi comment", `BEGIN { cat /*a*/ /*b
c*/ ("/etc/shadow"); }`, "BLOCKED_CALL", "blocked call: cat"},
		{"signal block comment", `BEGIN { signal/*x*/(9); }`, "BLOCKED_CALL", "blocked call: signal"},
		{"override block comment", `BEGIN { override/*x*/(0); }`, "BLOCKED_CALL", "blocked call: override"},
		{"split ident sys tem", `BEGIN { sys/*a*/tem("id"); }`, "UNKNOWN_CALL", "unknown function call: tem"},
		{"split ident ca t", `BEGIN { ca/*a*/t("/etc/shadow"); }`, "UNKNOWN_CALL", "unknown function call: t"},
		{"real call after comment", `BEGIN { /* system("id"); */ signal(9); }`, "BLOCKED_CALL", "blocked call: signal"},
		{"real call after line comment", "// system(\"id\")\nBEGIN { signal(9); }", "BLOCKED_CALL", "blocked call: signal"},
		{"call between strings", `BEGIN { printf("/*"); cat("/etc/shadow"); printf("*/"); }`, "BLOCKED_CALL", "blocked call: cat"},
		{"continuation inside cat", "BEGIN { ca\\\nt(\"/etc/shadow\"); }", "BLOCKED_CALL", "blocked call: cat"},
		{"continuation crlf inside cat", "BEGIN { ca\\\r\nt(\"/etc/shadow\"); }", "BLOCKED_CALL", "blocked call: cat"},
		{"continuation before paren", "BEGIN { cat\\\n(\"/etc/shadow\"); }", "BLOCKED_CALL", "blocked call: cat"},
		{"continuation inside system", "BEGIN { sys\\\ntem(\"id\"); }", "BLOCKED_CALL", "blocked call: system"},
		{"tab before paren", "BEGIN { system\t(\"id\"); }", "BLOCKED_CALL", "blocked call: system"},
		{"newline before paren", "BEGIN { system\n(\"id\"); }", "BLOCKED_CALL", "blocked call: system"},
		{"crlf before paren", "BEGIN { system\r\n(\"id\"); }", "BLOCKED_CALL", "blocked call: system"},
		{"spaces before paren", `BEGIN { system   ("id"); }`, "BLOCKED_CALL", "blocked call: system"},
		{"mixed whitespace before paren", "BEGIN { signal\t\n (9); }", "BLOCKED_CALL", "blocked call: signal"},
		{"comment packed call", `BEGIN {cat/***/("x");}`, "BLOCKED_CALL", "blocked call: cat"},
		{"macro-blocked inside probe", `BEGIN { macro system("id"); }`, "BLOCKED_CALL", "blocked call: system"},
		{"macro-blocked comment-split inside probe", `BEGIN { macro /*x*/ system("id"); }`, "BLOCKED_CALL", "blocked call: system"},
		{"uppercase system", `BEGIN { SYSTEM("id"); }`, "UNKNOWN_CALL", "unknown function call: SYSTEM"},
		{"capitalized system", `BEGIN { System("id"); }`, "UNKNOWN_CALL", "unknown function call: System"},
		{"capitalized cat", `BEGIN { Cat("/etc/passwd"); }`, "UNKNOWN_CALL", "unknown function call: Cat"},
		{"uppercase printf", `BEGIN { PRINTF("x"); }`, "UNKNOWN_CALL", "unknown function call: PRINTF"},
		{"exec", `BEGIN { exec("id"); }`, "UNKNOWN_CALL", "unknown function call: exec"},
		{"popen", `BEGIN { popen("id", "r"); }`, "UNKNOWN_CALL", "unknown function call: popen"},
		{"open", `BEGIN { open("/etc/passwd", 0); }`, "UNKNOWN_CALL", "unknown function call: open"},
		{"read", `BEGIN { read(0, buf, 1); }`, "UNKNOWN_CALL", "unknown function call: read"},
		{"write", `BEGIN { write(1, buf, 1); }`, "UNKNOWN_CALL", "unknown function call: write"},
		{"malloc", `BEGIN { malloc(16); }`, "UNKNOWN_CALL", "unknown function call: malloc"},
		{"free", `BEGIN { free(ptr); }`, "UNKNOWN_CALL", "unknown function call: free"},
		{"unlink", `BEGIN { unlink("/tmp/x"); }`, "UNKNOWN_CALL", "unknown function call: unlink"},
		{"strstr", `BEGIN { @x = strstr(comm, "a"); }`, "UNKNOWN_CALL", "unknown function call: strstr"},
		{"memcpy", `BEGIN { memcpy(dst, src, 8); }`, "UNKNOWN_CALL", "unknown function call: memcpy"},
		{"nested system in printf", `BEGIN { printf("%d", system("id")); }`, "BLOCKED_CALL", "blocked call: system"},
		{"nested system in count", `BEGIN { @x = count(system("id")); }`, "BLOCKED_CALL", "blocked call: system"},
		{"space split sys tem", `BEGIN { sys tem("id"); }`, "UNKNOWN_CALL", "unknown function call: tem"},
		{"space split ca t", `BEGIN { ca t("/etc/shadow"); }`, "UNKNOWN_CALL", "unknown function call: t"},
		{"include", "#include <stdio.h>\nBEGIN {}", "VALIDATION_FAILED", "blocked syntax: preprocessor directives are forbidden"},
		{"define", "#define FOO 1\nBEGIN {}", "VALIDATION_FAILED", "blocked syntax: preprocessor directives are forbidden"},
		{"spaced include", "  #  include <x>\nBEGIN {}", "VALIDATION_FAILED", "blocked syntax: preprocessor directives are forbidden"},
		{"pragma", "#pragma once\nBEGIN {}", "VALIDATION_FAILED", "blocked syntax: preprocessor directives are forbidden"},
		{"shebang", "#!/usr/bin/bpftrace\nBEGIN {}", "VALIDATION_FAILED", "blocked syntax: preprocessor directives are forbidden"},
		{"trailing define", "BEGIN {}\n#define HACK 1", "VALIDATION_FAILED", "blocked syntax: preprocessor directives are forbidden"},
		{"exec directive", "#exec cat\nBEGIN {}", "VALIDATION_FAILED", "blocked syntax: preprocessor directives are forbidden"},
		{"comment inside directive", "#/*c*/define X 1\nBEGIN {}", "VALIDATION_FAILED", "blocked syntax: preprocessor directives are forbidden"},
		{"unclosed block comment", "BEGIN { /*", "VALIDATION_FAILED", "blocked syntax: unclosed block comment"},
		{"unterminated string eof", "BEGIN { \"unterminated", "VALIDATION_FAILED", "blocked syntax: unterminated string literal"},
		{"unterminated string call", "BEGIN { printf(\"x); }", "VALIDATION_FAILED", "blocked syntax: unterminated string literal"},
		{"nul byte", "BEGIN {\x00 @x = count(); }", "VALIDATION_FAILED", "blocked syntax: invalid control character"},
		{"escape byte", "BEGIN {\x1b @x = count(); }", "VALIDATION_FAILED", "blocked syntax: invalid control character"},
		{"del byte", "BEGIN {\x7f @x = count(); }", "VALIDATION_FAILED", "blocked syntax: invalid control character"},
		{"fullwidth parens", "BEGIN { system\uff08\"id\"\uff09; }", "VALIDATION_FAILED", "blocked syntax: non-ASCII characters are not allowed"},
		{"lookalike es", "BEGIN { \u0441ount = count(); }", "VALIDATION_FAILED", "blocked syntax: non-ASCII characters are not allowed"},
		{"lookalike call rejected", "BEGIN { \u0455ystem(\"id\"); }", "UNKNOWN_CALL", "blocked syntax: non-ASCII characters are not allowed"},
		{"nesting flood", "BEGIN { @x = " + strings.Repeat("(", 200) + "1" + strings.Repeat(")", 200) + "; }", "VALIDATION_FAILED", "script too complex: nesting too deep"},
	}
	require.GreaterOrEqual(t, len(cases), 60, "corpus must hold at least 60 bypass attempts")
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := StaticValidate(tc.script, cat)
			require.NotEmpty(t, res.Errors, "expected rejection")
			require.Contains(t, strings.Join(res.Errors, "; "), tc.want)
			require.Equal(t, tc.code, res.Code)
		})
	}
}

// Words like system inside strings and comments never read as calls, and
// every allowlisted builtin plus control-flow keywords validate clean.
func TestLexerAcceptsBenignCalls(t *testing.T) {
	cat := lexerTestCatalog(t)
	accepts := []string{
		`BEGIN { printf("system(signal(override(cat("); }`,
		"// system( signal( override( cat(\nBEGIN { @x = count(); }",
		"/* system( signal( override( cat( */ BEGIN { @x = count(); }",
		`BEGIN { printf("/*"); printf("*/"); @x = count(); }`,
		`BEGIN { printf("http://x /*y*/"); }`,
		"BEGIN { printf\\\n(\"x\"); }",
		`BEGIN { $cat = 1; @system = count(); print(@system); }`,
		`BEGIN { @override[comm] = count(); }`,
		`BEGIN { if (1) { @x = count(); } }`,
		`BEGIN { for ($i = 0; $i < 1; $i++) { @x = count(); } }`,
		`BEGIN { printf("\u0441ystem"); }`,
		"// \u0441ystem(\nBEGIN { @x = count(); }",
	}
	for _, name := range []string{
		"printf", "print", "count", "sum", "avg", "min", "max", "stats",
		"hist", "lhist", "delete", "clear", "zero", "str", "strncmp",
		"strlen", "buf", "ntop", "kstack", "ustack", "ksym", "usym",
		"time", "join", "exit", "cgroup_path", "cgroupid",
	} {
		accepts = append(accepts, "BEGIN { @r = "+name+"(1); }")
	}
	for _, script := range accepts {
		res := StaticValidate(script, cat)
		require.Empty(t, res.Errors, script)
	}
}

// The token cap is unreachable through StaticValidate (the 8 KB size check
// fires first), so it is tested at the lexer layer directly.
func TestLexerTokenLimit(t *testing.T) {
	_, _, errs := lexScript("BEGIN { @a = " + strings.Repeat("1,", 6000) + "0; }")
	require.NotEmpty(t, errs)
	require.Contains(t, strings.Join(errs, "; "), "script too complex: token limit exceeded")
	toks, _, errs := lexScript("BEGIN { @x = count(); }")
	require.Empty(t, errs)
	require.NotEmpty(t, toks)
}

// Every committed recipe must stay free of lexical and call errors.
func TestLexerAcceptsRecipes(t *testing.T) {
	cat := lexerTestCatalog(t)
	paths, err := filepath.Glob("../../../recipes/*.bt")
	require.NoError(t, err)
	require.NotEmpty(t, paths)
	for _, p := range paths {
		raw, err := os.ReadFile(p)
		require.NoError(t, err)
		res := StaticValidate(string(raw), cat)
		for _, msg := range res.Errors {
			require.NotContains(t, msg, "blocked call:", p)
			require.NotContains(t, msg, "unknown function call:", p)
			require.NotContains(t, msg, "blocked syntax:", p)
			require.NotContains(t, msg, "script too complex:", p)
		}
	}
}

// Every committed eval script must stay free of lexical and call errors.
func TestLexerAcceptsEvalScripts(t *testing.T) {
	cat := lexerTestCatalog(t)
	raw, err := os.ReadFile("../../../eval/reports/2026-11-10-live-real-scripts.ndjson")
	require.NoError(t, err)
	type record struct {
		Script string `json:"script"`
	}
	count := 0
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var rec record
		require.NoError(t, json.Unmarshal([]byte(line), &rec))
		res := StaticValidate(rec.Script, cat)
		for _, msg := range res.Errors {
			require.NotContains(t, msg, "blocked call:", line)
			require.NotContains(t, msg, "unknown function call:", line)
			require.NotContains(t, msg, "blocked syntax:", line)
		}
		count++
	}
	require.GreaterOrEqual(t, count, 20)
}
