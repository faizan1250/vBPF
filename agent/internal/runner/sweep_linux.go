//go:build linux

package runner

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Seams for hermetic Linux /proc inspection tests.
var (
	sweepProcRoot   = "/proc"
	sweepReadlink   = os.Readlink
	sweepBeforeKill = func() {}
)

func verifySweepTarget(_ context.Context, pid int, expExe expectedExecutable, expectedUID, selfPGID int) (func() bool, bool) {
	pidDir := filepath.Join(sweepProcRoot, strconv.Itoa(pid))

	ruid, euid, ok := readProcUIDs(pidDir)
	if !ok || ruid != expectedUID || euid != expectedUID {
		return nil, false
	}

	pgid, startTime, ok := readProcStat(pidDir)
	if !ok || pgid != pid || pgid <= 1 || pgid == selfPGID {
		return nil, false
	}

	rawExe, err := sweepReadlink(filepath.Join(pidDir, "exe"))
	if err != nil || !exeMatches(rawExe, expExe) {
		return nil, false
	}

	args, ok := readProcCmdline(pidDir)
	if !ok || len(args) < 2 {
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

	return func() bool {
		sweepBeforeKill()
		pgid2, startTime2, ok := readProcStat(pidDir)
		return ok && pgid2 == pgid && startTime2 == startTime
	}, true
}

func readProcUIDs(pidDir string) (ruid, euid int, ok bool) {
	raw, err := os.ReadFile(filepath.Join(pidDir, "status"))
	if err != nil {
		return 0, 0, false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, "Uid:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 3 {
			return 0, 0, false
		}
		r, err1 := strconv.Atoi(fields[1])
		e, err2 := strconv.Atoi(fields[2])
		if err1 != nil || err2 != nil {
			return 0, 0, false
		}
		return r, e, true
	}
	return 0, 0, false
}

func readProcStat(pidDir string) (pgid int, startTime string, ok bool) {
	raw, err := os.ReadFile(filepath.Join(pidDir, "stat"))
	if err != nil {
		return 0, "", false
	}
	// comm (field 2) can contain spaces and ')'; split after the last ')'.
	idx := bytes.LastIndexByte(raw, ')')
	if idx < 0 {
		return 0, "", false
	}
	fields := strings.Fields(string(raw[idx+1:]))
	if len(fields) <= 19 {
		return 0, "", false
	}
	pgrp, err := strconv.Atoi(fields[2])
	if err != nil {
		return 0, "", false
	}
	if _, err := strconv.ParseUint(fields[19], 10, 64); err != nil {
		return 0, "", false
	}
	return pgrp, fields[19], true
}

func readProcCmdline(pidDir string) ([]string, bool) {
	raw, err := os.ReadFile(filepath.Join(pidDir, "cmdline"))
	if err != nil || len(raw) == 0 {
		return nil, false
	}
	raw = bytes.TrimSuffix(raw, []byte{0})
	if len(raw) == 0 {
		return nil, false
	}
	parts := bytes.Split(raw, []byte{0})
	args := make([]string, len(parts))
	for i, p := range parts {
		args[i] = string(p)
	}
	return args, true
}
