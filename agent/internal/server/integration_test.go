//go:build integration

package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"

	"github.com/faizan1250/vBPF/agent/internal/parser"
	"github.com/faizan1250/vBPF/agent/internal/runner"
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
	defer func() { _ = resp.Body.Close() }()
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
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()
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
	require.Equal(t, runner.ReasonCancelled, sum.ExitReason)
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
	if _, err := exec.LookPath("bpftool"); err != nil {
		t.Log("bpftool missing, skipping prog check")
	} else if out, err := exec.Command("bpftool", "prog", "list").CombinedOutput(); err != nil {
		t.Logf("bpftool prog list failed, skipping: %v", err)
	} else if len(strings.TrimSpace(string(out))) > 0 {
		t.Fatalf("leaked BPF programs:\n%s", out)
	}
	matches, _ := filepath.Glob(filepath.Join(os.TempDir(), "vbpf-*.bt"))
	require.Empty(t, matches, "temp scripts leaked")
}

// waitForBpftraceChild polls pgrep until a vbpf-*.bt child appears.
func waitForBpftraceChild(t *testing.T) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		out, err := exec.Command("pgrep", "-f", `vbpf-.*\.bt`).Output()
		if err == nil {
			if pid := strings.TrimSpace(string(out)); pid != "" {
				return strings.Fields(pid)[0]
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("bpftrace child never appeared in pgrep")
	return ""
}

func TestIntegrationKillBpftraceMidRun(t *testing.T) {
	requireRootBpftrace(t)
	s := integrationServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	script := loadRecipe(t, "cpu-by-process")
	runID := startRun(t, s, ts, script, 30)
	pid := waitForBpftraceChild(t)
	require.NoError(t, exec.Command("kill", "-KILL", pid).Run())
	sum := streamUntilSummary(t, s, ts, runID)
	require.Equal(t, runner.ReasonFailed, sum.ExitReason)
	deadline := time.Now().Add(10 * time.Second)
	for s.runs.Active() != 0 && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	require.Zero(t, s.runs.Active())
	assertNoLeak(t)
}

func TestIntegrationCloseTabMidRun(t *testing.T) {
	requireRootBpftrace(t)
	s := integrationServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	script := loadRecipe(t, "cpu-by-process")
	runID := startRun(t, s, ts, script, 30)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	wsURL := "ws://" + strings.TrimPrefix(ts.URL, "http://") + "/v1/runs/" + runID + "/stream"
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + s.Token()}},
	})
	require.NoError(t, err)
	_, _, err = conn.Read(ctx)
	require.NoError(t, err)
	// Abrupt tab close: no WS close frame, no DELETE.
	cancel()
	_ = conn.CloseNow()
	// The run survives the dropped viewer.
	time.Sleep(time.Second)
	require.Equal(t, 1, s.runs.Active())
	req, _ := http.NewRequest("DELETE", ts.URL+"/v1/runs/"+runID, nil)
	req.Header.Set("Authorization", "Bearer "+s.Token())
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	sum := streamUntilSummary(t, s, ts, runID)
	require.Equal(t, runner.ReasonCancelled, sum.ExitReason)
	assertNoLeak(t)
}

func TestIntegrationAPIKillMidRun(t *testing.T) {
	requireRootBpftrace(t)
	s := integrationServer(t)
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	// API death: WS drops, no DELETE ever arrives; the run must time out alone.
	script := loadRecipe(t, "cpu-by-process")
	runID := startRun(t, s, ts, script, 4)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	wsURL := "ws://" + strings.TrimPrefix(ts.URL, "http://") + "/v1/runs/" + runID + "/stream"
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + s.Token()}},
	})
	require.NoError(t, err)
	_, _, err = conn.Read(ctx)
	require.NoError(t, err)
	cancel()
	_ = conn.CloseNow()
	// Reconnect after the deadline; history replay must carry the summary.
	time.Sleep(6 * time.Second)
	require.Zero(t, s.runs.Active())
	sum := streamUntilSummary(t, s, ts, runID)
	require.Equal(t, runner.ReasonTimeout, sum.ExitReason)
	assertNoLeak(t)
}

func TestIntegrationAgentRestartSweep(t *testing.T) {
	requireRootBpftrace(t)
	// Orphaned child as left by a SIGKILLed agent: own process group, argv
	// carries a vbpf-*.bt temp path, never reaped by the dead parent.
	tmp, err := os.CreateTemp("", "vbpf-orphan-*.bt")
	require.NoError(t, err)
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	_, err = io.WriteString(tmp, "interval:s:1 { printf(\"tick\\n\"); }\n")
	require.NoError(t, err)
	require.NoError(t, tmp.Close())
	devNull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	require.NoError(t, err)
	defer func() { _ = devNull.Close() }()
	cmd := exec.Command("bpftrace", "-q", "-f", "json", tmpName)
	cmd.Stdout = devNull
	cmd.Stderr = devNull
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	require.NoError(t, cmd.Start())
	waitForBpftraceChild(t)
	// Next agent boot calls this once before serving (see realServe).
	sweepCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	killed, err := runner.SweepStale(sweepCtx)
	require.NoError(t, err)
	require.Positive(t, killed, "sweep must reap the orphan")
	_ = cmd.Wait() // reap so the zombie leaves pgrep too
	_ = os.Remove(tmpName)
	deadline := time.Now().Add(10 * time.Second)
	for {
		out, _ := exec.Command("pgrep", "-f", `vbpf-.*\.bt`).CombinedOutput()
		if len(strings.TrimSpace(string(out))) == 0 {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("orphan survived sweep: %s", out)
		}
		time.Sleep(200 * time.Millisecond)
	}
	assertNoLeak(t)
}
