// Command agent runs a bpftrace recipe for a bounded duration and streams
// normalized JSON events to stdout, one per line.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
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
		efprintf(stderr, "usage: agent run <script.bt> [--duration 10]")
		return 2
	}
	// Hand-rolled flag parsing so --duration works before or after the file.
	durationS := 10
	var positional []string
	rest := args[1:]
	for i := 0; i < len(rest); i++ {
		a := rest[i]
		switch {
		case a == "--duration" && i+1 < len(rest):
			i++
			n, err := strconv.Atoi(rest[i])
			if err != nil {
				efprintf(stderr, "agent: bad --duration:", rest[i])
				return 2
			}
			durationS = n
		case strings.HasPrefix(a, "--duration="):
			n, err := strconv.Atoi(strings.TrimPrefix(a, "--duration="))
			if err != nil {
				efprintf(stderr, "agent: bad --duration:", a)
				return 2
			}
			durationS = n
		case a == "--" && i+1 < len(rest):
			positional = append(positional, rest[i+1:]...)
			i = len(rest)
		case strings.HasPrefix(a, "--"):
			efprintf(stderr, "agent: unknown flag:", a)
			return 2
		default:
			positional = append(positional, a)
		}
	}
	if len(positional) != 1 {
		efprintf(stderr, "usage: agent run <script.bt> [--duration 10]")
		return 2
	}
	duration := time.Duration(durationS) * time.Second
	if err := limits.ValidateDuration(duration); err != nil {
		efprintf(stderr, "agent:", err)
		return 2
	}
	script, err := os.ReadFile(positional[0])
	if err != nil {
		efprintf(stderr, "agent:", err)
		return 1
	}
	if len(script) == 0 {
		efprintf(stderr, "agent: empty script")
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
		efprintf(stderr, "agent:", err)
		return 1
	}
	return 0
}

// efprintf reports CLI failures; a broken stderr is unrecoverable by definition.
func efprintf(w io.Writer, args ...any) {
	_, _ = fmt.Fprintln(w, args...)
}
