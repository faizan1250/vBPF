// Package parser decodes bpftrace -f json lines into normalized events.
// Raw bpftrace shapes vary by version; this is the only place that knows them.
package parser

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

const (
	KindStatus  Kind = "status"
	KindPrintf  Kind = "printf"
	KindMap     Kind = "map"
	KindHist    Kind = "hist"
	KindLHist   Kind = "lhist"
	KindLost    Kind = "lost"
	KindStderr  Kind = "stderr"
	KindSummary Kind = "summary"

	// MaxLineBytes bounds one bpftrace output line (large maps get wide).
	MaxLineBytes = 8 * 1024 * 1024
)

// Kind is the normalized event envelope type.
type Kind string

// IsControl reports whether k is control-plane (never rate-limited, never
// shed): lifecycle status, terminal summary, and drop-counter markers.
func (k Kind) IsControl() bool {
	switch k {
	case KindStatus, KindSummary, KindLost:
		return true
	default:
		return false
	}
}

// Event is the normalized envelope streamed to consumers.
type Event struct {
	RunID string `json:"run_id"`
	Seq   uint64 `json:"seq"`
	Ts    int64  `json:"ts"`
	Kind  Kind   `json:"kind"`
	Data  any    `json:"data"`
}

// rawLine is the bpftrace -f json wire shape.
type rawLine struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// dataKinds are bpftrace types forwarded with their kind unchanged.
var dataKinds = map[Kind]bool{
	KindPrintf: true,
	KindMap:    true,
	KindHist:   true,
	KindLHist:  true,
}

// NowMillis returns epoch millis for envelope timestamps.
func NowMillis() int64 { return time.Now().UnixMilli() }

// ParseLine decodes one bpftrace JSON line into an Event.
func ParseLine(runID string, seq uint64, line []byte) (Event, error) {
	var raw rawLine
	if err := json.Unmarshal(line, &raw); err != nil {
		return Event{}, fmt.Errorf("parser: bad line %d: %w", seq, err)
	}
	if !dataKinds[Kind(raw.Type)] {
		return Event{}, fmt.Errorf("parser: line %d has unsupported type %q", seq, raw.Type)
	}
	var data any
	if err := json.Unmarshal(raw.Data, &data); err != nil {
		return Event{}, fmt.Errorf("parser: line %d has bad data: %w", seq, err)
	}
	return Event{RunID: runID, Seq: seq, Ts: NowMillis(), Kind: Kind(raw.Type), Data: data}, nil
}

// Status builds a lifecycle event (attached, running, stopping, completed, failed).
func Status(runID string, seq uint64, state string) Event {
	return Event{RunID: runID, Seq: seq, Ts: NowMillis(), Kind: KindStatus, Data: map[string]string{"state": state}}
}

// Stderr builds an event from one captured child stderr line.
func Stderr(runID string, seq uint64, text string) Event {
	return Event{RunID: runID, Seq: seq, Ts: NowMillis(), Kind: KindStderr, Data: map[string]string{"text": text}}
}

// Lost builds a drop-counter event for backpressure or oversize lines.
func Lost(runID string, seq uint64, count uint64) Event {
	return Event{RunID: runID, Seq: seq, Ts: NowMillis(), Kind: KindLost, Data: map[string]uint64{"dropped": count}}
}

// Summary is the terminal per-run totals payload.
type Summary struct {
	Events     uint64 `json:"events"`
	Bytes      uint64 `json:"bytes"`
	Dropped    uint64 `json:"dropped"`
	DurationMs int64  `json:"duration_ms"`
	ExitReason string `json:"exit_reason"`
}

// Summarize builds the terminal summary event.
func Summarize(runID string, seq uint64, s Summary) Event {
	return Event{RunID: runID, Seq: seq, Ts: NowMillis(), Kind: KindSummary, Data: s}
}

// Stream decodes r line by line, emitting one Event per non-blank line.
// Oversize lines are counted and reported as lost events, never fatal.
func Stream(r io.Reader, runID string, emit func(Event) error) (events uint64, dropped uint64, err error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), MaxLineBytes)
	var seq uint64
	reportLost := func() error {
		if err := emit(Lost(runID, seq, dropped)); err != nil {
			return err
		}
		seq++
		return nil
	}
	for sc.Scan() {
		line := sc.Bytes()
		if len(trimSpace(line)) == 0 {
			continue
		}
		ev, perr := ParseLine(runID, seq, line)
		if perr != nil {
			dropped++
			if err := reportLost(); err != nil {
				return events, dropped, err
			}
			continue
		}
		if err := emit(ev); err != nil {
			return events, dropped, err
		}
		seq++
		events++
	}
	if err := sc.Err(); err != nil {
		dropped++
		if rerr := reportLost(); rerr != nil {
			return events, dropped, rerr
		}
	}
	return events, dropped, nil
}

func trimSpace(b []byte) []byte {
	start := 0
	for start < len(b) && (b[start] == ' ' || b[start] == '\t' || b[start] == '\r' || b[start] == '\n') {
		start++
	}
	end := len(b)
	for end > start && (b[end-1] == ' ' || b[end-1] == '\t' || b[end-1] == '\r' || b[end-1] == '\n') {
		end--
	}
	return b[start:end]
}
