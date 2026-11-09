package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func probeArgsServer(t *testing.T, fn ProbeArgsFunc) *Server {
	t.Helper()
	return testServer(t, Config{
		CatalogFn: func(ctx context.Context) ([]string, error) {
			return []string{
				"tracepoint:block:block_rq_issue",
				"tracepoint:syscalls:sys_enter_openat",
			}, nil
		},
		ProbeArgs: fn,
	})
}

func refreshCatalog(t *testing.T, s *Server) {
	t.Helper()
	require.NoError(t, s.catalog.Refresh(context.Background()))
}

func TestProbeArgsSuccess(t *testing.T) {
	s := probeArgsServer(t, func(ctx context.Context, probe string) (string, error) {
		require.Equal(t, "tracepoint:block:block_rq_issue", probe)
		return "tracepoint:block:block_rq_issue\n  unsigned long sector;\n", nil
	})
	refreshCatalog(t, s)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "GET", "/v1/probe-args?probe=tracepoint%3Ablock%3Ablock_rq_issue", ""))
	require.Equal(t, http.StatusOK, w.Code)
	var out struct {
		Probe  string `json:"probe"`
		Output string `json:"output"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.Equal(t, "tracepoint:block:block_rq_issue", out.Probe)
	require.Contains(t, out.Output, "sector")
}

func TestProbeArgsRejectsUnknown(t *testing.T) {
	called := false
	s := probeArgsServer(t, func(ctx context.Context, probe string) (string, error) {
		called = true
		return "", nil
	})
	refreshCatalog(t, s)
	for _, probe := range []string{
		"tracepoint:foo:bar",
		"tracepoint:block:block_rq_issue; rm -rf /",
		"tracepoint:block:block_rq_issue$(id)",
		"BEGIN",
		"tracepoint:*:*",
		"../../etc/passwd",
	} {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, authReq(t, s, "GET", "/v1/probe-args?probe="+url.QueryEscape(probe), ""))
		require.Equal(t, http.StatusNotFound, w.Code, probe)
	}
	require.False(t, called, "exec must not run for unknown probes")
}

func TestProbeArgsRejectsMissingOrLong(t *testing.T) {
	s := probeArgsServer(t, func(ctx context.Context, probe string) (string, error) {
		return "x", nil
	})
	refreshCatalog(t, s)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "GET", "/v1/probe-args", ""))
	require.Equal(t, http.StatusBadRequest, w.Code)

	w2 := httptest.NewRecorder()
	s.Handler().ServeHTTP(w2, authReq(t, s, "GET", "/v1/probe-args?probe="+strings.Repeat("a", MaxProbeNameLen+1), ""))
	require.Equal(t, http.StatusBadRequest, w2.Code)
}

func TestProbeArgsRequiresToken(t *testing.T) {
	s := probeArgsServer(t, func(ctx context.Context, probe string) (string, error) {
		return "x", nil
	})
	refreshCatalog(t, s)
	r := httptest.NewRequest("GET", "/v1/probe-args?probe=tracepoint%3Ablock%3Ablock_rq_issue", nil)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	require.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestProbeArgsExecFailure(t *testing.T) {
	s := probeArgsServer(t, func(ctx context.Context, probe string) (string, error) {
		return "", errors.New("bpftrace boom")
	})
	refreshCatalog(t, s)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "GET", "/v1/probe-args?probe=tracepoint%3Ablock%3Ablock_rq_issue", ""))
	require.Equal(t, http.StatusInternalServerError, w.Code)
	var body map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, "PROBE_ARGS_FAILED", body["code"])
}

func TestProbeArgsTimeout(t *testing.T) {
	s := probeArgsServer(t, func(ctx context.Context, probe string) (string, error) {
		<-ctx.Done()
		return "", ctx.Err()
	})
	refreshCatalog(t, s)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "GET", "/v1/probe-args?probe=tracepoint%3Ablock%3Ablock_rq_issue", ""))
	require.Equal(t, http.StatusGatewayTimeout, w.Code)
}

func TestProbeArgsCapsOutput(t *testing.T) {
	big := strings.Repeat("x", ProbeArgsMaxBytes+100)
	s := probeArgsServer(t, func(ctx context.Context, probe string) (string, error) {
		return big, nil
	})
	refreshCatalog(t, s)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "GET", "/v1/probe-args?probe=tracepoint%3Ablock%3Ablock_rq_issue", ""))
	require.Equal(t, http.StatusOK, w.Code)
	var out struct {
		Output string `json:"output"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.LessOrEqual(t, len(out.Output), ProbeArgsMaxBytes)
}

func TestDefaultProbeArgsUsesArgv(t *testing.T) {
	if _, err := exec.LookPath("bpftrace"); err != nil {
		t.Skip("bpftrace not installed")
	}
	fn := DefaultProbeArgs("bpftrace")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = fn(ctx, "tracepoint:block:block_rq_issue")
}
