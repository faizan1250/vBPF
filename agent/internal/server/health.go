package server

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/faizan1250/vBPF/agent/internal/limits"
)

// Health is the GET /health payload.
type Health struct {
	Kernel          string `json:"kernel"`
	BpftraceVersion string `json:"bpftrace_version"`
	BTF             bool   `json:"btf"`
	Root            bool   `json:"root"`
	Tracefs         bool   `json:"tracefs"`
	UptimeS         int64  `json:"uptime_s"`
}

// HealthProvider gathers capability signals. Func fields allow hermetic tests.
type HealthProvider struct {
	StartTime    time.Time
	BPFtracePath string
	Kernel       func() string
	Version      func(ctx context.Context) string
	HasBTF       func() bool
	IsRoot       func() bool
	HasTracefs   func() bool
}

// NewHealthProvider wires OS-backed probes with the given start time.
func NewHealthProvider(start time.Time, bpftracePath string) *HealthProvider {
	if bpftracePath == "" {
		bpftracePath = "bpftrace"
	}
	p := &HealthProvider{StartTime: start, BPFtracePath: bpftracePath}
	p.Kernel = defaultKernel
	p.Version = p.defaultVersion
	p.HasBTF = defaultHasBTF
	p.IsRoot = defaultIsRoot
	p.HasTracefs = defaultHasTracefs
	return p
}

// Snapshot collects one health report.
func (p *HealthProvider) Snapshot(ctx context.Context) Health {
	_ = ctx
	return Health{
		Kernel:          p.Kernel(),
		BpftraceVersion: p.Version(ctx),
		BTF:             p.HasBTF(),
		Root:            p.IsRoot(),
		Tracefs:         p.HasTracefs(),
		UptimeS:         int64(time.Since(p.StartTime).Seconds()),
	}
}

func defaultKernel() string {
	if raw, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		if s := strings.TrimSpace(string(raw)); s != "" {
			return s
		}
	}
	return runtime.GOOS + "/" + runtime.GOARCH
}

func (p *HealthProvider) defaultVersion(ctx context.Context) string {
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, p.BPFtracePath, "--version")
	cmd.Env = limits.ChildEnv(false)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "unknown"
	}
	line := strings.TrimSpace(string(out))
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	if line == "" {
		return "unknown"
	}
	return line
}

func defaultHasBTF() bool {
	_, err := os.Stat("/sys/kernel/btf/vmlinux")
	return err == nil
}

func defaultIsRoot() bool {
	return os.Geteuid() == 0
}

func defaultHasTracefs() bool {
	if st, err := os.Stat("/sys/kernel/tracing"); err == nil && st.IsDir() {
		return true
	}
	raw, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.Contains(line, " tracefs ") || strings.Contains(line, " debugfs ") {
			return true
		}
	}
	return false
}
