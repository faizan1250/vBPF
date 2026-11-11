package server

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/faizan1250/vBPF/agent/internal/limits"
)

const (
	uprobeListTimeout  = 3 * time.Second
	uprobeListMaxBytes = 8 * 1024
)

var (
	multiarchDirRe   = regexp.MustCompile(`^[a-z0-9_]+-linux-[a-z0-9]+$`)
	libcSoVersionRe  = regexp.MustCompile(`^libc\.so(\.[0-9]+)*$`)
	libcDashVerSoRe  = regexp.MustCompile(`^libc-[0-9]+(\.[0-9]+)*\.so$`)
	uprobeSymbolRe   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	hotLibcSymbols   = map[string]bool{"malloc": true, "free": true, "memcpy": true, "memset": true, "strlen": true, "read": true, "write": true}
	allowedLibcRoots = []string{"/lib", "/lib64", "/usr/lib", "/usr/lib64"}
)

func isHotLibcSymbol(symbol string) bool {
	return hotLibcSymbols[symbol]
}

func isLibcBasename(base string) bool {
	return libcSoVersionRe.MatchString(base) || libcDashVerSoRe.MatchString(base)
}

func isAllowedLibcDir(dir string) bool {
	for _, root := range allowedLibcRoots {
		if dir == root {
			return true
		}
		if strings.HasPrefix(dir, root+"/") {
			sub := strings.TrimPrefix(dir, root+"/")
			if sub != "" && !strings.Contains(sub, "/") && multiarchDirRe.MatchString(sub) {
				return true
			}
		}
	}
	return false
}

