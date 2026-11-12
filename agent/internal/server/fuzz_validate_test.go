package server

import (
	"context"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

// Fuzz corpus for I-05. Curated f.Add seeds below mirror the committed corpus
// in testdata/fuzz (generated from recipes/*.bt, the shared validator
// vectors, and committed eval scripts via scripts/gen-fuzz-corpus.go).
// Invariants for every input: no panic, bounded runtime, denied calls are
// always rejected, and no error/warning echoes raw input past the length cap.

const (
	fuzzMaxScriptBytes = 16 * 1024
	fuzzTimeBound      = 2 * time.Second
)

var fuzzKnownProbes = []string{
	"BEGIN",
	"tracepoint:block:block_rq_issue",
	"tracepoint:block:block_rq_complete",
	"tracepoint:syscalls:sys_enter_openat",
	"kprobe:vfs_read",
	"kprobe:vfs_write",
	"kretprobe:tcp_v4_connect",
}

// fuzzCatalog is a ready catalog over a fixed probe list so fuzz verdicts are
// hermetic (no bpftrace, no network).
func fuzzCatalog(tb require.TestingT) *Catalog {
	cat := NewCatalog("", func(ctx context.Context) ([]string, error) {
		return fuzzKnownProbes, nil
	})
	require.NoError(tb, cat.Refresh(context.Background()))
	return cat
}

func runeLen(s string) int {
	return utf8.RuneCountInString(s)
}

// assertFuzzInvariants checks the shared StaticValidate properties: bounded
// runtime is measured by the caller, this covers rejection and message caps.
func assertFuzzInvariants(t *testing.T, script string, res ValidateResult) {
	t.Helper()
	for _, e := range res.Errors {
		require.LessOrEqual(t, runeLen(e), maxValidatorErrorLen, "error echoes raw input past cap: %q", e)
	}
	for _, w := range res.Warnings {
		require.LessOrEqual(t, runeLen(w), maxValidatorErrorLen, "warning echoes raw input past cap: %q", w)
	}
	toks, _, _ := lexScript(script)
	calls, _ := collectCalls(toks)
	for _, c := range calls {
		if !deniedCalls[c] {
			continue
		}
		require.NotEmpty(t, res.Errors, "denied call %q accepted", c)
		if len(script) <= MaxScriptBytes {
			require.Equal(t, "BLOCKED_CALL", res.Code, "denied call %q misclassified", c)
		}
	}
	for _, pr := range res.Probes {
		provider := pr
		if i := strings.IndexByte(pr, ':'); i >= 0 {
			provider = pr[:i]
		}
		if (provider == "uprobe" || provider == "uretprobe") && strings.ContainsAny(pr, "*?[]") {
			require.NotEmpty(t, res.Errors, "wildcard uprobe %q accepted", pr)
		}
	}
}

func FuzzValidateStatic(f *testing.F) {
	seeds := []string{
		"BEGIN { @x = count(); }",
		"tracepoint:block:block_rq_issue { @x = count(); }",
		"kprobe:vfs_read { @bytes = sum(arg2); }",
		"kprobe:vfs_* { @x = count(); }",
		"tracepoint:block:* { @x = count(); }",
		"uprobe:libc:malloc { @x = count(); }",
		"uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc { @x = count(); }",
		`BEGIN { system("id"); }`,
		`BEGIN { signal(9); }`,
		`BEGIN { printf("system(signal(override(cat("); }`,
		"#include <stdio.h>\nBEGIN { @x = count(); }",
		"BEGIN { /* unterminated",
		`BEGIN { printf("x); }`,
		"BEGIN { @x = count(); } --unsafe",
		"kprobe:ab* { @x = count(); }",
		"",
		"BEGIN {\x00 @x = count(); }",
		strings.Repeat("BEGIN { @x = count(); }\n", 60),
		"tracepoint:block:block_rq_issue /@x > 0/ { @x = count(); }",
	}
	for _, s := range seeds {
		f.Add(s)
	}
	cat := fuzzCatalog(f)
	f.Fuzz(func(t *testing.T, script string) {
		if len(script) > fuzzMaxScriptBytes {
			t.Skip("input larger than fuzz bound")
		}
		start := time.Now()
		res := StaticValidate(script, cat)
		require.Less(t, time.Since(start), fuzzTimeBound, "validation exceeded time bound")
		assertFuzzInvariants(t, script, res)
		again := StaticValidate(script, cat)
		require.Equal(t, res, again, "StaticValidate is not deterministic")
	})
}

func FuzzLexer(f *testing.F) {
	for _, s := range []string{
		"BEGIN { @x = count(); }",
		`BEGIN { system/*x*/("id"); }`,
		"BEGIN { ca\\\nt(\"/etc/shadow\"); }",
		`BEGIN { printf("/*"); }`,
		"#include <stdio.h>\nBEGIN {}",
		"BEGIN { /* unterminated",
		`BEGIN { printf("x); }`,
		"// line comment\nBEGIN {}",
		"BEGIN {\x00\x1b\x7f }",
		"BEGIN { @x = (((1))); }",
		strings.Repeat("/*c*/", 500) + "BEGIN {}",
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, script string) {
		if len(script) > 32*1024 {
			t.Skip("input larger than fuzz bound")
		}
		start := time.Now()
		toks, cleaned, errs := lexScript(script)
		require.Less(t, time.Since(start), fuzzTimeBound, "lexer exceeded time bound")
		require.LessOrEqual(t, len(toks), maxLexerTokens+1, "token cap bypassed")
		require.LessOrEqual(t, len(cleaned), len(script), "cleaned output longer than input")
		for _, e := range errs {
			require.LessOrEqual(t, runeLen(e), maxValidatorErrorLen, "lexer error past cap: %q", e)
		}
		// Comment stripper must be total: re-lexing the cleaned source
		// surfaces no comment tokens and no preprocessor errors, since
		// comments and directives were replaced by blank space (strings
		// are preserved verbatim and re-lex as strings).
		toks2, _, errs2 := lexScript(cleaned)
		for _, tk := range toks2 {
			require.NotEqual(t, tokComment, tk.kind, "comment survived stripping")
		}
		for _, e := range errs2 {
			require.NotContains(t, e, "preprocessor directives are forbidden")
		}
	})
}

