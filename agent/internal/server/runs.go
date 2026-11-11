package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/faizan1250/vBPF/agent/internal/limits"
	"github.com/faizan1250/vBPF/agent/internal/parser"
	"github.com/faizan1250/vBPF/agent/internal/runner"
)

// RunnerFunc executes one probe run; defaults to runner.Run.
type RunnerFunc func(ctx context.Context, opts runner.Options, emit func(parser.Event) error) error

const (
	subBuffer     = 256
	maxPerSecond  = 500 // sustained event rate forwarded to consumers
	lostThrottle  = time.Second
	flushInterval = 100 * time.Millisecond // 10 Hz stream batches
)

// subscriber receives broadcast events with drop-oldest backpressure.
type subscriber struct {
	ch chan parser.Event
}

// Run tracks one probe execution and its stream fan-out.
type Run struct {
	id        string
	state     string
	startedAt time.Time
	cancel    context.CancelFunc
	done      chan struct{}

	mu           sync.Mutex
	history      []parser.Event
	historyBytes int64
	finishedAt   time.Time
	historyTimer *time.Timer
	subs         map[*subscriber]struct{}
	dropped      uint64
	lastLost     time.Time
	lastSeq      uint64
	rateN        int
	rateWin      time.Time
	summary      *parser.Summary
	summarySeq   uint64
	summaryTs    int64
	runErr       error
}

func newRunID() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("run_%d_%s", time.Now().UnixMilli(), hex.EncodeToString(b[:]))
}

// Registry caps concurrent runs and owns their lifetimes.
type Registry struct {
	mu                      sync.Mutex
	active                  map[string]*Run
	finished                map[string]*Run
	finishOrder             []string
	maxConc                 int
	maxFinishedHistoryBytes int64
	finishedHistoryTTL      time.Duration
	closed                  bool
	runFn                   RunnerFunc
	bpftracePath            string
	logger                  zerolog.Logger
}

// RegistryOption configures optional Registry retention parameters.
type RegistryOption func(*Registry)

// WithMaxFinishedHistoryBytes sets the retained event history byte cap across finished runs.
func WithMaxFinishedHistoryBytes(limit int64) RegistryOption {
	return func(r *Registry) {
		if limit >= 0 {
			r.maxFinishedHistoryBytes = limit
		}
	}
}

// WithFinishedHistoryTTL sets how long finished-run event history remains available for replay.
func WithFinishedHistoryTTL(ttl time.Duration) RegistryOption {
	return func(r *Registry) {
		if ttl > 0 {
			r.finishedHistoryTTL = ttl
		}
	}
}

// NewRegistry builds a run registry with no global state.
func NewRegistry(runFn RunnerFunc, bpftracePath string, logger zerolog.Logger, opts ...RegistryOption) *Registry {
	if runFn == nil {
		runFn = runner.Run
	}
	r := &Registry{
		active:                  make(map[string]*Run),
		finished:                make(map[string]*Run),
		maxConc:                 limits.MaxConcurrentRuns,
		maxFinishedHistoryBytes: maxFinishedHistoryBytes,
		finishedHistoryTTL:      finishedHistoryTTL,
		runFn:                   runFn,
		bpftracePath:            bpftracePath,
		logger:                  logger,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(r)
		}
	}
	return r
}

// Active returns the number of live runs.
func (r *Registry) Active() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.active)
}

// Get fetches a run by id, including recently finished ones.
func (r *Registry) Get(id string) (*Run, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if run, ok := r.active[id]; ok {
		return run, true
	}
	run, ok := r.finished[id]
	if ok && r.finishedHistoryTTL > 0 {
		now := time.Now()
		run.mu.Lock()
		if !run.finishedAt.IsZero() && now.Sub(run.finishedAt) >= r.finishedHistoryTTL && (len(run.history) > 0 || run.historyBytes > 0) {
			run.clearHistoryLocked()
		}
		run.mu.Unlock()
	}
	return run, ok
}

