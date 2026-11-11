package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/faizan1250/vBPF/agent/internal/limits"
	"github.com/stretchr/testify/require"
)

func wildcardCatalog(t *testing.T) *Catalog {
	t.Helper()
	var probes []string
	probes = append(probes,
		"tracepoint:block:block_rq_issue",
		"tracepoint:block:block_rq_complete",
		"tracepoint:block:block_bio_queue",
		"tracepoint:syscalls:sys_enter_openat",
		"tracepoint:syscalls:sys_enter_read",
		"kprobe:vfs_read",
		"kprobe:vfs_write",
		"kretprobe:tcp_v4_connect",
	)
	for i := 0; i < 30; i++ {
		probes = append(probes, fmt.Sprintf("tracepoint:sched:sched_%02d", i))
	}
	for i := 0; i < 25; i++ {
		probes = append(probes, fmt.Sprintf("tracepoint:net:net_%02d", i))
	}
	cat := NewCatalog("", func(ctx context.Context) ([]string, error) {
		return probes, nil
	})
	require.NoError(t, cat.Refresh(context.Background()))
	return cat
}

func TestWildcardAllowedAndRejectedShapes(t *testing.T) {
	cat := wildcardCatalog(t)

	valid := []struct {
		script    string
		wantCount int
	}{
		{"tracepoint:block:* { @x = count(); }", 3},
		{"tracepoint:syscalls:sys_enter_* { @x = count(); }", 2},
		{"kprobe:vfs_* { @x = count(); }", 2},
		{"kretprobe:tcp_* { @x = count(); }", 1},
	}
	for _, tc := range valid {
		res := StaticValidate(tc.script, cat)
		require.Empty(t, res.Errors, tc.script)
		require.Equal(t, tc.wantCount, res.ProbeCount, tc.script)
		require.NotEmpty(t, res.Warnings, tc.script)
		require.Contains(t, strings.Join(res.Warnings, " "), "expands to")
	}

	rejected := []struct {
		name   string
		script string
	}{
		{"bare star", `* { @x = count(); }`},
		{"kprobe bare star", `kprobe:* { @x = count(); }`},
		{"kretprobe bare star", `kretprobe:* { @x = count(); }`},
		{"kprobe 1 char prefix", `kprobe:v* { @x = count(); }`},
		{"kprobe 2 char prefix", `kprobe:vf* { @x = count(); }`},
		{"kretprobe 2 char prefix", `kretprobe:tc* { @x = count(); }`},
		{"tracepoint star subsys", `tracepoint:*:block_rq_issue { @x = count(); }`},
		{"tracepoint double star", `tracepoint:*:* { @x = count(); }`},
		{"tracepoint subsys wildcard prefix", `tracepoint:blo*:block_rq_issue { @x = count(); }`},
		{"tracepoint missing event star", `tracepoint:block* { @x = count(); }`},
		{"tracepoint leading star", `tracepoint:block:*_rq_issue { @x = count(); }`},
		{"kprobe middle star", `kprobe:vfs_*_read { @x = count(); }`},
		{"multiple stars", `tracepoint:block:*rq* { @x = count(); }`},
		{"question mark", `kprobe:vfs_rea? { @x = count(); }`},
		{"char class", `kprobe:vfs_[rw]* { @x = count(); }`},
		{"kprobe colon in wildcard", `kprobe:a:b* { @x = count(); }`},
		{"uprobe wildcard", `uprobe:libc:m* { @x = count(); }`},
		{"uretprobe wildcard", `uretprobe:/lib/libc.so.6:m* { @x = count(); }`},
		{"profile wildcard", `profile:hz:* { @x = count(); }`},
		{"interval wildcard", `interval:s:* { @x = count(); }`},
		{"software wildcard", `software:page-* { @x = count(); }`},
	}
	for _, tc := range rejected {
		t.Run(tc.name, func(t *testing.T) {
			res := StaticValidate(tc.script, cat)
			require.NotEmpty(t, res.Errors, tc.script)
			require.Equal(t, "VALIDATION_FAILED", res.Code, "errors=%v", res.Errors)
		})
	}
}

