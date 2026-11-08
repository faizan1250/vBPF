package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/faizan1250/vBPF/agent/internal/parser"
)

func TestUsage(t *testing.T) {
	for _, args := range [][]string{
		{},
		{"bogus"},
		{"run"},
		{"run", "a.bt", "b.bt"},
		{"run", "a.bt", "--duration", "99"},
		{"run", "a.bt", "--duration", "0"},
	} {
		if got := realMain(args, &bytes.Buffer{}, &bytes.Buffer{}); got != 2 {
			t.Fatalf("args %v: got %d want 2", args, got)
		}
	}
}

func TestMissingFile(t *testing.T) {
	if got := realMain([]string{"run", "nonexistent.bt"}, &bytes.Buffer{}, &bytes.Buffer{}); got == 0 {
		t.Fatal("expected non-zero exit")
	}
}

func TestRunWithFake(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "test.bt")
	if err := os.WriteFile(script, []byte("BEGIN { @x = count(); }\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BPFTRACE_PATH", fakeScript(t))
	t.Setenv("FAKE_MODE", "exit0")

	var stdout, stderr bytes.Buffer
	if got := realMain([]string{"run", script, "--duration", "1"}, &stdout, &stderr); got != 0 {
		t.Fatalf("exit=%d stderr=%s", got, stderr.String())
	}
	var kinds []string
	for _, line := range strings.Split(strings.TrimSpace(stdout.String()), "\n") {
		var ev parser.Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("bad event line %q: %v", line, err)
		}
		if ev.RunID == "" || ev.Ts <= 0 {
			t.Fatalf("bad envelope %+v", ev)
		}
		kinds = append(kinds, ev.Kind)
	}
	if len(kinds) < 2 || kinds[0] != parser.KindStatus || kinds[len(kinds)-1] != parser.KindSummary {
		t.Fatalf("kinds=%v", kinds)
	}
}

func fakeScript(t *testing.T) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join("..", "..", "..", "scripts", "fake-bpftrace.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Skipf("fake-bpftrace not found: %v", err)
	}
	return p
}

// The agent must never build a bpftrace command line with the unsafe flag
// (needle assembled at runtime so this guard cannot match itself).
func TestNoUnsafeFlag(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	needle := "--" + "unsafe"
	var hits []string
	err = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || (!strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, ".sh")) {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(raw), needle) {
			hits = append(hits, path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 0 {
		t.Fatalf("%s found in: %v", needle, hits)
	}
}
