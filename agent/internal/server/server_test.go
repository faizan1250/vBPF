package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"

	"github.com/faizan1250/vBPF/agent/internal/parser"
	"github.com/faizan1250/vBPF/agent/internal/runner"
	"github.com/stretchr/testify/require"
)

func testLogger() zerolog.Logger { return zerolog.Nop() }

func testServer(t *testing.T, cfg Config) *Server {
	t.Helper()
	cfg.Logger = testLogger()
	cfg.StartTime = time.Now()
	if cfg.TokenFile == "" {
		cfg.TokenFile = filepath.Join(t.TempDir(), "agent.token")
	}
	if cfg.DryRun == nil {
		cfg.DryRun = func(ctx context.Context, script string) []string { return nil }
	}
	if cfg.CatalogFn == nil {
		cfg.CatalogFn = func(ctx context.Context) ([]string, error) { return []string{}, nil }
	}
	s, err := New(cfg)
	require.NoError(t, err)
	return s
}

func authReq(t *testing.T, s *Server, method, path, body string) *http.Request {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	r.Header.Set("Authorization", "Bearer "+s.Token())
	return r
}

func TestAuthRequiredEverywhere(t *testing.T) {
	s := testServer(t, Config{})
	paths := []struct{ method, path, body string }{
		{"GET", "/health", ""},
		{"GET", "/v1/probes", ""},
		{"GET", "/v1/probe-args?probe=tracepoint:block:block_rq_issue", ""},
		{"POST", "/v1/validate", `{"script":"BEGIN {}"}`},
		{"POST", "/v1/runs", `{"script":"BEGIN {}"}`},
		{"DELETE", "/v1/runs/x", ""},
	}
	for _, p := range paths {
		r := httptest.NewRequest(p.method, p.path, strings.NewReader(p.body))
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		require.Equal(t, http.StatusUnauthorized, w.Code, p.path)
		bad := httptest.NewRequest(p.method, p.path, strings.NewReader(p.body))
		bad.Header.Set("Authorization", "Bearer wrong")
		w2 := httptest.NewRecorder()
		s.Handler().ServeHTTP(w2, bad)
		require.Equal(t, http.StatusUnauthorized, w2.Code, p.path)
	}
}

func TestHealthShape(t *testing.T) {
	s := testServer(t, Config{Health: &HealthProvider{
		StartTime:  time.Now().Add(-90 * time.Second),
		Kernel:     func() string { return "6.8-test" },
		Version:    func(ctx context.Context) string { return "bpftrace v0.21" },
		HasBTF:     func() bool { return true },
		IsRoot:     func() bool { return false },
		HasTracefs: func() bool { return true },
	}})
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "GET", "/health", ""))
	require.Equal(t, http.StatusOK, w.Code)
	var h map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &h))
	for _, k := range []string{"kernel", "bpftrace_version", "btf", "root", "tracefs", "uptime_s"} {
		require.Contains(t, h, k, "missing %s", k)
	}
	require.Equal(t, "6.8-test", h["kernel"])
	require.GreaterOrEqual(t, h["uptime_s"].(float64), float64(89))
}

