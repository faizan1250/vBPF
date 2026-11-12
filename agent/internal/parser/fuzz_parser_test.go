package parser

import (
	"bytes"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

// Fuzz corpus for I-05 (bpftrace output parser). Seeds mirror the committed
// corpus in testdata/fuzz (every fixtures/*.ndjson line plus malformed
// shapes). Invariants: no panic, bounded runtime, and Stream accounting
// stays exact (one emitted event per consumed or dropped line, contiguous
// sequence numbers).

const (
	fuzzParserTimeBound = 2 * time.Second
	fuzzMaxLineBytes    = 256 * 1024
	fuzzMaxStreamBytes  = 512 * 1024
)

func FuzzParseLine(f *testing.F) {
	for _, s := range []string{
		`{"type": "printf", "data": "hi\n"}`,
		`{"type": "map", "data": {"@a": 1}}`,
		`{"type": "hist", "data": {"@x": [{"min": 0, "max": 1, "count": 3}]}}`,
		`{"type": "lhist", "data": {"@x": [{"min": 0, "max": 1, "count": 3}]}}`,
		`{"type": "attached_probes", "data": {}}`,
		`{"type": "printf"}`,
		`{"data": {}}`,
		`not json`,
		``,
		`{"type": "printf", "data": "x"}`,
		"{\"type\": \"printf\", \"data\": \"" + strings.Repeat("x", 1024) + "\"}",
	} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, line []byte) {
		if len(line) > fuzzMaxLineBytes {
			t.Skip("input larger than fuzz bound")
		}
		start := time.Now()
		ev, err := ParseLine("run_fuzz", 3, line)
		require.Less(t, time.Since(start), fuzzParserTimeBound, "ParseLine exceeded time bound")
		if err != nil {
			return
		}
		require.Equal(t, "run_fuzz", ev.RunID)
		require.Equal(t, uint64(3), ev.Seq)
		require.Positive(t, ev.Ts)
		require.True(t, dataKinds[ev.Kind], "unexpected kind %q", ev.Kind)
		again, err := ParseLine("run_fuzz", 3, line)
		require.NoError(t, err)
		require.Equal(t, ev.Kind, again.Kind, "ParseLine is not deterministic")
	})
}

func FuzzStream(f *testing.F) {
	for _, s := range []string{
		"{\"type\": \"printf\", \"data\": \"hi\\n\"}\nnot-json\n\n{\"type\": \"map\", \"data\": {\"@a\": {\"x\": 1}}}\n",
		"{\"type\": \"printf\", \"data\": \"x\"}\n",
		"",
		"\n\n\n",
		"not-json\n",
		"{\"type\": \"printf\", \"data\": \"" + strings.Repeat("y", 512) + "\"}\n",
	} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > fuzzMaxStreamBytes {
			t.Skip("input larger than fuzz bound")
		}
		start := time.Now()
		var got []Event
		events, dropped, err := Stream(bytes.NewReader(data), "run_fuzz", func(ev Event) error {
			got = append(got, ev)
			return nil
		})
		require.Less(t, time.Since(start), fuzzParserTimeBound, "Stream exceeded time bound")
		require.NoError(t, err)
		require.Equal(t, int(events+dropped), len(got), "event accounting drifted")
		for i, ev := range got {
			require.Equal(t, uint64(i), ev.Seq, "sequence gap at %d", i)
			require.Equal(t, "run_fuzz", ev.RunID)
			require.Positive(t, ev.Ts)
			if n := utf8.RuneCountInString(string(ev.Kind)); n > 16 {
				t.Fatalf("kind too long: %q", ev.Kind)
			}
		}
	})
}
