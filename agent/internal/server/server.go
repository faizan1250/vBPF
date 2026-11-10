package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
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
	// AllowedOrigins is the WebSocket cross-origin allowlist, passed to
	// websocket.Accept as OriginPatterns. Empty (the default) denies every
	// browser origin; requests without an Origin header (server-to-server,
	// like the API dial) and same-host origins are always allowed.
	AllowedOrigins   []string
	CatalogFn        func(ctx context.Context) ([]string, error)
	CatalogRetryBase time.Duration
	CatalogRetryMax  time.Duration
	RunFn            RunnerFunc
	DryRun           DryRunFunc
	ProbeArgs        ProbeArgsFunc
	UprobeCheck      *UprobeChecker
	Health           *HealthProvider
	Logger           zerolog.Logger
	StartTime        time.Time
}

// Server is the agent HTTP and WebSocket front end.
type Server struct {
	addr              string
	token             string
	allowedOrigins    []string
	mux               *http.ServeMux
	runs              *Registry
	catalog           *Catalog
	catalogRetryBase  time.Duration
	catalogRetryMax   time.Duration
	readHeaderTimeout time.Duration
	health            *HealthProvider
	dryRun            DryRunFunc
	probeArgs         ProbeArgsFunc
	uprobeCheck       *UprobeChecker
	logger            zerolog.Logger
	startTime         time.Time
	bpftracePath      string
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
	probeArgs := cfg.ProbeArgs
	if probeArgs == nil {
		probeArgs = DefaultProbeArgs(cfg.BPFtracePath)
	}
	uprobeCheck := cfg.UprobeCheck
	if uprobeCheck == nil {
		uprobeCheck = NewUprobeChecker(cfg.BPFtracePath)
	} else {
		uprobeCheck = uprobeCheck.withDefaults()
	}
	if cfg.CatalogRetryBase <= 0 {
		cfg.CatalogRetryBase = time.Second
	}
	if cfg.CatalogRetryMax <= 0 {
		cfg.CatalogRetryMax = 30 * time.Second
	}
	s := &Server{
		addr:              cfg.Addr,
		token:             tok,
		allowedOrigins:    cfg.AllowedOrigins,
		mux:               http.NewServeMux(),
		runs:              NewRegistry(cfg.RunFn, cfg.BPFtracePath, cfg.Logger),
		catalog:           catalog,
		catalogRetryBase:  cfg.CatalogRetryBase,
		catalogRetryMax:   cfg.CatalogRetryMax,
		readHeaderTimeout: defaultReadHeaderTimeout,
		health:            health,
		dryRun:            dryRun,
		probeArgs:         probeArgs,
		uprobeCheck:       uprobeCheck,
		logger:            cfg.Logger,
		startTime:         cfg.StartTime,
		bpftracePath:      cfg.BPFtracePath,
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
	s.mux.Handle("GET /v1/probe-args", s.auth(http.HandlerFunc(s.handleProbeArgs)))
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

// WildcardBindEnv gates the 0.0.0.0/:: wildcard bind. Unset (or anything
// but "1") means loopback only; compose sets it for the agent container,
// where each container has its own loopback.
const WildcardBindEnv = "AGENT_ALLOW_WILDCARD_BIND"

// wildcardBindAllowed reports whether the wildcard bind is explicitly
// opted in. Strict "1" match so "true"/"yes" never widen the bind.
func wildcardBindAllowed() bool { return os.Getenv(WildcardBindEnv) == "1" }

// bindAllowed reports whether the agent may listen on host. Loopback is
// always allowed; the wildcard requires AGENT_ALLOW_WILDCARD_BIND=1; a
// specific non-loopback address is always refused.
func bindAllowed(host string) bool {
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	if ip.IsUnspecified() {
		return wildcardBindAllowed()
	}
	return false
}

const (
	defaultReadHeaderTimeout = 5 * time.Second
	defaultIdleTimeout       = 60 * time.Second
	defaultMaxHeaderBytes    = 64 << 10 // 64 KB
	maxRequestBodyBytes      = 64 << 10 // 64 KB
)

// newHTTPServer builds the HTTP server with Slowloris and header bounds while
// leaving WriteTimeout unset so 60s probe streams are not terminated mid-run.
func (s *Server) newHTTPServer() *http.Server {
	rht := s.readHeaderTimeout
	if rht <= 0 {
		rht = defaultReadHeaderTimeout
	}
	return &http.Server{
		Addr:              s.addr,
		Handler:           s.mux,
		ReadHeaderTimeout: rht,
		IdleTimeout:       defaultIdleTimeout,
		MaxHeaderBytes:    defaultMaxHeaderBytes,
	}
}

// ListenAndServe binds loopback (or the wildcard with the opt-in flag) immediately
// and loads the probe catalog asynchronously with exponential backoff.
func (s *Server) ListenAndServe(ctx context.Context) error {
	host, _, err := net.SplitHostPort(s.addr)
	if err != nil {
		return fmt.Errorf("server: bad addr: %w", err)
	}
	if !bindAllowed(host) {
		if ip := net.ParseIP(host); ip != nil && ip.IsUnspecified() {
			return fmt.Errorf("server: refuses wildcard bind %q without %s=1", host, WildcardBindEnv)
		}
		return fmt.Errorf("server: refuses non-loopback bind %q", host)
	}
	ln, err := net.Listen("tcp", s.addr)
	if err != nil {
		return err
	}
	loaderDone := s.startCatalogLoader(ctx)
	srv := s.newHTTPServer()
	go func() {
		<-ctx.Done()
		cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(cctx)
	}()
	s.logger.Info().Str("addr", ln.Addr().String()).Msg("agent listening")
	serveErr := srv.Serve(ln)
	<-loaderDone
	if serveErr != nil && serveErr != http.ErrServerClosed {
		return serveErr
	}
	return nil
}

const (
	catalogRetryAfterSeconds = "2"
	catalogWarnMinInterval   = 30 * time.Second
)

func (s *Server) startCatalogLoader(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		delay := s.catalogRetryBase
		var lastWarn time.Time
		for {
			if ctx.Err() != nil {
				return
			}
			if err := s.catalog.Refresh(ctx); err == nil {
				status := s.catalog.Status()
				ev := s.logger.Info().Int("probes", status.Probes)
				if len(status.Warnings) > 0 {
					ev = ev.Strs("warnings", status.Warnings)
				}
				ev.Msg("probe catalog ready")
				return
			} else if ctx.Err() == nil && (lastWarn.IsZero() || time.Since(lastWarn) >= catalogWarnMinInterval) {
				lastWarn = time.Now()
				s.logger.Warn().Str("error", sanitizeCatalogError(err)).Dur("retry_in", delay).Msg("probe catalog refresh failed")
			}

			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			delay *= 2
			if delay > s.catalogRetryMax {
				delay = s.catalogRetryMax
			}
		}
	}()
	return done
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, errCode, msg string) {
	writeJSON(w, code, map[string]string{"error": msg, "code": errCode})
}

func decodeStrictJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, dst any) error {
	if r.Body == nil {
		return errors.New("empty request body")
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("unexpected trailing JSON data")
		}
		return err
	}
	return nil
}

