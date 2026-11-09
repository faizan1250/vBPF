package runner

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/faizan1250/vBPF/agent/internal/limits"
	"github.com/faizan1250/vBPF/agent/internal/parser"
)

func fakePath(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs(filepath.Join("..", "..", "..", "scripts", "fake-bpftrace.sh"))
	require.NoError(t, err)
	if _, err := os.Stat(abs); err != nil {
		t.Skipf("fake-bpftrace not found: %v", err)
	}
	return abs
}

func run(t *testing.T, opts Options) ([]parser.Event, error) {
	t.Helper()
	var events []parser.Event
	err := Run(context.Background(), opts, func(ev parser.Event) error {
		events = append(events, ev)
		return nil
	})
	return events, err
}

func summaryOf(t *testing.T, events []parser.Event) parser.Summary {
	t.Helper()
	require.NotEmpty(t, events, "no events")
	last := events[len(events)-1]
	require.Equal(t, parser.KindSummary, last.Kind)
	s, ok := last.Data.(parser.Summary)
	require.True(t, ok, "summary data type %T", last.Data)
	return s
}

func TestReplayFixture(t *testing.T) {
	fake := fakePath(t)
	t.Setenv("FAKE_MODE", "replay")
	t.Setenv("FAKE_FIXTURE", filepath.Join("..", "..", "..", "fixtures", "syscall-counts-by-process.ndjson"))
	events, err := run(t, Options{BPFtracePath: fake, Script: "tracepoint:raw_syscalls:sys_enter {}", Duration: time.Second, RunID: "run_replay"})
	require.NoError(t, err)
	require.Equal(t, parser.KindStatus, events[0].Kind)
	s := summaryOf(t, events)
	require.Equal(t, ReasonCompleted, s.ExitReason)
	require.Positive(t, s.Events)
	require.Positive(t, s.Bytes)
	matches, _ := filepath.Glob(filepath.Join(os.TempDir(), "vbpf-*.bt"))
	require.Empty(t, matches, "temp files leaked")
}

func TestEarlyExit(t *testing.T) {
	fake := fakePath(t)
	t.Setenv("FAKE_MODE", "exit0")
	events, err := run(t, Options{BPFtracePath: fake, Script: "BEGIN {}", Duration: 10 * time.Second, RunID: "run_early"})
	require.NoError(t, err)
	require.Equal(t, ReasonCompleted, summaryOf(t, events).ExitReason)
}

func TestNonZeroExit(t *testing.T) {
	fake := fakePath(t)
	t.Setenv("FAKE_MODE", "exit1")
	t.Setenv("FAKE_EXIT", "3")
	events, err := run(t, Options{BPFtracePath: fake, Script: "BEGIN {}", Duration: 10 * time.Second, RunID: "run_fail"})
	require.Error(t, err)
	require.Equal(t, ReasonFailed, summaryOf(t, events).ExitReason)
	var found bool
	for _, ev := range events {
		if ev.Kind == parser.KindStderr {
			if text, ok := ev.Data.(map[string]string)["text"]; ok && strings.Contains(text, "boom") {
				found = true
			}
		}
	}
	require.True(t, found, "missing stderr event")
}

func TestTimeout(t *testing.T) {
	fake := fakePath(t)
	t.Setenv("FAKE_MODE", "sleep")
	t.Setenv("FAKE_SLEEP", "30")
	start := time.Now()
	events, err := run(t, Options{BPFtracePath: fake, Script: "profile:hz:99 {}", Duration: time.Second, RunID: "run_timeout", GracePeriod: 200 * time.Millisecond})
	require.NoError(t, err)
	require.Equal(t, ReasonTimeout, summaryOf(t, events).ExitReason)
	require.Less(t, time.Since(start), 10*time.Second)
}

func TestKillEscalation(t *testing.T) {
	fake := fakePath(t)
	t.Setenv("FAKE_MODE", "ignoreint")
	t.Setenv("FAKE_SLEEP", "30")
	start := time.Now()
	events, err := run(t, Options{BPFtracePath: fake, Script: "profile:hz:99 {}", Duration: time.Second, RunID: "run_kill", GracePeriod: 200 * time.Millisecond})
	require.NoError(t, err)
	require.Equal(t, ReasonTimeout, summaryOf(t, events).ExitReason)
	require.Less(t, time.Since(start), 10*time.Second, "SIGKILL escalation failed")
}

func TestByteLimit(t *testing.T) {
	fake := fakePath(t)
	t.Setenv("FAKE_MODE", "huge")
	t.Setenv("FAKE_COUNT", "20000")
	events, err := run(t, Options{BPFtracePath: fake, Script: "BEGIN {}", Duration: 10 * time.Second, RunID: "run_huge", MaxBytesPerRun: 64 * 1024, GracePeriod: 200 * time.Millisecond})
	require.NoError(t, err)
	s := summaryOf(t, events)
	require.Equal(t, ReasonLimit, s.ExitReason)
	require.LessOrEqual(t, s.Bytes, uint64(64*1024))
}

func TestCancel(t *testing.T) {
	fake := fakePath(t)
	t.Setenv("FAKE_MODE", "sleep")
	t.Setenv("FAKE_SLEEP", "30")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	var events []parser.Event
	var runErr error
	go func() {
		defer close(done)
		runErr = Run(ctx, Options{BPFtracePath: fake, Script: "profile:hz:99 {}", Duration: 10 * time.Second, RunID: "run_cancel", GracePeriod: 200 * time.Millisecond}, func(ev parser.Event) error {
			events = append(events, ev)
			return nil
		})
	}()
	time.Sleep(time.Second)
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("cancel did not stop the run")
	}
	require.NoError(t, runErr)
	s := summaryOf(t, events)
	require.Equal(t, ReasonCancelled, s.ExitReason)
	require.Positive(t, s.DurationMs)
}

func TestValidation(t *testing.T) {
	fake := fakePath(t)
	_, err := run(t, Options{BPFtracePath: fake, Duration: time.Second, RunID: "r"})
	require.Error(t, err, "empty script accepted")
	_, err = run(t, Options{BPFtracePath: fake, Script: "x", RunID: "r"})
	require.Error(t, err, "zero duration accepted")
	_, err = run(t, Options{BPFtracePath: fake, Script: "x", Duration: 10 * time.Second})
	require.Error(t, err, "empty run id accepted")
	_, err = run(t, Options{BPFtracePath: "/nonexistent/bpftrace", Script: "x", Duration: time.Second, RunID: "r"})
	require.Error(t, err, "missing binary accepted")
}

func TestBPFEnv(t *testing.T) {
	joined := strings.Join(bpfEnv(), " ")
	for _, want := range []string{"BPFTRACE_MAP_KEYS_MAX=4096", "BPFTRACE_MAX_PROBES=50", "BPFTRACE_STRLEN=64"} {
		require.Contains(t, joined, want)
	}
	require.Equal(t, 60*time.Second, limits.MaxDuration)
	require.Equal(t, 10*time.Second, limits.DefaultDuration)
}
