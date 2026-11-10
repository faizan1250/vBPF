package server

import (
	"context"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/faizan1250/vBPF/agent/internal/limits"
)

// MaxScriptBytes caps validated scripts at 8 KB.
const MaxScriptBytes = 8 * 1024

var (
	blockedCalls = regexp.MustCompile(`\b(system|signal|override|cat)\s*\(`)
	includeRe    = regexp.MustCompile(`(?m)^\s*#\s*(include|define)\b`)
	probeRe      = regexp.MustCompile(`\b(tracepoint|kprobe|kretprobe|uprobe|uretprobe|profile|interval|software):[^\s{;,)]+|\bBEGIN\b|\bEND\b`)
)

var allowedProviders = map[string]bool{
	"tracepoint": true,
	"kprobe":     true,
	"kretprobe":  true,
	"uprobe":     true,
	"uretprobe":  true,
	"profile":    true,
	"interval":   true,
	"software":   true,
	"BEGIN":      true,
	"END":        true,
}

// DryRunFunc compiles a script without attaching probes.
type DryRunFunc func(ctx context.Context, script string) []string

// classifyValidationError maps static/dry-run failures to the client-facing
// taxonomy code. HTTP status stays 400; only the code carries the taxonomy.
// Probe misses and over-broad wildcards are best-effort matches on compiler
// wording, so unknown shapes fall back to VALIDATION_FAILED.
func classifyValidationError(errs []string) string {
	for _, e := range errs {
		low := strings.ToLower(e)
		if strings.Contains(low, "probe not found") ||
			strings.Contains(low, "unknown probe") ||
			strings.Contains(low, "no such probe") {
			return "PROBE_NOT_FOUND"
		}
	}
	for _, e := range errs {
		if strings.Contains(strings.ToLower(e), "too many probes") {
			return "LIMIT_EXCEEDED"
		}
	}
	return "VALIDATION_FAILED"
}

// stripCommentsAndContinuations removes // and /* */ comments and \\\r?\n
// line continuations outside double-quoted strings so regex checks see unified
// tokens without gluing adjacent identifiers or merging lines across comments.
func stripCommentsAndContinuations(script string) (string, bool) {
	var out strings.Builder
	out.Grow(len(script))
	inString := false
	unclosedComment := false

	for i := 0; i < len(script); {
		c := script[i]
		if inString {
			if c == '\\' {
				out.WriteByte(c)
				i++
				if i < len(script) && script[i] != '\n' {
					out.WriteByte(script[i])
					i++
				}
				continue
			}
			out.WriteByte(c)
			if c == '"' || c == '\n' {
				inString = false
			}
			i++
			continue
		}

		if c == '"' {
			inString = true
			out.WriteByte(c)
			i++
			continue
		}
		if c == '\\' {
			if i+1 < len(script) && script[i+1] == '\n' {
				i += 2
				continue
			}
			if i+2 < len(script) && script[i+1] == '\r' && script[i+2] == '\n' {
				i += 3
				continue
			}
			out.WriteByte(c)
			i++
			continue
		}
		if c == '/' && i+1 < len(script) && script[i+1] == '/' {
			i += 2
			for i < len(script) && script[i] != '\n' {
				i++
			}
			out.WriteByte(' ')
			continue
		}
		if c == '/' && i+1 < len(script) && script[i+1] == '*' {
			i += 2
			out.WriteByte(' ')
			closed := false
			for i < len(script) {
				if script[i] == '*' && i+1 < len(script) && script[i+1] == '/' {
					i += 2
					closed = true
					break
				}
				if script[i] == '\n' {
					out.WriteByte('\n')
				}
				i++
			}
			if !closed {
				unclosedComment = true
			}
			continue
		}
		out.WriteByte(c)
		i++
	}
	return out.String(), unclosedComment
}