func TestProbesSearch(t *testing.T) {
	s := testServer(t, Config{CatalogFn: func(ctx context.Context) ([]string, error) {
		return []string{
			"tracepoint:block:block_rq_issue",
			"tracepoint:syscalls:sys_enter_openat",
			"kprobe:tcp_v4_connect",
		}, nil
	}})
	require.NoError(t, s.catalog.Refresh(context.Background()))
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "GET", "/v1/probes?q=block", ""))
	require.Equal(t, http.StatusOK, w.Code)
	var out struct {
		Probes []string `json:"probes"`
		Count  int      `json:"count"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.Equal(t, []string{"tracepoint:block:block_rq_issue"}, out.Probes)

	w2 := httptest.NewRecorder()
	s.Handler().ServeHTTP(w2, authReq(t, s, "GET", "/v1/probes?type=kprobe", ""))
	require.NoError(t, json.Unmarshal(w2.Body.Bytes(), &out))
	require.Equal(t, []string{"kprobe:tcp_v4_connect"}, out.Probes)
}

func TestValidateBlocklist(t *testing.T) {
	s := testServer(t, Config{})
	cases := map[string]string{
		`BEGIN { system("ls"); }`:             "blocked call",
		"#include <stdio.h>\nBEGIN {}":        "blocked syntax",
		"myprobe:foo { @x = count(); }":       "provider not allowed",
		"hello world, no probes here":         "no probes",
		"uprobe:foo:bar {}":                   "uprobe must target",
		"tracepoint:block:block_rq_issue { }": "",
		"BEGIN { @x = count(); }\nEND { }":    "",
		"kprobe:* { @x = count(); }":          "wildcard too broad",
		strings.Repeat("x", MaxScriptBytes+1): "exceeds 8 KB",
	}
	for script, want := range cases {
		body, _ := json.Marshal(map[string]string{"script": script})
		w := httptest.NewRecorder()
		req := authReq(t, s, "POST", "/v1/validate", string(body))
		s.Handler().ServeHTTP(w, req)
		require.Equal(t, http.StatusOK, w.Code)
		var out struct {
			OK     bool     `json:"ok"`
			Errors []string `json:"errors"`
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
		if want == "" {
			require.True(t, out.OK, script)
		} else {
			require.False(t, out.OK, script)
			require.Contains(t, strings.Join(out.Errors, " "), want, script)
		}
	}
}

func TestValidateDryRunFailure(t *testing.T) {
	s := testServer(t, Config{DryRun: func(ctx context.Context, script string) []string {
		return []string{"syntax error at line 1"}
	}})
	body, _ := json.Marshal(map[string]string{"script": "BEGIN { @x = count(); }"})
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "POST", "/v1/validate", string(body)))
	var out struct {
		OK     bool     `json:"ok"`
		Errors []string `json:"errors"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.False(t, out.OK)
	require.Contains(t, out.Errors[0], "syntax error")
}

func fakeRunner(events int, sleep time.Duration) RunnerFunc {
	return func(ctx context.Context, opts runner.Options, emit func(parser.Event) error) error {
		if err := emit(parser.Status(opts.RunID, 0, "running")); err != nil {
			return err
		}
		for i := 0; i < events; i++ {
			select {
			case <-ctx.Done():
				_ = emit(parser.Summarize(opts.RunID, uint64(i+1), parser.Summary{ExitReason: runner.ReasonCancelled}))
				return nil
			case <-time.After(sleep):
			}
			if err := emit(parser.Event{RunID: opts.RunID, Seq: uint64(i + 1), Ts: parser.NowMillis(), Kind: parser.KindPrintf, Data: fmt.Sprintf("line %d", i)}); err != nil {
				return err
			}
		}
		_ = emit(parser.Summarize(opts.RunID, uint64(events+1), parser.Summary{Events: uint64(events), ExitReason: runner.ReasonCompleted}))
		return nil
	}
}

func createRun(t *testing.T, s *Server, script string, dur int) string {
	t.Helper()
	body := fmt.Sprintf(`{"script":%q,"duration_s":%d}`, script, dur)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "POST", "/v1/runs", body))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	var out map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.NotEmpty(t, out["run_id"])
	return out["run_id"]
}

func TestRunsConcurrency409(t *testing.T) {
	block := make(chan struct{})
	s := testServer(t, Config{RunFn: func(ctx context.Context, opts runner.Options, emit func(parser.Event) error) error {
		_ = emit(parser.Status(opts.RunID, 0, "running"))
		<-ctx.Done()
		_ = emit(parser.Summarize(opts.RunID, 1, parser.Summary{ExitReason: runner.ReasonCancelled}))
		close(block)
		return nil
	}})
	id := createRun(t, s, "BEGIN { @x = count(); }", 10)
	require.NotEmpty(t, id)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "POST", "/v1/runs", `{"script":"BEGIN { @x = count(); }","duration_s":10}`))
	require.Equal(t, http.StatusConflict, w.Code)
	var errBody map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &errBody))
	require.Equal(t, "LIMIT_EXCEEDED", errBody["code"])

	w2 := httptest.NewRecorder()
	s.Handler().ServeHTTP(w2, authReq(t, s, "DELETE", "/v1/runs/"+id, ""))
	require.Equal(t, http.StatusOK, w2.Code)
	select {
	case <-block:
	case <-time.After(5 * time.Second):
		t.Fatal("run did not stop")
	}
}

