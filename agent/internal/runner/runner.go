// Package runner executes bpftrace without a shell and enforces limits.
// The child always runs in its own process group so deadline, cancel, or
// crash cleanup kills the whole group, never just the parent.
package runner

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"

	"github.com/faizan1250/vBPF/agent/internal/limits"
	"github.com/faizan1250/vBPF/agent/internal/parser"
)

// Options configures one probe run. Zero values take documented defaults.
type Options struct {
	BPFtracePath   string
	Script         string
	Duration       time.Duration
	RunID          string
	GracePeriod    time.Duration // default limits.KillGrace
	StderrMaxBytes int           // default limits.StderrMaxBytes
	MaxBytesPerRun int64         // default limits.MaxBytesPerRun
}

func (o *Options) withDefaults() {
	if o.BPFtracePath == "" {
		o.BPFtracePath = "bpftrace"
	}
	if o.GracePeriod <= 0 {
		o.GracePeriod = limits.KillGrace
	}
	if o.StderrMaxBytes <= 0 {
		o.StderrMaxBytes = limits.StderrMaxBytes
	}
	if o.MaxBytesPerRun <= 0 {
		o.MaxBytesPerRun = limits.MaxBytesPerRun
	}
}

// Exit reasons reported in the terminal summary event.
const (
	ReasonCompleted = "completed"
	ReasonTimeout   = "timeout"
	ReasonCancelled = "cancelled"
	ReasonLimit     = "limit_bytes"
	ReasonFailed    = "failed"
)

// Run writes the script to a 0600 temp file, execs
// `bpftrace -q -f json <file>` (never through a shell), streams normalized
// events to emit, and enforces deadline and byte caps. Emit is called
// sequentially, never concurrently.
//
// At deadline or cancel it sends SIGINT to the process group (bpftrace prints
// final maps on SIGINT), waits GracePeriod, then SIGKILLs the group.
func Run(ctx context.Context, opts Options, emit func(parser.Event) error) error {
	opts.withDefaults()
	logger := zerolog.Ctx(ctx).With().Str("run_id", opts.RunID).Logger()

	if opts.Script == "" {
		return fmt.Errorf("runner: empty script")
	}
	if opts.RunID == "" {
		return fmt.Errorf("runner: empty run id")
	}
	if err := limits.ValidateDuration(opts.Duration); err != nil {
		return fmt.Errorf("runner: %w", err)
	}

	tmp, err := os.CreateTemp("", "vbpf-*.bt")
	if err != nil {
		return fmt.Errorf("runner: temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() {
		_ = os.Remove(tmpName)
	}()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("runner: chmod temp file: %w", err)
	}
	if _, err := io.WriteString(tmp, opts.Script); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("runner: write temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("runner: close temp file: %w", err)
	}

	// Fixed argv (no shell, no extra flags): the bpftrace unsafe escape
	// hatch can never reach the command line from here.
	cmd := exec.Command(opts.BPFtracePath, "-q", "-f", "json", tmpName)
	cmd.Env = append(os.Environ(), bpfEnv()...)
	cmd.SysProcAttr = sysProcAttr()

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("runner: stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("runner: stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("runner: start bpftrace: %w", err)
	}
	logger.Info().Dur("duration", opts.Duration).Msg("bpftrace started")
	// Group kill on every exit path; harmless if the group is already reaped.
	defer func() {
		_ = killGroup(cmd.Process.Pid, killSignal())
	}()

	var seq atomic.Uint64
	nextSeq := func() uint64 { return seq.Add(1) - 1 }

	if err := emit(parser.Status(opts.RunID, nextSeq(), "running")); err != nil {
		return err
	}

	stderrCh := make(chan []string, 1)
	go func() {
		stderrCh <- readLinesBounded(stderr, opts.StderrMaxBytes)
	}()

	counter := &capReader{r: stdout, max: opts.MaxBytesPerRun}
	type parseOut struct {
		events  uint64
		dropped uint64
		err     error
	}
	parseCh := make(chan parseOut, 1)
	go func() {
		var out parseOut
		// Resequence here so running/data/stderr/summary share one space.
		out.events, out.dropped, out.err = parser.Stream(counter, opts.RunID, func(ev parser.Event) error {
			ev.Seq = nextSeq()
			return emit(ev)
		})
		parseCh <- out
	}()

	start := time.Now()
	timer := time.NewTimer(opts.Duration)
	defer timer.Stop()

	reason := ReasonCompleted
	var runErr error
	var out parseOut

	waitDone := make(chan error, 1)
	go func() { waitDone <- cmd.Wait() }()

	select {
	case out = <-parseCh:
		var werr error
		if counter.hit {
			reason = ReasonLimit
			werr = stopGroup(cmd.Process.Pid, opts.GracePeriod, waitDone)
		} else {
			werr = <-waitDone
		}
		if werr != nil && reason == ReasonCompleted {
			reason = ReasonFailed
			runErr = fmt.Errorf("runner: bpftrace: %w", werr)
		}
	case <-timer.C:
		reason = ReasonTimeout
		stopGroup(cmd.Process.Pid, opts.GracePeriod, waitDone)
		out = <-parseCh
	case <-ctx.Done():
		reason = ReasonCancelled
		stopGroup(cmd.Process.Pid, opts.GracePeriod, waitDone)
		out = <-parseCh
	}
	if out.err != nil && runErr == nil {
		runErr = fmt.Errorf("runner: parse: %w", out.err)
	}

	for _, line := range <-stderrCh {
		if err := emit(parser.Stderr(opts.RunID, nextSeq(), line)); err != nil {
			return err
		}
	}
	if err := emit(parser.Summarize(opts.RunID, nextSeq(), parser.Summary{
		Events:     out.events,
		Bytes:      uint64(counter.n),
		Dropped:    out.dropped,
		DurationMs: time.Since(start).Milliseconds(),
		ExitReason: reason,
	})); err != nil {
		return err
	}
	logger.Info().
		Str("exit_reason", reason).
		Uint64("events", out.events).
		Uint64("bytes", uint64(counter.n)).
		Msg("run finished")
	return runErr
}

