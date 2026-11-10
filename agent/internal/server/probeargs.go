package server

import (
	"context"
	"os/exec"
	"time"

	"github.com/faizan1250/vBPF/agent/internal/limits"
)

// ProbeArgsTimeout bounds `bpftrace -vl` per the R-03 contract.
const ProbeArgsTimeout = 3 * time.Second

// ProbeArgsMaxBytes caps -vl output at 8 KB.
const ProbeArgsMaxBytes = 8 * 1024

// MaxProbeNameLen caps the probe query parameter.
const MaxProbeNameLen = 256

// ProbeArgsFunc returns `bpftrace -vl` output for one catalog-validated probe.
type ProbeArgsFunc func(ctx context.Context, probe string) (string, error)

// DefaultProbeArgs execs the binary with argv only (no shell).
func DefaultProbeArgs(bpftracePath string) ProbeArgsFunc {
	if bpftracePath == "" {
		bpftracePath = "bpftrace"
	}
	return func(ctx context.Context, probe string) (string, error) {
		cctx, cancel := context.WithTimeout(ctx, ProbeArgsTimeout)
		defer cancel()
		cmd := exec.CommandContext(cctx, bpftracePath, "-vl", probe)
		cmd.Env = limits.ChildEnv(false)
		out, err := cmd.CombinedOutput()
		s := string(out)
		if len(s) > ProbeArgsMaxBytes {
			s = s[:ProbeArgsMaxBytes]
		}
		if err != nil {
			return s, err
		}
		return s, nil
	}
}
