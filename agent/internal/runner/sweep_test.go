//go:build unix

package runner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseSweepPIDs(t *testing.T) {
	require.Equal(t, []int{5678}, parseSweepPIDs([]byte("1234\n5678\n"), 1234))
	require.Empty(t, parseSweepPIDs([]byte(""), 1))
	require.Empty(t, parseSweepPIDs([]byte("abc\n-3\n0\n"), 1))
}

func withSweepStubs(t *testing.T, pgrepOut string, pgrepErr error, self int, verify func(int) (func() bool, bool)) *[]int {
	t.Helper()
	oldLook, oldPgrep, oldKill, oldSelf := sweepLookPath, sweepPgrep, sweepKill, sweepSelf
	oldSelfPGID, oldUID, oldVerify := sweepSelfPGID, sweepExpectedUID, sweepVerifyTarget
	var killed []int
	sweepLookPath = func(string) (string, error) { return "/bin/pgrep", nil }
	sweepPgrep = func(context.Context, string) ([]byte, error) { return []byte(pgrepOut), pgrepErr }
	sweepKill = func(pid int) error { killed = append(killed, pid); return nil }
	sweepSelf = func() int { return self }
	sweepSelfPGID = func() int { return self }
	sweepExpectedUID = func() int { return 1000 }
	sweepVerifyTarget = func(_ context.Context, pid int, _ expectedExecutable, _, _ int) (func() bool, bool) {
		if verify == nil {
			return nil, true
		}
		return verify(pid)
	}
	t.Cleanup(func() {
		sweepLookPath, sweepPgrep, sweepKill, sweepSelf = oldLook, oldPgrep, oldKill, oldSelf
		sweepSelfPGID, sweepExpectedUID, sweepVerifyTarget = oldSelfPGID, oldUID, oldVerify
	})
	return &killed
}

func TestSweepStaleKillsListed(t *testing.T) {
	killed := withSweepStubs(t, "11 22\n", nil, 99, nil)
	n, err := SweepStale(context.Background(), "bpftrace")
	require.NoError(t, err)
	require.Equal(t, 2, n)
	require.Equal(t, []int{11, 22}, *killed)
}

func TestSweepStaleSkipsSelf(t *testing.T) {
	killed := withSweepStubs(t, "11 22\n", nil, 22, nil)
	n, err := SweepStale(context.Background(), "bpftrace")
	require.NoError(t, err)
	require.Equal(t, 1, n)
	require.Equal(t, []int{11}, *killed)
}

func TestSweepStaleSkipsRejectedAndFailedConfirm(t *testing.T) {
	killed := withSweepStubs(t, "11 22 33\n", nil, 99, func(pid int) (func() bool, bool) {
		switch pid {
		case 11:
			return nil, false
		case 22:
			return func() bool { return false }, true
		case 33:
			return func() bool { return true }, true
		default:
			return nil, false
		}
	})
	n, err := SweepStale(context.Background(), "bpftrace")
	require.NoError(t, err)
	require.Equal(t, 1, n)
	require.Equal(t, []int{33}, *killed)
}

func TestSweepStaleNoPgrep(t *testing.T) {
	old := sweepLookPath
	sweepLookPath = func(string) (string, error) { return "", errors.New("not found") }
	t.Cleanup(func() { sweepLookPath = old })
	n, err := SweepStale(context.Background(), "bpftrace")
	require.NoError(t, err)
	require.Zero(t, n)
}

func TestSweepPgrepScrubsEnv(t *testing.T) {
	dir := t.TempDir()
	fakePgrep := filepath.Join(dir, "pgrep")
	err := os.WriteFile(fakePgrep, []byte("#!/bin/sh\nenv\n"), 0o755)
	require.NoError(t, err)

	t.Setenv("LD_LIBRARY_PATH", "/tmp/evil-lib")
	t.Setenv("LD_PRELOAD", "/tmp/evil-preload.so")
	t.Setenv("UNRELATED_SECRET", "must-not-leak")

	out, err := sweepPgrep(context.Background(), fakePgrep)
	require.NoError(t, err)
	got := string(out)
	require.NotContains(t, got, "LD_LIBRARY_PATH")
	require.NotContains(t, got, "LD_PRELOAD")
	require.NotContains(t, got, "UNRELATED_SECRET")
}

func TestIsSweepScriptArg(t *testing.T) {
	customTmp := t.TempDir()
	t.Setenv("TMPDIR", customTmp)

	require.True(t, isSweepScriptArg("/tmp/vbpf-12345.bt"))
	require.True(t, isSweepScriptArg(filepath.Join(customTmp, "vbpf-abc.bt")))

	require.False(t, isSweepScriptArg(""))
	require.False(t, isSweepScriptArg("vbpf-12345.bt"))
	require.False(t, isSweepScriptArg("/tmp/vbpf-validate-12345.bt"))
	require.False(t, isSweepScriptArg("/tmp/sub/vbpf-12345.bt"))
	require.False(t, isSweepScriptArg("/home/user/vbpf-12345.bt"))
	require.False(t, isSweepScriptArg("/tmp/../etc/vbpf-12345.bt"))
	require.False(t, isSweepScriptArg("/tmp/other.bt"))
	require.False(t, isSweepScriptArg("/tmp/vbpf-12345.bt "))
}

func TestExeMatches(t *testing.T) {
	dir := t.TempDir()
	realBin := filepath.Join(dir, "bpftrace")
	require.NoError(t, os.WriteFile(realBin, []byte("#!/bin/sh\n"), 0o755))
	decoyBin := filepath.Join(dir, "decoy")
	require.NoError(t, os.WriteFile(decoyBin, []byte("#!/bin/sh\n"), 0o755))

	expExact := resolveExpectedBPFtrace(realBin)
	require.True(t, exeMatches(realBin, expExact))
	require.True(t, exeMatches(realBin+" (deleted)", expExact))
	require.False(t, exeMatches(decoyBin, expExact))
	require.False(t, exeMatches(decoyBin+" (deleted)", expExact))
	require.False(t, exeMatches("", expExact))

	expByName := expectedExecutable{raw: "bpftrace"}
	require.True(t, exeMatches("/usr/bin/bpftrace", expByName))
	require.True(t, exeMatches("/usr/bin/bpftrace (deleted)", expByName))
	require.False(t, exeMatches("/usr/bin/vim", expByName))
}
