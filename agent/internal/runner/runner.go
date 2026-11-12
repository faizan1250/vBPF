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
	"sync"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"

	"github.com/faizan1250/vBPF/agent/internal/limits"
	"github.com/faizan1250/vBPF/agent/internal/parser"
)

// Seams for hermetic lifecycle tests.
var (
	signalGroup = killGroup
	waitCmd     = func(cmd *exec.Cmd) error { return cmd.Wait() }
)

// procGuard ensures a reaped process group is never signaled again (PID reuse).
// mu protects reaped and serializes signalGroup against post-wait updates,
// and is never held across cmd.Wait().
type procGuard struct {
	cmd    *exec.Cmd
	pid    int
	mu     sync.Mutex
	reaped bool
}

func (g *procGuard) wait() error {
	err := waitCmd(g.cmd)
	g.mu.Lock()
	g.reaped = true
	g.mu.Unlock()
	return err
}

func (g *procGuard) signal(sig os.Signal) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.reaped {
		return nil
	}
	return signalGroup(g.pid, sig)
}

// Options configures one probe run. Zero values take documented defaults.
type Options struct {
	BPFtracePath   string
	Script         string
	Duration       time.Duration
	RunID          string
	TempDir        string        // default os.TempDir(); tests pass t.TempDir()
	GracePeriod    time.Duration // default limits.KillGrace
	StderrMaxBytes int           // default limits.StderrMaxBytes
	MaxBytesPerRun int64         // default limits.MaxBytesPerRun
}

func (o *Options) withDefaults() {
	if o.BPFtracePath == "" {
		o.BPFtracePath = "bpftrace"
	}
	if o.TempDir == "" {
		o.TempDir = os.TempDir()
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

	tmp, err := os.CreateTemp(opts.TempDir, "vbpf-*.bt")
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
	cmd.Env = limits.ChildEnv(true)
	cmd.SysProcAttr = sysProcAttr()

	// Own OS pipes directly instead of StdoutPipe/StderrPipe so concurrent
	// cmd.Wait() never closes read ends before readers drain them.
	stdout, stdoutW, err := os.Pipe()
	if err != nil {
		return fmt.Errorf("runner: stdout pipe: %w", err)
	}
	stderr, stderrW, err := os.Pipe()
	if err != nil {
		_ = stdout.Close()
		_ = stdoutW.Close()
		return fmt.Errorf("runner: stderr pipe: %w", err)
	}
	cmd.Stdout = stdoutW
	cmd.Stderr = stderrW
	if err := cmd.Start(); err != nil {
		_ = stdout.Close()
		_ = stdoutW.Close()
		_ = stderr.Close()
		_ = stderrW.Close()
		return fmt.Errorf("runner: start bpftrace: %w", err)
	}
	_ = stdoutW.Close()
	_ = stderrW.Close()
	defer func() {
		_ = stdout.Close()
		_ = stderr.Close()
	}()
	logger.Info().Dur("duration", opts.Duration).Msg("bpftrace started")

	pg := &procGuard{cmd: cmd, pid: cmd.Process.Pid}

	var seq atomic.Uint64
	nextSeq := func() uint64 { return seq.Add(1) - 1 }

	if err := emit(parser.Status(opts.RunID, nextSeq(), "running")); err != nil {
		_ = pg.signal(killSignal())
		_ = pg.wait()
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
	go func() { waitDone <- pg.wait() }()

	select {
	case out = <-parseCh:
		if counter.hit {
			reason = ReasonLimit
			_ = stopGroup(pg, opts.GracePeriod, waitDone)
		} else if out.err != nil {
			reason = ReasonFailed
			_ = stopGroup(pg, opts.GracePeriod, waitDone)
		} else {
			// Child closed stdout; wait for it to exit without killing fast-exiting children.
			select {
			case werr := <-waitDone:
				if werr != nil {
					reason = ReasonFailed
					runErr = fmt.Errorf("runner: bpftrace: %w", werr)
				}
			case <-timer.C:
				reason = ReasonTimeout
				_ = stopGroup(pg, opts.GracePeriod, waitDone)
			case <-ctx.Done():
				reason = ReasonCancelled
				_ = stopGroup(pg, opts.GracePeriod, waitDone)
			}
		}
	case <-timer.C:
		reason = ReasonTimeout
		// We killed the group, so the wait error only says how it died.
		_ = stopGroup(pg, opts.GracePeriod, waitDone)
		out = <-parseCh
	case <-ctx.Done():
		reason = ReasonCancelled
		_ = stopGroup(pg, opts.GracePeriod, waitDone)
		out = <-parseCh
	}
	if out.err != nil && runErr == nil {
		runErr = fmt.Errorf("runner: parse: %w", out.err)
	}

	stderrLines := <-stderrCh
	for _, line := range stderrLines {
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
func stopGroup(pg *procGuard, grace time.Duration, waitDone <-chan error) error {
	select {
	case err := <-waitDone:
		return err
	default:
	}
	_ = pg.signal(interruptSignal())
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case err := <-waitDone:
		return err
	case <-timer.C:
		select {
		case err := <-waitDone:
			return err
		default:
		}
		_ = pg.signal(killSignal())
		return <-waitDone
	}
}

func bpfEnv() []string {
	return limits.BPFtraceEnvSlice()
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
