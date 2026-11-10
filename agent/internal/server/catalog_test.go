package server

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestCatalogLifecycleAndStalePreservation(t *testing.T) {
	var (
		mu     sync.Mutex
		probes = []string{"tracepoint:block:block_rq_issue", "kprobe:do_sys_open"}
		err    error
	)
	cat := NewCatalog("", func(ctx context.Context) ([]string, error) {
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			return nil, err
		}
		out := make([]string, len(probes))
		copy(out, probes)
		return out, nil
	})

	require.False(t, cat.Ready())
	st := cat.Status()
	require.Equal(t, CatalogStateLoading, st.State)
	require.Equal(t, 0, st.Probes)
	require.NotNil(t, st.Warnings)
	require.Empty(t, st.Warnings)

	// Empty probe list is treated as an error and stays not ready.
	mu.Lock()
	probes = nil
	mu.Unlock()
	require.Error(t, cat.Refresh(context.Background()))
	require.False(t, cat.Ready())
	st = cat.Status()
	require.Equal(t, CatalogStateFailed, st.State)
	require.NotEmpty(t, st.LastError)

	// First valid refresh makes catalog ready.
	mu.Lock()
	probes = []string{"tracepoint:block:block_rq_issue", "kprobe:do_sys_open"}
	mu.Unlock()
	require.NoError(t, cat.Refresh(context.Background()))
	require.True(t, cat.Ready())
	st = cat.Status()
	require.Equal(t, CatalogStateReady, st.State)
	require.Equal(t, 2, st.Probes)
	require.NotEmpty(t, st.RefreshedAt)
	require.Empty(t, st.StaleSince)
	require.Empty(t, st.LastError)
	require.Empty(t, st.Warnings)

	// Subsequent error marks stale without dropping the last good snapshot.
	mu.Lock()
	err = errors.New("bpftrace crashed\nline2")
	mu.Unlock()
	require.Error(t, cat.Refresh(context.Background()))
	require.True(t, cat.Ready())
	require.True(t, cat.Contains("tracepoint:block:block_rq_issue"))
	st = cat.Status()
	require.Equal(t, CatalogStateReady, st.State)
	require.Equal(t, 2, st.Probes)
	require.NotEmpty(t, st.StaleSince)
	require.Equal(t, "bpftrace crashed line2", st.LastError)

	// Subsequent empty refresh also preserves the last good snapshot cleanly.
	mu.Lock()
	err = nil
	probes = nil
	mu.Unlock()
	require.Error(t, cat.Refresh(context.Background()))
	require.True(t, cat.Contains("kprobe:do_sys_open"))
	require.NotEmpty(t, cat.Status().StaleSince)

	// Recovery clears stale_since and last_error.
	mu.Lock()
	probes = []string{"kprobe:do_sys_open"}
	mu.Unlock()
	require.NoError(t, cat.Refresh(context.Background()))
	st = cat.Status()
	require.Empty(t, st.StaleSince)
	require.Empty(t, st.LastError)
	require.Equal(t, []string{CatalogWarningNoTracepoints}, st.Warnings)
}

