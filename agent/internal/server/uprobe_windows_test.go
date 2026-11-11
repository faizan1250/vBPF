//go:build windows

package server

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// Windows has no POSIX uid, so the ownership gate is bypassed; the file
// safety net is allowlist + symlink containment + regular file + SafeMode.
func TestWindowsDefaultOwnershipBypassed(t *testing.T) {
	require.True(t, defaultFileRootOwned(nil))
	info, err := os.Stat(filepath.Join(t.TempDir(), ".."))
	require.NoError(t, err)
	require.True(t, defaultFileRootOwned(info))
}

func TestWindowsExplicitLibcPathPassesOwnership(t *testing.T) {
	root := t.TempDir()
	const validPath = "/lib/x86_64-linux-gnu/libc.so.6"
	full := filepath.Join(root, filepath.FromSlash("lib/x86_64-linux-gnu/libc.so.6"))
	require.NoError(t, os.MkdirAll(filepath.Dir(full), 0o755))
	require.NoError(t, os.WriteFile(full, []byte("ELF"), 0o444))
	require.NoError(t, os.Chmod(full, 0o444))

	chk := (&UprobeChecker{FSRoot: root}).withDefaults()
	resolved, err := chk.validateExplicitLibcPath(validPath)
	require.NoError(t, err)
	require.Equal(t, validPath, resolved)
}

func TestWindowsSafeModeStillEnforced(t *testing.T) {
	dir := t.TempDir()
	writable := filepath.Join(dir, "w")
	require.NoError(t, os.WriteFile(writable, []byte("ELF"), 0o666))
	wInfo, err := os.Stat(writable)
	require.NoError(t, err)
	require.False(t, defaultSafeFileMode(wInfo.Mode()))

	locked := filepath.Join(dir, "r")
	require.NoError(t, os.WriteFile(locked, []byte("ELF"), 0o444))
	require.NoError(t, os.Chmod(locked, 0o444))
	rInfo, err := os.Stat(locked)
	require.NoError(t, err)
	require.True(t, defaultSafeFileMode(rInfo.Mode()))
}