func FuzzUprobeTarget(f *testing.F) {
	for _, s := range []string{
		"uprobe:libc:malloc",
		"uretprobe:libc:free",
		"uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc",
		"uprobe:/usr/lib/libc.so.6:read",
		"uprobe:/bin/ls:main",
		"uprobe:/lib/../usr/lib/libc.so.6:malloc",
		"uprobe:libc",
		"uprobe:libc:",
		"uprobe:libc:malloc+0x10",
		"kprobe:vfs_read",
		"",
		"uprobe:libc:mal*",
		"uprobe:/lib/libc.so:malloc",
		"uprobe:/lib/x86_64-linux-gnu/libc.so.6:9bad",
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, pr string) {
		if len(pr) > 4*1024 {
			t.Skip("input larger than fuzz bound")
		}
		start := time.Now()
		provider, target, symbol, ok := parseUprobeProbe(pr)
		allowedTarget := isAllowedLibcTarget(target)
		allowedPath := isAllowedLibcPath(target)
		symOK := uprobeSymbolRe.MatchString(symbol)
		require.Less(t, time.Since(start), fuzzTimeBound, "uprobe parse exceeded time bound")
		if ok {
			require.Contains(t, []string{"uprobe", "uretprobe"}, provider)
			require.Equal(t, target == "libc" || allowedPath, allowedTarget, "target allowlist inconsistent for %q", pr)
			if allowedPath {
				require.True(t, strings.HasPrefix(target, "/"), "allowed path not absolute: %q", target)
				require.NotContains(t, target, "//", "allowed path has empty segment: %q", target)
				for _, part := range strings.Split(target[1:], "/") {
					require.NotContains(t, []string{"", ".", ".."}, part, "allowed path has dot segment: %q", target)
				}
				base := target[strings.LastIndexByte(target, '/')+1:]
				require.True(t, isLibcBasename(base), "allowed path has non-libc basename: %q", target)
			}
			// Determinism: same input, same verdict.
			p2, t2, s2, ok2 := parseUprobeProbe(pr)
			require.Equal(t, [4]any{provider, target, symbol, ok}, [4]any{p2, t2, s2, ok2})
			_ = symOK
		} else {
			colon := strings.IndexByte(pr, ':')
			require.True(t, colon < 0 ||
				(provider != "uprobe" && provider != "uretprobe") ||
				!strings.Contains(pr[colon+1:], ":"),
				"unexpected parse failure shape for %q", pr)
		}
	})
}

func FuzzWildcard(f *testing.F) {
	for _, s := range []string{
		"tracepoint:block:*",
		"tracepoint:syscalls:sys_enter_*",
		"kprobe:vfs_*",
		"kretprobe:tcp_*",
		"kprobe:ab*",
		"tracepoint:*:*",
		"*",
		"kprobe:vfs_rea?",
		"kprobe:vfs_[rw]*",
		"uprobe:libc:m*",
		"profile:hz:*",
		"tracepoint:block:missing_*",
		"kprobe:a:b*",
		"tracepoint:block:*rq*",
	} {
		f.Add(s)
	}
	known := map[string]bool{}
	for _, p := range fuzzKnownProbes {
		known[p] = true
	}
	f.Fuzz(func(t *testing.T, pattern string) {
		if len(pattern) > 2*1024 {
			t.Skip("input larger than fuzz bound")
		}
		start := time.Now()
		provider := pattern
		if i := strings.IndexByte(pattern, ':'); i >= 0 {
			provider = pattern[:i]
		}
		shapeErr := validateWildcardShape(pattern, provider)
		n := expandCount(pattern, known)
		suggest := suggestProbes(pattern, known)
		require.Less(t, time.Since(start), fuzzTimeBound, "wildcard check exceeded time bound")
		if shapeErr != "" {
			require.True(t,
				strings.HasPrefix(shapeErr, "wildcard not allowed") ||
					strings.HasPrefix(shapeErr, "invalid wildcard pattern") ||
					strings.HasPrefix(shapeErr, "wildcard too broad"),
				"wildcard error outside taxonomy: %q", shapeErr)
		}
		require.GreaterOrEqual(t, n, 0)
		require.LessOrEqual(t, runeLen(suggest), maxValidatorErrorLen, "suggestion echoes input past cap")
		require.Equal(t, shapeErr, validateWildcardShape(pattern, provider), "wildcard check nondeterministic")
		require.Equal(t, n, expandCount(pattern, known), "expansion count nondeterministic")
	})
}
