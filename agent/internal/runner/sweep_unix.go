//go:build unix

package runner

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/faizan1250/vBPF/agent/internal/limits"
)

// sweepPattern matches only our own temp-file runs (os.CreateTemp
// "vbpf-*.bt" passed as the bpftrace argv), never foreign bpftrace work.
const sweepPattern = `vbpf-.*\.bt`

var sweepScriptBaseRe = regexp.MustCompile(`^vbpf-[^/]+\.bt$`)

// Seams for hermetic tests.
var (
	sweepLookPath = exec.LookPath
	sweepPgrep    = func(ctx context.Context, path string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, path, "-f", sweepPattern)
		cmd.Env = limits.ChildEnv(false)
		return cmd.Output()
	}
	sweepKill         = func(pid int) error { return killGroup(pid, killSignal()) }
	sweepSelf         = os.Getpid
	sweepSelfPGID     = func() int { return syscall.Getpgrp() }
	sweepExpectedUID  = os.Geteuid
	sweepVerifyTarget = verifySweepTarget
)

type expectedExecutable struct {
	raw       string
	resolved  string
	exactPath bool
}

func evalPathOrDir(p string) string {
	if eval, err := filepath.EvalSymlinks(p); err == nil {
		return eval
	}
	if dirEval, err := filepath.EvalSymlinks(filepath.Dir(p)); err == nil {
		return filepath.Join(dirEval, filepath.Base(p))
	}
	return filepath.Clean(p)
}

func resolveExpectedBPFtrace(bpftracePath string) expectedExecutable {
	if bpftracePath == "" {
		bpftracePath = "bpftrace"
	}
	if !strings.ContainsRune(bpftracePath, filepath.Separator) {
		looked, err := sweepLookPath(bpftracePath)
		if err != nil {
			return expectedExecutable{raw: bpftracePath}
		}
		return expectedExecutable{raw: bpftracePath, resolved: evalPathOrDir(looked), exactPath: true}
	}
	return expectedExecutable{raw: bpftracePath, resolved: evalPathOrDir(bpftracePath), exactPath: true}
}

func exeMatches(rawExe string, exp expectedExecutable) bool {
	if rawExe == "" {
		return false
	}
	stripped, deleted := strings.CutSuffix(rawExe, " (deleted)")
	if stripped == "" {
		return false
	}
	candidate := evalPathOrDir(stripped)
	if !deleted && exp.exactPath {
		if _, err := filepath.EvalSymlinks(stripped); err != nil {
			if _, statErr := os.Stat(exp.resolved); statErr == nil {
				return false
			}
		}
	}
	if exp.exactPath {
		return candidate == exp.resolved
	}
	return filepath.Base(candidate) == exp.raw
}

func allowedSweepTempDirs() []string {
	seen := map[string]struct{}{}
	var dirs []string
	add := func(d string) {
		if d == "" {
			return
		}
		c := filepath.Clean(d)
		if _, ok := seen[c]; !ok {
			seen[c] = struct{}{}
			dirs = append(dirs, c)
		}
		if eval, err := filepath.EvalSymlinks(c); err == nil {
			eval = filepath.Clean(eval)
			if _, ok := seen[eval]; !ok {
				seen[eval] = struct{}{}
				dirs = append(dirs, eval)
			}
		}
	}
	add(os.TempDir())
	add("/tmp")
	return dirs
}

func isSweepScriptArg(arg string) bool {
	if arg == "" || !filepath.IsAbs(arg) {
		return false
	}
	clean := filepath.Clean(arg)
	base := filepath.Base(clean)
	if !sweepScriptBaseRe.MatchString(base) || strings.HasPrefix(base, "vbpf-validate-") {
		return false
	}
	dir := filepath.Dir(clean)
	for _, allowed := range allowedSweepTempDirs() {
		if dir == allowed {
			return true
		}
	}
	return false
}

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

// staleBPFtracePIDs lists candidate leftover PIDs via pgrep. It returns nil
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
// from crashed runs after verifying executable, UID, PGID, cmdline, and
// start time invariants. Call once at agent startup; safe when nothing is stale.
func SweepStale(ctx context.Context, bpftracePath string) (int, error) {
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	pids, err := staleBPFtracePIDs(cctx)
	if err != nil {
		return 0, err
	}
	expExe := resolveExpectedBPFtrace(bpftracePath)
	expectedUID := sweepExpectedUID()
	selfPGID := sweepSelfPGID()
	killed := 0
	for _, pid := range pids {
		confirmKill, ok := sweepVerifyTarget(cctx, pid, expExe, expectedUID, selfPGID)
		if !ok {
			continue
		}
		if confirmKill != nil && !confirmKill() {
			continue
		}
		if err := sweepKill(pid); err == nil {
			killed++
		}
	}
	return killed, nil
}
