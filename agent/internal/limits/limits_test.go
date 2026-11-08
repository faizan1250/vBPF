package limits

import (
	"testing"
	"time"
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
			if err := ValidateDuration(c.d); (err != nil) != c.wantErr {
				t.Fatalf("ValidateDuration(%s) err=%v wantErr=%v", c.d, err, c.wantErr)
			}
		})
	}
}

func TestBPFtraceEnv(t *testing.T) {
	env := BPFtraceEnv()
	for _, k := range []string{"BPFTRACE_MAP_KEYS_MAX", "BPFTRACE_MAX_PROBES", "BPFTRACE_STRLEN"} {
		if env[k] == "" {
			t.Fatalf("missing %s", k)
		}
	}
}
