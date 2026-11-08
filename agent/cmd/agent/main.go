// Command agent runs a bpftrace recipe for a bounded duration and streams
// normalized JSON events to stdout, one per line.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/faizan1250/vBPF/agent/internal/limits"
	"github.com/faizan1250/vBPF/agent/internal/parser"
	"github.com/faizan1250/vBPF/agent/internal/runner"
)

func main() {
	os.Exit(realMain(os.Args[1:], os.Stdout, os.Stderr))
}

func realMain(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] != "run" {
		fmt.Fprintln(stderr, "usage: agent run <script.bt> [--duration 10]")
		return 2
	}
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	durationS := fs.Int("duration", 10, "run duration in seconds (1-60)")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fmt.Fprintln(stderr, "usage: agent run <script.bt> [--duration 10]")
		return 2
	}
	duration := time.Duration(*durationS) * time.Second
	if err := limits.ValidateDuration(duration); err != nil {
		fmt.Fprintln(stderr, "agent:", err)
		return 2
	}
	script, err := os.ReadFile(fs.Arg(0))
	if err != nil {
		fmt.Fprintln(stderr, "agent:", err)
		return 1
	}
	if len(script) == 0 {
		fmt.Fprintln(stderr, "agent: empty script")
		return 1
	}

	// BPFTRACE_PATH override exists for tests and demos without bpftrace.
	bin := os.Getenv("BPFTRACE_PATH")
	opts := runner.Options{
		BPFtracePath: bin,
		Script:       string(script),
		Duration:     duration,
		RunID:        fmt.Sprintf("run_%d", time.Now().UnixMilli()),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	enc := json.NewEncoder(stdout)
	if err := runner.Run(ctx, opts, func(ev parser.Event) error { return enc.Encode(ev) }); err != nil {
		fmt.Fprintln(stderr, "agent:", err)
		return 1
	}
	return 0
}
