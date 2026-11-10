//go:build linux

package runner

import (
	"os"
	"syscall"
)

// New process group plus parent-death signal: no orphaned bpftrace.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

func interruptSignal() os.Signal { return syscall.SIGINT }

func killSignal() os.Signal { return syscall.SIGKILL }

func killGroup(pid int, sig os.Signal) error {
	s, ok := sig.(syscall.Signal)
	if !ok {
		return syscall.EINVAL
	}
	return syscall.Kill(-pid, s)
}
