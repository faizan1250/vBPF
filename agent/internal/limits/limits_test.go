package limits

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestValidateDuration(t *testing.T) {
	cases := []struct {
		name    string
		d       time.Duration
		wantErr bool
	}{
		{"min", MinDuration, false},
		{"default", DefaultDuration, false},
		{"max", MaxDuration, false},
		{"zero rejected", 0, true},
		{"over max rejected", MaxDuration + time.Second, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := ValidateDuration(c.d)
			if c.wantErr {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
		})
	}
}

func TestBPFtraceEnv(t *testing.T) {
	env := BPFtraceEnv()
	for _, k := range []string{"BPFTRACE_MAP_KEYS_MAX", "BPFTRACE_MAX_PROBES", "BPFTRACE_STRLEN"} {
		require.NotEmpty(t, env[k], "missing %s", k)
	}
}

func TestChildEnvScrubsUnsafeAndRespectsTestingMode(t *testing.T) {
	parent := []string{
		"PATH=/custom/bin",
		"LD_LIBRARY_PATH=/tmp/hijack",
		"LD_PRELOAD=/tmp/preload.so",
		"API_SECRET=super-secret",
		"FAKE_MODE=replay",
		"FAKE_EXIT=2",
		"SystemRoot=C:\\Windows",
		"TEMP=C:\\Temp",
		"TMP=C:\\Temp",
		"PATHEXT=.COM;.EXE",
	}

	prodWithCaps := buildChildEnv(true, false, parent)
	require.Equal(t, []string{
		"PATH=/custom/bin",
		"PATHEXT=.COM;.EXE",
		"SystemRoot=C:\\Windows",
		"TEMP=C:\\Temp",
		"TMP=C:\\Temp",
		"BPFTRACE_MAP_KEYS_MAX=4096",
		"BPFTRACE_MAX_PROBES=50",
		"BPFTRACE_STRLEN=64",
	}, prodWithCaps)

	testNoCaps := buildChildEnv(false, true, parent)
	require.Equal(t, []string{
		"PATH=/custom/bin",
		"PATHEXT=.COM;.EXE",
		"SystemRoot=C:\\Windows",
		"TEMP=C:\\Temp",
		"TMP=C:\\Temp",
		"FAKE_EXIT=2",
		"FAKE_MODE=replay",
	}, testNoCaps)

	fallbackPath := buildChildEnv(false, false, nil)
	require.Equal(t, []string{"PATH=" + defaultChildPath}, fallbackPath)
}

func TestChildEnvPreservesWindowsVarsCaseInsensitive(t *testing.T) {
	parent := []string{"PATH=/bin", "systemroot=C:\\Win", "temp=C:\\T"}
	got := buildChildEnv(false, false, parent)
	require.Contains(t, got, "PATH=/bin")
	require.Contains(t, got, "systemroot=C:\\Win")
	require.Contains(t, got, "temp=C:\\T")
}
