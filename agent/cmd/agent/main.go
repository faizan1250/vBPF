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

	"github.com/rs/zerolog"

	"github.com/faizan1250/vBPF/agent/internal/limits"
	"github.com/faizan1250/vBPF/agent/internal/parser"
	"github.com/faizan1250/vBPF/agent/internal/priv"
	"github.com/faizan1250/vBPF/agent/internal/runner"
	"github.com/faizan1250/vBPF/agent/internal/server"
)

func main() {
	os.Exit(realMain(os.Args[1:], os.Stdout, os.Stderr))
}

func realMain(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		efprintf(stderr, "usage: agent <run|serve> ...")
		return 2
	}
	if args[0] == "serve" {
		return realServe(args[1:], stdout, stderr)
	}
	if args[0] != "run" {
		efprintf(stderr, "usage: agent <run|serve> ...")
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

// realServe starts the HTTP and WebSocket front end on loopback only.
func realServe(args []string, _, stderr io.Writer) int {
	addr := "127.0.0.1:8787"
	tokenFile := ""
	allowedOrigins := server.AllowedOriginsFromEnv()
	bin := os.Getenv("BPFTRACE_PATH")
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--addr" && i+1 < len(args):
			i++
			addr = args[i]
		case strings.HasPrefix(a, "--addr="):
			addr = strings.TrimPrefix(a, "--addr=")
		case a == "--allowed-origins" && i+1 < len(args):
			i++
			allowedOrigins = server.SplitOrigins(args[i])
		case strings.HasPrefix(a, "--allowed-origins="):
			allowedOrigins = server.SplitOrigins(strings.TrimPrefix(a, "--allowed-origins="))
		case a == "--token-file" && i+1 < len(args):
			i++
			tokenFile = args[i]
		case strings.HasPrefix(a, "--token-file="):
			tokenFile = strings.TrimPrefix(a, "--token-file=")
		case a == "--bpftrace" && i+1 < len(args):
			i++
			bin = args[i]
		case strings.HasPrefix(a, "--bpftrace="):
			bin = strings.TrimPrefix(a, "--bpftrace=")
		default:
			efprintf(stderr, "usage: agent serve [--addr 127.0.0.1:8787] [--token-file run/agent.token] [--allowed-origins https://app.example]")
			return 2
		}
	}
	log := zerolog.New(os.Stderr).With().Timestamp().Logger()
	// Drop to the tracing retain set before binding or spawning bpftrace;
	// best-effort (logs and continues) so unprivileged dev runs keep working.
	priv.Harden(priv.DefaultOps(), log)
	sweepCtx, sweepCancel := context.WithTimeout(context.Background(), 5*time.Second)
	swept, err := runner.SweepStale(sweepCtx, bin)
	sweepCancel()
	if err != nil {
		log.Warn().Err(err).Msg("stale sweep failed")
	} else if swept > 0 {
		log.Info().Int("pids", swept).Msg("swept stale bpftrace children")
	}
	srv, err := server.New(server.Config{
		Addr:           addr,
		TokenFile:      tokenFile,
		AllowedOrigins: allowedOrigins,
		BPFtracePath:   bin,
		Logger:         log,
		StartTime:      time.Now(),
	})
	if err != nil {
		efprintf(stderr, "agent:", err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := srv.ListenAndServe(ctx); err != nil {
		efprintf(stderr, "agent:", err)
		return 1
	}
	return 0
}

// efprintf reports CLI failures; a broken stderr is unrecoverable by definition.
func efprintf(w io.Writer, args ...any) {
	_, _ = fmt.Fprintln(w, args...)
}
