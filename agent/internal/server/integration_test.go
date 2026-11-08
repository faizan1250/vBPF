//go:build integration

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"nhooyr.io/websocket"

	"github.com/faizan1250/vBPF/agent/internal/parser"
	"github.com/stretchr/testify/require"
)

func requireRootBpftrace(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("integration needs linux + bpftrace")
	}
	if os.Geteuid() != 0 {
		t.Skip("integration needs root")
	}
	if _, err := exec.LookPath("bpftrace"); err != nil {
		t.Skip("bpftrace not installed")
	}
}

func integrationServer(t *testing.T) *Server {
	t.Helper()
	s, err := New(Config{
		TokenFile: filepath.Join(t.TempDir(), "agent.token"),
		Logger:    zerolog.Nop(),
		StartTime: time.Now(),
	})
	require.NoError(t, err)
	require.NoError(t, s.catalog.Refresh(context.Background()))
	return s
}

func loadRecipe(t *testing.T, id string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "recipes", id+".bt"))
	require.NoError(t, err)
	require.NotEmpty(t, strings.TrimSpace(string(raw)))
	return string(raw)
}

func startRun(t *testing.T, s *Server, ts *httptest.Server, script string, dur int) string {
	t.Helper()
	body, err := json.Marshal(map[string]any{"script": script, "duration_s": dur})
	require.NoError(t, err)
	req, _ := http.NewRequest("POST", ts.URL+"/v1/runs", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer "+s.Token())
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	var out map[string]string
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	require.NotEmpty(t, out["run_id"])
	return out["run_id"]
}

func streamUntilSummary(t *testing.T, s *Server, ts *httptest.Server, id string) parser.Summary {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	wsURL := "ws://" + strings.TrimPrefix(ts.URL, "http://") + "/v1/runs/" + id + "/stream"
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + s.Token()}},
	})
	require.NoError(t, err)
	defer conn.Close(websocket.StatusNormalClosure, "")
	var events int
	for {
		_, raw, err := conn.Read(ctx)
		require.NoError(t, err)
		var ev parser.Event
		require.NoError(t, json.Unmarshal(raw, &ev))
		require.Equal(t, id, ev.RunID)
		events++
		if ev.Kind == parser.KindSummary {
			raw, merr := json.Marshal(ev.Data)
			require.NoError(t, merr)
			var sum parser.Summary
			require.NoError(t, json.Unmarshal(raw, &sum), "summary payload shape")
			require.Positive(t, events)
			return sum
		}
	}
}

func TestIntegrationThreeRecipes(t *testing.T) {
	requireRootBpftrace(t)
	s := integrationServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// Generate exec load so the exec recipe sees events.
	stopLoad := make(chan struct{})
	go func() {
		for {
			select {
			case <-stopLoad:
				return
			default:
				_ = exec.Command("true").Run()
			}
		}
	}()
	defer close(stopLoad)

	for _, id := range []string{"cpu-by-process", "syscall-counts-by-process", "new-processes"} {
		script := loadRecipe(t, id)
		runID := startRun(t, s, ts, script, 3)
		sum := streamUntilSummary(t, s, ts, runID)
		require.Contains(t, []string{"completed", "timeout"}, sum.ExitReason, id)
		require.Zero(t, s.runs.Active())
	}
	assertNoLeak(t)
}

func TestIntegrationKillMidRun(t *testing.T) {
	requireRootBpftrace(t)
	s := integrationServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	script := loadRecipe(t, "cpu-by-process")
	runID := startRun(t, s, ts, script, 30)
	time.Sleep(2 * time.Second)
	req, _ := http.NewRequest("DELETE", ts.URL+"/v1/runs/"+runID, nil)
	req.Header.Set("Authorization", "Bearer "+s.Token())
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	sum := streamUntilSummary(t, s, ts, runID)
	require.Contains(t, []string{"completed", "timeout"}, sum.ExitReason)
	deadline := time.Now().Add(10 * time.Second)
	for s.runs.Active() != 0 && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	require.Zero(t, s.runs.Active())
	assertNoLeak(t)
}

func assertNoLeak(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("pgrep"); err != nil {
		t.Log("pgrep missing, skipping process check")
	} else if out, _ := exec.Command("pgrep", "-a", "bpftrace").CombinedOutput(); len(strings.TrimSpace(string(out))) > 0 {
		t.Fatalf("leaked bpftrace processes: %s", out)
	}
	matches, _ := filepath.Glob(filepath.Join(os.TempDir(), "vbpf-*.bt"))
	require.Empty(t, matches, "temp scripts leaked")
}
