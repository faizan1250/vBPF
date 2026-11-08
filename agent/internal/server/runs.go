package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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

	mu       sync.Mutex
	history  []parser.Event
	subs     map[*subscriber]struct{}
	dropped  uint64
	lastLost time.Time
	lastSeq  uint64
	rateN    int
	rateWin  time.Time
	summary  *parser.Summary
	runErr   error
}

func newRunID() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("run_%d_%s", time.Now().UnixMilli(), hex.EncodeToString(b[:]))
}

// Registry caps concurrent runs and owns their lifetimes.
type Registry struct {
	mu           sync.Mutex
	active       map[string]*Run
	finished     map[string]*Run
	finishOrder  []string
	maxConc      int
	runFn        RunnerFunc
	bpftracePath string
	logger       zerolog.Logger
}

// NewRegistry builds a run registry with no global state.
func NewRegistry(runFn RunnerFunc, bpftracePath string, logger zerolog.Logger) *Registry {
	if runFn == nil {
		runFn = runner.Run
	}
	return &Registry{
		active:       make(map[string]*Run),
		finished:     make(map[string]*Run),
		maxConc:      limits.MaxConcurrentRuns,
		runFn:        runFn,
		bpftracePath: bpftracePath,
		logger:       logger,
	}
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

// retainFinished caps retained terminal runs so replays stay available.
const retainFinished = 16

func (r *Registry) execute(ctx context.Context, run *Run, log zerolog.Logger, script string, duration time.Duration) {
	defer close(run.done)
	defer func() {
		r.mu.Lock()
		run.mu.Lock()
		run.state = finalState(run)
		run.mu.Unlock()
		delete(r.active, run.id)
		r.finished[run.id] = run
		r.finishOrder = append(r.finishOrder, run.id)
		for len(r.finishOrder) > retainFinished {
			oldest := r.finishOrder[0]
			r.finishOrder = r.finishOrder[1:]
			delete(r.finished, oldest)
		}
		r.mu.Unlock()
	}()
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
	if run.rateN >= maxPerSecond {
		run.dropped++
		run.maybeEmitLostLocked(now)
		return
	}
	run.rateN++
	if ev.Seq > run.lastSeq || (ev.Kind == parser.KindStatus && ev.Seq >= run.lastSeq) {
		run.lastSeq = ev.Seq
	}
	if ev.Kind == parser.KindSummary {
		if s, ok := ev.Data.(parser.Summary); ok {
			cp := s
			run.summary = &cp
		}
	}
	run.history = append(run.history, ev)
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
	for sub := range run.subs {
		select {
		case sub.ch <- lost:
		default:
		}
	}
}

// subscribe replays history then streams live events.
func (run *Run) subscribe() (*subscriber, []parser.Event) {
	sub := &subscriber{ch: make(chan parser.Event, subBuffer)}
	run.mu.Lock()
	defer run.mu.Unlock()
	hist := make([]parser.Event, len(run.history))
	copy(hist, run.history)
	run.subs[sub] = struct{}{}
	return sub, hist
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
