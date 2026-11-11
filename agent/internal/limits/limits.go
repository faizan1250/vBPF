// Package limits holds the runtime caps for probe runs.
// Defaults mirror systemarchitecture.md section 7.3.
package limits

import (
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"
	"testing"
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

const defaultChildPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// BPFtraceEnvSlice returns BPFtraceEnv pairs sorted deterministically by key.
func BPFtraceEnvSlice() []string {
	m := BPFtraceEnv()
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+m[k])
	}
	return out
}

// ChildEnv builds a minimal allowlisted environment for child processes.
// Inherited host variables like LD_LIBRARY_PATH and LD_PRELOAD are stripped;
// FAKE_* test hooks are forwarded only when running under `go test`.
// Windows children need SystemRoot plus TEMP/TMP/PATHEXT to spawn; they are
// preserved allowlist-style (case-insensitive, harmless elsewhere).
func ChildEnv(withBPFtraceCaps bool) []string {
	return buildChildEnv(withBPFtraceCaps, testing.Testing(), os.Environ())
}

// windowsChildVars is the minimal set Windows needs to spawn children.
var windowsChildVars = map[string]bool{
	"SYSTEMROOT": true,
	"TEMP":       true,
	"TMP":        true,
	"PATHEXT":    true,
}

func buildChildEnv(withBPFtraceCaps, includeFake bool, parentEnv []string) []string {
	pathVal := ""
	var fakeVars []string
	winVals := map[string]string{}
	for _, entry := range parentEnv {
		k, v, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		isPath := k == "PATH" || (runtime.GOOS == "windows" && strings.EqualFold(k, "PATH"))
		if isPath && pathVal == "" && v != "" {
			pathVal = v
		} else if includeFake && strings.HasPrefix(k, "FAKE_") {
			fakeVars = append(fakeVars, entry)
		} else if windowsChildVars[strings.ToUpper(k)] {
			if _, seen := winVals[strings.ToUpper(k)]; !seen && v != "" {
				winVals[strings.ToUpper(k)] = k + "=" + v
			}
		}
	}
	if pathVal == "" {
		pathVal = defaultChildPath
	}
	out := []string{"PATH=" + pathVal}
	if len(winVals) > 0 {
		keys := make([]string, 0, len(winVals))
		for k := range winVals {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			out = append(out, winVals[k])
		}
	}
	if withBPFtraceCaps {
		out = append(out, BPFtraceEnvSlice()...)
	}
	if len(fakeVars) > 0 {
		sort.Strings(fakeVars)
		out = append(out, fakeVars...)
	}
	return out
}