// stopGroup sends SIGINT for a graceful bpftrace shutdown, then SIGKILLs
// the group after grace unless the process already exited. It reports how
// the process died; callers must not receive from waitDone again.
func stopGroup(pid int, grace time.Duration, waitDone <-chan error) error {
	_ = signalGroup(pid, interruptSignal())
	select {
	case err := <-waitDone:
		return err
	case <-time.After(grace):
		_ = killGroup(pid, killSignal())
		return <-waitDone
	}
}

func bpfEnv() []string {
	out := make([]string, 0, len(limits.BPFtraceEnv()))
	for k, v := range limits.BPFtraceEnv() {
		out = append(out, k+"="+v)
	}
	return out
}

// capReader counts bytes and returns EOF once max is reached.
type capReader struct {
	r   io.Reader
	n   int64
	max int64
	hit bool
}

func (c *capReader) Read(p []byte) (int, error) {
	if c.n >= c.max {
		c.hit = true
		return 0, io.EOF
	}
	if int64(len(p)) > c.max-c.n {
		p = p[:c.max-c.n]
	}
	n, err := c.r.Read(p)
	c.n += int64(n)
	if c.n >= c.max {
		c.hit = true
	}
	return n, err
}

// readLinesBounded slurps r up to max bytes and splits it into lines.
func readLinesBounded(r io.Reader, max int) []string {
	buf, _ := io.ReadAll(io.LimitReader(r, int64(max)+1))
	if len(buf) > max {
		buf = buf[:max]
	}
	var lines []string
	for _, ln := range bytes.Split(buf, []byte{'\n'}) {
		if len(bytes.TrimSpace(ln)) == 0 {
			continue
		}
		lines = append(lines, string(ln))
	}
	return lines
}