func writeDecodeError(w http.ResponseWriter, err error) {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "request body too large")
		return
	}
	writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "invalid JSON")
}

func writeCatalogUnavailable(w http.ResponseWriter) {
	w.Header().Set("Retry-After", catalogRetryAfterSeconds)
	writeError(w, http.StatusServiceUnavailable, "CATALOG_UNAVAILABLE", "probe catalog not ready")
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	snap := s.health.Snapshot(r.Context())
	snap.Ready = s.catalog.Ready()
	snap.Catalog = s.catalog.Status()
	writeJSON(w, http.StatusOK, snap)
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

// handleProbeArgs returns `bpftrace -vl` output for one catalog-validated
// probe name. The name must exactly match a catalog entry, so no arbitrary
// input reaches exec (argv only, no shell).
func (s *Server) handleProbeArgs(w http.ResponseWriter, r *http.Request) {
	probe := r.URL.Query().Get("probe")
	if probe == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "missing probe")
		return
	}
	if len(probe) > MaxProbeNameLen {
		writeError(w, http.StatusBadRequest, "VALIDATION_FAILED", "probe name too long")
		return
	}
	if !s.catalog.Contains(probe) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "unknown probe")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ProbeArgsTimeout)
	defer cancel()
	out, err := s.probeArgs(ctx, probe)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			writeError(w, http.StatusGatewayTimeout, "TIMEOUT", "probe args timed out")
			return
		}
		s.logger.Error().Str("probe", probe).Err(err).Msg("probe args failed")
		writeError(w, http.StatusInternalServerError, "PROBE_ARGS_FAILED", "probe args failed")
		return
	}
	if len(out) > ProbeArgsMaxBytes {
		out = out[:ProbeArgsMaxBytes]
	}
	writeJSON(w, http.StatusOK, map[string]any{"probe": probe, "output": out})
}

