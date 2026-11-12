package server

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// Version-tolerant oracle parsing: wording differs across bpftrace releases,
// so each signal is asserted against several plausible phrasings. No
// bpftrace binary is needed for this file.
func TestParseDryRunVerdict(t *testing.T) {
	unsafeOutputs := []string{
		"stdin:1:9-23: ERROR: unsafe call 'system' not allowed",
		"ERROR: Function 'system' is not allowed in safe mode. Use --unsafe to allow it",
		"stdin:1:1: ERROR: signal() is not permitted without --unsafe",
		"ERROR: forbidden function 'override' in safe mode",
		"STDIN:3: WARNING-free build: UNSAFE builtin rejected",
	}
	for _, out := range unsafeOutputs {
		v := parseDryRunVerdict(out)
		require.True(t, v.unsafeFunc, "missed unsafe signal in %q", out)
		require.False(t, v.ok, "unsafe output reads as ok: %q", out)
		require.False(t, v.unsupportedFlag, "unsafe output reads as unsupported flag: %q", out)
	}

	unknownOutputs := []string{
		"stdin:2:5-20: ERROR: Unknown function: nosuchfn",
		"ERROR: undefined function 'strstr'",
		"stdin:1:1: ERROR: function not found: exec",
		"ERROR: call to undeclared identifier 'popen'",
	}
	for _, out := range unknownOutputs {
		v := parseDryRunVerdict(out)
		require.True(t, v.unknownFunc, "missed unknown-function signal in %q", out)
		require.False(t, v.unsafeFunc, "unknown-function output reads as unsafe: %q", out)
	}

	syntaxOutputs := []string{
		"stdin:1:1-6: ERROR: syntax error, unexpected end of file",
		"stdin:1:1: ERROR: parse error near '{'",
		"ERROR: failed to parse script",
	}
	for _, out := range syntaxOutputs {
		v := parseDryRunVerdict(out)
		require.True(t, v.syntaxError, "missed syntax signal in %q", out)
		require.False(t, v.unsafeFunc, "syntax output reads as unsafe: %q", out)
	}

	require.True(t, parseDryRunVerdict("").ok, "empty output must read as ok")
	require.True(t, parseDryRunVerdict("bpftrace: unrecognized option '--dry-run'").unsupportedFlag)
	require.True(t, parseDryRunVerdict("Unknown flag: -d").unsupportedFlag)
	unclassified := parseDryRunVerdict("some new compiler failure wording v99")
	require.False(t, unclassified.ok, "unrecognized failure must not read as ok")
	require.False(t, unclassified.unsafeFunc, "unrecognized failure must not read as unsafe")
}