// isAllowedLibcPath validates canonical POSIX absolute libc shared-object paths.
func isAllowedLibcPath(target string) bool {
	if target == "" || !strings.HasPrefix(target, "/") || strings.HasSuffix(target, "/") {
		return false
	}
	if strings.Contains(target, "//") || strings.ContainsFunc(target, unicode.IsSpace) {
		return false
	}
	parts := strings.Split(target[1:], "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	idx := strings.LastIndexByte(target, '/')
	if idx <= 0 {
		return false
	}
	dir := target[:idx]
	base := target[idx+1:]
	return isAllowedLibcDir(dir) && isLibcBasename(base)
}

func isAllowedLibcTarget(target string) bool {
	return target == "libc" || isAllowedLibcPath(target)
}

func parseUprobeProbe(pr string) (provider, target, symbol string, ok bool) {
	colon := strings.IndexByte(pr, ':')
	if colon < 0 {
		return "", "", "", false
	}
	provider = pr[:colon]
	if provider != "uprobe" && provider != "uretprobe" {
		return "", "", "", false
	}
	rest := pr[colon+1:]
	target, symbol, ok = strings.Cut(rest, ":")
	return provider, target, symbol, ok
}

// UprobeChecker validates host libc files and verifies symbol existence via `bpftrace -l`.
// Zero-value fields default to production host checks under "/".
type UprobeChecker struct {
	FSRoot      string
	BPFtraceBin string
	ListProbe   func(ctx context.Context, probe string) ([]string, error)
	EvalSymlink func(path string) (string, error)
	StatFile    func(path string) (fs.FileInfo, error)
	ReadDir     func(path string) ([]fs.DirEntry, error)
	IsRootOwned func(info fs.FileInfo) bool
	SafeMode    func(mode fs.FileMode) bool
}

func NewUprobeChecker(bpftracePath string) *UprobeChecker {
	if bpftracePath == "" {
		bpftracePath = "bpftrace"
	}
	c := &UprobeChecker{
		FSRoot:      "/",
		BPFtraceBin: bpftracePath,
		EvalSymlink: filepath.EvalSymlinks,
		StatFile:    os.Lstat,
		ReadDir:     os.ReadDir,
		IsRootOwned: defaultFileRootOwned,
		SafeMode:    defaultSafeFileMode,
	}
	c.ListProbe = c.defaultListProbe
	return c
}

func (c *UprobeChecker) withDefaults() *UprobeChecker {
	out := *c
	if out.FSRoot == "" {
		out.FSRoot = "/"
	}
	if out.BPFtraceBin == "" {
		out.BPFtraceBin = "bpftrace"
	}
	if out.EvalSymlink == nil {
		out.EvalSymlink = filepath.EvalSymlinks
	}
	if out.StatFile == nil {
		out.StatFile = os.Lstat
	}
	if out.ReadDir == nil {
		out.ReadDir = os.ReadDir
	}
	if out.IsRootOwned == nil {
		out.IsRootOwned = defaultFileRootOwned
	}
	if out.SafeMode == nil {
		out.SafeMode = defaultSafeFileMode
	}
	if out.ListProbe == nil {
		out.ListProbe = out.defaultListProbe
	}
	return &out
}

func (c *UprobeChecker) defaultListProbe(ctx context.Context, probe string) ([]string, error) {
	cctx, cancel := context.WithTimeout(ctx, uprobeListTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, c.BPFtraceBin, "-l", probe)
	cmd.Env = limits.ChildEnv(false)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	raw, readErr := io.ReadAll(io.LimitReader(stdout, uprobeListMaxBytes+1))
	if len(raw) > uprobeListMaxBytes {
		raw = raw[:uprobeListMaxBytes]
		cancel()
	}
	waitErr := cmd.Wait()
	if readErr != nil {
		return nil, readErr
	}
	var lines []string
	for _, ln := range strings.Split(string(raw), "\n") {
		if s := strings.TrimSpace(ln); s != "" {
			lines = append(lines, s)
		}
	}
	if waitErr != nil && len(lines) == 0 {
		return nil, waitErr
	}
	return lines, nil
}

func joinUnderRoot(fsRoot, virtualPath string) string {
	trimmed := strings.TrimPrefix(virtualPath, "/")
	if trimmed == "" {
		return fsRoot
	}
	return filepath.Join(fsRoot, filepath.FromSlash(trimmed))
}

func (c *UprobeChecker) validateExplicitLibcPath(virtualPath string) (string, error) {
	if !isAllowedLibcPath(virtualPath) {
		return "", fmt.Errorf("uprobe target not allowed: %s", virtualPath)
	}
	rootReal, err := c.EvalSymlink(c.FSRoot)
	if err != nil {
		return "", fmt.Errorf("uprobe host path invalid: %s (%v)", virtualPath, err)
	}
	hostCandidate := joinUnderRoot(c.FSRoot, virtualPath)
	resolvedHost, err := c.EvalSymlink(hostCandidate)
	if err != nil {
		return "", fmt.Errorf("uprobe host path invalid: %s (%v)", virtualPath, err)
	}
	rel, err := filepath.Rel(rootReal, resolvedHost)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("uprobe host path invalid: symlink escapes root for %s", virtualPath)
	}
	resolvedVirtual := "/" + filepath.ToSlash(rel)
	if !isAllowedLibcPath(resolvedVirtual) {
		return "", fmt.Errorf("uprobe host path invalid: resolved path %s not allowed", resolvedVirtual)
	}
	info, err := c.StatFile(resolvedHost)
	if err != nil {
		return "", fmt.Errorf("uprobe host path invalid: %s (%v)", virtualPath, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("uprobe host path invalid: %s is not a regular file", virtualPath)
	}
	if !c.IsRootOwned(info) {
		return "", fmt.Errorf("uprobe host path invalid: %s is not owned by root", virtualPath)
	}
	if !c.SafeMode(info.Mode()) {
		return "", fmt.Errorf("uprobe host path invalid: %s has unsafe writable permissions (%o)", virtualPath, info.Mode().Perm())
	}
	return resolvedVirtual, nil
}

func (c *UprobeChecker) resolveFirstValidLibc() (string, error) {
	dirs := make([]string, 0, 16)
	dirs = append(dirs, allowedLibcRoots...)
	for _, root := range allowedLibcRoots {
		entries, err := c.ReadDir(joinUnderRoot(c.FSRoot, root))
		if err != nil {
			continue
		}
		var subdirs []string
		for _, e := range entries {
			if e.IsDir() && multiarchDirRe.MatchString(e.Name()) {
				subdirs = append(subdirs, root+"/"+e.Name())
			}
		}
		sort.Strings(subdirs)
		dirs = append(dirs, subdirs...)
	}

	var firstErr error
	for _, dir := range dirs {
		entries, err := c.ReadDir(joinUnderRoot(c.FSRoot, dir))
		if err != nil {
			continue
		}
		var versioned, bare []string
		for _, e := range entries {
			name := e.Name()
			if !isLibcBasename(name) {
				continue
			}
			// Prefer versioned shared objects over bare libc.so (often an ld linker script).
			if name == "libc.so" {
				bare = append(bare, name)
			} else {
				versioned = append(versioned, name)
			}
		}
		sort.Strings(versioned)
		candidates := append(versioned, bare...)
		for _, name := range candidates {
			virt := dir + "/" + name
			resolved, verr := c.validateExplicitLibcPath(virt)
			if verr == nil {
				return resolved, nil
			}
			if firstErr == nil {
				firstErr = verr
			}
		}
	}
	if firstErr != nil {
		return "", firstErr
	}
	return "", fmt.Errorf("probe not found: uprobe:libc (no valid libc shared object found in standard /lib directories; try specifying e.g. /lib/x86_64-linux-gnu/libc.so.6)")
}

// VerifyProbes checks host file safety and `bpftrace -l` existence for every uprobe/uretprobe.
func (c *UprobeChecker) VerifyProbes(ctx context.Context, probes []string) []string {
	chk := c.withDefaults()
	var errs []string
	for _, pr := range probes {
		provider, target, symbol, ok := parseUprobeProbe(pr)
		if !ok {
			continue
		}
		if target != "libc" {
			if _, err := chk.validateExplicitLibcPath(target); err != nil {
				errs = append(errs, err.Error())
				continue
			}
			lines, err := chk.ListProbe(ctx, provider+":"+target+":"+symbol)
			if err != nil || len(lines) == 0 {
				errs = append(errs, fmt.Sprintf("probe not found: %s (check available symbols with `bpftrace -l '%s:%s:*'`)", pr, provider, target))
			}
			continue
		}

		lines, err := chk.ListProbe(ctx, provider+":libc:"+symbol)
		if err == nil && len(lines) > 0 {
			continue
		}
		resolved, rerr := chk.resolveFirstValidLibc()
		if rerr != nil {
			errs = append(errs, fmt.Sprintf("probe not found: %s (unable to resolve libc path: %s)", pr, rerr.Error()))
			continue
		}
		lines, err = chk.ListProbe(ctx, provider+":"+resolved+":"+symbol)
		if err != nil || len(lines) == 0 {
			errs = append(errs, fmt.Sprintf("probe not found: %s (symbol missing in %s; inspect with `bpftrace -l '%s:%s:*'`)", pr, resolved, provider, resolved))
		}
	}
	return errs
}
