//go:build unix

package runner

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// sweepPattern matches only our own temp-file runs (os.CreateTemp
// "vbpf-*.bt" passed as the bpftrace argv), never foreign bpftrace work.
const sweepPattern = `vbpf-.*\.bt`

// Seams for hermetic tests.
var (
	sweepLookPath = exec.LookPath
	sweepPgrep    = func(ctx context.Context, path string) ([]byte, error) {
		return exec.CommandContext(ctx, path, "-f", sweepPattern).Output()
	}
	sweepKill = func(pid int) error { return killGroup(pid, killSignal()) }
	sweepSelf = os.Getpid
)

// parseSweepPIDs extracts PIDs from pgrep output, excluding our own.
func parseSweepPIDs(out []byte, self int) []int {
	var pids []int
	for _, f := range strings.Fields(string(out)) {
		pid, err := strconv.Atoi(f)
		if err != nil || pid <= 0 || pid == self {
			continue
		}
		pids = append(pids, pid)
	}
	return pids
}

// staleBPFtracePIDs lists leftover run children via pgrep. It returns nil
// without error when pgrep is missing (non-Linux dev boxes) or matches
// nothing (pgrep exits 1 on no match).
func staleBPFtracePIDs(ctx context.Context) ([]int, error) {
	path, err := sweepLookPath("pgrep")
	if err != nil {
		return nil, nil
	}
	out, err := sweepPgrep(ctx, path)
	if err != nil {
		if _, ok := err.(*exec.ExitError); ok {
			return nil, nil
		}
		return nil, err
	}
	return parseSweepPIDs(bytes.TrimSpace(out), sweepSelf()), nil
}

// SweepStale kills leftover own-run bpftrace process groups (vbpf-*.bt)
// from crashed runs. Call once at agent startup; safe when nothing is stale.
func SweepStale(ctx context.Context) (int, error) {
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	pids, err := staleBPFtracePIDs(cctx)
	if err != nil {
		return 0, err
	}
	killed := 0
	for _, pid := range pids {
		if err := sweepKill(pid); err == nil {
			killed++
		}
	}
	return killed, nil
}
