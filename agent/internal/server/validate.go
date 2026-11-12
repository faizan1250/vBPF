package server

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/faizan1250/vBPF/agent/internal/limits"
)

// MaxScriptBytes caps validated scripts at 8 KB.
const MaxScriptBytes = 8 * 1024

// maxValidatorErrorLen caps every static-validation error and warning so a
// fuzz-generated (or adversarial) probe name cannot echo unbounded raw input
// back to callers. Truncation keeps the message prefix, which is what the
// taxonomy classifier matches on. Mirrors MAX_VALIDATOR_ERROR_LEN in
// api/src/validator.ts and truncateErrors there.
const maxValidatorErrorLen = 500

// truncateValidatorError bounds one message to maxValidatorErrorLen runes.
func truncateValidatorError(s string) string {
	r := []rune(s)
	if len(r) <= maxValidatorErrorLen {
		return s
	}
	return string(r[:maxValidatorErrorLen])
}

// truncateValidatorErrors bounds every message in place.
func truncateValidatorErrors(msgs []string) []string {
	for i := range msgs {
		msgs[i] = truncateValidatorError(msgs[i])
	}
	return msgs
}

var (
	cDeclRe = regexp.MustCompile(`^(struct|enum|union)(\s+[A-Za-z_][A-Za-z0-9_]*)?$`)
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

// ValidateResult holds the static validation outcome and resolved counts.
type ValidateResult struct {
	Code       string
	Probes     []string
	Errors     []string
	Warnings   []string
	ProbeCount int
}

var staticValidationFailedPrefixes = []string{
	"empty script",
	"script exceeds ",
	"blocked ",
	"invalid probe ",
	"invalid uprobe ",
	"invalid wildcard ",
	"no probes found",
	"provider not allowed:",
	"uprobe must ",
	"uprobe target not allowed:",
	"uprobe host path invalid:",
	"wildcard too broad:",
	"wildcard not allowed ",
}

func classifySingleError(err string) string {
	if strings.HasPrefix(err, "catalog unavailable:") {
		return "CATALOG_UNAVAILABLE"
	}
	if strings.HasPrefix(err, "blocked call:") {
		return "BLOCKED_CALL"
	}
	if strings.HasPrefix(err, "unknown function call:") {
		return "UNKNOWN_CALL"
	}
	if strings.HasPrefix(err, "probe not found:") {
		return "PROBE_NOT_FOUND"
	}
	if strings.HasPrefix(err, "wildcard expands to too many probes:") || strings.HasPrefix(err, "too many probes:") {
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
// Severity order: BLOCKED_CALL, UNKNOWN_CALL, PROBE_NOT_FOUND, LIMIT_EXCEEDED.
func classifyValidationError(errs []string) string {
	for _, e := range errs {
		if classifySingleError(e) == "BLOCKED_CALL" {
			return "BLOCKED_CALL"
		}
	}
	for _, e := range errs {
		if classifySingleError(e) == "UNKNOWN_CALL" {
			return "UNKNOWN_CALL"
		}
	}
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

// Token-level lexer for default-deny call validation. Strings and comments
// become opaque tokens so their contents can never read as calls; the cleaned
// source rebuilt here feeds probe-header parsing. Unterminated strings and
// comments, preprocessor lines, NUL/control bytes, non-ASCII code, token
// floods, and deep nesting are validation errors, never silent skips.
type tokenKind int

const (
	tokIdent tokenKind = iota
	tokNumber
	tokString
	tokPunct
	tokComment
	tokPreproc
)

type scriptToken struct {
	kind tokenKind
	text string
}

const (
	maxLexerTokens  = 10000
	maxNestingDepth = 128
)

// deniedCalls are rejected with the function name even though they are also
// absent from the allowlist, so the reason is specific.
var deniedCalls = map[string]bool{
	"system":   true,
	"signal":   true,
	"override": true,
	"cat":      true,
}

// allowedCalls is the default-deny function allowlist: bpftrace builtins that
// are read-only or in-kernel aggregation/output helpers.
var allowedCalls = map[string]bool{
	"printf": true, "print": true,
	"count": true, "sum": true, "avg": true, "min": true, "max": true,
	"stats": true, "hist": true, "lhist": true,
	"delete": true, "clear": true, "zero": true,
	"str": true, "strncmp": true, "strlen": true, "buf": true,
	"ntop":   true,
	"kstack": true, "ustack": true, "ksym": true, "usym": true,
	"time": true, "join": true,
	"exit":        true,
	"cgroup_path": true, "cgroupid": true,
}

// callKeywords take parentheses but are control flow, not function calls.
var callKeywords = map[string]bool{
	"if": true, "else": true, "for": true, "while": true, "return": true,
	"sizeof": true, "typeof": true, "unroll": true, "comptime": true,
}

func isASCIILetter(c byte) bool {
	return c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
}

func isASCIIDigit(c byte) bool {
	return c >= '0' && c <= '9'
}

func lexScript(script string) ([]scriptToken, string, []string) {
	var toks []scriptToken
	var cleaned strings.Builder
	cleaned.Grow(len(script))
	var errs []string
	seenControl := false
	seenNonASCII := false
	n := len(script)
	i := 0
	for i < n {
		if len(toks) > maxLexerTokens {
			errs = append(errs, "script too complex: token limit exceeded")
			break
		}
		c := script[i]
		switch {
		case c == '\n':
			cleaned.WriteByte(c)
			i++
		case c == ' ' || c == '\t' || c == '\r':
			cleaned.WriteByte(c)
			i++
		case c == '/' && i+1 < n && script[i+1] == '/':
			j := i + 2
			for j < n && script[j] != '\n' {
				j++
			}
			toks = append(toks, scriptToken{kind: tokComment, text: script[i:j]})
			cleaned.WriteByte(' ')
			i = j
		case c == '/' && i+1 < n && script[i+1] == '*':
			j := i + 2
			closed := false
			for j < n {
				if script[j] == '*' && j+1 < n && script[j+1] == '/' {
					j += 2
					closed = true
					break
				}
				if script[j] == '\n' {
					cleaned.WriteByte('\n')
				}
				j++
			}
			toks = append(toks, scriptToken{kind: tokComment, text: script[i:j]})
			cleaned.WriteByte(' ')
			if !closed {
				errs = append(errs, "blocked syntax: unclosed block comment")
			}
			i = j
		case c == '"':
			j := i + 1
			closed := false
			for j < n {
				if script[j] == '\\' {
					if j+1 < n && script[j+1] != '\n' {
						j += 2
					} else {
						j++
					}
					continue
				}
				if script[j] == '"' {
					j++
					closed = true
					break
				}
				if script[j] == '\n' {
					break
				}
				j++
			}
			toks = append(toks, scriptToken{kind: tokString, text: script[i:j]})
			cleaned.WriteString(script[i:j])
			if !closed {
				errs = append(errs, "blocked syntax: unterminated string literal")
			}
			i = j
		case c == '#':
			j := i + 1
			for j < n && script[j] != '\n' {
				if script[j] == '\\' && j+1 < n && script[j+1] == '\n' {
					j += 2
					continue
				}
				if script[j] == '\\' && j+2 < n && script[j+1] == '\r' && script[j+2] == '\n' {
					j += 3
					continue
				}
				j++
			}
			toks = append(toks, scriptToken{kind: tokPreproc, text: script[i:j]})
			cleaned.WriteByte(' ')
			errs = append(errs, "blocked syntax: preprocessor directives are forbidden")
			i = j
		case c == '\\' && i+1 < n && script[i+1] == '\n':
			i += 2
		case c == '\\' && i+2 < n && script[i+1] == '\r' && script[i+2] == '\n':
			i += 3
		case c >= 0x80:
			_, size := utf8.DecodeRuneInString(script[i:])
			if !seenNonASCII {
				seenNonASCII = true
				errs = append(errs, "blocked syntax: non-ASCII characters are not allowed outside strings and comments")
			}
			cleaned.WriteByte(' ')
			i += size
		case c < 0x20 || c == 0x7f:
			if !seenControl {
				seenControl = true
				errs = append(errs, "blocked syntax: invalid control character")
			}
			cleaned.WriteByte(' ')
			i++
		case isASCIILetter(c):
			var sb strings.Builder
			j := i
			for j < n {
				if isASCIILetter(script[j]) || isASCIIDigit(script[j]) {
					sb.WriteByte(script[j])
					j++
					continue
				}
				// Line continuations join identifiers, as in C, so a split
				// spelling still reads as the same call.
				if script[j] == '\\' && j+1 < n && script[j+1] == '\n' {
					j += 2
					continue
				}
				if script[j] == '\\' && j+2 < n && script[j+1] == '\r' && script[j+2] == '\n' {
					j += 3
					continue
				}
				break
			}
			toks = append(toks, scriptToken{kind: tokIdent, text: sb.String()})
			cleaned.WriteString(sb.String())
			i = j
		case isASCIIDigit(c):
			var nb strings.Builder
			j := i
			for j < n {
				if isASCIILetter(script[j]) || isASCIIDigit(script[j]) || script[j] == '.' {
					nb.WriteByte(script[j])
					j++
					continue
				}
				if script[j] == '\\' && j+1 < n && script[j+1] == '\n' {
					j += 2
					continue
				}
				if script[j] == '\\' && j+2 < n && script[j+1] == '\r' && script[j+2] == '\n' {
					j += 3
					continue
				}
				break
			}
			toks = append(toks, scriptToken{kind: tokNumber, text: nb.String()})
			cleaned.WriteString(nb.String())
			i = j
		default:
			toks = append(toks, scriptToken{kind: tokPunct, text: script[i : i+1]})
			cleaned.WriteByte(c)
			i++
		}
	}
	return toks, cleaned.String(), errs
}

// collectCalls records every identifier call site: an identifier whose next
// non-comment token is an opening paren. Comment-split, whitespace-split, and
// line-continued spellings still read as calls; split identifiers cannot.
// A name in macro-definition position at depth 0 is a definition, not a call.
func collectCalls(toks []scriptToken) (calls []string, tooDeep bool) {
	depth := 0
	maxDepth := 0
	prevIdent := ""
	for idx, t := range toks {
		if t.kind == tokComment {
			continue
		}
		call := false
		if t.kind == tokPunct && len(t.text) == 1 {
			switch t.text[0] {
			case '(', '{', '[':
				depth++
				if depth > maxDepth {
					maxDepth = depth
				}
			case ')', '}', ']':
				if depth > 0 {
					depth--
				}
			}
		} else if t.kind == tokIdent && !callKeywords[t.text] && (prevIdent != "macro" || depth > 0) {
			j := idx + 1
			for j < len(toks) && toks[j].kind == tokComment {
				j++
			}
			if j < len(toks) && toks[j].kind == tokPunct && toks[j].text == "(" {
				call = true
			}
		}
		if call {
			calls = append(calls, t.text)
		}
		if t.kind == tokIdent {
			prevIdent = t.text
		} else {
			prevIdent = ""
		}
	}
	return calls, maxDepth > maxNestingDepth
}

// checkCalls enforces default-deny: every recorded call must be allowlisted,
// with denylisted calls rejected under their own message.
func checkCalls(calls []string) []string {
	seen := map[string]bool{}
	var errs []string
	for _, name := range calls {
		if seen[name] {
			continue
		}
		seen[name] = true
		if deniedCalls[name] {
			errs = append(errs, "blocked call: "+name+" is forbidden")
		} else if !allowedCalls[name] {
			errs = append(errs, "unknown function call: "+name+" is not allowlisted")
		}
	}
	sort.Strings(errs)
	return errs
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

// StaticValidate fails closed until the catalog is ready, then applies blocklist,
// allowlist, and size rules (no exec).
func StaticValidate(script string, catalog *Catalog) ValidateResult {
	if catalog == nil || !catalog.Ready() {
		return ValidateResult{
			Code:     "CATALOG_UNAVAILABLE",
			Probes:   []string{},
			Errors:   []string{"catalog unavailable: probe catalog not ready"},
			Warnings: []string{},
		}
	}
	if strings.TrimSpace(script) == "" {
		return ValidateResult{
			Code:     "VALIDATION_FAILED",
			Probes:   []string{},
			Errors:   []string{"empty script"},
			Warnings: []string{},
		}
	}
	if len(script) > MaxScriptBytes {
		return ValidateResult{
			Code:     "VALIDATION_FAILED",
			Probes:   []string{},
			Errors:   []string{"script exceeds 8 KB"},
			Warnings: []string{},
		}
	}
	var errors []string
	var warnings []string
	seenHotSym := map[string]bool{}
	toks, cleaned, lexErrs := lexScript(script)
	errors = append(errors, lexErrs...)
	calls, tooDeep := collectCalls(toks)
	if tooDeep {
		errors = append(errors, "script too complex: nesting too deep")
	}
	errors = append(errors, checkCalls(calls)...)
	probes, parseErrs := extractProbes(cleaned)
	errors = append(errors, parseErrs...)
	if len(probes) == 0 && len(parseErrs) == 0 {
		errors = append(errors, "no probes found")
	}
	known := map[string]bool{}
	for _, p := range catalog.Snapshot() {
		known[p] = true
	}
	probeCount := 0
	exceededByWildcard := false
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
			if strings.ContainsAny(pr, "*?[]") {
				errors = append(errors, "wildcard not allowed on provider "+provider+": "+pr)
				continue
			}
			_, target, symbol, ok := parseUprobeProbe(pr)
			if !ok {
				errors = append(errors, "invalid uprobe target: missing symbol in "+pr)
				continue
			}
			if !isAllowedLibcTarget(target) {
				errors = append(errors, "uprobe must target libc or canonical libc path: "+pr)
				continue
			}
			if !uprobeSymbolRe.MatchString(symbol) {
				errors = append(errors, "invalid uprobe symbol: "+symbol+" in "+pr)
				continue
			}
			if isHotLibcSymbol(symbol) && !seenHotSym[symbol] {
				seenHotSym[symbol] = true
				warnings = append(warnings, fmt.Sprintf("Hot libc symbol %q fires at high frequency; rely on in-kernel aggregation and agent rate caps.", symbol))
			}
			probeCount++
			continue
		}
		if strings.ContainsAny(pr, "*?[]") {
			if werr := validateWildcardShape(pr, provider); werr != "" {
				errors = append(errors, werr)
				continue
			}
			n := expandCount(pr, known)
			if n == 0 {
				errors = append(errors, "probe not found: "+pr+suggestProbes(pr, known))
			} else if n > limits.MaxProbes {
				errors = append(errors, fmt.Sprintf("wildcard expands to too many probes: %s (%d exceeds max %d)", pr, n, limits.MaxProbes))
				exceededByWildcard = true
			} else {
				warnings = append(warnings, fmt.Sprintf("Wildcard probe %s expands to %d probes; capped at %d.", pr, n, limits.MaxProbes))
			}
			probeCount += n
			continue
		}
		probeCount++
		if provider != "profile" && provider != "interval" && provider != "software" && provider != "BEGIN" && provider != "END" {
			if !known[pr] {
				errors = append(errors, "probe not found: "+pr+suggestProbes(pr, known))
			}
		}
	}
	if probeCount > limits.MaxProbes && !exceededByWildcard {
		errors = append(errors, fmt.Sprintf("too many probes: script attaches %d probes (limit %d)", probeCount, limits.MaxProbes))
	}
	code := ""
	if len(errors) > 0 {
		code = classifyValidationError(errors)
		errors = truncateValidatorErrors(errors)
	}
	warnings = truncateValidatorErrors(warnings)
	return ValidateResult{
		Code:       code,
		Probes:     probesOrEmpty(probes),
		Errors:     errorsOrEmpty(errors),
		Warnings:   errorsOrEmpty(warnings),
		ProbeCount: probeCount,
	}
}

func validateWildcardShape(pr, provider string) string {
	if provider != "tracepoint" && provider != "kprobe" && provider != "kretprobe" {
		return "wildcard not allowed on provider " + provider + ": " + pr
	}
	if strings.ContainsAny(pr, "?[]") || strings.Count(pr, "*") != 1 || !strings.HasSuffix(pr, "*") {
		return "invalid wildcard pattern: " + pr
	}
	rest := strings.TrimPrefix(pr, provider+":")
	if provider == "tracepoint" {
		// No prefix-length floor: tracepoint patterns are catalog-bounded
		// (subsys must match a known catalog entry, expansion capped at
		// MaxProbes), while kprobe matches an unbounded kernel symbol
		// namespace and needs the >=3 floor below.
		subsys, event, ok := strings.Cut(rest, ":")
		if !ok || subsys == "" || strings.Contains(event, ":") {
			return "invalid wildcard pattern: " + pr
		}
		return ""
	}
	prefix := strings.TrimSuffix(rest, "*")
	if strings.Contains(prefix, ":") {
		return "invalid wildcard pattern: " + pr
	}
	if len(prefix) < 3 {
		return "wildcard too broad: " + pr
	}
	return ""
}

func suggestProbes(pr string, known map[string]bool) string {
	if len(known) == 0 {
		return ""
	}
	colon := strings.IndexByte(pr, ':')
	provider := pr
	if colon >= 0 {
		provider = pr[:colon]
	}
	cleanTarget := strings.TrimSuffix(pr, "*")
	searchPrefix := provider + ":"
	if colon >= 0 && provider == "tracepoint" {
		if second := strings.IndexByte(cleanTarget[colon+1:], ':'); second > 0 {
			searchPrefix = cleanTarget[:colon+1+second+1]
		}
	}
	// Prefer the full pre-* prefix so long names narrow to their own
	// family before falling back to the short stem and provider scope.
	var candidates []string
	for k := range known {
		if !strings.HasPrefix(k, searchPrefix) {
			continue
		}
		if provider == "tracepoint" {
			if strings.HasPrefix(k, cleanTarget) {
				candidates = append(candidates, k)
			}
		} else if strings.HasPrefix(k, cleanTarget) {
			candidates = append(candidates, k)
		}
	}
	if len(candidates) == 0 {
		targetStem := cleanTarget
		if len(targetStem) > len(provider)+4 {
			targetStem = targetStem[:len(provider)+4]
		}
		for k := range known {
			if provider == "tracepoint" {
				if strings.HasPrefix(k, searchPrefix) {
					candidates = append(candidates, k)
				}
			} else if strings.HasPrefix(k, provider+":") && strings.HasPrefix(k, targetStem) {
				candidates = append(candidates, k)
			}
		}
	}
	if len(candidates) == 0 {
		for k := range known {
			if strings.HasPrefix(k, provider+":") {
				candidates = append(candidates, k)
			}
		}
	}
	if len(candidates) == 0 {
		return ""
	}
	sort.Strings(candidates)
	if len(candidates) > 3 {
		candidates = candidates[:3]
	}
	return fmt.Sprintf(" (did you mean: %s?)", strings.Join(candidates, ", "))
}

func probesOrEmpty(p []string) []string {
	if p == nil {
		return []string{}
	}
	return p
}

func errorsOrEmpty(e []string) []string {
	if e == nil {
		return []string{}
	}
	return e
}

func expandCount(pattern string, known map[string]bool) int {
	star := strings.IndexByte(pattern, '*')
	if star < 0 {
		return 0
	}
	prefix := pattern[:star]
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
