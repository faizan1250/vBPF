//go:build unix && !linux

package runner

import (
	"context"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/faizan1250/vBPF/agent/internal/limits"
)

func verifySweepTarget(ctx context.Context, pid int, expExe expectedExecutable, expectedUID, selfPGID int) (func() bool, bool) {
	pidStr := strconv.Itoa(pid)
	meta, err := runPS(ctx, "-p", pidStr, "-o", "uid=,pgid=,comm=")
	if err != nil {
		return nil, false
	}
	fields := strings.Fields(meta)
	if len(fields) < 3 {
		return nil, false
	}
	uid, err := strconv.Atoi(fields[0])
	if err != nil || uid != expectedUID {
		return nil, false
	}
	pgid, err := strconv.Atoi(fields[1])
	if err != nil || pgid != pid || pgid <= 1 || pgid == selfPGID {
		return nil, false
	}
	comm := strings.Join(fields[2:], " ")
	if !psCommMatches(comm, expExe) {
		return nil, false
	}
	argsOut, err := runPS(ctx, "-p", pidStr, "-o", "args=")
	if err != nil {
		return nil, false
	}
	args := strings.Fields(argsOut)
	if len(args) < 2 {
		return nil, false
	}
	hasScript := false
	for _, arg := range args[1:] {
		if isSweepScriptArg(arg) {
			hasScript = true
			break
		}
	}
	if !hasScript {
		return nil, false
	}
	lstart1, err := runPS(ctx, "-p", pidStr, "-o", "lstart=")
	if err != nil || strings.TrimSpace(lstart1) == "" {
		return nil, false
	}
	return func() bool {
		lstart2, err := runPS(ctx, "-p", pidStr, "-o", "lstart=")
		if err != nil {
			return false
		}
		return strings.TrimSpace(lstart2) == strings.TrimSpace(lstart1)
	}, true
}

func psCommMatches(comm string, exp expectedExecutable) bool {
	comm = strings.TrimSpace(comm)
	if comm == "" {
		return false
	}
	if exp.exactPath {
		if filepath.IsAbs(comm) {
			return exeMatches(comm, exp)
		}
		return filepath.Base(comm) == filepath.Base(exp.resolved)
	}
	return filepath.Base(comm) == exp.raw
}

func runPS(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "ps", args...)
	cmd.Env = limits.ChildEnv(false)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
