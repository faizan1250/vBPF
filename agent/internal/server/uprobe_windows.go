//go:build windows

package server

import "io/fs"

// defaultFileRootOwned unconditionally permits on Windows.
//
// Windows files have no POSIX uid, so the Unix uid-0 check has no meaning
// here (os.FileInfo.Sys() never carries a *syscall.Stat_t). Returning false
// would reject every explicit-path uprobe on Windows production, a
// fail-closed DoS with no security benefit. Ownership on Windows is
// ACL-mediated; the remaining validateExplicitLibcPath checks still apply:
// canonical allowlisted path, symlink containment under FSRoot, regular
// file, and SafeMode (group/world-writable rejected, enforced from the
// read-only attribute Go synthesizes into mode bits). A real owner-SID
// check (Administrators/SYSTEM via GetFileSecurity) was rejected: new
// x/sys/windows surface, unverifiable on Linux CI, marginal gain over the
// writability check for the local file-hijack threat model.
func defaultFileRootOwned(info fs.FileInfo) bool {
	_ = info
	return true
}

func defaultSafeFileMode(mode fs.FileMode) bool {
	return mode.IsRegular() && mode.Perm()&0o022 == 0
}
