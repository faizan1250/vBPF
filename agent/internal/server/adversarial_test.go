package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/faizan1250/vBPF/agent/internal/parser"
	"github.com/faizan1250/vBPF/agent/internal/runner"
	"github.com/stretchr/testify/require"
)

func TestClassifyValidationError(t *testing.T) {
	require.Equal(t, "PROBE_NOT_FOUND", classifyValidationError([]string{"probe not found: tracepoint:foo:bar"}))
	require.Equal(t, "PROBE_NOT_FOUND", classifyValidationError([]string{"ERROR: unknown probe foo"}))
	require.Equal(t, "LIMIT_EXCEEDED", classifyValidationError([]string{"wildcard expands to too many probes: tracepoint:block:item*"}))
	require.Equal(t, "VALIDATION_FAILED", classifyValidationError([]string{"blocked call: system/signal/override/cat are forbidden"}))
	require.Equal(t, "VALIDATION_FAILED", classifyValidationError(nil))
	// Probe misses win over limit errors when both are present.
	require.Equal(t, "PROBE_NOT_FOUND", classifyValidationError([]string{
		"wildcard expands to too many probes: tracepoint:block:item*",
		"probe not found: tracepoint:foo:bar",
	}))
}

func knownCatalogServer(t *testing.T, known []string) *Server {
	t.Helper()
	s := testServer(t, Config{CatalogFn: func(ctx context.Context) ([]string, error) {
		return known, nil
	}})
	require.NoError(t, s.catalog.Refresh(context.Background()))
	return s
}

func postRunCode(t *testing.T, s *Server, script string) (int, string) {
	t.Helper()
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "POST", "/v1/runs", fmt.Sprintf(`{"script":%q,"duration_s":10}`, script)))
	var body map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	code, _ := body["code"].(string)
	return w.Code, code
}

// Unknown probes surface PROBE_NOT_FOUND (not generic VALIDATION_FAILED).
func TestCreateRunProbeNotFoundCode(t *testing.T) {
	s := knownCatalogServer(t, []string{"tracepoint:block:block_rq_issue"})
	status, code := postRunCode(t, s, "tracepoint:syscalls:sys_enter_openat { @x = count(); }")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "PROBE_NOT_FOUND", code)
}

// Wildcards expanding past the probe cap surface LIMIT_EXCEEDED.
func TestCreateRunWildcardLimitCode(t *testing.T) {
	known := make([]string, 0, 60)
	for i := 0; i < 60; i++ {
		known = append(known, fmt.Sprintf("tracepoint:block:item%d", i))
	}
	s := knownCatalogServer(t, known)
	status, code := postRunCode(t, s, "tracepoint:block:item* { @x = count(); }")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "LIMIT_EXCEEDED", code)
}

// Dry-run compiler misses map the same way.
func TestCreateRunDryRunProbeMissCode(t *testing.T) {
	s := testServer(t, Config{DryRun: func(ctx context.Context, script string) []string {
		return []string{"ERROR: unknown probe: tracepoint:foo:bar"}
	}})
	status, code := postRunCode(t, s, "BEGIN { @x = count(); }")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "PROBE_NOT_FOUND", code)
}

