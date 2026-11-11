package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"

	"github.com/faizan1250/vBPF/agent/internal/parser"
	"github.com/faizan1250/vBPF/agent/internal/runner"
)

func largePayloadRunner(chunkBytes, chunks int) RunnerFunc {
	payload := strings.Repeat("a", chunkBytes)
	return func(ctx context.Context, opts runner.Options, emit func(parser.Event) error) error {
		if err := emit(parser.Status(opts.RunID, 0, "running")); err != nil {
			return err
		}
		for i := 0; i < chunks; i++ {
			if err := emit(parser.Event{
				RunID: opts.RunID,
				Seq:   uint64(i + 1),
				Ts:    parser.NowMillis(),
				Kind:  parser.KindPrintf,
				Data:  fmt.Sprintf("%03d:%s", i, payload),
			}); err != nil {
				return err
			}
		}
		return emit(parser.Summarize(opts.RunID, uint64(chunks+1), parser.Summary{
			Events:     uint64(chunks),
			Bytes:      uint64(chunks * chunkBytes),
			ExitReason: runner.ReasonCompleted,
		}))
	}
}

func TestFinishedRunsGlobalHistoryCap(t *testing.T) {
	// Each run emits ~512 KB (> 8 MB total across 16 runs without the global cap).
	reg := NewRegistry(largePayloadRunner(128*1024, 4), "", testLogger())
	t.Cleanup(reg.Shutdown)

	runs := make([]*Run, 0, retainFinished)
	for i := 0; i < retainFinished; i++ {
		run, err := reg.Start(context.Background(), "BEGIN {}", 5*time.Second)
		require.NoError(t, err)
		<-run.done
		runs = append(runs, run)
		require.LessOrEqual(t, reg.finishedHistoryBytes(), int64(maxFinishedHistoryBytes))
	}

	require.LessOrEqual(t, reg.finishedHistoryBytes(), int64(maxFinishedHistoryBytes))

	// Oldest runs must have had their history evicted while keeping summary metadata.
	for i := 0; i < retainFinished-2; i++ {
		r := runs[i]
		r.mu.Lock()
		hist := r.history
		histBytes := r.historyBytes
		timer := r.historyTimer
		dropped := r.dropped
		summary := r.summary
		r.mu.Unlock()

		require.Nil(t, hist, "oldest run %d retained history", i)
		require.Zero(t, histBytes, "oldest run %d retained historyBytes", i)
		require.Nil(t, timer, "oldest run %d leaked timer", i)
		require.Positive(t, dropped, "oldest run %d missing dropped count", i)
		require.NotNil(t, summary, "oldest run %d lost summary", i)
		require.Equal(t, runner.ReasonCompleted, summary.ExitReason)
	}

	// Newest finished run retains replay history within the global cap.
	newest := runs[len(runs)-1]
	newest.mu.Lock()
	require.NotEmpty(t, newest.history)
	require.Positive(t, newest.historyBytes)
	require.NotNil(t, newest.summary)
	newest.mu.Unlock()
}

func TestSingleRunOverBudgetTrimsOldestAndReleasesSlice(t *testing.T) {
	// Emits ~1.5 MB (6 x 256 KB) in one run, exceeding the 1 MB finished-history cap.
	reg := NewRegistry(largePayloadRunner(256*1024, 6), "", testLogger())
	t.Cleanup(reg.Shutdown)

	run, err := reg.Start(context.Background(), "BEGIN {}", 5*time.Second)
	require.NoError(t, err)
	<-run.done

	require.LessOrEqual(t, reg.finishedHistoryBytes(), int64(maxFinishedHistoryBytes))

	run.mu.Lock()
	defer run.mu.Unlock()
	require.LessOrEqual(t, run.historyBytes, int64(maxFinishedHistoryBytes))
	require.Positive(t, run.dropped, "trimmed oldest events should increment dropped")
	require.NotEmpty(t, run.history)
	// Exact-capacity copy guarantees the oversized backing slice is released for GC.
	require.Equal(t, len(run.history), cap(run.history))
	require.Equal(t, parser.KindSummary, run.history[len(run.history)-1].Kind)
	require.Contains(t, fmt.Sprint(run.history[len(run.history)-2].Data), "005:")
	require.NotNil(t, run.summary)
	require.Equal(t, uint64(6), run.summary.Events)
}

