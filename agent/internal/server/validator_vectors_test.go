package server

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

// Shared parity vectors (I-04, decision D-70): the same file consumed by the
// TS suite. Scope is the static layer only — StaticValidate, not host
// uprobe-FS checks or bpftrace dry-run, which are agent-only by nature.
// Both sides assert identical ok verdicts and taxonomy codes; message text
// may differ.

type validatorVectorExpect struct {
	OK         bool     `json:"ok"`
	ErrorCodes []string `json:"error_codes"`
}

type validatorVector struct {
	ID      string                `json:"id"`
	Script  string                `json:"script"`
	Catalog string                `json:"catalog"`
	Known   []string              `json:"known"`
	Expect  validatorVectorExpect `json:"expect"`
}

var validatorVectorCodes = map[string]bool{
	"CATALOG_UNAVAILABLE": true,
	"VALIDATION_FAILED":   true,
	"PROBE_NOT_FOUND":     true,
	"LIMIT_EXCEEDED":      true,
	"BLOCKED_CALL":        true,
	"UNKNOWN_CALL":        true,
}

var validatorVectorIDRe = regexp.MustCompile(`^[a-z0-9-]+$`)

func loadValidatorVectors(t *testing.T) []validatorVector {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	require.True(t, ok)
	path := filepath.Join(filepath.Dir(file), "..", "..", "..", "packages", "schemas", "validator-vectors.json")
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var vectors []validatorVector
	require.NoError(t, json.Unmarshal(raw, &vectors))
	require.NotEmpty(t, vectors)
	return vectors
}

// vectorCatalog mirrors the TS harness catalog modes: enforce uses the
// vector's own known list (empty stays unready, pinning fail-closed), skip
// uses a minimal ready catalog since Go has no skip mode and every skip
// vector only uses catalog-exempt probes.
func vectorCatalog(t *testing.T, v validatorVector) *Catalog {
	t.Helper()
	if v.Catalog == "enforce" && len(v.Known) == 0 {
		return NewCatalog("", func(ctx context.Context) ([]string, error) {
			return nil, errors.New("empty catalog")
		})
	}
	known := v.Known
	if v.Catalog == "skip" {
		known = []string{"BEGIN"}
	}
	cat := NewCatalog("", func(ctx context.Context) ([]string, error) {
		return known, nil
	})
	require.NoError(t, cat.Refresh(context.Background()))
	return cat
}

func TestValidatorVectors(t *testing.T) {
	vectors := loadValidatorVectors(t)
	require.GreaterOrEqual(t, len(vectors), 50)
	seen := map[string]bool{}
	for _, v := range vectors {
		require.Regexp(t, validatorVectorIDRe, v.ID)
		require.NotContains(t, seen, v.ID, "duplicate vector id")
		seen[v.ID] = true
		require.Contains(t, []string{"enforce", "skip"}, v.Catalog)
		for _, c := range v.Expect.ErrorCodes {
			require.Contains(t, validatorVectorCodes, c, "unknown code in %s", v.ID)
		}
	}

	for _, v := range vectors {
		t.Run(v.ID, func(t *testing.T) {
			res := StaticValidate(v.Script, vectorCatalog(t, v))
			if v.Expect.OK {
				require.Empty(t, res.Errors)
				require.Empty(t, res.Code)
				require.Empty(t, v.Expect.ErrorCodes)
				return
			}
			require.NotEmpty(t, res.Errors)
			require.Len(t, v.Expect.ErrorCodes, 1)
			require.Equal(t, v.Expect.ErrorCodes[0], res.Code)
		})
	}
}