type validateRequest struct {
	Script string `json:"script"`
}

func (s *Server) handleValidate(w http.ResponseWriter, r *http.Request) {
	var req validateRequest
	if err := decodeStrictJSON(w, r, maxRequestBodyBytes, &req); err != nil {
		writeDecodeError(w, err)
		return
	}
	if !s.catalog.Ready() {
		writeCatalogUnavailable(w)
		return
	}
	res := StaticValidate(req.Script, s.catalog)
	if res.Code == "CATALOG_UNAVAILABLE" {
		writeCatalogUnavailable(w)
		return
	}
	if len(res.Errors) > 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":          false,
			"errors":      res.Errors,
			"probes":      slicesOrEmpty(res.Probes),
			"warnings":    slicesOrEmpty(res.Warnings),
			"probe_count": res.ProbeCount,
		})
		return
	}
	if uErrs := s.uprobeCheck.VerifyProbes(r.Context(), res.Probes); len(uErrs) > 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":          false,
			"errors":      uErrs,
			"probes":      slicesOrEmpty(res.Probes),
			"warnings":    slicesOrEmpty(res.Warnings),
			"probe_count": res.ProbeCount,
		})
		return
	}
	if dryErrs := s.dryRun(r.Context(), req.Script); len(dryErrs) > 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":          false,
			"errors":      dryErrs,
			"probes":      slicesOrEmpty(res.Probes),
			"warnings":    slicesOrEmpty(res.Warnings),
			"probe_count": res.ProbeCount,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"errors":      []string{},
		"probes":      slicesOrEmpty(res.Probes),
		"warnings":    slicesOrEmpty(res.Warnings),
		"probe_count": res.ProbeCount,
	})
}

func slicesOrEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

type createRunRequest struct {
	Script    string `json:"script"`
	DurationS *int   `json:"duration_s"`
}

func (s *Server) handleCreateRun(w http.ResponseWriter, r *http.Request) {
	var req createRunRequest
	if err := decodeStrictJSON(w, r, maxRequestBodyBytes, &req); err != nil {
		writeDecodeError(w, err)
		return
	}
	if !s.catalog.Ready() {
		writeCatalogUnavailable(w)
		return
	}
	duration := limits.DefaultDuration
	if req.DurationS != nil {
		duration = time.Duration(*req.DurationS) * time.Second
	}
	res := StaticValidate(req.Script, s.catalog)
	if res.Code == "CATALOG_UNAVAILABLE" {
		writeCatalogUnavailable(w)
		return
	}
	if len(res.Errors) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": strings.Join(res.Errors, "; "), "code": classifyValidationError(res.Errors), "errors": res.Errors})
		return
	}
	if uErrs := s.uprobeCheck.VerifyProbes(r.Context(), res.Probes); len(uErrs) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": strings.Join(uErrs, "; "), "code": classifyValidationError(uErrs), "errors": uErrs})
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
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.allowedOrigins})
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
