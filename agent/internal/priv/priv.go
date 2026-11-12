// Package priv hardens the agent process at startup.
//
// The agent must start with enough privilege to load BPF programs, but a
// validator bypass would then inherit full root. Harden sets no_new_privs
// and drops every Linux capability except the tracing retain set
// (CAP_BPF, CAP_PERFMON, CAP_SYS_RESOURCE). Every step is best-effort: a
// failure is logged and startup continues, so unprivileged dev and CI runs
// keep working and only the log shows the reduction did not apply.
package priv

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/rs/zerolog"
)

// RetainSet is the minimal capability set the agent (and its bpftrace
// children, which inherit it) needs: load BPF programs and maps (BPF),
// use perf events for kprobe/tracepoint attach (PERFMON), and raise the
// memlock rlimit for BPF maps (SYS_RESOURCE). CAP_SYS_ADMIN and
// CAP_DAC_READ_SEARCH are deliberately absent: they were not needed in
// testing (see docs/decisions.md D-84) and either would widen a bypass
// into host-wide root.
const (
	CapBPF         = 39
	CapPerfmon     = 38
	CapSysResource = 24
	CapSysAdmin    = 21
)

// RetainMask keeps exactly the retain set.
const RetainMask = (uint64(1) << CapBPF) | (uint64(1) << CapPerfmon) | (uint64(1) << CapSysResource)

// DropToRetain masks a capability triple down to the retain set and clears
// the inheritable set, which the agent never needs across exec.
func DropToRetain(eff, prm, _ uint64) (newEff, newPrm, newInh uint64) {
	return eff & RetainMask, prm & RetainMask, 0
}

// capNames names bits for logs; unlisted bits render as cap_N so a dropped
// or retained bit is never silently unnamed.
var capNames = map[int]string{
	0:  "cap_chown",
	1:  "cap_dac_override",
	2:  "cap_dac_read_search",
	3:  "cap_fowner",
	12: "cap_net_admin",
	21: "cap_sys_admin",
	24: "cap_sys_resource",
	38: "cap_perfmon",
	39: "cap_bpf",
}

// NameSet formats a 64-bit capability mask for logs.
func NameSet(mask uint64) string {
	if mask == 0 {
		return "none"
	}
	var names []string
	for b := 0; b < 64; b++ {
		if mask&(uint64(1)<<b) == 0 {
			continue
		}
		if n, ok := capNames[b]; ok {
			names = append(names, n)
		} else {
			names = append(names, fmt.Sprintf("cap_%d", b))
		}
	}
	sort.Strings(names)
	return strings.Join(names, ",")
}

// FormatCaps renders one capability triple for logs.
func FormatCaps(eff, prm, inh uint64) string {
	return fmt.Sprintf("eff=[%s] prm=[%s] inh=[%s]", NameSet(eff), NameSet(prm), NameSet(inh))
}

// ParseStatusCaps extracts the hex capability masks from /proc/self/status
// text (CapEff/CapPrm/CapInh lines). All three keys must be present;
// a missing key returns an error instead of a silent zero mask.
func ParseStatusCaps(status string) (eff, prm, inh uint64, err error) {
	got := map[string]*uint64{"CapEff:": &eff, "CapPrm:": &prm, "CapInh:": &inh}
	seen := map[string]bool{}
	for _, line := range strings.Split(status, "\n") {
		for key, dst := range got {
			if !strings.HasPrefix(line, key) {
				continue
			}
			v, perr := strconv.ParseUint(strings.TrimSpace(strings.TrimPrefix(line, key)), 16, 64)
			if perr != nil {
				return 0, 0, 0, fmt.Errorf("priv: bad %s: %w", strings.TrimSuffix(key, ":"), perr)
			}
			*dst = v
			seen[key] = true
		}
	}
	for key := range got {
		if !seen[key] {
			return 0, 0, 0, fmt.Errorf("priv: missing %s", strings.TrimSuffix(key, ":"))
		}
	}
	return eff, prm, inh, nil
}

// Ops injects the privileged operations so Harden is hermetically testable.
// ReadStatusCaps is the /proc/self/status cross-check; nil skips verification.
type Ops struct {
	SetNoNewPrivs  func() error
	GetCaps        func() (eff, prm, inh uint64, err error)
	SetCaps        func(eff, prm, inh uint64) error
	ReadStatusCaps func() (eff, prm, inh uint64, err error)
}

// Harden sets no_new_privs and drops to the retain set, logging the final
// set. It never fails startup: every error is logged and the current (or
// "unknown") set is returned for the caller to record.
func Harden(ops Ops, log zerolog.Logger) string {
	if err := ops.SetNoNewPrivs(); err != nil {
		log.Warn().Err(err).Msg("priv: no_new_privs not set, continuing")
	}
	eff, prm, inh, err := ops.GetCaps()
	if err != nil {
		log.Warn().Err(err).Msg("priv: capability set unreadable, continuing unreduced")
		return "unknown"
	}
	newEff, newPrm, newInh := DropToRetain(eff, prm, inh)
	dropped := (eff | prm) &^ (newEff | newPrm)
	if err := ops.SetCaps(newEff, newPrm, newInh); err != nil {
		log.Warn().Err(err).Str("current", FormatCaps(eff, prm, inh)).Msg("priv: capability drop failed, continuing")
		return FormatCaps(eff, prm, inh)
	}
	final := FormatCaps(newEff, newPrm, newInh)
	if ops.ReadStatusCaps != nil {
		if oEff, oPrm, oInh, rerr := ops.ReadStatusCaps(); rerr != nil {
			log.Warn().Err(rerr).Msg("priv: status cross-check unreadable, continuing")
		} else if oEff != newEff || oPrm != newPrm || oInh != newInh {
			log.Warn().Str("expected", final).Str("observed", FormatCaps(oEff, oPrm, oInh)).Msg("priv: status cross-check mismatch, continuing")
		}
	}
	log.Info().Str("final", final).Str("dropped", NameSet(dropped)).Msg("priv: capabilities reduced to tracing retain set")
	return final
}
