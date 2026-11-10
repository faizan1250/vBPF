package server

import (
	"context"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/faizan1250/vBPF/agent/internal/limits"
)

// MaxScriptBytes caps validated scripts at 8 KB.
const MaxScriptBytes = 8 * 1024

var (
	blockedCalls = regexp.MustCompile(`\b(system|signal|override|cat)\s*\(`)
	includeRe    = regexp.MustCompile(`(?m)^\s*#\s*(include|define)\b`)
	cDeclRe      = regexp.MustCompile(`^(struct|enum|union)(\s+[A-Za-z_][A-Za-z0-9_]*)?$`)
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

var staticValidationFailedPrefixes = []string{
	"empty script",
	"script exceeds ",
	"blocked ",
	"invalid probe ",
	"no probes found",
	"provider not allowed:",
	"uprobe must target ",
	"wildcard too broad:",
}

func classifySingleError(err string) string {
	if strings.HasPrefix(err, "probe not found:") {
		return "PROBE_NOT_FOUND"
	}
	if strings.HasPrefix(err, "wildcard expands to too many probes:") {
		return "LIMIT_EXCEEDED"
	}
	for _, prefix := range staticValidationFailedPrefixes {
		if strings.HasPrefix(err, prefix) {
			return "VALIDATION_FAILED"
		}
	}
	low := strings.ToLower(err)
	if strings.Contains(low, "probe not found") ||
		strings.Contains(low, "unknown probe") ||
		strings.Contains(low, "no such probe") {
		return "PROBE_NOT_FOUND"
	}
	if strings.Contains(low, "too many probes") {
		return "LIMIT_EXCEEDED"
	}
	return "VALIDATION_FAILED"
}

// classifyValidationError maps static/dry-run failures to the client-facing
// taxonomy code. HTTP status stays 400; only the code carries the taxonomy.
// StaticValidate errors match strictly by prefix so probe text cannot spoof
// dry-run compiler wording; unrecognized errors fall back to best-effort matching.
func classifyValidationError(errs []string) string {
	code := "VALIDATION_FAILED"
	for _, e := range errs {
		switch classifySingleError(e) {
		case "PROBE_NOT_FOUND":
			return "PROBE_NOT_FOUND"
		case "LIMIT_EXCEEDED":
			code = "LIMIT_EXCEEDED"
		}
	}
	return code
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

func advanceInString(s string, i int) (int, bool) {
	if s[i] == '\\' {
		i++
		if i < len(s) && s[i] != '\n' {
			i++
		}
		return i, true
	}
	return i + 1, s[i] != '"' && s[i] != '\n'
}

func skipSpaces(s string, i int) int {
	for i < len(s) {
		r, size := utf8.DecodeRuneInString(s[i:])
		if !unicode.IsSpace(r) {
			break
		}
		i += size
	}
	return i
}

// Path-bearing providers accept slashes in target paths unless separated by whitespace/comma.
func startsPredicate(cleaned string, headerStart, segmentStart, idx int) bool {
	if idx == headerStart {
		return true
	}
	r, _ := utf8.DecodeLastRuneInString(cleaned[:idx])
	if unicode.IsSpace(r) || r == ',' {
		return true
	}
	tok := strings.TrimLeftFunc(cleaned[segmentStart:idx], unicode.IsSpace)
	for _, prefix := range []string{"uprobe:", "uretprobe:", "usdt:", "u:", "ur:", "U:"} {
		if strings.HasPrefix(tok, prefix) {
			return false
		}
	}
	return true
}

func scanPredicate(cleaned string, i int) (int, bool) {
	i++ // consume opening '/'
	inString := false
	parenDepth := 0
	bracketDepth := 0
	for i < len(cleaned) {
		c := cleaned[i]
		if inString {
			i, inString = advanceInString(cleaned, i)
			continue
		}
		switch c {
		case '"':
			inString = true
		case '(':
			parenDepth++
		case ')':
			if parenDepth > 0 {
				parenDepth--
			}
		case '[':
			bracketDepth++
		case ']':
			if bracketDepth > 0 {
				bracketDepth--
			}
		case '/':
			if parenDepth == 0 && bracketDepth == 0 {
				return i + 1, true
			}
		}
		i++
	}
	return i, false
}

func scanActionBlock(cleaned string, i int) (int, bool) {
	i++ // consume opening '{'
	depth := 1
	inString := false
	for i < len(cleaned) && depth > 0 {
		c := cleaned[i]
		if inString {
			i, inString = advanceInString(cleaned, i)
			continue
		}
		switch c {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
		}
		i++
	}
	return i, depth == 0
}

func resyncToActionBlock(cleaned string, i int) (next int, foundOpen, foundClose bool) {
	inString := false
	for i < len(cleaned) {
		c := cleaned[i]
		if inString {
			i, inString = advanceInString(cleaned, i)
			continue
		}
		if c == '"' {
			inString = true
			i++
			continue
		}
		if c == '{' {
			return i, true, false
		}
		if c == '}' {
			return i, false, true
		}
		i++
	}
	return i, false, false
}

func splitHeaderSegments(header string) []string {
	var segments []string
	start := 0
	inString := false
	for i := 0; i < len(header); {
		c := header[i]
		if inString {
			i, inString = advanceInString(header, i)
			continue
		}
		if c == '"' {
			inString = true
			i++
			continue
		}
		if c == ',' {
			segments = append(segments, header[start:i])
			i++
			start = i
			continue
		}
		i++
	}
	return append(segments, header[start:])
}

func inspectHeaderSegment(seg string) (hasUnquotedSpace, hasUnclosedQuote bool) {
	inString := false
	for i := 0; i < len(seg); {
		if inString {
			if seg[i] == '\n' {
				hasUnclosedQuote = true
			}
			i, inString = advanceInString(seg, i)
			continue
		}
		if seg[i] == '"' {
			inString = true
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(seg[i:])
		if unicode.IsSpace(r) {
			hasUnquotedSpace = true
		}
		i += size
	}
	if inString {
		hasUnclosedQuote = true
	}
	return hasUnquotedSpace, hasUnclosedQuote
}

func parseHeaderTargets(header string) (targets, errs []string) {
	for _, raw := range splitHeaderSegments(header) {
		seg := strings.TrimSpace(raw)
		if seg == "" {
			errs = append(errs, "invalid probe header: empty probe target")
			continue
		}
		hasSpace, unclosedQuote := inspectHeaderSegment(seg)
		if unclosedQuote {
			errs = append(errs, "invalid probe header: unclosed quote in probe target")
			continue
		}
		if hasSpace {
			errs = append(errs, "invalid probe header: unexpected whitespace in probe target")
			continue
		}
		if strings.HasPrefix(seg, ":") || strings.HasSuffix(seg, ":") {
			errs = append(errs, "invalid probe header: invalid colon in probe target")
			continue
		}
		provider := seg
		if colon := strings.IndexByte(seg, ':'); colon >= 0 {
			provider = seg[:colon]
			if provider == "BEGIN" || provider == "END" {
				errs = append(errs, "invalid probe header: BEGIN/END cannot have target")
				continue
			}
		}
		if strings.ContainsFunc(provider, unicode.IsSpace) {
			errs = append(errs, "invalid probe header: unexpected whitespace in probe target")
			continue
		}
		targets = append(targets, seg)
	}
	return targets, errs
}

func extractProbes(cleaned string) (probes, errs []string) {
	n := len(cleaned)
	for i := 0; i < n; {
		i = skipSpaces(cleaned, i)
		if i >= n {
			break
		}
		if cleaned[i] == '}' {
			errs = append(errs, "invalid probe syntax: unexpected closing brace")
			i++
			continue
		}

		headerStart := i
		segmentStart := headerStart
		headerEnd := i
		inString := false
		hasPredicate := false
		foundOpenBrace := false
		foundTopCloseBrace := false

		for i < n {
			c := cleaned[i]
			if inString {
				i, inString = advanceInString(cleaned, i)
				continue
			}
			if c == '"' {
				inString = true
				i++
				continue
			}
			if c == ',' {
				i++
				segmentStart = i
				continue
			}
			if c == '{' {
				headerEnd = i
				foundOpenBrace = true
				break
			}
			if c == '}' {
				headerEnd = i
				foundTopCloseBrace = true
				break
			}
			if c == '/' && startsPredicate(cleaned, headerStart, segmentStart, i) {
				headerEnd = i
				hasPredicate = true
				break
			}
			i++
		}

		if foundTopCloseBrace {
			errs = append(errs, "invalid probe syntax: unexpected closing brace")
			i++
			continue
		}
		if hasPredicate {
			next, closed := scanPredicate(cleaned, i)
			if !closed {
				errs = append(errs, "invalid probe syntax: unclosed predicate")
				break
			}
			i = skipSpaces(cleaned, next)
			if i >= n {
				errs = append(errs, "invalid probe header: missing action block")
				break
			}
			if cleaned[i] != '{' {
				errs = append(errs, "invalid probe header: unexpected token after predicate")
				var closeBrace bool
				i, foundOpenBrace, closeBrace = resyncToActionBlock(cleaned, i)
				if closeBrace {
					errs = append(errs, "invalid probe syntax: unexpected closing brace")
					i++
					continue
				}
				if !foundOpenBrace {
					break
				}
			} else {
				foundOpenBrace = true
			}
		} else if !foundOpenBrace {
			if len(probes) > 0 {
				errs = append(errs, "invalid probe header: missing action block")
			}
			break
		}

		header := strings.TrimSpace(cleaned[headerStart:headerEnd])
		if header == "" {
			errs = append(errs, "invalid probe header: empty probe header")
		} else if !hasPredicate && cDeclRe.MatchString(header) {
			next, closed := scanActionBlock(cleaned, i)
			if !closed {
				errs = append(errs, "invalid probe syntax: unclosed action block")
				break
			}
			i = skipSpaces(cleaned, next)
			if i < n && cleaned[i] == ';' {
				i++
			}
			continue
		} else {
			targets, hdrErrs := parseHeaderTargets(header)
			probes = append(probes, targets...)
			errs = append(errs, hdrErrs...)
		}

		next, closed := scanActionBlock(cleaned, i)
		if !closed {
			errs = append(errs, "invalid probe syntax: unclosed action block")
			break
		}
		i = next
	}
	return probes, errs
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
	var parseErrs []string
	probes, parseErrs = extractProbes(cleaned)
	errors = append(errors, parseErrs...)
	if len(probes) == 0 && len(parseErrs) == 0 {
		errors = append(errors, "no probes found")
	}
	known := map[string]bool{}
	if catalog != nil {
		for _, p := range catalog.Snapshot() {
			known[p] = true
		}
	}
	for _, pr := range probes {
		colon := strings.IndexByte(pr, ':')
		provider := pr
		if colon >= 0 {
			provider = pr[:colon]
		}
		if !allowedProviders[provider] {
			errors = append(errors, "provider not allowed: "+provider)
			continue
		}
		if colon < 0 && provider != "BEGIN" && provider != "END" {
			errors = append(errors, "invalid probe header: missing target for provider "+provider)
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
			cmd := exec.CommandContext(cctx, bpftracePath, flag, name)
			cmd.Env = limits.ChildEnv(true)
			out, err := cmd.CombinedOutput()
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
