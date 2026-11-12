//go:build integration && linux

package server

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Differential oracle (I-05): every script the validator accepts must not be
// a script bpftrace itself flags as unsafe. Runs `bpftrace --dry-run` (or
// `-d`) without `--unsafe` over recipes, shared vectors, and deterministic
// single-point mutants. Needs Linux + bpftrace; use `make
// test-differential`. Validator-stricter disagreements are logged, not
// failures: the validator is intentionally stricter than the compiler.

func differentialCorpus(t *testing.T) []string {
	t.Helper()
	var seeds []string
	addFile := func(path string) {
		raw, err := os.ReadFile(path)
		require.NoError(t, err)
		if s := strings.TrimSpace(string(raw)); s != "" {
			seeds = append(seeds, s)
		}
	}
	recipes, err := filepath.Glob(filepath.Join("..", "..", "..", "recipes", "*.bt"))
	require.NoError(t, err)
	require.NotEmpty(t, recipes, "no recipes found")
	for _, r := range recipes {
		addFile(r)
	}
	for _, v := range loadValidatorVectors(t) {
		if strings.TrimSpace(v.Script) != "" {
			seeds = append(seeds, v.Script)
		}
	}
	out := make([]string, 0, len(seeds)*2)
	out = append(out, seeds...)
	// Deterministic mutants: one denied-call and one unknown-call injection
	// per recipe (vectors already cover call smuggling shapes).
	inject := func(script, call string) string {
		if i := strings.LastIndex(script, "}"); i >= 0 {
			return script[:i] + " " + call + " " + script[i:]
		}
		return script + "\nBEGIN { " + call + " }"
	}
	for _, r := range recipes {
		raw, err := os.ReadFile(r)
		require.NoError(t, err)
		base := strings.TrimSpace(string(raw))
		out = append(out, inject(base, `system("id");`))
		out = append(out, inject(base, `nosuchfn_vbpf(1);`))
	}
	return out
}

func TestDifferentialOracle(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("differential oracle needs linux + bpftrace")
	}
	if _, err := exec.LookPath("bpftrace"); err != nil {
		t.Skip("bpftrace not installed")
	}
	cat := NewCatalog("bpftrace", nil)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := cat.Refresh(ctx); err != nil {
		t.Skipf("real catalog unavailable: %v", err)
	}
	dryRun := DefaultDryRun("bpftrace")
	corpus := differentialCorpus(t)
	require.NotEmpty(t, corpus)

	var unsafeAccepted, validatorStricter, agreements int
	for i, script := range corpus {
		sctx, scancel := context.WithTimeout(context.Background(), 30*time.Second)
		res := StaticValidate(script, cat)
		out := dryRun(sctx, script)
		scancel()
		accepted := len(res.Errors) == 0
		if out == nil {
			if accepted {
				agreements++
			} else {
				validatorStricter++
				t.Logf("case %d: validator stricter (code=%s): %.120s", i, res.Code, script)
			}
			continue
		}
		verdict := parseDryRunVerdict(strings.Join(out, "\n"))
		if verdict.unsupportedFlag {
			t.Skipf("this bpftrace lacks --dry-run/-d: %s", strings.Join(out, "; "))
		}
		switch {
		case verdict.unsafeFunc && accepted:
			unsafeAccepted++
			t.Errorf("case %d: bpftrace flags unsafe but validator accepts: %.200s\nbpftrace: %.300s",
				i, script, strings.Join(out, "; "))
		case verdict.unsafeFunc:
			agreements++
		case accepted:
			validatorStricter++
			t.Logf("case %d: dry-run failed (%s) but validator accepts: %.120s",
				i, strings.Join(out, "; "), script)
		default:
			agreements++
		}
	}
	t.Logf("oracle: %d agreements, %d validator-stricter, %d unsafe-accepted (must be 0)",
		agreements, validatorStricter, unsafeAccepted)
	require.Zero(t, unsafeAccepted, "validator accepted scripts bpftrace flags as unsafe")
}
