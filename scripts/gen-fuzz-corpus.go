// Command gen-fuzz-corpus regenerates the committed Go fuzz seed corpora for
// I-05 from recipes, shared validator vectors, committed eval scripts, and
// parser fixtures. Run from the agent module:
//
//	cd agent && go run ../scripts/gen-fuzz-corpus.go
//
// Output lands in agent/internal/{server,parser}/testdata/fuzz/... in the
// `go test fuzz v1` corpus format, so plain `go test ./...` executes every
// file as a seed. The file is stdlib-only and lives outside the agent
// module on purpose (ad-hoc `go run`, never built or vetted).
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
)

var headerRe = regexp.MustCompile(`[A-Za-z]+:[^\s{},;"/]*`)

var fixedUprobe = []string{
	"uprobe:libc:malloc",
	"uretprobe:libc:free",
	"uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc",
	"uprobe:/bin/ls:main",
	"uprobe:libc",
	"kprobe:vfs_read",
	"uprobe:libc:mal*",
	"uprobe:/lib//libc.so.6:m",
}

var fixedWildcard = []string{
	"tracepoint:block:*",
	"kprobe:vfs_*",
	"kprobe:ab*",
	"tracepoint:*:*",
	"*",
	"kprobe:vfs_rea?",
	"uprobe:libc:m*",
	"profile:hz:*",
	"kprobe:a:b*",
}

func readScripts(root string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(s string) {
		if s == "" || seen[s] {
			return
		}
		seen[s] = true
		out = append(out, s)
	}
	mk, _ := filepath.Glob(filepath.Join(root, "recipes", "*.bt"))
	sort.Strings(mk)
	for _, p := range mk {
		raw, err := os.ReadFile(p)
		if err != nil {
			panic(err)
		}
		add(string(raw))
	}
	var vectors []struct {
		Script string `json:"script"`
	}
	raw, err := os.ReadFile(filepath.Join(root, "packages", "schemas", "validator-vectors.json"))
	if err != nil {
		panic(err)
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		panic(err)
	}
	for _, v := range vectors {
		add(v.Script)
	}
	nd, err := os.ReadFile(filepath.Join(root, "eval", "reports", "2026-11-10-live-real-scripts.ndjson"))
	if err != nil {
		panic(err)
	}
	var rec struct {
		Script string `json:"script"`
	}
	for _, line := range splitLines(string(nd)) {
		if line == "" {
			continue
		}
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			panic(err)
		}
		add(rec.Script)
	}
	return out
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}

func writeCorpus(dir string, values []string, asBytes bool) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		panic(err)
	}
	// Clear stale generated files (all start with "seed") so renames shrink
	// the corpus instead of leaving orphans.
	old, _ := filepath.Glob(filepath.Join(dir, "seed*"))
	for _, p := range old {
		if err := os.Remove(p); err != nil {
			panic(err)
		}
	}
	kind := "string"
	if asBytes {
		kind = "[]byte"
	}
	for i, v := range values {
		name := filepath.Join(dir, fmt.Sprintf("seed%03d", i))
		body := "go test fuzz v1\n" + kind + "(" + strconv.Quote(v) + ")\n"
		if err := os.WriteFile(name, []byte(body), 0o644); err != nil {
			panic(err)
		}
	}
	fmt.Printf("%s: %d seeds\n", dir, len(values))
}

func main() {
	if len(os.Args) != 1 {
		panic("no arguments expected; run from the agent module dir")
	}
	cwd, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	// Generator runs with CWD=agent/; repo root is the parent.
	root := filepath.Dir(cwd)
	scripts := readScripts(root)
	fmt.Printf("scripts: %d\n", len(scripts))

	serverFuzz := filepath.Join(cwd, "internal", "server", "testdata", "fuzz")
	writeCorpus(filepath.Join(serverFuzz, "FuzzValidateStatic"), scripts, false)
	writeCorpus(filepath.Join(serverFuzz, "FuzzLexer"), scripts, false)

	seen := map[string]bool{}
	var headers []string
	for _, s := range scripts {
		for _, h := range headerRe.FindAllString(s, -1) {
			if !seen[h] {
				seen[h] = true
				headers = append(headers, h)
			}
		}
	}
	sort.Strings(headers)
	uprobe := append(append([]string{}, fixedUprobe...), headers...)
	writeCorpus(filepath.Join(serverFuzz, "FuzzUprobeTarget"), uprobe, false)
	var wild []string
	for _, h := range headers {
		for _, c := range "*?[]" {
			if containsRune(h, c) {
				wild = append(wild, h)
				break
			}
		}
	}
	wild = append(fixedWildcard, wild...)
	writeCorpus(filepath.Join(serverFuzz, "FuzzWildcard"), wild, false)

	parserFuzz := filepath.Join(cwd, "internal", "parser", "testdata", "fuzz")
	fixs, _ := filepath.Glob(filepath.Join(root, "fixtures", "*.ndjson"))
	sort.Strings(fixs)
	var lines []string
	var streams []string
	for _, p := range fixs {
		raw, err := os.ReadFile(p)
		if err != nil {
			panic(err)
		}
		streams = append(streams, string(raw))
		for _, ln := range splitLines(string(raw)) {
			if ln != "" {
				lines = append(lines, ln)
			}
		}
	}
	writeCorpus(filepath.Join(parserFuzz, "FuzzParseLine"), lines, true)
	writeCorpus(filepath.Join(parserFuzz, "FuzzStream"), streams, true)
}

func containsRune(s string, r rune) bool {
	for _, c := range s {
		if c == r {
			return true
		}
	}
	return false
}