// Start validates duration, enforces the concurrency cap, and launches runner.
func (r *Registry) Start(ctx context.Context, script string, duration time.Duration) (*Run, error) {
	if err := limits.ValidateDuration(duration); err != nil {
		return nil, err
	}
	if script == "" {
		return nil, fmt.Errorf("empty script")
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil, fmt.Errorf("registry closed")
	}
	if len(r.active) >= r.maxConc {
		r.mu.Unlock()
		return nil, fmt.Errorf("another run is active")
	}
	id := newRunID()
	for {
		if _, dup := r.active[id]; !dup {
			break
		}
		id = newRunID()
	}
	runCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	log := r.logger.With().Str("run_id", id).Logger()
	runCtx = log.WithContext(runCtx)
	run := &Run{
		id:        id,
		state:     "running",
		startedAt: time.Now(),
		cancel:    cancel,
		done:      make(chan struct{}),
		subs:      make(map[*subscriber]struct{}),
		rateWin:   time.Now(),
	}
	r.active[id] = run
	r.mu.Unlock()

	go r.execute(runCtx, run, log, script, duration)
	return run, nil
}

// Shutdown cancels active runs and stops pending finished-history timers.
func (r *Registry) Shutdown() {
	r.mu.Lock()
	r.closed = true
	cancels := make([]context.CancelFunc, 0, len(r.active))
	for _, run := range r.active {
		cancels = append(cancels, run.cancel)
	}
	for _, run := range r.finished {
		run.mu.Lock()
		run.clearHistoryLocked()
		run.mu.Unlock()
	}
	r.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

const (
	// retainFinished caps retained terminal run metadata slots.
	retainFinished = 16
	// maxFinishedHistoryBytes bounds total replay event memory across all finished runs.
	maxFinishedHistoryBytes = 1 << 20
	// finishedHistoryTTL bounds how long finished runs retain replay events after completion.
	finishedHistoryTTL = 30 * time.Second
)

func (r *Registry) execute(ctx context.Context, run *Run, log zerolog.Logger, script string, duration time.Duration) {
	defer close(run.done)
	defer r.finishRun(run)
	opts := runner.Options{
		BPFtracePath: r.bpftracePath,
		Script:       script,
		Duration:     duration,
		RunID:        run.id,
	}
	err := r.runFn(ctx, opts, func(ev parser.Event) error {
		run.publish(ev)
		return nil
	})
	run.mu.Lock()
	run.runErr = err
	if err != nil {
		log.Error().Err(err).Msg("run finished with error")
	} else {
		log.Info().Msg("run finished")
	}
	run.mu.Unlock()
}

func (r *Registry) finishRun(run *Run) {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	r.pruneExpiredHistoriesLocked(now)

	run.mu.Lock()
	run.state = finalState(run)
	run.finishedAt = now
	if r.closed {
		run.clearHistoryLocked()
	} else {
		run.trimHistoryToBudgetLocked(r.maxFinishedHistoryBytes)
	}
	run.mu.Unlock()

	delete(r.active, run.id)
	r.finished[run.id] = run
	r.finishOrder = append(r.finishOrder, run.id)
	for len(r.finishOrder) > retainFinished {
		oldest := r.finishOrder[0]
		copy(r.finishOrder, r.finishOrder[1:])
		r.finishOrder[len(r.finishOrder)-1] = ""
		r.finishOrder = r.finishOrder[:len(r.finishOrder)-1]
		if oldRun, ok := r.finished[oldest]; ok {
			oldRun.mu.Lock()
			oldRun.clearHistoryLocked()
			oldRun.mu.Unlock()
			delete(r.finished, oldest)
		}
	}

	r.enforceFinishedHistoryBudgetLocked()

	run.mu.Lock()
	if !r.closed && len(run.history) > 0 && r.finishedHistoryTTL > 0 {
		run.stopHistoryTimerLocked()
		run.historyTimer = time.AfterFunc(r.finishedHistoryTTL, func() {
			r.expireRunHistory(run)
		})
	}
	run.mu.Unlock()
}

func (r *Registry) pruneExpiredHistoriesLocked(now time.Time) {
	if r.finishedHistoryTTL <= 0 {
		return
	}
	for _, id := range r.finishOrder {
		fin := r.finished[id]
		if fin == nil {
			continue
		}
		fin.mu.Lock()
		if !fin.finishedAt.IsZero() && now.Sub(fin.finishedAt) >= r.finishedHistoryTTL && (len(fin.history) > 0 || fin.historyBytes > 0) {
			fin.clearHistoryLocked()
		}
		fin.mu.Unlock()
	}
}

func (r *Registry) enforceFinishedHistoryBudgetLocked() {
	var total int64
	for _, id := range r.finishOrder {
		fin := r.finished[id]
		if fin == nil {
			continue
		}
		fin.mu.Lock()
		total += fin.historyBytes
		fin.mu.Unlock()
	}
	for _, id := range r.finishOrder {
		if total <= r.maxFinishedHistoryBytes {
			break
		}
		fin := r.finished[id]
		if fin == nil {
			continue
		}
		fin.mu.Lock()
		if len(fin.history) > 0 || fin.historyBytes > 0 {
			cleared := fin.historyBytes
			fin.clearHistoryLocked()
			total -= cleared
		}
		fin.mu.Unlock()
	}
}

func (r *Registry) expireRunHistory(run *Run) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	if cur, ok := r.finished[run.id]; !ok || cur != run {
		return
	}
	run.mu.Lock()
	run.clearHistoryLocked()
	run.mu.Unlock()
}