// StaticValidate applies blocklist, allowlist, and size rules (no exec).
func StaticValidate(script string, catalog *Catalog) (probes []string, errors []string) {
	if strings.TrimSpace(script) == "" {
		return nil, []string{"empty script"}
	}
	if len(script) > MaxScriptBytes {
		return nil, []string{"script exceeds 8 KB"}
	}
	cleaned, unclosedComment := stripCommentsAndContinuations(script)
	if unclosedComment {
		errors = append(errors, "blocked syntax: unclosed block comment")
	}
	if blockedCalls.MatchString(cleaned) {
		errors = append(errors, "blocked call: system/signal/override/cat are forbidden")
	}
	if includeRe.MatchString(cleaned) {
		errors = append(errors, "blocked syntax: #include/#define are forbidden")
	}
	probes = probeRe.FindAllString(cleaned, -1)
	if len(probes) == 0 {
		errors = append(errors, "no probes found")
	}
	known := map[string]bool{}
	if catalog != nil {
		for _, p := range catalog.Snapshot() {
			known[p] = true
		}
	}
	for _, pr := range probes {
		provider := pr
		if i := strings.IndexByte(pr, ':'); i >= 0 {
			provider = pr[:i]
		}
		if !allowedProviders[provider] {
			errors = append(errors, "provider not allowed: "+provider)
			continue
		}
		if provider == "uprobe" || provider == "uretprobe" {
			rest := strings.TrimPrefix(pr, provider+":")
			if !strings.Contains(rest, "libc") && !strings.HasPrefix(rest, "/") {
				errors = append(errors, "uprobe must target libc or an absolute path: "+pr)
			}
		}
		if strings.Contains(pr, "*") {
			if pr == "*" || strings.HasSuffix(pr, ":*") || pr == "tracepoint:*:*" || pr == "kprobe:*" {
				errors = append(errors, "wildcard too broad: "+pr)
				continue
			}
			if len(known) > 0 {
				n := expandCount(pr, known)
				if n > limits.MaxProbes {
					errors = append(errors, "wildcard expands to too many probes: "+pr)
				} else if n == 0 {
					errors = append(errors, "probe not found: "+pr)
				}
			}
			continue
		}
		if len(known) > 0 && (provider != "profile" && provider != "interval" && provider != "software" && provider != "BEGIN" && provider != "END") {
			if !known[pr] {
				errors = append(errors, "probe not found: "+pr)
			}
		}
	}
	return probes, errors
}

func expandCount(pattern string, known map[string]bool) int {
	prefix := pattern[:strings.IndexByte(pattern, '*')]
	n := 0
	for k := range known {
		if strings.HasPrefix(k, prefix) {
			n++
		}
	}
	return n
}

// DefaultDryRun compiles via a temp file without attaching probes.
func DefaultDryRun(bpftracePath string) DryRunFunc {
	if bpftracePath == "" {
		bpftracePath = "bpftrace"
	}
	return func(ctx context.Context, script string) []string {
		tmp, err := os.CreateTemp("", "vbpf-validate-*.bt")
		if err != nil {
			return []string{"dry-run temp file: " + err.Error()}
		}
		name := tmp.Name()
		defer func() { _ = os.Remove(name) }()
		if err := tmp.Chmod(0o600); err != nil {
			_ = tmp.Close()
			return []string{"dry-run chmod: " + err.Error()}
		}
		if _, err := tmp.WriteString(script); err != nil {
			_ = tmp.Close()
			return []string{"dry-run write: " + err.Error()}
		}
		_ = tmp.Close()
		for _, flag := range []string{"--dry-run", "-d"} {
			cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			out, err := exec.CommandContext(cctx, bpftracePath, flag, name).CombinedOutput()
			cancel()
			text := strings.TrimSpace(string(out))
			if err == nil {
				return nil
			}
			if strings.Contains(strings.ToLower(text), "unknown") || strings.Contains(strings.ToLower(text), "unrecognized") {
				continue
			}
			return truncateLines(text, 20)
		}
		return []string{"dry-run not supported by this bpftrace version"}
	}
}

func truncateLines(s string, max int) []string {
	lines := strings.Split(s, "\n")
	var out []string
	for _, l := range lines {
		if t := strings.TrimSpace(l); t != "" {
			out = append(out, t)
		}
		if len(out) >= max {
			break
		}
	}
	if len(out) == 0 {
		return []string{"dry-run failed"}
	}
	return out
}
