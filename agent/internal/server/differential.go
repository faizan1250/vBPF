package server

import "strings"

// dryRunVerdict is the oracle's reading of one `bpftrace --dry-run` (or
// `-d`) stderr dump. Matching is deliberately loose (case-insensitive
// substring alternatives) because error wording varies across bpftrace
// versions; see parseDryRunVerdict.
type dryRunVerdict struct {
	// ok means the output carries no failure signal.
	ok bool
	// unsupportedFlag means this bpftrace does not know the dry-run flag.
	unsupportedFlag bool
	// unsafeFunc means bpftrace flagged a function as unsafe for safe mode.
	unsafeFunc bool
	// unknownFunc means bpftrace reported an unknown/undefined function.
	unknownFunc bool
	// syntaxError means bpftrace failed to parse the script.
	syntaxError bool
}

// parseDryRunVerdict classifies dry-run output without trusting exact
// version-specific wording. Priority: unsupported flag, unsafe, unknown
// function, syntax error. Unrecognized non-empty output is a failure with
// no flag set (logged by the caller, never a pass).
func parseDryRunVerdict(output string) dryRunVerdict {
	text := strings.ToLower(output)
	if strings.Contains(text, "unrecognized option") ||
		strings.Contains(text, "unknown option") ||
		strings.Contains(text, "invalid option") ||
		strings.Contains(text, "unknown flag") {
		return dryRunVerdict{unsupportedFlag: true}
	}
	v := dryRunVerdict{}
	if strings.Contains(text, "unsafe") ||
		strings.Contains(text, "not allowed") ||
		strings.Contains(text, "not permitted") ||
		strings.Contains(text, "forbidden") {
		v.unsafeFunc = true
	}
	if strings.Contains(text, "unknown function") ||
		strings.Contains(text, "unknown func") ||
		strings.Contains(text, "undefined function") ||
		strings.Contains(text, "function not found") ||
		strings.Contains(text, "no such function") ||
		strings.Contains(text, "undeclared") {
		v.unknownFunc = true
	}
	if strings.Contains(text, "syntax error") ||
		strings.Contains(text, "parse error") ||
		strings.Contains(text, "failed to parse") {
		v.syntaxError = true
	}
	v.ok = !v.unsafeFunc && !v.unknownFunc && !v.syntaxError && strings.TrimSpace(text) == ""
	return v
}
