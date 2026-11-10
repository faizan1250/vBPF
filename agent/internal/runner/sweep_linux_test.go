//go:build linux

package runner

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func buildSleeperNamed(t *testing.T, dir, name string) string {
	t.Helper()
	srcPath := filepath.Join(dir, name+".go")
	binPath := filepath.Join(dir, name)
	src := `package main

import "time"

func main() {
	time.Sleep(30 * time.Second)
}
`
	require.NoError(t, os.WriteFile(srcPath, []byte(src), 0o600))
	out, err := exec.Command("go", "build", "-o", binPath, srcPath).CombinedOutput()
	require.NoError(t, err, "build helper %s: %s", name, out)
	return binPath
}

func waitPgrepFindsPID(t *testing.T, pid int) {
	t.Helper()
	pgrepPath, err := exec.LookPath("pgrep")
	if err != nil {
		t.Skip("pgrep not installed")
	}
	want := strconv.Itoa(pid)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		out, _ := exec.Command(pgrepPath, "-f", sweepPattern).Output()
		for _, f := range strings.Fields(string(out)) {
			if f == want {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("pid %d never appeared in pgrep", pid)
}

func createTempScript(t *testing.T, pattern string) string {
	t.Helper()
	f, err := os.CreateTemp("", pattern)
	require.NoError(t, err)
	name := f.Name()
	require.NoError(t, f.Close())
	t.Cleanup(func() { _ = os.Remove(name) })
	return name
}

func TestSweepStaleRealDecoyAndGenuineProcesses(t *testing.T) {
	if _, err := exec.LookPath("pgrep"); err != nil {
		t.Skip("pgrep not installed")
	}

	dir := t.TempDir()
	decoyBin := buildSleeperNamed(t, dir, "decoy")
	genuineBin := buildSleeperNamed(t, dir, "bpftrace")

	decoyScript := createTempScript(t, "vbpf-decoy-*.bt")
	genuineScript := createTempScript(t, "vbpf-orphan-*.bt")

	decoyCmd := exec.Command(decoyBin, "-q", "-f", "json", decoyScript)
	decoyCmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	require.NoError(t, decoyCmd.Start())
	t.Cleanup(func() {
		if decoyCmd.Process != nil {
			_ = syscall.Kill(-decoyCmd.Process.Pid, syscall.SIGKILL)
		}
		_ = decoyCmd.Wait()
	})

	genuineCmd := exec.Command(genuineBin, "-q", "-f", "json", genuineScript)
	genuineCmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	require.NoError(t, genuineCmd.Start())
	t.Cleanup(func() {
		if genuineCmd.Process != nil {
			_ = syscall.Kill(-genuineCmd.Process.Pid, syscall.SIGKILL)
		}
		_ = genuineCmd.Wait()
	})

	waitPgrepFindsPID(t, decoyCmd.Process.Pid)
	waitPgrepFindsPID(t, genuineCmd.Process.Pid)

	n, err := SweepStale(context.Background(), genuineBin)
	require.NoError(t, err)
	require.Equal(t, 1, n)

	// Genuine target must exit via SIGKILL; decoy must remain alive.
	waitDone := make(chan error, 1)
	go func() { waitDone <- genuineCmd.Wait() }()
	select {
	case werr := <-waitDone:
		require.Error(t, werr)
	case <-time.After(3 * time.Second):
		t.Fatal("genuine target was not killed by SweepStale")
	}

	require.NoError(t, syscall.Kill(decoyCmd.Process.Pid, 0), "non-bpftrace decoy must not be killed")
}

type fakeProcOpts struct {
	ruid      int
	euid      int
	comm      string
	pgid      int
	startTime string
	exeTarget string
	args      []string
}

func writeFakeProcEntry(t *testing.T, procRoot string, pid int, opts fakeProcOpts) {
	t.Helper()
	pidDir := filepath.Join(procRoot, strconv.Itoa(pid))
	require.NoError(t, os.MkdirAll(pidDir, 0o755))

	status := fmt.Sprintf("Name:\t%s\nUid:\t%d\t%d\t%d\t%d\n", opts.comm, opts.ruid, opts.euid, opts.ruid, opts.ruid)
	require.NoError(t, os.WriteFile(filepath.Join(pidDir, "status"), []byte(status), 0o600))

	stat := fmt.Sprintf("%d (%s) S 1 %d %d 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 %s 1000 100\n",
		pid, opts.comm, opts.pgid, opts.pgid, opts.startTime)
	require.NoError(t, os.WriteFile(filepath.Join(pidDir, "stat"), []byte(stat), 0o600))

	exeLink := filepath.Join(pidDir, "exe")
	_ = os.Remove(exeLink)
	require.NoError(t, os.Symlink(opts.exeTarget, exeLink))

	var cmdline []byte
	for _, a := range opts.args {
		cmdline = append(cmdline, []byte(a)...)
		cmdline = append(cmdline, 0)
	}
	require.NoError(t, os.WriteFile(filepath.Join(pidDir, "cmdline"), cmdline, 0o600))
}

func TestSweepStaleProcInvariants(t *testing.T) {
	binDir := t.TempDir()
	bpfBin := filepath.Join(binDir, "bpftrace")
	require.NoError(t, os.WriteFile(bpfBin, []byte("#!/bin/sh\n"), 0o755))
	vimBin := filepath.Join(binDir, "vim")
	require.NoError(t, os.WriteFile(vimBin, []byte("#!/bin/sh\n"), 0o755))

	setup := func(t *testing.T, pid int, opts fakeProcOpts, beforeKill func(procRoot string)) *[]int {
		t.Helper()
		procRoot := t.TempDir()
		writeFakeProcEntry(t, procRoot, pid, opts)

		oldProc, oldBefore := sweepProcRoot, sweepBeforeKill
		oldLook, oldPgrep, oldKill := sweepLookPath, sweepPgrep, sweepKill
		oldSelf, oldSelfPGID, oldUID := sweepSelf, sweepSelfPGID, sweepExpectedUID

		var killed []int
		sweepProcRoot = procRoot
		sweepLookPath = func(string) (string, error) { return "/bin/pgrep", nil }
		sweepPgrep = func(context.Context, string) ([]byte, error) {
			return []byte(strconv.Itoa(pid) + "\n"), nil
		}
		sweepKill = func(p int) error {
			killed = append(killed, p)
			return nil
		}
		sweepSelf = func() int { return 99999 }
		sweepSelfPGID = func() int { return 88888 }
		sweepExpectedUID = func() int { return 1000 }
		sweepBeforeKill = func() {
			if beforeKill != nil {
				beforeKill(procRoot)
			}
		}

		t.Cleanup(func() {
			sweepProcRoot, sweepBeforeKill = oldProc, oldBefore
			sweepLookPath, sweepPgrep, sweepKill = oldLook, oldPgrep, oldKill
			sweepSelf, sweepSelfPGID, sweepExpectedUID = oldSelf, oldSelfPGID, oldUID
		})
		return &killed
	}

	baseOpts := func(pid int) fakeProcOpts {
		return fakeProcOpts{
			ruid:      1000,
			euid:      1000,
			comm:      "bpftrace",
			pgid:      pid,
			startTime: "123456",
			exeTarget: bpfBin,
			args:      []string{"bpftrace", "-q", "-f", "json", "/tmp/vbpf-orphan-1.bt"},
		}
	}

	t.Run("genuine_target_killed", func(t *testing.T) {
		killed := setup(t, 4242, baseOpts(4242), nil)
		n, err := SweepStale(context.Background(), bpfBin)
		require.NoError(t, err)
		require.Equal(t, 1, n)
		require.Equal(t, []int{4242}, *killed)
	})

	t.Run("comm_with_spaces_and_parens_parsed", func(t *testing.T) {
		opts := baseOpts(4242)
		opts.comm = "bpf (trace) v2"
		killed := setup(t, 4242, opts, nil)
		n, err := SweepStale(context.Background(), bpfBin)
		require.NoError(t, err)
		require.Equal(t, 1, n)
		require.Equal(t, []int{4242}, *killed)
	})

	t.Run("uid_mismatch_skipped", func(t *testing.T) {
		opts := baseOpts(4242)
		opts.ruid = 1001
		opts.euid = 1001
		killed := setup(t, 4242, opts, nil)
		n, err := SweepStale(context.Background(), bpfBin)
		require.NoError(t, err)
		require.Zero(t, n)
		require.Empty(t, *killed)
	})

	t.Run("euid_mismatch_skipped", func(t *testing.T) {
		opts := baseOpts(4242)
		opts.euid = 0
		killed := setup(t, 4242, opts, nil)
		n, err := SweepStale(context.Background(), bpfBin)
		require.NoError(t, err)
		require.Zero(t, n)
		require.Empty(t, *killed)
	})

	t.Run("pgid_not_leader_skipped", func(t *testing.T) {
		opts := baseOpts(4242)
		opts.pgid = 500
		killed := setup(t, 4242, opts, nil)
		n, err := SweepStale(context.Background(), bpfBin)
		require.NoError(t, err)
		require.Zero(t, n)
		require.Empty(t, *killed)
	})

	t.Run("pgid_one_skipped", func(t *testing.T) {
		opts := baseOpts(1)
		killed := setup(t, 1, opts, nil)
		n, err := SweepStale(context.Background(), bpfBin)
		require.NoError(t, err)
		require.Zero(t, n)
		require.Empty(t, *killed)
	})

	t.Run("self_pgid_skipped", func(t *testing.T) {
		opts := baseOpts(88888)
		killed := setup(t, 88888, opts, nil)
		n, err := SweepStale(context.Background(), bpfBin)
		require.NoError(t, err)
		require.Zero(t, n)
		require.Empty(t, *killed)
	})

	t.Run("missing_vbpf_argv_skipped", func(t *testing.T) {
		opts := baseOpts(4242)
		opts.args = []string{"bpftrace", "-q", "-f", "json", "/tmp/other.bt"}
		killed := setup(t, 4242, opts, nil)
		n, err := SweepStale(context.Background(), bpfBin)
		require.NoError(t, err)
		require.Zero(t, n)
		require.Empty(t, *killed)
	})

	t.Run("argv0_only_vbpf_skipped", func(t *testing.T) {
		opts := baseOpts(4242)
		opts.args = []string{"/tmp/vbpf-spoof.bt", "-q"}
		killed := setup(t, 4242, opts, nil)
		n, err := SweepStale(context.Background(), bpfBin)
		require.NoError(t, err)
		require.Zero(t, n)
		require.Empty(t, *killed)
	})

	t.Run("vbpf_validate_argv_skipped", func(t *testing.T) {
		opts := baseOpts(4242)
		opts.args = []string{"bpftrace", "--dry-run", "/tmp/vbpf-validate-123.bt"}
		killed := setup(t, 4242, opts, nil)
		n, err := SweepStale(context.Background(), bpfBin)
		require.NoError(t, err)
		require.Zero(t, n)
		require.Empty(t, *killed)
	})

	t.Run("wrong_dir_vbpf_argv_skipped", func(t *testing.T) {
		opts := baseOpts(4242)
		opts.args = []string{"bpftrace", "/home/user/vbpf-123.bt"}
		killed := setup(t, 4242, opts, nil)
		n, err := SweepStale(context.Background(), bpfBin)
		require.NoError(t, err)
		require.Zero(t, n)
		require.Empty(t, *killed)
	})

	t.Run("non_bpftrace_exe_skipped", func(t *testing.T) {
		opts := baseOpts(4242)
		opts.exeTarget = vimBin
		opts.args = []string{"vim", "/tmp/vbpf-orphan-1.bt"}
		killed := setup(t, 4242, opts, nil)
		n, err := SweepStale(context.Background(), bpfBin)
		require.NoError(t, err)
		require.Zero(t, n)
		require.Empty(t, *killed)
	})

	t.Run("deleted_exe_handled", func(t *testing.T) {
		opts := baseOpts(4242)
		opts.exeTarget = bpfBin + " (deleted)"
		killed := setup(t, 4242, opts, nil)
		n, err := SweepStale(context.Background(), bpfBin)
		require.NoError(t, err)
		require.Equal(t, 1, n)
		require.Equal(t, []int{4242}, *killed)
	})

	t.Run("deleted_other_exe_skipped", func(t *testing.T) {
		opts := baseOpts(4242)
		opts.exeTarget = vimBin + " (deleted)"
		killed := setup(t, 4242, opts, nil)
		n, err := SweepStale(context.Background(), bpfBin)
		require.NoError(t, err)
		require.Zero(t, n)
		require.Empty(t, *killed)
	})

	t.Run("pid_reuse_changed_starttime_skipped", func(t *testing.T) {
		opts := baseOpts(4242)
		killed := setup(t, 4242, opts, func(procRoot string) {
			reused := opts
			reused.startTime = "999999"
			writeFakeProcEntry(t, procRoot, 4242, reused)
		})
		n, err := SweepStale(context.Background(), bpfBin)
		require.NoError(t, err)
		require.Zero(t, n)
		require.Empty(t, *killed)
	})

	t.Run("real_proc_stat_matches_self", func(t *testing.T) {
		pgid, startTime, ok := readProcStat("/proc/self")
		require.True(t, ok)
		require.Equal(t, syscall.Getpgrp(), pgid)
		require.NotEmpty(t, startTime)
	})
}
