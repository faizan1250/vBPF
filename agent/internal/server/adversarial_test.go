package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

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
