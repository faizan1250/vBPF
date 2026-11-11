package server

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func readyMinimalCatalog(t *testing.T) *Catalog {
	t.Helper()
	cat := NewCatalog("", func(ctx context.Context) ([]string, error) {
		return []string{"tracepoint:block:block_rq_issue", "kprobe:do_sys_open"}, nil
	})
	require.NoError(t, cat.Refresh(context.Background()))
	return cat
}

func TestUprobeLibcAllowlistAndSymbols(t *testing.T) {
	cat := readyMinimalCatalog(t)

	valid := []string{
		`uprobe:libc:malloc { @x = count(); }`,
		`uretprobe:libc:getaddrinfo { @x = count(); }`,
		`uprobe:/lib/libc.so.6:malloc { @x = count(); }`,
		`uprobe:/lib64/libc.so:calloc { @x = count(); }`,
		`uprobe:/usr/lib/libc.so.6:free { @x = count(); }`,
		`uprobe:/usr/lib64/libc-2.31.so:getaddrinfo { @x = count(); }`,
		`uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc { @x = count(); }`,
		`uretprobe:/usr/lib/aarch64-linux-gnu/libc.so.6:_pthread_cleanup_push { @x = count(); }`,
	}
	for _, script := range valid {
		res := StaticValidate(script, cat)
		require.Empty(t, res.Errors, script)
		require.Equal(t, 1, res.ProbeCount, script)
	}

	rejected := []struct {
		name   string
		script string
	}{
		{"usdt rejected", `usdt:/lib/x86_64-linux-gnu/libc.so.6:probe { @x = count(); }`},
		{"non-libc binary", `uprobe:/bin/ls:main { @x = count(); }`},
		{"tmp libc path", `uprobe:/tmp/libc.so.6:malloc { @x = count(); }`},
		{"nested sub-subdir", `uprobe:/lib/x86_64-linux-gnu/evil/libc.so.6:malloc { @x = count(); }`},
		{"non-multiarch subdir", `uprobe:/lib/evil/libc.so.6:malloc { @x = count(); }`},
		{"dotdot traversal", `uprobe:/lib/../usr/lib/libc.so.6:malloc { @x = count(); }`},
		{"dot segment", `uprobe:/lib/./libc.so.6:malloc { @x = count(); }`},
		{"double slash", `uprobe:/lib//libc.so.6:malloc { @x = count(); }`},
		{"trailing slash", `uprobe:/lib/libc.so.6/:malloc { @x = count(); }`},
		{"non-libc libcrypt", `uprobe:/lib/libcrypt.so.1:crypt { @x = count(); }`},
		{"non-libc libcpp", `uprobe:/lib/libc++.so.6:malloc { @x = count(); }`},
		{"missing symbol colon", `uprobe:libc { @x = count(); }`},
		{"plus offset symbol", `uprobe:libc:malloc+0x10 { @x = count(); }`},
		{"raw hex address", `uprobe:libc:0x401000 { @x = count(); }`},
		{"wildcard star symbol", `uprobe:libc:* { @x = count(); }`},
		{"wildcard prefix symbol", `uprobe:libc:mal* { @x = count(); }`},
		{"wildcard question symbol", `uprobe:libc:m?lloc { @x = count(); }`},
		{"extra colon segment", `uprobe:/lib/libc.so.6:malloc:extra { @x = count(); }`},
		{"quoted cpp signature", `uprobe:/lib/libc.so.6:"Foo::bar(int, int)" { @x = count(); }`},
	}
	for _, tc := range rejected {
		t.Run(tc.name, func(t *testing.T) {
			res := StaticValidate(tc.script, cat)
			require.NotEmpty(t, res.Errors, tc.script)
			require.Equal(t, "VALIDATION_FAILED", res.Code, "errors=%v", res.Errors)
		})
	}
}

func TestUprobeHotSymbolWarnings(t *testing.T) {
	cat := readyMinimalCatalog(t)
	for _, sym := range []string{"malloc", "free", "memcpy", "memset", "strlen", "read", "write"} {
		res := StaticValidate("uprobe:libc:"+sym+" { @x = count(); }", cat)
		require.Empty(t, res.Errors, sym)
		require.NotEmpty(t, res.Warnings, sym)
		require.Contains(t, strings.Join(res.Warnings, " "), sym)
	}

	dup := StaticValidate("uprobe:libc:malloc { @a = count(); }\nuretprobe:libc:malloc { @b = count(); }", cat)
	require.Empty(t, dup.Errors)
	require.Len(t, dup.Warnings, 1)

	cold := StaticValidate("uprobe:libc:getaddrinfo { @x = count(); }", cat)
	require.Empty(t, cold.Errors)
	require.Empty(t, cold.Warnings)
}

