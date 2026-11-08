//go:build windows

package runner

import (
	"os"
	"syscall"
)

// No process groups on Windows; stop falls back to killing the process.
func sysProcAttr() *syscall.SysProcAttr { return nil }

func interruptSignal() os.Signal { return os.Kill }

func killSignal() os.Signal { return os.Kill }

func signalGroup(pid int, sig os.Signal) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}

func killGroup(pid int, sig os.Signal) error { return signalGroup(pid, sig) }
