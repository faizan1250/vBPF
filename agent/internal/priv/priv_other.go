//go:build !linux

package priv

import "errors"

// DefaultOps on non-Linux reports unsupported for every operation so Harden
// logs and continues; capability reduction is a Linux-only concern and CI
// runs these paths on Windows/macOS.
func DefaultOps() Ops {
	unsupported := func() (uint64, uint64, uint64, error) {
		return 0, 0, 0, errors.New("priv: capabilities unsupported on this OS")
	}
	return Ops{
		SetNoNewPrivs:  func() error { return errors.New("priv: no_new_privs unsupported on this OS") },
		GetCaps:        unsupported,
		SetCaps:        func(_, _, _ uint64) error { return errors.New("priv: capabilities unsupported on this OS") },
		ReadStatusCaps: ReadStatusCaps,
	}
}

// ReadStatusCaps has no /proc on non-Linux.
func ReadStatusCaps() (eff, prm, inh uint64, err error) {
	return 0, 0, 0, errors.New("priv: /proc/self/status unsupported on this OS")
}
