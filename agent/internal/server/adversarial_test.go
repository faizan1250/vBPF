package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/faizan1250/vBPF/agent/internal/parser"
	"github.com/faizan1250/vBPF/agent/internal/runner"
	"github.com/stretchr/testify/require"
)

func TestClassifyValidationError(t *testing.T) {
	require.Equal(t, "PROBE_NOT_FOUND", classifyValidationError([]string{"probe not found: tracepoint:foo:bar"}))
	require.Equal(t, "PROBE_NOT_FOUND", classifyValidationError([]string{"probe not found: tracepoint:too many probes:bar"}))
	require.Equal(t, "PROBE_NOT_FOUND", classifyValidationError([]string{"ERROR: unknown probe foo"}))
	require.Equal(t, "PROBE_NOT_FOUND", classifyValidationError([]string{"ERROR: No such probe: foo"}))
	require.Equal(t, "PROBE_NOT_FOUND", classifyValidationError([]string{"stdin:1:1: ERROR: probe not found: foo"}))
	require.Equal(t, "LIMIT_EXCEEDED", classifyValidationError([]string{"wildcard expands to too many probes: tracepoint:block:item*"}))
	require.Equal(t, "LIMIT_EXCEEDED", classifyValidationError([]string{"wildcard expands to too many probes: tracepoint:unknown probe:*"}))
	require.Equal(t, "LIMIT_EXCEEDED", classifyValidationError([]string{"ERROR: too many probes"}))
	require.Equal(t, "VALIDATION_FAILED", classifyValidationError([]string{"blocked call: system/signal/override/cat are forbidden"}))
	require.Equal(t, "VALIDATION_FAILED", classifyValidationError([]string{`uprobe must target libc or an absolute path: uprobe:rel/"unknown probe":fn`}))
	require.Equal(t, "VALIDATION_FAILED", classifyValidationError([]string{`uprobe must target libc or an absolute path: uprobe:rel/"too many probes":fn`}))
	require.Equal(t, "VALIDATION_FAILED", classifyValidationError([]string{`wildcard too broad: tracepoint:block:"unknown probe":*`}))
	require.Equal(t, "VALIDATION_FAILED", classifyValidationError([]string{`wildcard too broad: tracepoint:block:"too many probes":*`}))
	require.Equal(t, "VALIDATION_FAILED", classifyValidationError([]string{`provider not allowed: "no such probe"`}))
	require.Equal(t, "VALIDATION_FAILED", classifyValidationError([]string{"invalid probe header: missing target for provider profile"}))
	require.Equal(t, "VALIDATION_FAILED", classifyValidationError([]string{"empty script"}))
	require.Equal(t, "VALIDATION_FAILED", classifyValidationError([]string{"script exceeds 8 KB"}))
	require.Equal(t, "VALIDATION_FAILED", classifyValidationError([]string{"no probes found"}))
	require.Equal(t, "VALIDATION_FAILED", classifyValidationError(nil))
	// Probe misses win over limit errors regardless of order.
	require.Equal(t, "PROBE_NOT_FOUND", classifyValidationError([]string{
		"wildcard expands to too many probes: tracepoint:block:item*",
		"probe not found: tracepoint:foo:bar",
	}))
	require.Equal(t, "PROBE_NOT_FOUND", classifyValidationError([]string{
		"probe not found: tracepoint:foo:bar",
		"wildcard expands to too many probes: tracepoint:block:item*",
	}))
	require.Equal(t, "PROBE_NOT_FOUND", classifyValidationError([]string{
		"wildcard expands to too many probes: tracepoint:unknown probe:*",
		"ERROR: unknown probe foo",
	}))
	require.Equal(t, "LIMIT_EXCEEDED", classifyValidationError([]string{
		`uprobe must target libc or an absolute path: uprobe:rel/"unknown probe":fn`,
		"wildcard expands to too many probes: tracepoint:unknown probe:*",
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
	cat := NewCatalog("", func(ctx context.Context) ([]string, error) {
		return []string{"tracepoint:syscalls:sys_enter_openat"}, nil
	})
	require.NoError(t, cat.Refresh(context.Background()))
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
			res := StaticValidate(tc.script, cat)
			require.NotEmpty(t, res.Errors, "expected validation error for %s", tc.name)
			require.Contains(t, strings.Join(res.Errors, "; "), tc.want)
		})
	}

	t.Run("commented fake probe is ignored", func(t *testing.T) {
		res := StaticValidate("// BEGIN {}\ncat/*x*/(\"/etc/shadow\")", cat)
		require.Empty(t, res.Probes)
		joined := strings.Join(res.Errors, "; ")
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
		res := StaticValidate(script, cat)
		require.Empty(t, res.Errors, script)
		require.Equal(t, []string{"BEGIN"}, res.Probes, script)
	}

	res := StaticValidate("// comment mentioning BEGIN tracepoint:foo:bar\ntracepoint:block:block_rq_issue { @x = count(); }", cat)
	require.Empty(t, res.Errors)
	require.Equal(t, []string{"tracepoint:block:block_rq_issue"}, res.Probes)

	res = StaticValidate("tracepoint:block:block_rq_complete /@start[args->dev]/ { @lat = hist((nsecs - @start[args->dev]) / 1000); }", cat)
	require.Empty(t, res.Errors)
	require.Equal(t, []string{"tracepoint:block:block_rq_complete"}, res.Probes)
}

func TestCommentBypassRunsRejectedAndValidRawScriptPreserved(t *testing.T) {
	var (
		mu         sync.Mutex
		dryScripts []string
		runScripts []string
	)
	s := testServer(t, Config{
		DryRun: func(ctx context.Context, script string) []string {
			mu.Lock()
			dryScripts = append(dryScripts, script)
			mu.Unlock()
			return nil
		},
		RunFn: func(ctx context.Context, opts runner.Options, emit func(parser.Event) error) error {
			mu.Lock()
			runScripts = append(runScripts, opts.Script)
			mu.Unlock()
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

	mu.Lock()
	gotDry := append([]string(nil), dryScripts...)
	gotRun := append([]string(nil), runScripts...)
	mu.Unlock()
	require.Empty(t, gotDry)
	require.Empty(t, gotRun)

	valid := "// header comment\nBEGIN { @x = count(); }"
	w := httptest.NewRecorder()
	body, _ := json.Marshal(map[string]any{"script": valid, "duration_s": 5})
	s.Handler().ServeHTTP(w, authReq(t, s, "POST", "/v1/runs", string(body)))
	require.Equal(t, http.StatusCreated, w.Code)
	mu.Lock()
	gotDry = append([]string(nil), dryScripts...)
	mu.Unlock()
	require.Equal(t, []string{valid}, gotDry)
	require.Eventually(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(runScripts) > 0
	}, 2*time.Second, 10*time.Millisecond)
	mu.Lock()
	gotRun = append([]string(nil), runScripts...)
	mu.Unlock()
	require.Equal(t, []string{valid}, gotRun)
}

func TestStaticValidateRejectsUnlistedProbesAndAliases(t *testing.T) {
	cat := NewCatalog("", func(ctx context.Context) ([]string, error) {
		return []string{
			"BEGIN",
			"END",
			"tracepoint:block:block_rq_issue",
			"kprobe:do_sys_open",
		}, nil
	})
	require.NoError(t, cat.Refresh(context.Background()))

	unlisted := []struct {
		probe    string
		provider string
	}{
		{"fentry:tcp_connect", "fentry"},
		{"fexit:tcp_connect", "fexit"},
		{"kfunc:tcp_connect", "kfunc"},
		{"kretfunc:tcp_connect", "kretfunc"},
		{"rawtracepoint:sched_switch", "rawtracepoint"},
		{"watchpoint:0x1000:4:w", "watchpoint"},
		{"asyncwatchpoint:0x1000:4:w", "asyncwatchpoint"},
		{"hardware:cache-misses:1000", "hardware"},
		{"usdt:/bin/sh:*", "usdt"},
		{"iter:task", "iter"},
		{"k:tcp_v4_connect", "k"},
		{"kr:tcp_v4_connect", "kr"},
		{"t:syscalls:sys_enter_openat", "t"},
		{"u:/lib/x86_64-linux-gnu/libc.so.6:malloc", "u"},
		{"ur:/lib/x86_64-linux-gnu/libc.so.6:malloc", "ur"},
		{"U:/bin/app:p", "U"},
		{"p:hz:99", "p"},
		{"i:s:1", "i"},
		{"s:cpu-clock:100", "s"},
		{"h:cache-misses:1000", "h"},
		{"rt:sched_switch", "rt"},
		{"f:tcp_connect", "f"},
		{"fr:tcp_connect", "fr"},
		{"w:0x1000:4:w", "w"},
		{"aw:0x1000:4:w", "aw"},
		{"B", "B"},
		{"E", "E"},
		{"B:1", "B"},
		{"E:1", "E"},
		{"begin", "begin"},
		{"end", "end"},
	}

	for _, tc := range unlisted {
		t.Run("standalone_"+tc.probe, func(t *testing.T) {
			res := StaticValidate(tc.probe+" { @x = count(); }", cat)
			require.NotEmpty(t, res.Errors)
			require.Contains(t, strings.Join(res.Errors, "; "), "provider not allowed: "+tc.provider)
			require.Equal(t, "VALIDATION_FAILED", classifyValidationError(res.Errors))
		})
		t.Run("piggybacked_block_"+tc.probe, func(t *testing.T) {
			res := StaticValidate("BEGIN {}\n"+tc.probe+" { @x = count(); }", cat)
			require.NotEmpty(t, res.Errors)
			require.Contains(t, strings.Join(res.Errors, "; "), "provider not allowed: "+tc.provider)
			require.Equal(t, "VALIDATION_FAILED", classifyValidationError(res.Errors))
		})
		t.Run("piggybacked_comma_"+tc.probe, func(t *testing.T) {
			res := StaticValidate("BEGIN, "+tc.probe+" { @x = count(); }", cat)
			require.NotEmpty(t, res.Errors)
			require.Contains(t, strings.Join(res.Errors, "; "), "provider not allowed: "+tc.provider)
			require.Equal(t, "VALIDATION_FAILED", classifyValidationError(res.Errors))
		})
	}
}

func TestStaticValidateHeaderSyntaxAndSpoofing(t *testing.T) {
	cat := NewCatalog("", func(ctx context.Context) ([]string, error) {
		return []string{
			"BEGIN",
			"END",
			"tracepoint:block:block_rq_issue",
			"tracepoint:block:block_rq_complete",
			"tracepoint:raw_syscalls:sys_enter",
			"kprobe:do_sys_open",
			"kretprobe:do_sys_open",
			"uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo",
			`uprobe:/lib/libc.so.6:"Foo::bar(int, int)"`,
		}, nil
	})
	require.NoError(t, cat.Refresh(context.Background()))

	rejectCases := []struct {
		name   string
		script string
		want   string
	}{
		{"config block with spaces", "config = { max_probes = 999; }", "invalid probe header"},
		{"config block compact", "config={max_probes=999;}", "provider not allowed: config="},
		{"config block before BEGIN", "config = { max_probes = 999; }\nBEGIN {}", "invalid probe header"},
		{"macro definition", "macro m() { @x = count(); }", "invalid probe header"},
		{"macro before BEGIN", "macro m() { @x = count(); }\nBEGIN { m(); }", "invalid probe header"},
		{"multiline comma mixed", "kprobe:do_sys_open,\nu:./evil:fn { @x = count(); }", "provider not allowed: u"},
		{"BEGIN with target", "BEGIN:evil {}", "invalid probe header: BEGIN/END cannot have target"},
		{"END with target", "END:evil {}", "invalid probe header: BEGIN/END cannot have target"},
		{"leading colon", ":foo {}", "invalid probe header: invalid colon"},
		{"trailing colon", "kprobe: {}", "invalid probe header: invalid colon"},
		{"empty comma target", "BEGIN, {}", "invalid probe header: empty probe target"},
		{"empty header", "{ @x = count(); }", "invalid probe header: empty probe header"},
		{"second empty header", "BEGIN {} { @x = count(); }", "invalid probe header: empty probe header"},
		{"struct mixed comma", "struct s, fentry:evil {}", "invalid probe header"},
		{"struct with predicate", "struct s /1/ {}", "invalid probe header"},
		{"unclosed action block", "BEGIN { @x = count();", "invalid probe syntax: unclosed action block"},
		{"unexpected closing brace", "BEGIN {} }", "invalid probe syntax: unexpected closing brace"},
		{"lone closing brace", "}", "invalid probe syntax: unexpected closing brace"},
		{"unclosed predicate", "BEGIN /pid == 1 { @x = count(); }", "invalid probe syntax: unclosed predicate"},
		{"unclosed paren in predicate", "BEGIN /(pid == 1/ {}", "invalid probe syntax: unclosed predicate"},
		{"unexpected token after predicate", "BEGIN /1/ extra {}", "invalid probe header: unexpected token after predicate"},
		{"missing action block after probe", "BEGIN {} fentry:evil", "invalid probe header: missing action block"},
		{"trailing flag after probe", "BEGIN {} --flag", "invalid probe header: missing action block"},
		{"missing action block after predicate", "BEGIN /1/", "invalid probe header: missing action block"},
		{"unclosed quote in target", "uprobe:/bin/app:\"unclosed\n{}", "invalid probe header: unclosed quote"},
		{"quoted C++ uprobe symbol rejected", `uprobe:/lib/libc.so.6:"Foo::bar(int, int)" { @x = count(); }`, "invalid uprobe symbol"},
		{"spoofed BEGIN in string", `fentry:vfs_read { printf("BEGIN"); }`, "provider not allowed: fentry"},
		{"spoofed catalog probe in string", `u:./evil:fn { $s = "tracepoint:block:block_rq_issue"; }`, "provider not allowed: u"},
		{"unknown probe wording injection", "unknown probe {}", "invalid probe header"},
		{"quoted unknown probe wording injection", `"unknown probe":foo {}`, "invalid probe header"},
		{"quoted unknown probe bare injection", `"unknown probe" {}`, "invalid probe header"},
		{"too many probes wording injection", "too many probes {}", "invalid probe header"},
	}

	for _, tc := range rejectCases {
		t.Run(tc.name, func(t *testing.T) {
			res := StaticValidate(tc.script, cat)
			require.NotEmpty(t, res.Errors)
			require.Contains(t, strings.Join(res.Errors, "; "), tc.want)
			require.Equal(t, "VALIDATION_FAILED", classifyValidationError(res.Errors))
		})
	}

	validCases := []struct {
		name       string
		script     string
		wantProbes []string
	}{
		{
			"string literals and ternary inside body ignored",
			`BEGIN { printf("tracepoint:foo:bar"); $s = "kprobe:*"; $t = 1 ? 2 : 3; }`,
			[]string{"BEGIN"},
		},
		{
			"three-slash uprobe path",
			`uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo { printf("%s\n", str(arg0)); }`,
			[]string{"uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo"},
		},
		{
			"zero whitespace probe headers",
			`tracepoint:raw_syscalls:sys_enter{@x=count();}END{clear(@x);}`,
			[]string{"tracepoint:raw_syscalls:sys_enter", "END"},
		},
		{
			"multiline predicate",
			"tracepoint:block:block_rq_complete\n/@start[args->dev, args->sector]/\n{ @x = count(); }",
			[]string{"tracepoint:block:block_rq_complete"},
		},
		{
			"predicate with division in parens and slash in string",
			`tracepoint:block:block_rq_complete /(nsecs / 1000) > 10 && comm == "a/b"/ { @x = count(); }`,
			[]string{"tracepoint:block:block_rq_complete"},
		},
		{
			"struct enum union before probe",
			"struct s { int x; }; enum e { A = 1 }; union u { int y; }; BEGIN { @x = count(); }",
			[]string{"BEGIN"},
		},
		{
			"multiline comma valid header",
			"kprobe:do_sys_open,\nkretprobe:do_sys_open { @x = count(); }",
			[]string{"kprobe:do_sys_open", "kretprobe:do_sys_open"},
		},
	}

	for _, tc := range validCases {
		t.Run(tc.name, func(t *testing.T) {
			res := StaticValidate(tc.script, cat)
			require.Empty(t, res.Errors)
			require.Equal(t, tc.wantProbes, res.Probes)
		})
	}

	t.Run("create run classifies unlisted probe as VALIDATION_FAILED even with catalog", func(t *testing.T) {
		s := knownCatalogServer(t, []string{"BEGIN", "tracepoint:block:block_rq_issue"})
		status, code := postRunCode(t, s, `BEGIN {} fentry:tcp_connect { @x = count(); }`)
		require.Equal(t, http.StatusBadRequest, status)
		require.Equal(t, "VALIDATION_FAILED", code)
	})
}

func TestCreateRunErrorClassificationImmunity(t *testing.T) {
	minimalSrv := knownCatalogServer(t, []string{"tracepoint:syscalls:sys_enter_openat"})
	for _, script := range []string{
		`tracepoint:block:"unknown probe":* {}`,
		`tracepoint:block:"too many probes":* {}`,
		`uprobe:rel/"unknown probe":fn {}`,
		`uprobe:rel/"too many probes":fn {}`,
	} {
		t.Run("minimal_catalog_"+script, func(t *testing.T) {
			status, code := postRunCode(t, minimalSrv, script)
			require.Equal(t, http.StatusBadRequest, status)
			require.Equal(t, "VALIDATION_FAILED", code)
		})
	}

	known := []string{"BEGIN", "tracepoint:block:block_rq_issue"}
	for i := 0; i < 60; i++ {
		known = append(known, fmt.Sprintf("tracepoint:block:item%d", i))
		known = append(known, fmt.Sprintf(`tracepoint:"unknown probe":item%d`, i))
	}
	catSrv := knownCatalogServer(t, known)

	for _, tc := range []struct {
		name   string
		script string
		want   string
	}{
		{"quoted unknown probe broad wildcard", `tracepoint:block:"unknown probe":* {}`, "VALIDATION_FAILED"},
		{"quoted too many probes broad wildcard", `tracepoint:block:"too many probes":* {}`, "VALIDATION_FAILED"},
		{"wildcard limit containing unknown probe text", `tracepoint:"unknown probe":item* { @x = count(); }`, "LIMIT_EXCEEDED"},
		{"probe miss beats limit exceeded", `tracepoint:block:item*, tracepoint:foo:bar { @x = count(); }`, "PROBE_NOT_FOUND"},
		{"probe miss first beats limit exceeded", `tracepoint:foo:bar, tracepoint:block:item* { @x = count(); }`, "PROBE_NOT_FOUND"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, code := postRunCode(t, catSrv, tc.script)
			require.Equal(t, http.StatusBadRequest, status)
			require.Equal(t, tc.want, code)
		})
	}
}

func TestStaticValidateRejectsAllowedProvidersMissingTarget(t *testing.T) {
	cat := NewCatalog("", func(ctx context.Context) ([]string, error) {
		return []string{"BEGIN", "END", "tracepoint:block:block_rq_issue", "profile:hz:99", "software:page-faults"}, nil
	})
	require.NoError(t, cat.Refresh(context.Background()))

	providers := []string{"tracepoint", "kprobe", "kretprobe", "uprobe", "uretprobe", "profile", "interval", "software"}
	for _, provider := range providers {
		for _, tc := range []struct {
			name   string
			script string
		}{
			{"standalone", provider + " { @x = count(); }"},
			{"block_piggybacked", "BEGIN {}\n" + provider + " { @x = count(); }"},
			{"comma_piggybacked", "BEGIN, " + provider + " { @x = count(); }"},
		} {
			t.Run(provider+"_"+tc.name+"_nil_catalog", func(t *testing.T) {
				res := StaticValidate(tc.script, nil)
				require.Equal(t, "CATALOG_UNAVAILABLE", res.Code)
				require.NotEmpty(t, res.Errors)
			})
			t.Run(provider+"_"+tc.name+"_with_catalog", func(t *testing.T) {
				res := StaticValidate(tc.script, cat)
				require.NotEmpty(t, res.Errors)
				joined := strings.Join(res.Errors, "; ")
				require.Contains(t, joined, "invalid probe header: missing target for provider "+provider)
				low := strings.ToLower(joined)
				require.NotContains(t, low, "probe not found")
				require.NotContains(t, low, "unknown probe")
				require.NotContains(t, low, "no such probe")
				require.NotContains(t, low, "too many probes")
				require.Equal(t, "VALIDATION_FAILED", classifyValidationError(res.Errors))
			})
		}
	}

	minimalSrv := knownCatalogServer(t, []string{"tracepoint:syscalls:sys_enter_openat"})
	catSrv := knownCatalogServer(t, []string{"BEGIN", "END", "tracepoint:block:block_rq_issue"})
	for _, script := range []string{"profile { @x = count(); }", "kprobe { @x = count(); }"} {
		for _, srv := range []*Server{minimalSrv, catSrv} {
			status, code := postRunCode(t, srv, script)
			require.Equal(t, http.StatusBadRequest, status)
			require.Equal(t, "VALIDATION_FAILED", code)
		}
	}

	for _, valid := range []string{"BEGIN { @x = count(); }", "END { @x = count(); }", "BEGIN, END { @x = count(); }"} {
		res := StaticValidate(valid, cat)
		require.Empty(t, res.Errors, valid)
	}
}

func TestParseHeaderTargetsPreservesQuotedColon(t *testing.T) {
	targets, errs := parseHeaderTargets(`uprobe:/lib/libc.so.6:"Foo::bar(int, int)"`)
	require.Empty(t, errs)
	require.Equal(t, []string{`uprobe:/lib/libc.so.6:"Foo::bar(int, int)"`}, targets)
}
