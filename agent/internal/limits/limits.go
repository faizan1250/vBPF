// Package limits holds the runtime caps for probe runs.
// Defaults mirror systemarchitecture.md section 7.3.
package limits

import (
	"fmt"
	"time"
)

const (
	// DefaultDuration is the probe run length when the caller passes none.
	DefaultDuration = 10 * time.Second
	// MinDuration and MaxDuration bound every run. No unbounded runs.
	MinDuration = 1 * time.Second
	MaxDuration = 60 * time.Second
	// KillGrace is the wait between SIGINT and SIGKILL on the process group.
	KillGrace = 3 * time.Second

	// MapKeysMax caps bpftrace map cardinality.
	MapKeysMax = 4096
	// MaxProbes caps wildcard probe expansion.
	MaxProbes = 50
	// StrLen caps bpftrace string reads.
	StrLen = 64

	// MaxEventsPerSec is the sustained event rate forwarded to consumers.
	MaxEventsPerSec = 500
	// BatchHz is the UI batching rate.
	BatchHz = 10
	// MaxBytesPerRun stops a run once stdout exceeds this many bytes.
	MaxBytesPerRun = 5 * 1024 * 1024
	// MaxConcurrentRuns caps simultaneous runs (MVP: one).
	MaxConcurrentRuns = 1

	// StderrMaxBytes bounds captured child stderr.
	StderrMaxBytes = 64 * 1024
)

// ValidateDuration rejects durations outside [MinDuration, MaxDuration].
func ValidateDuration(d time.Duration) error {
	if d < MinDuration || d > MaxDuration {
		return fmt.Errorf("limits: duration %s outside [%s, %s]", d, MinDuration, MaxDuration)
	}
	return nil
}

// BPFtraceEnv returns the bpftrace limit variables applied to every run.
func BPFtraceEnv() map[string]string {
	return map[string]string{
		"BPFTRACE_MAP_KEYS_MAX": fmt.Sprint(MapKeysMax),
		"BPFTRACE_MAX_PROBES":   fmt.Sprint(MaxProbes),
		"BPFTRACE_STRLEN":       fmt.Sprint(StrLen),
	}
}
