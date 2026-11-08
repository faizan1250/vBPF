package parser

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every committed fixture must decode with the expected kind.
func TestFixtures(t *testing.T) {
	fixtures := []struct {
		file string
		kind string
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
			if err != nil {
				t.Fatal(err)
			}
			var events []Event
			lines := strings.Split(string(raw), "\n")
			for i, ln := range lines {
				if strings.TrimSpace(ln) == "" {
					continue
				}
				ev, err := ParseLine("run_test", uint64(len(events)), []byte(ln))
				if err != nil {
					t.Fatalf("line %d: %v", i, err)
				}
				if ev.Kind != f.kind {
					t.Fatalf("line %d: kind=%q want %q", i, ev.Kind, f.kind)
				}
				if ev.RunID != "run_test" || ev.Ts <= 0 {
					t.Fatalf("line %d: bad envelope %+v", i, ev)
				}
				events = append(events, ev)
			}
			if len(events) == 0 {
				t.Fatal("no events decoded")
			}
		})
	}
}

func TestParseLineRejects(t *testing.T) {
	cases := []struct {
		name string
		line string
	}{
		{"empty", ""},
		{"not json", "not json"},
		{"missing type", `{"data": {}}`},
		{"unknown type", `{"type": "attached_probes", "data": {}}`},
		{"missing data", `{"type": "map"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := ParseLine("run_test", 0, []byte(c.line)); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestParseLHist(t *testing.T) {
	ev, err := ParseLine("run_test", 7, []byte(`{"type": "lhist", "data": {"@x": [{"min": 0, "max": 1, "count": 3}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	if ev.Kind != KindLHist || ev.Seq != 7 {
		t.Fatalf("unexpected event %+v", ev)
	}
}

func TestStreamCountsLost(t *testing.T) {
	in := "{\"type\": \"printf\", \"data\": \"hi\\n\"}\nnot-json\n\n{\"type\": \"map\", \"data\": {\"@a\": {\"x\": 1}}}\n"
	var got []Event
	events, dropped, err := Stream(strings.NewReader(in), "run_test", func(ev Event) error {
		got = append(got, ev)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if events != 2 || dropped != 1 {
		t.Fatalf("events=%d dropped=%d", events, dropped)
	}
	kinds := []string{got[0].Kind, got[1].Kind, got[2].Kind}
	if kinds[0] != KindPrintf || kinds[1] != KindLost || kinds[2] != KindMap {
		t.Fatalf("kinds=%v", kinds)
	}
	for i, ev := range got {
		if ev.Seq != uint64(i) {
			t.Fatalf("seq gap at %d: %+v", i, ev)
		}
	}
}

func TestStreamPropagatesEmitError(t *testing.T) {
	boom := errors.New("boom")
	_, _, err := Stream(strings.NewReader("{\"type\": \"printf\", \"data\": \"x\"}\n"), "run_test", func(Event) error {
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("err=%v", err)
	}
}

func TestConstructors(t *testing.T) {
	if Status("r", 0, "running").Kind != KindStatus {
		t.Fatal("bad status kind")
	}
	if Stderr("r", 0, "x").Kind != KindStderr {
		t.Fatal("bad stderr kind")
	}
	if Lost("r", 0, 3).Kind != KindLost {
		t.Fatal("bad lost kind")
	}
	if Summarize("r", 0, Summary{ExitReason: "completed"}).Kind != KindSummary {
		t.Fatal("bad summary kind")
	}
}