// Per-event printf on raw_syscalls stays legal but must warn: hot probes
// need in-kernel aggregation, enforced here via catalog-independent rules.
func TestRawSyscallsPrintfWarns(t *testing.T) {
	s := testServer(t, Config{})
	w := httptest.NewRecorder()
	body, _ := json.Marshal(map[string]string{"script": "tracepoint:raw_syscalls:sys_enter { printf(\"%d\\n\", pid); }"})
	s.Handler().ServeHTTP(w, authReq(t, s, "POST", "/v1/validate", string(body)))
	require.Equal(t, http.StatusOK, w.Code)
	var out struct {
		OK     bool     `json:"ok"`
		Errors []string `json:"errors"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.True(t, out.OK, "raw_syscalls printf blocked: %v", out.Errors)
}

func TestStaticValidateRejectsCommentAndContinuationBypasses(t *testing.T) {
	cases := []struct {
		name   string
		script string
		want   string
	}{
		{"cat block comment", `BEGIN { cat/*x*/("/etc/shadow"); }`, "blocked call"},
		{"cat line comment", "BEGIN { cat//c\n(\"/etc/shadow\"); }", "blocked call"},
		{"cat multi comment", "BEGIN { cat /*a*/ /*b\nc*/ (\"/etc/shadow\"); }", "blocked call"},
		{"system block comment", `BEGIN { system/*x*/("id"); }`, "blocked call"},
		{"signal block comment", `BEGIN { signal/*x*/(9); }`, "blocked call"},
		{"override block comment", `BEGIN { override/*x*/(0); }`, "blocked call"},
		{"comment before include", "/*x*/#include <stdio.h>\nBEGIN {}", "blocked syntax: #include/#define"},
		{"comment inside define", "#/*x*/define FOO cat\nBEGIN {}", "blocked syntax: #include/#define"},
		{"line continuation include", "#\\\ninclude <x>\nBEGIN {}", "blocked syntax: #include/#define"},
		{"line continuation inside cat", "BEGIN { ca\\\nt(\"/etc/shadow\"); }", "blocked call"},
		{"line continuation crlf cat", "BEGIN { ca\\\r\nt(\"/etc/shadow\"); }", "blocked call"},
		{"line continuation before paren", "BEGIN { cat\\\n(\"/etc/shadow\"); }", "blocked call"},
		{"multiline comment before define", "struct s{}; /*\n*/#define X 1\nBEGIN {}", "blocked syntax: #include/#define"},
		{"crlf line comment cat", "BEGIN { cat//\r\n(\"/etc/shadow\"); }", "blocked call"},
		{"unclosed block comment", "BEGIN { /*", "unclosed block comment"},
		{"unclosed slash-star-slash", "BEGIN { /*/", "unclosed block comment"},
		{"line comment only", "// only comment", "no probes found"},
		{"block comment only", "/* only comment */", "no probes found"},
		{"non-nested block comment", `/* outer /* inner */ cat("/etc/shadow"); BEGIN {}`, "blocked call"},
		{"comment backslash does not join line", "// comment\\\nBEGIN { cat(\"/etc/shadow\"); }", "blocked call"},
		{"quote in line comment ignored", "// \"\nBEGIN { cat/*x*/(\"/etc/shadow\"); }", "blocked call"},
		{"quote in block comment ignored", "/* \" */ BEGIN { cat/*x*/(\"/etc/shadow\"); }", "blocked call"},
		{"string quote-escaped string closes", `BEGIN { printf("a\\"); cat/*x*/("/etc/shadow"); }`, "blocked call"},
		{"string comment delimiters sandwich", `BEGIN { printf("/*"); cat("/etc/shadow"); printf("*/"); }`, "blocked call"},
		{"unterminated string resets at newline", "BEGIN { printf(\"unterminated\ncat/*x*/(\"/etc/shadow\"); }", "blocked call"},
		{"unterminated string backslash newline", "BEGIN { printf(\"unterminated\\\ncat/*x*/(\"/etc/shadow\"); }", "blocked call"},
		{"unterminated string backslash crlf", "BEGIN { printf(\"unterminated\\\r\ncat/*x*/(\"/etc/shadow\"); }", "blocked call"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, errs := StaticValidate(tc.script, nil)
			require.NotEmpty(t, errs, "expected validation error for %s", tc.name)
			require.Contains(t, strings.Join(errs, "; "), tc.want)
		})
	}

	t.Run("commented fake probe is ignored", func(t *testing.T) {
		probes, errs := StaticValidate("// BEGIN {}\ncat/*x*/(\"/etc/shadow\")", nil)
		require.Empty(t, probes)
		joined := strings.Join(errs, "; ")
		require.Contains(t, joined, "blocked call")
		require.Contains(t, joined, "no probes found")
	})
}

func TestStaticValidateStringAndSlashInvariants(t *testing.T) {
	cat := NewCatalog("", func(ctx context.Context) ([]string, error) {
		return []string{
			"tracepoint:block:block_rq_issue",
			"tracepoint:block:block_rq_complete",
		}, nil
	})
	require.NoError(t, cat.Refresh(context.Background()))

	for _, script := range []string{
		`BEGIN { printf("http://x /*y*/"); }`,
		"// open /* inside line comment\nBEGIN { @x = count(); }",
		"/* // inside block comment */ BEGIN { @x = count(); }",
		`/**/BEGIN { @x = count(); }`,
	} {
		probes, errs := StaticValidate(script, cat)
		require.Empty(t, errs, script)
		require.Equal(t, []string{"BEGIN"}, probes, script)
	}

	probes, errs := StaticValidate("// comment mentioning BEGIN tracepoint:foo:bar\ntracepoint:block:block_rq_issue { @x = count(); }", cat)
	require.Empty(t, errs)
	require.Equal(t, []string{"tracepoint:block:block_rq_issue"}, probes)

	probes, errs = StaticValidate("tracepoint:block:block_rq_complete /@start[args->dev]/ { @lat = hist((nsecs - @start[args->dev]) / 1000); }", cat)
	require.Empty(t, errs)
	require.Equal(t, []string{"tracepoint:block:block_rq_complete"}, probes)
}

func TestCommentBypassRunsRejectedAndValidRawScriptPreserved(t *testing.T) {
	var dryScript, runScript string
	s := testServer(t, Config{
		DryRun: func(ctx context.Context, script string) []string {
			dryScript = script
			return nil
		},
		RunFn: func(ctx context.Context, opts runner.Options, emit func(parser.Event) error) error {
			runScript = opts.Script
			_ = emit(parser.Status(opts.RunID, 0, "running"))
			_ = emit(parser.Summarize(opts.RunID, 1, parser.Summary{ExitReason: runner.ReasonCompleted}))
			return nil
		},
	})

	status, code := postRunCode(t, s, `BEGIN { cat/*x*/("/etc/shadow"); }`)
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "VALIDATION_FAILED", code)

	status, code = postRunCode(t, s, "BEGIN { /*")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "VALIDATION_FAILED", code)

	valid := "// header comment\nBEGIN { @x = count(); }"
	w := httptest.NewRecorder()
	body, _ := json.Marshal(map[string]any{"script": valid, "duration_s": 5})
	s.Handler().ServeHTTP(w, authReq(t, s, "POST", "/v1/runs", string(body)))
	require.Equal(t, http.StatusCreated, w.Code)
	require.Equal(t, valid, dryScript)
	require.Eventually(t, func() bool { return runScript == valid }, 2*time.Second, 10*time.Millisecond)
}