func (r *Registry) finishedHistoryBytes() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	var total int64
	for _, fin := range r.finished {
		fin.mu.Lock()
		total += fin.historyBytes
		fin.mu.Unlock()
	}
	return total
}

func finalState(run *Run) string {
	if run.summary != nil {
		switch run.summary.ExitReason {
		case runner.ReasonCompleted, runner.ReasonTimeout:
			return "completed"
		case runner.ReasonCancelled:
			return "stopping"
		default:
			return "failed"
		}
	}
	if run.runErr != nil {
		return "failed"
	}
	return "completed"
}

// Stop cancels a run; runner escalates SIGINT to SIGKILL on its grace period.
func (r *Registry) Stop(id string) bool {
	r.mu.Lock()
	run, ok := r.active[id]
	r.mu.Unlock()
	if !ok {
		return false
	}
	run.mu.Lock()
	if run.state == "running" {
		run.state = "stopping"
	}
	run.mu.Unlock()
	run.cancel()
	return true
}

// publish forwards one event with rate cap and drop-oldest fan-out.
func (run *Run) publish(ev parser.Event) {
	now := time.Now()
	run.mu.Lock()
	defer run.mu.Unlock()
	if now.Sub(run.rateWin) >= time.Second {
		run.rateWin = now
		run.rateN = 0
	}
	// Terminal summary is never rate-limited: dropping it loses finalState
	// and stalls stream consumers waiting for summary completion.
	if ev.Kind != parser.KindSummary {
		if run.rateN >= maxPerSecond {
			run.dropped++
			run.maybeEmitLostLocked(now)
			return
		}
		run.rateN++
	}
	if ev.Seq > run.lastSeq || (ev.Kind == parser.KindStatus && ev.Seq >= run.lastSeq) {
		run.lastSeq = ev.Seq
	}
	if ev.Kind == parser.KindSummary {
		if s, ok := ev.Data.(parser.Summary); ok {
			cp := s
			run.summary = &cp
			run.summarySeq = ev.Seq
			run.summaryTs = ev.Ts
		}
	}
	run.history = append(run.history, ev)
	run.historyBytes += eventBytes(ev)
	for sub := range run.subs {
		select {
		case sub.ch <- ev:
		default:
			select {
			case <-sub.ch:
			default:
			}
			select {
			case sub.ch <- ev:
			default:
			}
			run.dropped++
		}
	}
	run.maybeEmitLostLocked(now)
}

func (run *Run) maybeEmitLostLocked(now time.Time) {
	if run.dropped == 0 || now.Sub(run.lastLost) < lostThrottle {
		return
	}
	run.lastSeq++
	lost := parser.Lost(run.id, run.lastSeq, run.dropped)
	run.dropped = 0
	run.lastLost = now
	run.history = append(run.history, lost)
	run.historyBytes += eventBytes(lost)
	for sub := range run.subs {
		select {
		case sub.ch <- lost:
		default:
		}
	}
}