func makeFakeLibcFile(t *testing.T, root, virtPath string, mode fs.FileMode) string {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(virtPath, "/")))
	require.NoError(t, os.MkdirAll(filepath.Dir(full), 0o755))
	require.NoError(t, os.WriteFile(full, []byte("ELF"), 0o444))
	require.NoError(t, os.Chmod(full, mode))
	return full
}

func TestUprobeHostFSChecksAndListProbe(t *testing.T) {
	root := t.TempDir()
	const validPath = "/lib/x86_64-linux-gnu/libc.so.6"
	makeFakeLibcFile(t, root, validPath, 0o444)

	var listed []string
	var dryRunCalls int
	chk := &UprobeChecker{
		FSRoot:      root,
		IsRootOwned: func(fs.FileInfo) bool { return true },
		ListProbe: func(ctx context.Context, probe string) ([]string, error) {
			listed = append(listed, probe)
			if strings.HasSuffix(probe, ":getaddrinfo") {
				return []string{probe}, nil
			}
			return nil, nil
		},
	}

	s := testServer(t, Config{
		UprobeCheck: chk,
		DryRun: func(ctx context.Context, script string) []string {
			dryRunCalls++
			return nil
		},
	})

	// Valid uretprobe queries `uretprobe:<path>:<symbol>` via -l and still executes dry-run.
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "POST", "/v1/validate", `{"script":"uretprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo { @x = count(); }"}`))
	require.Equal(t, http.StatusOK, w.Code)
	var valOut struct {
		OK         bool     `json:"ok"`
		Errors     []string `json:"errors"`
		ProbeCount int      `json:"probe_count"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &valOut))
	require.True(t, valOut.OK, "errors=%v", valOut.Errors)
	require.Equal(t, 1, valOut.ProbeCount)
	require.Equal(t, []string{"uretprobe:" + validPath + ":getaddrinfo"}, listed)
	require.Equal(t, 1, dryRunCalls)

	// Missing symbol on explicit path returns PROBE_NOT_FOUND on /v1/runs without calling dry-run.
	status, code := postRunCode(t, s, "uprobe:/lib/x86_64-linux-gnu/libc.so.6:missing_sym { @x = count(); }")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "PROBE_NOT_FOUND", code)
	require.Equal(t, 1, dryRunCalls)

	// Dry-run remains the final compile gate after uprobe checks pass.
	sDryFail := testServer(t, Config{
		UprobeCheck: chk,
		DryRun: func(ctx context.Context, script string) []string {
			return []string{"stdin:1:1: ERROR: invalid arg0"}
		},
	})
	wDry := httptest.NewRecorder()
	sDryFail.Handler().ServeHTTP(wDry, authReq(t, sDryFail, "POST", "/v1/validate", `{"script":"uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo { @x = count(); }"}`))
	require.NoError(t, json.Unmarshal(wDry.Body.Bytes(), &valOut))
	require.False(t, valOut.OK)
	require.Contains(t, strings.Join(valOut.Errors, " "), "invalid arg0")

	// Group/world-writable libc file is rejected with VALIDATION_FAILED.
	const writablePath = "/lib/libc.so.6"
	makeFakeLibcFile(t, root, writablePath, 0o666)
	status, code = postRunCode(t, s, "uprobe:/lib/libc.so.6:getaddrinfo { @x = count(); }")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "VALIDATION_FAILED", code)

	// Directory in libc path (non-regular file) is rejected with VALIDATION_FAILED.
	require.NoError(t, os.MkdirAll(filepath.Join(root, "usr", "lib", "libc.so.6"), 0o755))
	status, code = postRunCode(t, s, "uprobe:/usr/lib/libc.so.6:getaddrinfo { @x = count(); }")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "VALIDATION_FAILED", code)

	// Wrong file owner is rejected with VALIDATION_FAILED.
	sNonRoot := testServer(t, Config{
		UprobeCheck: &UprobeChecker{
			FSRoot:      root,
			IsRootOwned: func(fs.FileInfo) bool { return false },
			ListProbe: func(ctx context.Context, probe string) ([]string, error) {
				return []string{probe}, nil
			},
		},
	})
	status, code = postRunCode(t, sNonRoot, "uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo { @x = count(); }")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "VALIDATION_FAILED", code)

	// Symlink escape outside root is rejected with VALIDATION_FAILED.
	sEscape := testServer(t, Config{
		UprobeCheck: &UprobeChecker{
			FSRoot:      root,
			IsRootOwned: func(fs.FileInfo) bool { return true },
			EvalSymlink: func(p string) (string, error) {
				if p == root {
					return filepath.EvalSymlinks(root)
				}
				return filepath.Join(filepath.Dir(root), "outside-libc.so.6"), nil
			},
			ListProbe: func(ctx context.Context, probe string) ([]string, error) {
				return []string{probe}, nil
			},
		},
	})
	status, code = postRunCode(t, sEscape, "uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo { @x = count(); }")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "VALIDATION_FAILED", code)

	// Symlink resolving to non-libc directory inside root is rejected with VALIDATION_FAILED.
	makeFakeLibcFile(t, root, "/tmp/libc.so.6", 0o444)
	sBadDest := testServer(t, Config{
		UprobeCheck: &UprobeChecker{
			FSRoot:      root,
			IsRootOwned: func(fs.FileInfo) bool { return true },
			EvalSymlink: func(p string) (string, error) {
				if p == root {
					return filepath.EvalSymlinks(root)
				}
				rootReal, _ := filepath.EvalSymlinks(root)
				return filepath.Join(rootReal, "tmp", "libc.so.6"), nil
			},
			ListProbe: func(ctx context.Context, probe string) ([]string, error) {
				return []string{probe}, nil
			},
		},
	})
	status, code = postRunCode(t, sBadDest, "uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo { @x = count(); }")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "VALIDATION_FAILED", code)

	// Usr-merge symlink resolving /lib/x86_64-linux-gnu/libc.so.6 -> /usr/lib/x86_64-linux-gnu/libc-2.31.so passes.
	makeFakeLibcFile(t, root, "/usr/lib/x86_64-linux-gnu/libc-2.31.so", 0o444)
	sUsrMerged := testServer(t, Config{
		UprobeCheck: &UprobeChecker{
			FSRoot:      root,
			IsRootOwned: func(fs.FileInfo) bool { return true },
			EvalSymlink: func(p string) (string, error) {
				rootReal, _ := filepath.EvalSymlinks(root)
				if p == root {
					return rootReal, nil
				}
				return filepath.Join(rootReal, "usr", "lib", "x86_64-linux-gnu", "libc-2.31.so"), nil
			},
			ListProbe: func(ctx context.Context, probe string) ([]string, error) {
				return []string{probe}, nil
			},
		},
	})
	wMerged := httptest.NewRecorder()
	sUsrMerged.Handler().ServeHTTP(wMerged, authReq(t, sUsrMerged, "POST", "/v1/validate", `{"script":"uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo { @x = count(); }"}`))
	require.NoError(t, json.Unmarshal(wMerged.Body.Bytes(), &valOut))
	require.True(t, valOut.OK, "errors=%v", valOut.Errors)
}

func TestUprobeLibcAliasFallback(t *testing.T) {
	root := t.TempDir()
	// Put bare libc.so (often linker script) and versioned libc.so.6; versioned should win.
	makeFakeLibcFile(t, root, "/lib/x86_64-linux-gnu/libc.so", 0o444)
	makeFakeLibcFile(t, root, "/lib/x86_64-linux-gnu/libc.so.6", 0o444)

	var queried []string
	s := testServer(t, Config{
		UprobeCheck: &UprobeChecker{
			FSRoot:      root,
			IsRootOwned: func(fs.FileInfo) bool { return true },
			ListProbe: func(ctx context.Context, probe string) ([]string, error) {
				queried = append(queried, probe)
				if probe == "uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc" {
					return []string{probe}, nil
				}
				return nil, nil
			},
		},
	})

	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "POST", "/v1/validate", `{"script":"uprobe:libc:malloc { @x = count(); }"}`))
	require.Equal(t, http.StatusOK, w.Code)
	var out struct {
		OK       bool     `json:"ok"`
		Errors   []string `json:"errors"`
		Warnings []string `json:"warnings"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.True(t, out.OK, "errors=%v", out.Errors)
	require.NotEmpty(t, out.Warnings)
	require.Equal(t, []string{
		"uprobe:libc:malloc",
		"uprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc",
	}, queried)

	// Missing symbol even after resolved path returns PROBE_NOT_FOUND with helpful message.
	status, code := postRunCode(t, s, "uretprobe:libc:missing_fn { @x = count(); }")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "PROBE_NOT_FOUND", code)
}

