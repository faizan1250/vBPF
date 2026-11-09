package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"

	"github.com/faizan1250/vBPF/agent/internal/limits"
	"github.com/faizan1250/vBPF/agent/internal/parser"
)

// Config wires the server without globals.
type Config struct {
	Addr         string
	TokenFile    string
	BPFtracePath string
	CatalogFn    func(ctx context.Context) ([]string, error)
	RunFn        RunnerFunc
	DryRun       DryRunFunc
	Health       *HealthProvider
	Logger       zerolog.Logger
	StartTime    time.Time
}

// Server is the agent HTTP and WebSocket front end.
type Server struct {
	addr         string
	token        string
	mux          *http.ServeMux
	runs         *Registry
	catalog      *Catalog
	health       *HealthProvider
	dryRun       DryRunFunc
	logger       zerolog.Logger
	startTime    time.Time
	bpftracePath string
}

// New loads or creates the bearer token and registers authenticated routes.
func New(cfg Config) (*Server, error) {
	if cfg.Addr == "" {
		cfg.Addr = "127.0.0.1:8787"
	}
	tokenFile := cfg.TokenFile
	if tokenFile == "" {
		tokenFile = TokenFilePath()
	}
	tok, err := LoadOrCreateToken(tokenFile)
	if err != nil {
		return nil, fmt.Errorf("server: token: %w", err)
	}
	if cfg.StartTime.IsZero() {
		cfg.StartTime = time.Now()
	}
	health := cfg.Health
	if health == nil {
		health = NewHealthProvider(cfg.StartTime, cfg.BPFtracePath)
	}
	catalog := NewCatalog(cfg.BPFtracePath, cfg.CatalogFn)
	dryRun := cfg.DryRun
	if dryRun == nil {
		dryRun = DefaultDryRun(cfg.BPFtracePath)
	}
	s := &Server{
		addr:         cfg.Addr,
		token:        tok,
		mux:          http.NewServeMux(),
		runs:         NewRegistry(cfg.RunFn, cfg.BPFtracePath, cfg.Logger),
		catalog:      catalog,
		health:       health,
		dryRun:       dryRun,
		logger:       cfg.Logger,
		startTime:    cfg.StartTime,
		bpftracePath: cfg.BPFtracePath,
	}
	s.routes()
	return s, nil
}

// Handler exposes the mux for httptest.
func (s *Server) Handler() http.Handler { return s.mux }

// Token is exposed only for tests; never log it.
func (s *Server) Token() string { return s.token }

func (s *Server) routes() {
	s.mux.Handle("GET /health", s.auth(http.HandlerFunc(s.handleHealth)))
	s.mux.Handle("GET /v1/probes", s.auth(http.HandlerFunc(s.handleProbes)))
	s.mux.Handle("POST /v1/validate", s.auth(http.HandlerFunc(s.handleValidate)))
	s.mux.Handle("POST /v1/runs", s.auth(http.HandlerFunc(s.handleCreateRun)))
	s.mux.Handle("DELETE /v1/runs/{id}", s.auth(http.HandlerFunc(s.handleDeleteRun)))
	s.mux.Handle("GET /v1/runs/{id}/stream", s.auth(http.HandlerFunc(s.handleStream)))
}

func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !tokensEqual(bearerToken(r), s.token) {
			s.logger.Warn().Str("path", r.URL.Path).Msg("unauthorized")
			writeUnauthorized(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ListenAndServe binds loopback only and serves until ctx ends.
func (s *Server) ListenAndServe(ctx context.Context) error {
	host, _, err := net.SplitHostPort(s.addr)
	if err != nil {
		return fmt.Errorf("server: bad addr: %w", err)
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("server: refuses non-loopback bind %q", host)
	}
	_ = s.catalog.Refresh(ctx)
	srv := &http.Server{Addr: s.addr, Handler: s.mux}
	go func() {
		<-ctx.Done()
		cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(cctx)
	}()
	s.logger.Info().Str("addr", s.addr).Msg("agent listening")
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, errCode, msg string) {
	writeJSON(w, code, map[string]string{"error": msg, "code": errCode})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.health.Snapshot(r.Context()))
}

func (s *Server) handleProbes(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	typ := r.URL.Query().Get("type")
	probes := s.catalog.Search(q, typ)
	if probes == nil {
		probes = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"probes": probes, "count": len(probes)})
}

