package priv

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"github.com/stretchr/testify/require"
)

func testLogger(buf *bytes.Buffer) zerolog.Logger {
	return zerolog.New(buf).With().Timestamp().Logger()
}

func TestDropToRetainKeepsOnlyTracingCaps(t *testing.T) {
	full := ^uint64(0)
	eff, prm, inh := DropToRetain(full, full, full)
	require.Equal(t, RetainMask, eff)
	require.Equal(t, RetainMask, prm)
	require.Zero(t, inh)
	require.NotZero(t, eff&(uint64(1)<<CapBPF))
	require.NotZero(t, eff&(uint64(1)<<CapPerfmon))
	require.NotZero(t, eff&(uint64(1)<<CapSysResource))
	require.Zero(t, eff&(uint64(1)<<CapSysAdmin), "CAP_SYS_ADMIN must be dropped")
}

func TestHardenDropsSysAdminAndLogsFinalSet(t *testing.T) {
	var setArgs [3]uint64
	var setCalls int
	ops := Ops{
		SetNoNewPrivs: func() error { return nil },
		GetCaps:       func() (uint64, uint64, uint64, error) { return ^uint64(0), ^uint64(0), 7, nil },
		SetCaps: func(eff, prm, inh uint64) error {
			setArgs = [3]uint64{eff, prm, inh}
			setCalls++
			return nil
		},
	}
	var buf bytes.Buffer
	final := Harden(ops, testLogger(&buf))
	require.Equal(t, 1, setCalls)
	require.Equal(t, RetainMask, setArgs[0])
	require.Equal(t, RetainMask, setArgs[1])
	require.Zero(t, setArgs[2], "inheritable must be cleared")
	require.Contains(t, final, "cap_bpf")
	require.Contains(t, final, "cap_perfmon")
	require.Contains(t, final, "cap_sys_resource")
	require.NotContains(t, final, "cap_sys_admin")
	require.Contains(t, buf.String(), "cap_sys_admin", "dropped set must name CAP_SYS_ADMIN")
}

func TestHardenToleratesFailures(t *testing.T) {
	ops := Ops{
		SetNoNewPrivs: func() error { return errors.New("denied") },
		GetCaps:       func() (uint64, uint64, uint64, error) { return 0, 0, 0, errors.New("denied") },
		SetCaps:       func(_, _, _ uint64) error { return errors.New("must not be called") },
	}
	var buf bytes.Buffer
	require.Equal(t, "unknown", Harden(ops, testLogger(&buf)))
	require.Contains(t, buf.String(), "continuing")
}

func TestNameSetCoversUnknownBits(t *testing.T) {
	require.Equal(t, "none", NameSet(0))
	require.Contains(t, NameSet(RetainMask), "cap_bpf")
	require.Contains(t, NameSet(uint64(1)<<60), "cap_60")
}

func TestParseStatusCaps(t *testing.T) {
	status := "Name:\tagent\nCapInh:\t0000000000000000\nCapPrm:\t000001ffffffffff\nCapEff:\t000001ffffffffff\n"
	eff, prm, inh, err := ParseStatusCaps(status)
	require.NoError(t, err)
	require.Equal(t, uint64(0x1ffffffffff), eff)
	require.Equal(t, uint64(0x1ffffffffff), prm)
	require.Zero(t, inh)
	_, _, _, err = ParseStatusCaps("CapEff:\tzzz\n")
	require.Error(t, err)
	require.True(t, strings.Contains(err.Error(), "CapEff"))
}