// subscribe replays history (or synthesized terminal summary after eviction/expiry)
// then streams live events.
func (run *Run) subscribe() (*subscriber, []parser.Event) {
	sub := &subscriber{ch: make(chan parser.Event, subBuffer)}
	run.mu.Lock()
	defer run.mu.Unlock()
	var hist []parser.Event
	if len(run.history) > 0 {
		hist = make([]parser.Event, len(run.history))
		copy(hist, run.history)
	} else if run.summary != nil {
		hist = []parser.Event{run.summaryEventLocked()}
	}
	run.subs[sub] = struct{}{}
	return sub, hist
}

func (run *Run) summaryEventLocked() parser.Event {
	return parser.Event{
		RunID: run.id,
		Seq:   run.summarySeq,
		Ts:    run.summaryTs,
		Kind:  parser.KindSummary,
		Data:  *run.summary,
	}
}

func (run *Run) summaryEvent() (parser.Event, bool) {
	run.mu.Lock()
	defer run.mu.Unlock()
	if run.summary == nil {
		return parser.Event{}, false
	}
	return run.summaryEventLocked(), true
}

func (run *Run) unsubscribe(sub *subscriber) {
	run.mu.Lock()
	defer run.mu.Unlock()
	delete(run.subs, sub)
}

// snapshot exposes state for HTTP handlers.
func (run *Run) snapshot() (id, state string, dropped uint64) {
	run.mu.Lock()
	defer run.mu.Unlock()
	return run.id, run.state, run.dropped
}

func (run *Run) stopHistoryTimerLocked() {
	if run.historyTimer != nil {
		run.historyTimer.Stop()
		run.historyTimer = nil
	}
}

func (run *Run) clearHistoryLocked() {
	run.stopHistoryTimerLocked()
	if len(run.history) > 0 {
		run.dropped += uint64(len(run.history))
	}
	run.history = nil
	run.historyBytes = 0
}

func (run *Run) trimHistoryToBudgetLocked(budget int64) {
	if budget <= 0 {
		run.clearHistoryLocked()
		return
	}
	if run.historyBytes <= budget {
		return
	}
	idx := 0
	for idx < len(run.history) && run.historyBytes > budget {
		run.historyBytes -= eventBytes(run.history[idx])
		if run.historyBytes < 0 {
			run.historyBytes = 0
		}
		run.dropped++
		idx++
	}
	if idx >= len(run.history) {
		run.history = nil
		run.historyBytes = 0
		return
	}
	// Copy into an exact-sized slice so GC releases the trimmed backing array.
	kept := make([]parser.Event, len(run.history)-idx)
	copy(kept, run.history[idx:])
	var keptBytes int64
	for _, ev := range kept {
		keptBytes += eventBytes(ev)
	}
	run.history = kept
	run.historyBytes = keptBytes
}

func eventBytes(ev parser.Event) int64 {
	return 64 + int64(len(ev.RunID)) + int64(len(ev.Kind)) + estimateValueBytes(ev.Data, 0)
}

func estimateValueBytes(v any, depth int) int64 {
	if v == nil {
		return 0
	}
	if depth > 32 {
		return 64
	}
	switch x := v.(type) {
	case string:
		return int64(len(x)) + 16
	case []byte:
		return int64(len(x)) + 24
	case bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return 8
	case []string:
		n := int64(24)
		for _, s := range x {
			n += 16 + int64(len(s))
		}
		return n
	case []any:
		n := int64(24)
		for _, elem := range x {
			n += 16 + estimateValueBytes(elem, depth+1)
		}
		return n
	case map[string]string:
		n := int64(48)
		for k, val := range x {
			n += 48 + int64(len(k)) + int64(len(val))
		}
		return n
	case map[string]uint64:
		n := int64(48)
		for k := range x {
			n += 40 + int64(len(k))
		}
		return n
	case map[string]any:
		n := int64(48)
		for k, val := range x {
			n += 48 + int64(len(k)) + estimateValueBytes(val, depth+1)
		}
		return n
	case parser.Summary:
		return 64 + int64(len(x.ExitReason))
	case *parser.Summary:
		if x == nil {
			return 0
		}
		return 64 + int64(len(x.ExitReason))
	default:
		if raw, err := json.Marshal(x); err == nil {
			return int64(len(raw)) + 32
		}
		return 64
	}
}