func TestStaticValidateAndEndpointsFailClosedWhenCatalogUnready(t *testing.T) {
	cat := NewCatalog("", func(ctx context.Context) ([]string, error) {
		return nil, errors.New("boom")
	})

	for _, script := range []string{"BEGIN {}", "BEGIN { @x = count(); }", `BEGIN { system("ls"); }`} {
		resNil := StaticValidate(script, nil)
		require.Equal(t, "CATALOG_UNAVAILABLE", resNil.Code)
		require.NotEmpty(t, resNil.Errors)

		resLoading := StaticValidate(script, cat)
		require.Equal(t, "CATALOG_UNAVAILABLE", resLoading.Code)
		require.NotEmpty(t, resLoading.Errors)
	}

	require.Error(t, cat.Refresh(context.Background()))
	resFailed := StaticValidate("BEGIN {}", cat)
	require.Equal(t, "CATALOG_UNAVAILABLE", resFailed.Code)

	s := unreadyTestServer(t, Config{Health: &HealthProvider{
		StartTime:  time.Now(),
		Kernel:     func() string { return "6.8-test" },
		Version:    func(ctx context.Context) string { return "bpftrace v0.21" },
		HasBTF:     func() bool { return true },
		IsRoot:     func() bool { return true },
		HasTracefs: func() bool { return true },
	}})

	// /health returns 200 (liveness) with ready=false while catalog is loading.
	hw := httptest.NewRecorder()
	s.Handler().ServeHTTP(hw, authReq(t, s, "GET", "/health", ""))
	require.Equal(t, http.StatusOK, hw.Code)
	var health Health
	require.NoError(t, json.Unmarshal(hw.Body.Bytes(), &health))
	require.False(t, health.Ready)
	require.Equal(t, CatalogStateLoading, health.Catalog.State)

	// /v1/validate and /v1/runs fail closed with 503 + Retry-After + CATALOG_UNAVAILABLE.
	for _, tc := range []struct {
		path string
		body string
	}{
		{"/v1/validate", `{"script":"BEGIN {}"}`},
		{"/v1/runs", `{"script":"BEGIN {}"}`},
	} {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, authReq(t, s, "POST", tc.path, tc.body))
		require.Equal(t, http.StatusServiceUnavailable, w.Code, tc.path)
		require.NotEmpty(t, w.Header().Get("Retry-After"), tc.path)
		var errBody map[string]string
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &errBody))
		require.Equal(t, "CATALOG_UNAVAILABLE", errBody["code"])
	}
}

func TestListenAndServeStartsWithoutBlockingAndRetriesCatalogBackoff(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := ln.Addr().String()
	require.NoError(t, ln.Close())

	var attempts atomic.Int32
	gate := make(chan struct{})
	s, err := New(Config{
		Addr:             addr,
		TokenFile:        filepath.Join(t.TempDir(), "agent.token"),
		Logger:           testLogger(),
		StartTime:        time.Now(),
		CatalogRetryBase: 15 * time.Millisecond,
		CatalogRetryMax:  30 * time.Millisecond,
		CatalogFn: func(ctx context.Context) ([]string, error) {
			n := attempts.Add(1)
			if n == 1 {
				<-gate
				return nil, errors.New("initial failure")
			}
			if n == 2 {
				return nil, errors.New("second failure")
			}
			return []string{"BEGIN", "tracepoint:syscalls:sys_enter_openat"}, nil
		},
		Health: &HealthProvider{
			StartTime:  time.Now(),
			Kernel:     func() string { return "6.8-test" },
			Version:    func(ctx context.Context) string { return "bpftrace v0.21" },
			HasBTF:     func() bool { return true },
			IsRoot:     func() bool { return true },
			HasTracefs: func() bool { return true },
		},
		DryRun: func(ctx context.Context, script string) []string { return nil },
	})
	require.NoError(t, err)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- s.ListenAndServe(ctx)
	}()

	// Server accepts connections immediately while first catalog attempt is still blocked.
	client := &http.Client{Timeout: time.Second}
	var resp *http.Response
	require.Eventually(t, func() bool {
		req, _ := http.NewRequest("GET", "http://"+addr+"/health", nil)
		req.Header.Set("Authorization", "Bearer "+s.Token())
		r, err := client.Do(req)
		if err != nil {
			return false
		}
		resp = r
		return true
	}, 2*time.Second, 10*time.Millisecond)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var h Health
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&h))
	require.False(t, h.Ready)

	close(gate)

	// Retries with backoff until third attempt succeeds and transitions to ready.
	require.Eventually(t, func() bool {
		req, _ := http.NewRequest("GET", "http://"+addr+"/health", nil)
		req.Header.Set("Authorization", "Bearer "+s.Token())
		r, err := client.Do(req)
		if err != nil {
			return false
		}
		defer func() { _ = r.Body.Close() }()
		var cur Health
		if err := json.NewDecoder(r.Body).Decode(&cur); err != nil {
			return false
		}
		return cur.Ready && cur.Catalog.Probes == 2
	}, 2*time.Second, 10*time.Millisecond)

	cancel()
	select {
	case err := <-serveDone:
		require.NoError(t, err)
	case <-time.After(2 * time.Second):
		t.Fatal("ListenAndServe did not stop cleanly")
	}
}