func TestUprobeProviderPreservedInListQuery(t *testing.T) {
	root := t.TempDir()
	const validPath = "/lib/x86_64-linux-gnu/libc.so.6"
	makeFakeLibcFile(t, root, validPath, 0o444)

	// Stub only knows return probes: entry queries come back empty.
	var queried []string
	s := testServer(t, Config{
		UprobeCheck: &UprobeChecker{
			FSRoot:      root,
			IsRootOwned: func(fs.FileInfo) bool { return true },
			ListProbe: func(ctx context.Context, probe string) ([]string, error) {
				queried = append(queried, probe)
				if strings.HasPrefix(probe, "uretprobe:") && strings.HasSuffix(probe, ":getaddrinfo") {
					return []string{probe}, nil
				}
				return nil, nil
			},
		},
		DryRun: func(ctx context.Context, script string) []string { return nil },
	})

	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "POST", "/v1/validate", `{"script":"uretprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo { @x = count(); }"}`))
	var okOut struct {
		OK     bool     `json:"ok"`
		Errors []string `json:"errors"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &okOut))
	require.True(t, okOut.OK, "errors=%v", okOut.Errors)
	require.Equal(t, []string{"uretprobe:" + validPath + ":getaddrinfo"}, queried)

	// Same symbol as entry probe is unknown to the stub: entry vs return distinguished.
	status, code := postRunCode(t, s, "uprobe:/lib/x86_64-linux-gnu/libc.so.6:getaddrinfo { @x = count(); }")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "PROBE_NOT_FOUND", code)
	require.Equal(t, []string{
		"uretprobe:" + validPath + ":getaddrinfo",
		"uprobe:" + validPath + ":getaddrinfo",
	}, queried)
}

func TestUretprobeLibcAliasPreservesProvider(t *testing.T) {
	root := t.TempDir()
	makeFakeLibcFile(t, root, "/lib/x86_64-linux-gnu/libc.so.6", 0o444)

	var queried []string
	s := testServer(t, Config{
		UprobeCheck: &UprobeChecker{
			FSRoot:      root,
			IsRootOwned: func(fs.FileInfo) bool { return true },
			ListProbe: func(ctx context.Context, probe string) ([]string, error) {
				queried = append(queried, probe)
				if probe == "uretprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc" {
					return []string{probe}, nil
				}
				return nil, nil
			},
		},
	})

	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, authReq(t, s, "POST", "/v1/validate", `{"script":"uretprobe:libc:malloc { @x = count(); }"}`))
	require.Equal(t, http.StatusOK, w.Code)
	var out struct {
		OK     bool     `json:"ok"`
		Errors []string `json:"errors"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.True(t, out.OK, "errors=%v", out.Errors)
	require.Equal(t, []string{
		"uretprobe:libc:malloc",
		"uretprobe:/lib/x86_64-linux-gnu/libc.so.6:malloc",
	}, queried)
}

