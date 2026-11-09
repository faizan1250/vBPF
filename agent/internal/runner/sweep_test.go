//go:build unix

package runner

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseSweepPIDs(t *testing.T) {
	require.Equal(t, []int{5678}, parseSweepPIDs([]byte("1234\n5678\n"), 1234))
	require.Empty(t, parseSweepPIDs([]byte(""), 1))
	require.Empty(t, parseSweepPIDs([]byte("abc\n-3\n0\n"), 1))
}

func withSweepStubs(t *testing.T, pgrepOut string, pgrepErr error, self int) *[]int {
	t.Helper()
	oldLook, oldPgrep, oldKill, oldSelf := sweepLookPath, sweepPgrep, sweepKill, sweepSelf
	var killed []int
	sweepLookPath = func(string) (string, error) { return "/bin/pgrep", nil }
	sweepPgrep = func(context.Context, string) ([]byte, error) { return []byte(pgrepOut), pgrepErr }
	sweepKill = func(pid int) error { killed = append(killed, pid); return nil }
	sweepSelf = func() int { return self }
	t.Cleanup(func() {
		sweepLookPath, sweepPgrep, sweepKill, sweepSelf = oldLook, oldPgrep, oldKill, oldSelf
	})
	return &killed
}

func TestSweepStaleKillsListed(t *testing.T) {
	killed := withSweepStubs(t, "11 22\n", nil, 99)
	n, err := SweepStale(context.Background())
	require.NoError(t, err)
	require.Equal(t, 2, n)
	require.Equal(t, []int{11, 22}, *killed)
}

func TestSweepStaleSkipsSelf(t *testing.T) {
	killed := withSweepStubs(t, "11 22\n", nil, 22)
	n, err := SweepStale(context.Background())
	require.NoError(t, err)
	require.Equal(t, 1, n)
	require.Equal(t, []int{11}, *killed)
}

func TestSweepStaleNoPgrep(t *testing.T) {
	old := sweepLookPath
	sweepLookPath = func(string) (string, error) { return "", errors.New("not found") }
	t.Cleanup(func() { sweepLookPath = old })
	n, err := SweepStale(context.Background())
	require.NoError(t, err)
	require.Zero(t, n)
}