func TestFastCompletingRunReplaysWithinTTL(t *testing.T) {
	s := testServer(t, Config{RunFn: fakeRunner(3, 0)})
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	req, err := http.NewRequest("POST", ts.URL+"/v1/runs", strings.NewReader(`{"script":"BEGIN { @x = count(); }","duration_s":5}`))
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+s.Token())
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusCreated, resp.StatusCode)

	var created struct {
		RunID string `json:"run_id"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&created))

	run, ok := s.runs.Get(created.RunID)
	require.True(t, ok)
	// Force fast completion before the stream viewer connects.
	<-run.done

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws://" + strings.TrimPrefix(ts.URL, "http://") + "/v1/runs/" + created.RunID + "/stream"
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + s.Token()}},
	})
	require.NoError(t, err)
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	var kinds []parser.Kind
	for {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			break
		}
		var ev parser.Event
		require.NoError(t, json.Unmarshal(raw, &ev))
		require.Equal(t, created.RunID, ev.RunID)
		kinds = append(kinds, ev.Kind)
		if ev.Kind == parser.KindSummary {
			break
		}
	}
	require.Equal(t, []parser.Kind{parser.KindStatus, parser.KindPrintf, parser.KindPrintf, parser.KindPrintf, parser.KindSummary}, kinds)
}

func TestFinishedRunHistoryTTLExpiresCleanly(t *testing.T) {
	reg := NewRegistry(fakeRunner(5, 0), "", testLogger(), WithFinishedHistoryTTL(25*time.Millisecond))
	t.Cleanup(reg.Shutdown)

	run, err := reg.Start(context.Background(), "BEGIN {}", 5*time.Second)
	require.NoError(t, err)
	<-run.done

	run.mu.Lock()
	require.NotEmpty(t, run.history)
	require.Positive(t, run.historyBytes)
	run.mu.Unlock()

	require.Eventually(t, func() bool {
		run.mu.Lock()
		defer run.mu.Unlock()
		return run.history == nil && run.historyBytes == 0 && run.historyTimer == nil
	}, 2*time.Second, 5*time.Millisecond)

	require.Zero(t, reg.finishedHistoryBytes())

	// Run entry and summary metadata stay accessible via Get even after history expires.
	got, ok := reg.Get(run.id)
	require.True(t, ok)
	require.Equal(t, run, got)

	got.mu.Lock()
	require.Nil(t, got.history)
	require.Zero(t, got.historyBytes)
	require.NotNil(t, got.summary)
	require.Equal(t, runner.ReasonCompleted, got.summary.ExitReason)
	got.mu.Unlock()

	sub, hist := got.subscribe()
	defer got.unsubscribe(sub)
	require.Len(t, hist, 1)
	require.Equal(t, parser.KindSummary, hist[0].Kind)
}

func TestLateStreamReconnectAfterEvictionAndTTLReceivesSummary(t *testing.T) {
	t.Run("after TTL expiry", func(t *testing.T) {
		s := testServer(t, Config{})
		s.runs = NewRegistry(fakeRunner(4, 0), "", testLogger(), WithFinishedHistoryTTL(20*time.Millisecond))
		t.Cleanup(s.runs.Shutdown)

		ts := httptest.NewServer(s.Handler())
		defer ts.Close()

		id := createRun(t, s, "BEGIN { @x = count(); }", 5)
		run, ok := s.runs.Get(id)
		require.True(t, ok)
		<-run.done

		require.Eventually(t, func() bool {
			run.mu.Lock()
			defer run.mu.Unlock()
			return run.history == nil && run.historyBytes == 0
		}, 2*time.Second, 5*time.Millisecond)

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		wsURL := "ws://" + strings.TrimPrefix(ts.URL, "http://") + "/v1/runs/" + id + "/stream"
		conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
			HTTPHeader: http.Header{"Authorization": []string{"Bearer " + s.Token()}},
		})
		require.NoError(t, err)
		defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

		_, raw, err := conn.Read(ctx)
		require.NoError(t, err)
		var ev parser.Event
		require.NoError(t, json.Unmarshal(raw, &ev))
		require.Equal(t, id, ev.RunID)
		require.Equal(t, parser.KindSummary, ev.Kind)
	})

	t.Run("after FIFO history eviction", func(t *testing.T) {
		s := testServer(t, Config{})
		s.runs = NewRegistry(largePayloadRunner(200*1024, 3), "", testLogger())
		t.Cleanup(s.runs.Shutdown)

		ts := httptest.NewServer(s.Handler())
		defer ts.Close()

		id1 := createRun(t, s, "BEGIN { @x = count(); }", 5)
		r1, ok := s.runs.Get(id1)
		require.True(t, ok)
		<-r1.done

		id2 := createRun(t, s, "BEGIN { @x = count(); }", 5)
		r2, ok := s.runs.Get(id2)
		require.True(t, ok)
		<-r2.done

		// Run 1 (~600 KB) + Run 2 (~600 KB) > 1 MB cap, so Run 1's history is evicted.
		r1.mu.Lock()
		require.Nil(t, r1.history)
		require.Zero(t, r1.historyBytes)
		r1.mu.Unlock()

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		wsURL := "ws://" + strings.TrimPrefix(ts.URL, "http://") + "/v1/runs/" + id1 + "/stream"
		conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
			HTTPHeader: http.Header{"Authorization": []string{"Bearer " + s.Token()}},
		})
		require.NoError(t, err)
		defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

		_, raw, err := conn.Read(ctx)
		require.NoError(t, err)
		var ev parser.Event
		require.NoError(t, json.Unmarshal(raw, &ev))
		require.Equal(t, id1, ev.RunID)
		require.Equal(t, parser.KindSummary, ev.Kind)
	})
}

func TestFinishedRunHistoryTTLConcurrentAccessRaceClean(t *testing.T) {
	reg := NewRegistry(fakeRunner(4, 0), "", testLogger(), WithFinishedHistoryTTL(15*time.Millisecond))
	t.Cleanup(reg.Shutdown)

	run, err := reg.Start(context.Background(), "BEGIN {}", 5*time.Second)
	require.NoError(t, err)
	<-run.done

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				if r, ok := reg.Get(run.id); ok {
					sub, _ := r.subscribe()
					r.unsubscribe(sub)
					_, _, _ = r.snapshot()
				}
				time.Sleep(2 * time.Millisecond)
			}
		}()
	}
	wg.Wait()
}

func TestRegistryShutdownStopsTimersAndActiveRuns(t *testing.T) {
	started := make(chan struct{})
	reg := NewRegistry(func(ctx context.Context, opts runner.Options, emit func(parser.Event) error) error {
		_ = emit(parser.Status(opts.RunID, 0, "running"))
		if opts.Script == "block" {
			close(started)
			<-ctx.Done()
			return emit(parser.Summarize(opts.RunID, 1, parser.Summary{ExitReason: runner.ReasonCancelled}))
		}
		return emit(parser.Summarize(opts.RunID, 1, parser.Summary{ExitReason: runner.ReasonCompleted}))
	}, "", testLogger())

	finished, err := reg.Start(context.Background(), "fast", 5*time.Second)
	require.NoError(t, err)
	<-finished.done

	active, err := reg.Start(context.Background(), "block", 5*time.Second)
	require.NoError(t, err)
	<-started

	reg.Shutdown()

	select {
	case <-active.done:
	case <-time.After(2 * time.Second):
		t.Fatal("active run did not stop on Shutdown")
	}
	require.Zero(t, reg.Active())
	require.Zero(t, reg.finishedHistoryBytes())

	for _, r := range []*Run{finished, active} {
		r.mu.Lock()
		require.Nil(t, r.history)
		require.Zero(t, r.historyBytes)
		require.Nil(t, r.historyTimer)
		require.NotNil(t, r.summary)
		r.mu.Unlock()
	}

	_, err = reg.Start(context.Background(), "after", 5*time.Second)
	require.Error(t, err)
}

func TestBurstDoesNotDropTerminalSummary(t *testing.T) {
	run := &Run{id: "run_burst", state: "running", subs: make(map[*subscriber]struct{}), rateWin: time.Now()}
	sub, _ := run.subscribe()
	defer run.unsubscribe(sub)

	// Saturate the per-second budget, then overflow it within the same window.
	for i := 0; i < maxPerSecond+100; i++ {
		run.publish(parser.Event{RunID: run.id, Seq: uint64(i + 1), Ts: parser.NowMillis(), Kind: parser.KindPrintf, Data: fmt.Sprintf("line %d", i)})
	}
	run.publish(parser.Summarize(run.id, uint64(maxPerSecond+101), parser.Summary{Events: uint64(maxPerSecond + 100), ExitReason: runner.ReasonCompleted}))

	// Non-terminal overflow is still shed.
	run.mu.Lock()
	defer run.mu.Unlock()
	require.Positive(t, run.dropped)
	require.NotNil(t, run.summary)
	require.Equal(t, runner.ReasonCompleted, run.summary.ExitReason)
	require.NotEmpty(t, run.history)
	require.Equal(t, parser.KindSummary, run.history[len(run.history)-1].Kind)
	require.Equal(t, "completed", finalState(run))

	// Subscriber fan-out also delivers the terminal summary.
	found := false
	for {
		select {
		case ev := <-sub.ch:
			if ev.Kind == parser.KindSummary {
				found = true
			}
		default:
			require.True(t, found, "subscriber never received terminal summary under burst")
			return
		}
	}
}
