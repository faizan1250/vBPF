package parser

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// Every committed fixture must decode with the expected kind.
func TestFixtures(t *testing.T) {
	fixtures := []struct {
		file string
		kind Kind
	}{
		{"block-latency-histogram.ndjson", KindHist},
		{"cpu-by-process.ndjson", KindMap},
		{"dns-lookups.ndjson", KindPrintf},
		{"page-faults-by-process.ndjson", KindMap},
		{"syscall-counts-by-process.ndjson", KindMap},
	}
	for _, f := range fixtures {
		t.Run(f.file, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join("..", "..", "..", "fixtures", f.file))
			require.NoError(t, err)
			var count int
			for i, ln := range strings.Split(string(raw), "\n") {
				if strings.TrimSpace(ln) == "" {
					continue
				}
				ev, err := ParseLine("run_test", uint64(count), []byte(ln))
				require.NoError(t, err, "line %d", i)
				require.Equal(t, f.kind, ev.Kind, "line %d", i)
				require.Equal(t, "run_test", ev.RunID)
				require.Positive(t, ev.Ts)
				count++
			}
			require.Positive(t, count, "no events decoded")
		})
	}
}

func TestParseLineRejects(t *testing.T) {
	for _, line := range []string{
		"",
		"not json",
		`{"data": {}}`,
		`{"type": "attached_probes", "data": {}}`,
		`{"type": "map"}`,
	} {
		t.Run(line, func(t *testing.T) {
			_, err := ParseLine("run_test", 0, []byte(line))
			require.Error(t, err)
		})
	}
}

func TestParseLHist(t *testing.T) {
	ev, err := ParseLine("run_test", 7, []byte(`{"type": "lhist", "data": {"@x": [{"min": 0, "max": 1, "count": 3}]}}`))
	require.NoError(t, err)
	require.Equal(t, KindLHist, ev.Kind)
	require.Equal(t, uint64(7), ev.Seq)
}

func TestStreamCountsLost(t *testing.T) {
	in := "{\"type\": \"printf\", \"data\": \"hi\\n\"}\nnot-json\n\n{\"type\": \"map\", \"data\": {\"@a\": {\"x\": 1}}}\n"
	var got []Event
	events, dropped, err := Stream(strings.NewReader(in), "run_test", func(ev Event) error {
		got = append(got, ev)
		return nil
	})
	require.NoError(t, err)
	require.Equal(t, uint64(2), events)
	require.Equal(t, uint64(1), dropped)
	require.Len(t, got, 3)
	require.Equal(t, KindPrintf, got[0].Kind)
	require.Equal(t, KindLost, got[1].Kind)
	require.Equal(t, KindMap, got[2].Kind)
	for i, ev := range got {
		require.Equal(t, uint64(i), ev.Seq, "seq gap")
	}
}

func TestStreamPropagatesEmitError(t *testing.T) {
	boom := errors.New("boom")
	_, _, err := Stream(strings.NewReader("{\"type\": \"printf\", \"data\": \"x\"}\n"), "run_test", func(Event) error {
		return boom
	})
	require.ErrorIs(t, err, boom)
}

func TestConstructors(t *testing.T) {
	require.Equal(t, KindStatus, Status("r", 0, "running").Kind)
	require.Equal(t, KindStderr, Stderr("r", 0, "x").Kind)
	require.Equal(t, KindLost, Lost("r", 0, 3).Kind)
	require.Equal(t, KindSummary, Summarize("r", 0, Summary{ExitReason: "completed"}).Kind)
}

func TestStreamOversizeLineDropped(t *testing.T) {
	big := `{"type": "printf", "data": "` + strings.Repeat("x", MaxLineBytes) + `"}`
	var got []Event
	events, dropped, err := Stream(strings.NewReader(big+"\n"), "run_test", func(ev Event) error {
		got = append(got, ev)
		return nil
	})
	require.NoError(t, err)
	require.Equal(t, uint64(0), events)
	require.Equal(t, uint64(1), dropped)
	require.Len(t, got, 1)
	require.Equal(t, KindLost, got[0].Kind)
}
