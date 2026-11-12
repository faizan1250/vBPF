//go:build linux

package priv

import (
	"os"
	"unsafe"

	"golang.org/x/sys/unix"
)

// DefaultOps wires the real Linux capability operations.
func DefaultOps() Ops {
	return Ops{
		SetNoNewPrivs: func() error {
			return unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
		},
		GetCaps:        getCaps,
		SetCaps:        setCaps,
		ReadStatusCaps: ReadStatusCaps,
	}
}

// The x/sys Capget/Capset wrappers expose only the first 32 capabilities,
// but CAP_PERFMON (38) and CAP_BPF (39) live in the second word, so v3 is
// used directly with a two-word array.
func getCaps() (eff, prm, inh uint64, err error) {
	hdr := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	var data [2]unix.CapUserData
	_, _, errno := unix.Syscall(unix.SYS_CAPGET, uintptr(unsafe.Pointer(&hdr)), uintptr(unsafe.Pointer(&data)), 0)
	if errno != 0 {
		return 0, 0, 0, errno
	}
	return wordPair(data[0].Effective, data[1].Effective),
		wordPair(data[0].Permitted, data[1].Permitted),
		wordPair(data[0].Inheritable, data[1].Inheritable), nil
}

func setCaps(eff, prm, inh uint64) error {
	hdr := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	data := [2]unix.CapUserData{
		{Effective: uint32(eff), Permitted: uint32(prm), Inheritable: uint32(inh)},
		{Effective: uint32(eff >> 32), Permitted: uint32(prm >> 32), Inheritable: uint32(inh >> 32)},
	}
	_, _, errno := unix.Syscall(unix.SYS_CAPSET, uintptr(unsafe.Pointer(&hdr)), uintptr(unsafe.Pointer(&data)), 0)
	if errno != 0 {
		return errno
	}
	return nil
}

func wordPair(lo, hi uint32) uint64 { return uint64(hi)<<32 | uint64(lo) }

// ReadStatusCaps parses /proc/self/status CapEff/CapPrm/CapInh as an
// independent cross-check of the final set for logs.
func ReadStatusCaps() (eff, prm, inh uint64, err error) {
	raw, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0, 0, 0, err
	}
	return ParseStatusCaps(string(raw))
}