func buildTestListBinary(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	src := filepath.Join(dir, "main.go")
	binName := "fake-bpftrace-list"
	if runtime.GOOS == "windows" {
		binName += ".exe"
	}
	binPath := filepath.Join(dir, binName)

	code := `package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	mode := os.Getenv("FAKE_LIST_MODE")
	if os.Getenv("LD_LIBRARY_PATH") != "" || os.Getenv("LD_PRELOAD") != "" || os.Getenv("PARENT_SECRET") != "" {
		os.Exit(99)
	}
	switch mode {
	case "flood":
		chunk := strings.Repeat("uprobe:/lib/libc.so.6:fn\n", 1024)
		for i := 0; i < 64; i++ {
			_, _ = os.Stdout.WriteString(chunk)
		}
	default:
		if len(os.Args) != 3 || os.Args[1] != "-l" {
			os.Exit(98)
		}
		fmt.Println(os.Args[2])
	}
}
`
	require.NoError(t, os.WriteFile(src, []byte(code), 0o600))
	cmd := exec.Command("go", "build", "-o", binPath, src)
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "build helper binary: %s", string(out))
	return binPath
}

func TestDefaultListProbeCapAndScrubbedEnv(t *testing.T) {
	bin := buildTestListBinary(t)
	t.Setenv("LD_LIBRARY_PATH", "/tmp/evil")
	t.Setenv("LD_PRELOAD", "/tmp/evil.so")
	t.Setenv("PARENT_SECRET", "super-secret")

	chk := NewUprobeChecker(bin)
	lines, err := chk.defaultListProbe(context.Background(), "uprobe:libc:malloc")
	require.NoError(t, err)
	require.Equal(t, []string{"uprobe:libc:malloc"}, lines)

	// Output > 8 KB is capped cleanly.
	t.Setenv("FAKE_LIST_MODE", "flood")
	floodLines, err := chk.defaultListProbe(context.Background(), "uprobe:libc:malloc")
	require.NoError(t, err)
	total := 0
	for _, ln := range floodLines {
		total += len(ln) + 1
	}
	require.LessOrEqual(t, total, uprobeListMaxBytes+64)
}

func TestDefaultListProbeTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		chk := NewUprobeChecker("powershell")
		_, err := chk.defaultListProbe(ctx, "Start-Sleep -Seconds 5")
		require.Error(t, err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	chk := NewUprobeChecker("sleep")
	_, err := chk.defaultListProbe(ctx, "5")
	require.Error(t, err)
}
