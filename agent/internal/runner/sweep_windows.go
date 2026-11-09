//go:build windows

package runner

import (
	"context"
)

// No stale sweep on Windows: pgrep is absent and child cleanup falls back
// to killing the process directly (see proc_windows.go).
func SweepStale(_ context.Context) (int, error) { return 0, nil }
