//go:build windows

package server

import "io/fs"

func defaultFileRootOwned(info fs.FileInfo) bool {
	_ = info
	return false
}

func defaultSafeFileMode(mode fs.FileMode) bool {
	return mode.IsRegular() && mode.Perm()&0o022 == 0
}