type validateRequest struct {
	Script string `json:"script"`
}

func (s *Server) handleValidate(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	var req validateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "invalid JSON")
		return
	}
	probes, errs := StaticValidate(req.Script, s.catalog)
	if len(errs) > 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "errors": errs, "probes": probesOrEmpty(probes)})
		return
	}
	if dryErrs := s.dryRun(r.Context(), req.Script); len(dryErrs) > 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "errors": dryErrs, "probes": probesOrEmpty(probes)})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "errors": []string{}, "probes": probesOrEmpty(probes)})
}

func probesOrEmpty(p []string) []string {
	if p == nil {
		return []string{}
	}
	return p
}

type createRunRequest struct {
	Script    string `json:"script"`
	DurationS *int   `json:"duration_s"`
}

func (s *Server) handleCreateRun(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	var req createRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "invalid JSON")
		return
	}
	duration := limits.DefaultDuration
	if req.DurationS != nil {
		duration = time.Duration(*req.DurationS) * time.Second
	}
	if _, errs := StaticValidate(req.Script, s.catalog); len(errs) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": strings.Join(errs, "; "), "code": classifyValidationError(errs), "errors": errs})
		return
	}
	if dryErrs := s.dryRun(r.Context(), req.Script); len(dryErrs) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": strings.Join(dryErrs, "; "), "code": classifyValidationError(dryErrs), "errors": dryErrs})
		return
	}
	run, err := s.runs.Start(r.Context(), req.Script, duration)
	if err != nil {
		if strings.Contains(err.Error(), "another run is active") {
			writeError(w, http.StatusConflict, "LIMIT_EXCEEDED", "another run is active")
			return
		}
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", err.Error())
		return
	}
	id, state, _ := run.snapshot()
	s.logger.Info().Str("run_id", id).Msg("run started")
	writeJSON(w, http.StatusCreated, map[string]string{"run_id": id, "state": state})
}

func (s *Server) handleDeleteRun(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "missing id")
		return
	}
	if !s.runs.Stop(id) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "unknown run")
		return
	}
	s.logger.Info().Str("run_id", id).Msg("run stop requested")
	writeJSON(w, http.StatusOK, map[string]string{"run_id": id, "state": "stopping"})
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	run, ok := s.runs.Get(id)
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "unknown run")
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
		return
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "done") }()
	ctx := r.Context()
	sub, hist := run.subscribe()
	defer run.unsubscribe(sub)

	for _, ev := range hist {
		if err := writeEvent(ctx, conn, ev); err != nil {
			return
		}
		if ev.Kind == parser.KindSummary {
			return
		}
	}

	readCtx, cancelRead := context.WithCancel(ctx)
	defer cancelRead()
	go func() {
		for {
			_, msg, err := conn.Read(readCtx)
			if err != nil {
				return
			}
			var m struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(msg, &m); err != nil {
				continue
			}
			if m.Type == "stop" {
				s.runs.Stop(id)
			}
		}
	}()

	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()
	var pending []parser.Event
	flush := func() bool {
		for _, ev := range pending {
			if err := writeEvent(ctx, conn, ev); err != nil {
				return false
			}
			if ev.Kind == parser.KindSummary {
				return false
			}
		}
		pending = pending[:0]
		return true
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-run.done:
			for {
				select {
				case ev := <-sub.ch:
					pending = append(pending, ev)
				default:
					if !flush() {
						return
					}
					return
				}
			}
		case ev := <-sub.ch:
			pending = append(pending, ev)
			if len(pending) >= 50 {
				if !flush() {
					return
				}
			}
		case <-ticker.C:
			if len(pending) > 0 {
				if !flush() {
					return
				}
			}
		}
	}
}

func writeEvent(ctx context.Context, conn *websocket.Conn, ev parser.Event) error {
	raw, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, raw)
}
