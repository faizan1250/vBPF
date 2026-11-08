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