func TestWildcardZeroMatchIncludesSuggestions(t *testing.T) {
	cat := wildcardCatalog(t)
	res := StaticValidate("tracepoint:block:missing_* { @x = count(); }", cat)
	require.Equal(t, "PROBE_NOT_FOUND", res.Code)
	require.Contains(t, strings.Join(res.Errors, "; "), "did you mean: tracepoint:block:")

	resK := StaticValidate("kprobe:vfs_missing* { @x = count(); }", cat)
	require.Equal(t, "PROBE_NOT_FOUND", resK.Code)
	require.Contains(t, strings.Join(resK.Errors, "; "), "did you mean: kprobe:vfs_read, kprobe:vfs_write")
}

func TestSuggestProbesPrefersFullPrefix(t *testing.T) {
	known := map[string]bool{
		"kprobe:vfs_read":     true,
		"kprobe:vfs_readlink": true,
		"kprobe:vfs_write":    true,
	}
	got := suggestProbes("kprobe:vfs_readlin", known)
	require.Contains(t, got, "kprobe:vfs_readlink")
	require.NotContains(t, got, "kprobe:vfs_write")
}

func TestTracepointShortPrefixHasNoFloor(t *testing.T) {
	cat := wildcardCatalog(t)
	// Catalog-bounded: a 1-char event prefix still passes shape checks and
	// resolves via the catalog (or reports PROBE_NOT_FOUND, never too broad).
	res := StaticValidate("tracepoint:block:a* { @x = count(); }", cat)
	require.NotContains(t, strings.Join(res.Errors, "; "), "wildcard too broad")
	resK := StaticValidate("kprobe:vf* { @x = count(); }", cat)
	require.Contains(t, strings.Join(resK.Errors, "; "), "wildcard too broad")
}

func TestMaxProbesOccurrenceSumAndEndpointProbeCount(t *testing.T) {
	cat := wildcardCatalog(t)

	// Duplicates in comma lists and separate blocks count per occurrence.
	exactly50 := strings.Repeat("tracepoint:block:block_rq_issue { @x = count(); }\n", limits.MaxProbes)
	res50 := StaticValidate(exactly50, cat)
	require.Empty(t, res50.Errors)
	require.Equal(t, 50, res50.ProbeCount)

	over51 := exactly50 + "BEGIN {}"
	res51 := StaticValidate(over51, cat)
	require.Equal(t, "LIMIT_EXCEEDED", res51.Code)
	require.Equal(t, 51, res51.ProbeCount)
	require.Contains(t, strings.Join(res51.Errors, " "), "too many probes:")

	commaDup := "tracepoint:sched:* , tracepoint:net:* { @x = count(); }"
	resSum := StaticValidate(commaDup, cat)
	require.Equal(t, "LIMIT_EXCEEDED", resSum.Code)
	require.Equal(t, 55, resSum.ProbeCount)

	// Duplicate wildcard expands twice (30 + 30 = 60 > 50).
	dupWild := "tracepoint:sched:* { @a = count(); }\ntracepoint:sched:* { @b = count(); }"
	resDupWild := StaticValidate(dupWild, cat)
	require.Equal(t, "LIMIT_EXCEEDED", resDupWild.Code)
	require.Equal(t, 60, resDupWild.ProbeCount)

	// Validate HTTP endpoint returns expanded probe_count + warnings cleanly.
	s := testServer(t, Config{CatalogFn: func(ctx context.Context) ([]string, error) {
		return cat.Snapshot(), nil
	}})
	require.NoError(t, s.catalog.Refresh(context.Background()))

	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "POST", "/v1/validate", `{"script":"tracepoint:block:*, BEGIN { @x = count(); }"}`))
	require.Equal(t, http.StatusOK, w.Code)
	var out struct {
		OK         bool     `json:"ok"`
		ProbeCount int      `json:"probe_count"`
		Probes     []string `json:"probes"`
		Warnings   []string `json:"warnings"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.True(t, out.OK)
	require.Len(t, out.Probes, 2)
	require.Equal(t, 4, out.ProbeCount)
	require.NotEmpty(t, out.Warnings)
}