func TestRunValidationRejects(t *testing.T) {
	s := testServer(t, Config{RunFn: fakeRunner(1, time.Millisecond)})
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "POST", "/v1/runs", `{"script":"BEGIN { system(\"x\"); }","duration_s":2}`))
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestStreamEnvelopeAndStop(t *testing.T) {
	s := testServer(t, Config{RunFn: fakeRunner(50, 5*time.Millisecond)})
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	id := func() string {
		req, _ := http.NewRequest("POST", ts.URL+"/v1/runs", strings.NewReader(`{"script":"BEGIN { @x = count(); }","duration_s":10}`))
		req.Header.Set("Authorization", "Bearer "+s.Token())
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		require.Equal(t, http.StatusCreated, resp.StatusCode)
		var out map[string]string
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return out["run_id"]
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	wsURL := "ws://" + strings.TrimPrefix(ts.URL, "http://") + "/v1/runs/" + id + "/stream"
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + s.Token()}}})
	require.NoError(t, err)
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()
	var seenStatus, seenData bool
	for i := 0; i < 10; i++ {
		_, raw, err := conn.Read(ctx)
		require.NoError(t, err)
		var ev parser.Event
		require.NoError(t, json.Unmarshal(raw, &ev))
		require.NotEmpty(t, ev.RunID)
		require.NotEmpty(t, ev.Kind)
		require.Equal(t, id, ev.RunID)
		switch ev.Kind {
		case parser.KindStatus:
			seenStatus = true
		case parser.KindPrintf:
			seenData = true
		}
		if seenStatus && seenData {
			break
		}
	}
	require.True(t, seenStatus, "no status envelope")
	require.True(t, seenData, "no data envelope")
	require.NoError(t, conn.Write(ctx, websocket.MessageText, []byte(`{"type":"stop"}`)))
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, err := conn.Read(ctx); err != nil {
			break
		}
	}
	require.Equal(t, 0, s.runs.Active(), "run leaked after stop")
}

func TestBackpressureDropOldest(t *testing.T) {
	run := &Run{
		id:       "run_test",
		state:    "running",
		subs:     make(map[*subscriber]struct{}),
		rateWin:  time.Now(),
		lastLost: time.Now().Add(-2 * time.Second),
	}
	sub := &subscriber{ch: make(chan parser.Event, 4)}
	run.subs[sub] = struct{}{}
	for i := 0; i < 20; i++ {
		run.publish(parser.Event{RunID: run.id, Seq: uint64(i), Ts: 1, Kind: parser.KindPrintf, Data: i})
	}
	require.LessOrEqual(t, len(sub.ch), 4, "subscriber channel unbounded")
	run.mu.Lock()
	histLost := 0
	for _, ev := range run.history {
		if ev.Kind == parser.KindLost {
			histLost++
		}
	}
	run.mu.Unlock()
	require.Positive(t, histLost, "no lost event emitted")
}

func TestRateCap500(t *testing.T) {
	run := &Run{id: "run_rate", state: "running", subs: make(map[*subscriber]struct{}), rateWin: time.Now(), lastLost: time.Now()}
	for i := 0; i < 600; i++ {
		run.publish(parser.Event{RunID: run.id, Seq: uint64(i), Ts: 1, Kind: parser.KindPrintf, Data: i})
	}
	run.mu.Lock()
	defer run.mu.Unlock()
	require.LessOrEqual(t, len(run.history), 501+1, "rate cap not enforced")
}

func TestTokenFile0600(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "agent.token")
	tok, err := LoadOrCreateToken(path)
	require.NoError(t, err)
	require.NotEmpty(t, tok)
	tok2, err := LoadOrCreateToken(path)
	require.NoError(t, err)
	require.Equal(t, tok, tok2)
	fi, err := os.Stat(path)
	require.NoError(t, err)
	if runtime.GOOS != "windows" {
		require.Equal(t, os.FileMode(0o600), fi.Mode().Perm())
	} else {
		require.NotZero(t, fi.Size())
	}
}
