//go:build unix

package server

import (
	"io/fs"
	"syscall"
)

func defaultFileRootOwned(info fs.FileInfo) bool {
	if info == nil {
		return false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && st.Uid == 0
}

func defaultSafeFileMode(mode fs.FileMode) bool {
	return mode.IsRegular() && mode.Perm()&0o022 == 0
}
