package server

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func buildEnvRecorderBinary(t *testing.T) (binPath, envOut string) {
	t.Helper()
	dir := t.TempDir()
	envOut = filepath.Join(dir, "child.env")
	srcPath := filepath.Join(dir, "main.go")
	binPath = filepath.Join(dir, "fake-bpftrace")
	if runtime.GOOS == "windows" {
		binPath += ".exe"
	}
	src := fmt.Sprintf(`package main
import ("fmt"; "os"; "strings")
func main() {
	_ = os.WriteFile(%q, []byte(strings.Join(os.Environ(), "\n")), 0o600)
	fmt.Println("tracepoint:syscalls:sys_enter_openat")
}
`, envOut)
	require.NoError(t, os.WriteFile(srcPath, []byte(src), 0o600))
	out, err := exec.Command("go", "build", "-o", binPath, srcPath).CombinedOutput()
	require.NoError(t, err, "build env recorder: %s", out)
	return binPath, envOut
}

func TestChildExecScrubsDangerousEnvAndAppliesDryRunCaps(t *testing.T) {
	bin, envOut := buildEnvRecorderBinary(t)
	t.Setenv("LD_LIBRARY_PATH", "/tmp/evil-lib")
	t.Setenv("LD_PRELOAD", "/tmp/evil-preload.so")
	t.Setenv("API_SECRET", "must-not-leak")

	cases := []struct {
		name     string
		wantCaps bool
		invoke   func(t *testing.T)
	}{
		{
			name:     "DefaultDryRun",
			wantCaps: true,
			invoke: func(t *testing.T) {
				errs := DefaultDryRun(bin)(context.Background(), "BEGIN {}")
				require.Empty(t, errs)
			},
		},
		{
			name:     "Catalog.Refresh",
			wantCaps: false,
			invoke: func(t *testing.T) {
				cat := NewCatalog(bin, nil)
				require.NoError(t, cat.Refresh(context.Background()))
			},
		},
		{
			name:     "DefaultProbeArgs",
			wantCaps: false,
			invoke: func(t *testing.T) {
				_, err := DefaultProbeArgs(bin)(context.Background(), "tracepoint:syscalls:sys_enter_openat")
				require.NoError(t, err)
			},
		},
		{
			name:     "HealthProvider.defaultVersion",
			wantCaps: false,
			invoke: func(t *testing.T) {
				ver := NewHealthProvider(time.Now(), bin).defaultVersion(context.Background())
				require.NotEqual(t, "unknown", ver)
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_ = os.Remove(envOut)
			tc.invoke(t)
			raw, err := os.ReadFile(envOut)
			require.NoError(t, err)
			got := string(raw)
			require.NotContains(t, got, "LD_LIBRARY_PATH")
			require.NotContains(t, got, "LD_PRELOAD")
			require.NotContains(t, got, "API_SECRET")
			if tc.wantCaps {
				require.Contains(t, got, "BPFTRACE_MAX_PROBES=50")
				require.Contains(t, got, "BPFTRACE_MAP_KEYS_MAX=4096")
				require.Contains(t, got, "BPFTRACE_STRLEN=64")
			} else {
				require.NotContains(t, got, "BPFTRACE_MAX_PROBES=")
			}
		})
	}
}
