//go:build unix && !linux

package runner

import (
	"os"
	"syscall"
)

// New process group; no Pdeathsig outside Linux.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

func interruptSignal() os.Signal { return syscall.SIGINT }

func killSignal() os.Signal { return syscall.SIGKILL }

func signalGroup(pid int, sig os.Signal) error {
	s, ok := sig.(syscall.Signal)
	if !ok {
		return syscall.EINVAL
	}
	return syscall.Kill(-pid, s)
}

func killGroup(pid int, sig os.Signal) error { return signalGroup(pid, sig) }
