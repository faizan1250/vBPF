package runner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
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
	// Isolate os.TempDir so the leak glob below sees only this test's files,
	// not other packages' in-flight vbpf-*.bt files during parallel runs.
	isolated := t.TempDir()
	t.Setenv("TMPDIR", isolated)
	t.Setenv("TMP", isolated)
	t.Setenv("TEMP", isolated)
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

func TestRunScrubsChildEnvAndPassesBPFtraceCaps(t *testing.T) {
	dir := t.TempDir()
	envOut := filepath.Join(dir, "env.txt")
	srcPath := filepath.Join(dir, "main.go")
	binPath := filepath.Join(dir, "fake-bpftrace")
	if runtime.GOOS == "windows" {
		binPath += ".exe"
	}
	src := fmt.Sprintf(`package main
import ("os"; "strings")
func main() { _ = os.WriteFile(%q, []byte(strings.Join(os.Environ(), "\n")), 0o600) }
`, envOut)
	require.NoError(t, os.WriteFile(srcPath, []byte(src), 0o600))
	build := exec.Command("go", "build", "-o", binPath, srcPath)
	out, err := build.CombinedOutput()
	require.NoError(t, err, "build helper: %s", out)

	t.Setenv("LD_LIBRARY_PATH", "/tmp/evil-lib")
	t.Setenv("LD_PRELOAD", "/tmp/evil-preload.so")
	t.Setenv("UNRELATED_SECRET", "must-not-leak")

	_, err = run(t, Options{
		BPFtracePath: binPath,
		Script:       "BEGIN { @x = count(); }",
		Duration:     time.Second,
		RunID:        "run_env_check",
	})
	require.NoError(t, err)

	raw, err := os.ReadFile(envOut)
	require.NoError(t, err)
	got := string(raw)
	require.NotContains(t, got, "LD_LIBRARY_PATH")
	require.NotContains(t, got, "LD_PRELOAD")
	require.NotContains(t, got, "UNRELATED_SECRET")
	require.Contains(t, got, "BPFTRACE_MAX_PROBES=50")
	require.Contains(t, got, "BPFTRACE_MAP_KEYS_MAX=4096")
	require.Contains(t, got, "BPFTRACE_STRLEN=64")
}

