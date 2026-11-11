package server

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/faizan1250/vBPF/agent/internal/parser"
	"github.com/faizan1250/vBPF/agent/internal/runner"
)

// fixedClock advances step per call so burst tests never straddle a rate window.
func fixedClock(t0 time.Time, step time.Duration) func() time.Time {
	now := t0
	return func() time.Time {
		now = now.Add(step)
		return now
	}
}

func TestKindIsControl(t *testing.T) {
	for _, k := range []parser.Kind{parser.KindStatus, parser.KindSummary, parser.KindLost} {
		require.True(t, k.IsControl(), "control kind %q not classified", string(k))
	}
	for _, k := range []parser.Kind{parser.KindPrintf, parser.KindMap, parser.KindHist, parser.KindLHist, parser.KindStderr} {
		require.False(t, k.IsControl(), "data kind %q classified as control", string(k))
	}
}

func TestControlEventsBypassRateLimit(t *testing.T) {
	for _, n := range []int{499, 500, 501, 5000, 50000} {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			t0 := time.Now()
			run := &Run{id: "run_ctrl", state: "running", subs: make(map[*subscriber]struct{}), rateWin: t0, clock: fixedClock(t0, time.Microsecond)}
			for i := 0; i < n; i++ {
				run.publish(parser.Event{RunID: run.id, Seq: uint64(i + 1), Ts: 1, Kind: parser.KindPrintf, Data: i})
			}
			run.publish(parser.Status(run.id, uint64(n+1), "running"))
			run.publish(parser.Summarize(run.id, uint64(n+2), parser.Summary{Events: uint64(n), ExitReason: runner.ReasonCompleted}))

			run.mu.Lock()
			defer run.mu.Unlock()
			var seenStatus, seenSummary bool
			var dataInHistory int
			var lostTotal uint64
			for _, ev := range run.history {
				switch {
				case ev.Kind == parser.KindStatus:
					seenStatus = true
				case ev.Kind == parser.KindSummary:
					seenSummary = true
				case ev.Kind == parser.KindLost:
					if m, ok := ev.Data.(map[string]uint64); ok {
						lostTotal += m["dropped"]
					}
				case !ev.Kind.IsControl():
					dataInHistory++
				}
			}
			require.True(t, seenStatus, "status shed under burst")
			require.True(t, seenSummary, "summary shed under burst")
			overflow := n - maxPerSecond
			if overflow < 0 {
				overflow = 0
			}
			require.Equal(t, n, dataInHistory+int(run.dropped)+int(lostTotal), "every data event is kept or shed-counted")
			require.Equal(t, overflow, int(run.dropped)+int(lostTotal), "dropped counts data overflow only")
			require.Equal(t, "completed", finalState(run))
		})
	}
}

func TestSlowSubscriberKeepsControl(t *testing.T) {
	t0 := time.Now()
	run := &Run{id: "run_slow", state: "running", subs: make(map[*subscriber]struct{}), rateWin: t0, clock: fixedClock(t0, time.Microsecond)}
	sub, _ := run.subscribe()
	defer run.unsubscribe(sub)

	const data = 300
	for i := 0; i < data; i++ {
		run.publish(parser.Event{RunID: run.id, Seq: uint64(i + 1), Ts: 1, Kind: parser.KindPrintf, Data: i})
	}
	run.publish(parser.Status(run.id, data+1, "running"))
	run.publish(parser.Summarize(run.id, data+2, parser.Summary{Events: data, ExitReason: runner.ReasonCompleted}))

	var seenStatus, seenSummary bool
	var deliveredData int
	var lostTotal uint64
	for {
		select {
		case ev := <-sub.ch:
			switch {
			case ev.Kind == parser.KindStatus:
				seenStatus = true
			case ev.Kind == parser.KindSummary:
				seenSummary = true
			case ev.Kind == parser.KindLost:
				if m, ok := ev.Data.(map[string]uint64); ok {
					lostTotal += m["dropped"]
				}
			case !ev.Kind.IsControl():
				deliveredData++
			}
		default:
			goto drained
		}
	}
drained:
	require.True(t, seenStatus, "status lost on slow subscriber")
	require.True(t, seenSummary, "summary lost on slow subscriber")
	require.Equal(t, data, deliveredData+int(run.dropped)+int(lostTotal), "every data event is delivered or shed-counted")
	require.Equal(t, "completed", finalState(run))
}

func TestRunWithoutSummaryFailsNoSummary(t *testing.T) {
	reg := NewRegistry(func(ctx context.Context, opts runner.Options, emit func(parser.Event) error) error {
		return emit(parser.Status(opts.RunID, 0, "running"))
	}, "", testLogger())
	t.Cleanup(reg.Shutdown)

	run, err := reg.Start(context.Background(), "BEGIN {}", 5*time.Second)
	require.NoError(t, err)
	<-run.done

	run.mu.Lock()
	defer run.mu.Unlock()
	require.Equal(t, "failed", run.state)
	require.Equal(t, "failed", finalState(run))
	require.NotNil(t, run.summary)
	require.Equal(t, "no_summary", run.summary.ExitReason)
	require.NotEmpty(t, run.history)
	require.Equal(t, parser.KindSummary, run.history[len(run.history)-1].Kind)
}

func TestDuplicateSummaryIgnored(t *testing.T) {
	run := &Run{id: "run_dup", state: "running", subs: make(map[*subscriber]struct{}), rateWin: time.Now()}
	run.publish(parser.Summarize(run.id, 1, parser.Summary{Events: 1, ExitReason: runner.ReasonCompleted}))
	run.publish(parser.Summarize(run.id, 2, parser.Summary{Events: 2, ExitReason: runner.ReasonFailed}))

	run.mu.Lock()
	defer run.mu.Unlock()
	require.NotNil(t, run.summary)
	require.Equal(t, runner.ReasonCompleted, run.summary.ExitReason)
	summaries := 0
	for _, ev := range run.history {
		if ev.Kind == parser.KindSummary {
			summaries++
		}
	}
	require.Equal(t, 1, summaries, "second summary must be ignored")
	require.Equal(t, "completed", finalState(run))
}
