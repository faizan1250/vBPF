package server

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// Uprobes attach by file inode as seen in the agent's mount namespace, so
// inside a container uprobe:libc resolves to the container's libc, never
// the host's. This pins the code-level half of that claim: resolution never
// leaves the checker's FSRoot, even when a different root holds a valid
// libc at the same virtual path.
func TestUprobeResolvesWithinAgentMountNamespace(t *testing.T) {
	const virt = "/lib/x86_64-linux-gnu/libc.so.6"
	hostRoot := t.TempDir()
	ctrRoot := t.TempDir()
	hostFile := makeFakeLibcFile(t, hostRoot, virt, 0o444)
	ctrFile := makeFakeLibcFile(t, ctrRoot, virt, 0o444)
	hostInfo, err := os.Stat(hostFile)
	require.NoError(t, err)
	ctrInfo, err := os.Stat(ctrFile)
	require.NoError(t, err)
	require.False(t, os.SameFile(hostInfo, ctrInfo), "roots must hold distinct inodes")

	var statPaths []string
	chk := &UprobeChecker{
		FSRoot:      ctrRoot,
		IsRootOwned: func(fs.FileInfo) bool { return true },
		StatFile: func(path string) (fs.FileInfo, error) {
			statPaths = append(statPaths, path)
			return os.Lstat(path)
		},
		ListProbe: func(ctx context.Context, probe string) ([]string, error) {
			return []string{probe}, nil
		},
	}
	errs := chk.VerifyProbes(context.Background(), []string{"uprobe:" + virt + ":getaddrinfo"})
	require.Empty(t, errs)
	require.NotEmpty(t, statPaths, "explicit path must be stat'ed")
	want := filepath.Join(ctrRoot, filepath.FromSlash(virt))
	require.Contains(t, statPaths, want)
	for _, p := range statPaths {
		require.False(t, strings.HasPrefix(p, hostRoot), "resolution escaped to the host root: %s", p)
	}
}