func TestFastExitCapturesStdoutAndStderr(t *testing.T) {
	dir := t.TempDir()
	srcPath := filepath.Join(dir, "main.go")
	binPath := filepath.Join(dir, "fast-exit")
	if runtime.GOOS == "windows" {
		binPath += ".exe"
	}
	src := `package main

import "os"

func main() {
	_, _ = os.Stdout.WriteString("{\"type\":\"printf\",\"data\":\"hello\\n\"}\n")
	_, _ = os.Stderr.WriteString("fast boom\n")
	os.Exit(3)
}
`
	require.NoError(t, os.WriteFile(srcPath, []byte(src), 0o600))
	build := exec.Command("go", "build", "-o", binPath, srcPath)
	out, err := build.CombinedOutput()
	require.NoError(t, err, "build helper: %s", out)

	var wg sync.WaitGroup
	errs := make(chan error, 4*15)
	for w := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range 15 {
				var events []parser.Event
				err := Run(context.Background(), Options{
					BPFtracePath: binPath,
					Script:       "BEGIN {}",
					Duration:     10 * time.Second,
					RunID:        fmt.Sprintf("run_fast_%d_%d", w, i),
				}, func(ev parser.Event) error {
					events = append(events, ev)
					return nil
				})
				if err == nil {
					errs <- fmt.Errorf("w=%d i=%d: expected error", w, i)
					return
				}
				if len(events) == 0 || events[len(events)-1].Kind != parser.KindSummary {
					errs <- fmt.Errorf("w=%d i=%d: missing summary event: %+v", w, i, events)
					return
				}
				s, ok := events[len(events)-1].Data.(parser.Summary)
				if !ok || s.ExitReason != ReasonFailed || s.Events != 1 {
					errs <- fmt.Errorf("w=%d i=%d: bad summary: %+v", w, i, events[len(events)-1])
					return
				}
				var sawPrintf, sawStderr bool
				for _, ev := range events {
					if ev.Kind == parser.KindPrintf {
						sawPrintf = true
					}
					if ev.Kind == parser.KindStderr {
						if text, ok := ev.Data.(map[string]string)["text"]; ok && strings.Contains(text, "fast boom") {
							sawStderr = true
						}
					}
				}
				if !sawPrintf || !sawStderr {
					errs <- fmt.Errorf("w=%d i=%d: sawPrintf=%v sawStderr=%v events=%+v", w, i, sawPrintf, sawStderr, events)
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
}

func TestStatusEmitErrorStopsChild(t *testing.T) {
	dir := t.TempDir()
	srcPath := filepath.Join(dir, "main.go")
	binPath := filepath.Join(dir, "sleeper")
	if runtime.GOOS == "windows" {
		binPath += ".exe"
	}
	src := `package main

import "time"

func main() {
	time.Sleep(30 * time.Second)
}
`
	require.NoError(t, os.WriteFile(srcPath, []byte(src), 0o600))
	build := exec.Command("go", "build", "-o", binPath, srcPath)
	out, err := build.CombinedOutput()
	require.NoError(t, err, "build helper: %s", out)

	start := time.Now()
	err = Run(context.Background(), Options{
		BPFtracePath: binPath,
		Script:       "BEGIN {}",
		Duration:     10 * time.Second,
		RunID:        "run_emit_err",
	}, func(ev parser.Event) error {
		return errors.New("sink closed")
	})
	require.EqualError(t, err, "sink closed")
	require.Less(t, time.Since(start), 5*time.Second)
}

func buildRunnerTestHelper(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	srcPath := filepath.Join(dir, "main.go")
	binPath := filepath.Join(dir, "runner-helper")
	if runtime.GOOS == "windows" {
		binPath += ".exe"
	}
	src := `package main

import (
	"os"
	"time"
)

func main() {
	switch os.Getenv("FAKE_HELPER_MODE") {
	case "exit0":
		_, _ = os.Stdout.WriteString("{\"type\":\"printf\",\"data\":\"ok\\n\"}\n")
	case "exit3":
		_, _ = os.Stdout.WriteString("{\"type\":\"printf\",\"data\":\"ok\\n\"}\n")
		_, _ = os.Stderr.WriteString("boom\n")
		os.Exit(3)
	case "flood_sleep":
		for range 40 {
			_, _ = os.Stdout.WriteString("{\"type\":\"printf\",\"data\":\"payload-line\\n\"}\n")
		}
		time.Sleep(30 * time.Second)
	case "printf_then_sleep":
		_, _ = os.Stdout.WriteString("{\"type\":\"printf\",\"data\":\"hello\\n\"}\n")
		_, _ = os.Stderr.WriteString("before-sleep stderr\n")
		time.Sleep(30 * time.Second)
	case "close_stdout_sleep":
		_, _ = os.Stdout.WriteString("{\"type\":\"printf\",\"data\":\"early\\n\"}\n")
		_, _ = os.Stderr.WriteString("still-alive stderr\n")
		_ = os.Stdout.Close()
		time.Sleep(30 * time.Second)
	default:
		time.Sleep(30 * time.Second)
	}
}
`
	require.NoError(t, os.WriteFile(srcPath, []byte(src), 0o600))
	build := exec.Command("go", "build", "-o", binPath, srcPath)
	out, err := build.CombinedOutput()
	require.NoError(t, err, "build helper: %s", out)
	return binPath
}

func TestSignalNotCalledAfterWait(t *testing.T) {
	binPath := buildRunnerTestHelper(t)

	origSignal := signalGroup
	origWait := waitCmd
	var waited atomic.Bool
	var totalSignals atomic.Int32
	var postReapSignals atomic.Int32

	signalGroup = func(pid int, sig os.Signal) error {
		totalSignals.Add(1)
		if waited.Load() {
			postReapSignals.Add(1)
		}
		return origSignal(pid, sig)
	}
	waitCmd = func(cmd *exec.Cmd) error {
		err := origWait(cmd)
		waited.Store(true)
		return err
	}
	t.Cleanup(func() {
		signalGroup = origSignal
		waitCmd = origWait
	})

	reset := func() {
		waited.Store(false)
		totalSignals.Store(0)
		postReapSignals.Store(0)
	}

	t.Run(ReasonCompleted, func(t *testing.T) {
		reset()
		t.Setenv("FAKE_HELPER_MODE", "exit0")
		events, err := run(t, Options{BPFtracePath: binPath, Script: "BEGIN {}", Duration: 5 * time.Second, RunID: "sig_completed"})
		require.NoError(t, err)
		require.Equal(t, ReasonCompleted, summaryOf(t, events).ExitReason)
		require.Zero(t, totalSignals.Load())
		require.Zero(t, postReapSignals.Load())
	})

	t.Run(ReasonFailed, func(t *testing.T) {
		reset()
		t.Setenv("FAKE_HELPER_MODE", "exit3")
		events, err := run(t, Options{BPFtracePath: binPath, Script: "BEGIN {}", Duration: 5 * time.Second, RunID: "sig_failed"})
		require.Error(t, err)
		require.Equal(t, ReasonFailed, summaryOf(t, events).ExitReason)
		require.Zero(t, totalSignals.Load())
		require.Zero(t, postReapSignals.Load())
	})

	t.Run(ReasonTimeout, func(t *testing.T) {
		reset()
		t.Setenv("FAKE_HELPER_MODE", "sleep")
		events, err := run(t, Options{BPFtracePath: binPath, Script: "BEGIN {}", Duration: time.Second, GracePeriod: 200 * time.Millisecond, RunID: "sig_timeout"})
		require.NoError(t, err)
		require.Equal(t, ReasonTimeout, summaryOf(t, events).ExitReason)
		require.Positive(t, totalSignals.Load())
		require.Zero(t, postReapSignals.Load())
	})

	t.Run(ReasonCancelled, func(t *testing.T) {
		reset()
		t.Setenv("FAKE_HELPER_MODE", "sleep")
		ctx, cancel := context.WithCancel(context.Background())
		go func() {
			time.Sleep(150 * time.Millisecond)
			cancel()
		}()
		var events []parser.Event
		err := Run(ctx, Options{BPFtracePath: binPath, Script: "BEGIN {}", Duration: 10 * time.Second, GracePeriod: 200 * time.Millisecond, RunID: "sig_cancel"}, func(ev parser.Event) error {
			events = append(events, ev)
			return nil
		})
		require.NoError(t, err)
		require.Equal(t, ReasonCancelled, summaryOf(t, events).ExitReason)
		require.Positive(t, totalSignals.Load())
		require.Zero(t, postReapSignals.Load())
	})

	t.Run(ReasonLimit, func(t *testing.T) {
		reset()
		t.Setenv("FAKE_HELPER_MODE", "flood_sleep")
		events, err := run(t, Options{BPFtracePath: binPath, Script: "BEGIN {}", Duration: 10 * time.Second, GracePeriod: 200 * time.Millisecond, MaxBytesPerRun: 512, RunID: "sig_limit"})
		require.NoError(t, err)
		require.Equal(t, ReasonLimit, summaryOf(t, events).ExitReason)
		require.Positive(t, totalSignals.Load())
		require.Zero(t, postReapSignals.Load())
	})

	t.Run("status_emit_error", func(t *testing.T) {
		reset()
		t.Setenv("FAKE_HELPER_MODE", "sleep")
		err := Run(context.Background(), Options{BPFtracePath: binPath, Script: "BEGIN {}", Duration: 10 * time.Second, RunID: "sig_status_err"}, func(parser.Event) error {
			return errors.New("status sink closed")
		})
		require.EqualError(t, err, "status sink closed")
		require.Equal(t, int32(1), totalSignals.Load())
		require.Zero(t, postReapSignals.Load())
	})

	t.Run("data_emit_error", func(t *testing.T) {
		reset()
		t.Setenv("FAKE_HELPER_MODE", "printf_then_sleep")
		sinkErr := errors.New("data sink closed")
		err := Run(context.Background(), Options{BPFtracePath: binPath, Script: "BEGIN {}", Duration: 10 * time.Second, GracePeriod: 200 * time.Millisecond, RunID: "sig_data_err"}, func(ev parser.Event) error {
			if ev.Kind == parser.KindPrintf {
				return sinkErr
			}
			return nil
		})
		require.ErrorIs(t, err, sinkErr)
		require.Positive(t, totalSignals.Load())
		require.Zero(t, postReapSignals.Load())
	})
}

func TestStopGroupSkipsSignalWhenReaped(t *testing.T) {
	origSignal := signalGroup
	var calls atomic.Int32
	signalGroup = func(int, os.Signal) error {
		calls.Add(1)
		return nil
	}
	t.Cleanup(func() { signalGroup = origSignal })

	pg := &procGuard{pid: 99999, reaped: true}
	waitDone := make(chan error, 1)
	waitDone <- nil
	require.NoError(t, stopGroup(pg, 50*time.Millisecond, waitDone))
	require.NoError(t, pg.signal(killSignal()))
	require.Zero(t, calls.Load())
}

func TestDataEmitErrorStopsChildAndPreservesError(t *testing.T) {
	binPath := buildRunnerTestHelper(t)
	t.Setenv("FAKE_HELPER_MODE", "printf_then_sleep")

	sinkErr := errors.New("sink closed")
	var events []parser.Event
	var mu sync.Mutex
	start := time.Now()
	err := Run(context.Background(), Options{
		BPFtracePath: binPath,
		Script:       "BEGIN {}",
		Duration:     10 * time.Second,
		GracePeriod:  200 * time.Millisecond,
		RunID:        "run_data_emit_err",
	}, func(ev parser.Event) error {
		if ev.Kind == parser.KindPrintf {
			return sinkErr
		}
		mu.Lock()
		events = append(events, ev)
		mu.Unlock()
		return nil
	})
	require.Less(t, time.Since(start), 3*time.Second)
	require.ErrorIs(t, err, sinkErr)
	require.NotContains(t, err.Error(), "signal: killed")
	require.Equal(t, ReasonFailed, summaryOf(t, events).ExitReason)

	var sawStderr bool
	for _, ev := range events {
		if ev.Kind == parser.KindStderr {
			if text, ok := ev.Data.(map[string]string)["text"]; ok && strings.Contains(text, "before-sleep stderr") {
				sawStderr = true
			}
		}
	}
	require.True(t, sawStderr, "stderr should still be drained")
}

func TestEarlyStdoutCloseHonorsTimeoutAndCancel(t *testing.T) {
	binPath := buildRunnerTestHelper(t)
	t.Setenv("FAKE_HELPER_MODE", "close_stdout_sleep")

	t.Run("timeout", func(t *testing.T) {
		start := time.Now()
		events, err := run(t, Options{
			BPFtracePath: binPath,
			Script:       "BEGIN {}",
			Duration:     time.Second,
			GracePeriod:  200 * time.Millisecond,
			RunID:        "run_early_stdout_timeout",
		})
		require.NoError(t, err)
		require.Less(t, time.Since(start), 5*time.Second)
		s := summaryOf(t, events)
		require.Equal(t, ReasonTimeout, s.ExitReason)
		require.Equal(t, uint64(1), s.Events)

		var sawStderr bool
		for _, ev := range events {
			if ev.Kind == parser.KindStderr {
				if text, ok := ev.Data.(map[string]string)["text"]; ok && strings.Contains(text, "still-alive stderr") {
					sawStderr = true
				}
			}
		}
		require.True(t, sawStderr, "stderr should still be drained")
	})

	t.Run("cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		go func() {
			time.Sleep(150 * time.Millisecond)
			cancel()
		}()
		start := time.Now()
		var events []parser.Event
		err := Run(ctx, Options{
			BPFtracePath: binPath,
			Script:       "BEGIN {}",
			Duration:     10 * time.Second,
			GracePeriod:  200 * time.Millisecond,
			RunID:        "run_early_stdout_cancel",
		}, func(ev parser.Event) error {
			events = append(events, ev)
			return nil
		})
		require.NoError(t, err)
		require.Less(t, time.Since(start), 3*time.Second)
		s := summaryOf(t, events)
		require.Equal(t, ReasonCancelled, s.ExitReason)
		require.Equal(t, uint64(1), s.Events)

		var sawStderr bool
		for _, ev := range events {
			if ev.Kind == parser.KindStderr {
				if text, ok := ev.Data.(map[string]string)["text"]; ok && strings.Contains(text, "still-alive stderr") {
					sawStderr = true
				}
			}
		}
		require.True(t, sawStderr, "stderr should still be drained")
	})
}
