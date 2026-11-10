package server

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/faizan1250/vBPF/agent/internal/limits"
)

const (
	CatalogStateLoading = "loading"
	CatalogStateReady   = "ready"
	CatalogStateFailed  = "failed"

	// CatalogWarningNoTracepoints warns when bpftrace -l returns probes without tracepoints.
	CatalogWarningNoTracepoints = "catalog contains no tracepoint probes; tracefs may not be mounted"
)

// CatalogStatus summarizes catalog readiness and refresh health for GET /health.
type CatalogStatus struct {
	State       string   `json:"state"`
	Probes      int      `json:"probes"`
	RefreshedAt string   `json:"refreshed_at,omitempty"`
	StaleSince  string   `json:"stale_since,omitempty"`
	LastError   string   `json:"last_error,omitempty"`
	Warnings    []string `json:"warnings"`
}

type catalogSnapshot struct {
	state         string
	ready         bool
	probes        []string
	probeSet      map[string]struct{}
	hasTracepoint bool
	refreshedAt   time.Time
	staleSince    time.Time
	lastError     string
}

// Catalog caches bpftrace probe names from `bpftrace -l` using an immutable atomic snapshot.
type Catalog struct {
	refreshMu sync.Mutex
	snap      atomic.Pointer[catalogSnapshot]
	listFunc  func(ctx context.Context) ([]string, error)
}

// NewCatalog builds a catalog in the loading state; nil listFunc uses the bpftrace binary.
func NewCatalog(bpftracePath string, listFunc func(ctx context.Context) ([]string, error)) *Catalog {
	if listFunc == nil {
		bin := bpftracePath
		if bin == "" {
			bin = "bpftrace"
		}
		listFunc = func(ctx context.Context) ([]string, error) {
			cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			cmd := exec.CommandContext(cctx, bin, "-l")
			cmd.Env = limits.ChildEnv(false)
			out, err := cmd.Output()
			if err != nil {
				return nil, err
			}
			var probes []string
			for _, line := range strings.Split(string(out), "\n") {
				if s := strings.TrimSpace(line); s != "" {
					probes = append(probes, s)
				}
			}
			return probes, nil
		}
	}
	c := &Catalog{listFunc: listFunc}
	c.snap.Store(&catalogSnapshot{state: CatalogStateLoading})
	return c
}

func sanitizeCatalogError(err error) string {
	if err == nil {
		return ""
	}
	s := strings.Join(strings.Fields(err.Error()), " ")
	if len(s) > 200 {
		return s[:200]
	}
	return s
}

// Refresh reloads the cache; failures or empty lists mark an existing ready catalog stale
// without replacing its probe snapshot.
func (c *Catalog) Refresh(ctx context.Context) error {
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()

	probes, err := c.listFunc(ctx)
	if err == nil && len(probes) == 0 {
		err = errors.New("bpftrace -l returned 0 probes")
	}
	if err != nil {
		sanErr := sanitizeCatalogError(err)
		cur := c.snap.Load()
		if cur != nil && cur.ready {
			staleSince := cur.staleSince
			if staleSince.IsZero() {
				staleSince = time.Now().UTC()
			}
			c.snap.Store(&catalogSnapshot{
				state:         CatalogStateReady,
				ready:         true,
				probes:        cur.probes,
				probeSet:      cur.probeSet,
				hasTracepoint: cur.hasTracepoint,
				refreshedAt:   cur.refreshedAt,
				staleSince:    staleSince,
				lastError:     sanErr,
			})
			return err
		}
		c.snap.Store(&catalogSnapshot{
			state:     CatalogStateFailed,
			ready:     false,
			lastError: sanErr,
		})
		return err
	}

	copied := make([]string, len(probes))
	probeSet := make(map[string]struct{}, len(probes))
	hasTracepoint := false
	for i, p := range probes {
		copied[i] = p
		probeSet[p] = struct{}{}
		if strings.HasPrefix(p, "tracepoint:") {
			hasTracepoint = true
		}
	}
	c.snap.Store(&catalogSnapshot{
		state:         CatalogStateReady,
		ready:         true,
		probes:        copied,
		probeSet:      probeSet,
		hasTracepoint: hasTracepoint,
		refreshedAt:   time.Now().UTC(),
	})
	return nil
}

// Ready reports whether at least one refresh succeeded with >= 1 probe.
func (c *Catalog) Ready() bool {
	if c == nil {
		return false
	}
	s := c.snap.Load()
	return s != nil && s.ready
}

// Status returns the current readiness metadata and warnings.
func (c *Catalog) Status() CatalogStatus {
	if c == nil {
		return CatalogStatus{State: CatalogStateFailed, Warnings: []string{}}
	}
	s := c.snap.Load()
	if s == nil {
		return CatalogStatus{State: CatalogStateLoading, Warnings: []string{}}
	}
	warnings := []string{}
	if s.ready && !s.hasTracepoint {
		warnings = append(warnings, CatalogWarningNoTracepoints)
	}
	out := CatalogStatus{
		State:     s.state,
		Probes:    len(s.probes),
		LastError: s.lastError,
		Warnings:  warnings,
	}
	if !s.refreshedAt.IsZero() {
		out.RefreshedAt = s.refreshedAt.Format(time.RFC3339)
	}
	if !s.staleSince.IsZero() {
		out.StaleSince = s.staleSince.Format(time.RFC3339)
	}
	return out
}

// Snapshot returns a copy of the cached probes.
func (c *Catalog) Snapshot() []string {
	if c == nil {
		return nil
	}
	s := c.snap.Load()
	if s == nil || len(s.probes) == 0 {
		return nil
	}
	out := make([]string, len(s.probes))
	copy(out, s.probes)
	return out
}

// Contains reports whether probe exactly matches a catalog entry.
func (c *Catalog) Contains(probe string) bool {
	if c == nil {
		return false
	}
	s := c.snap.Load()
	if s == nil || len(s.probeSet) == 0 {
		return false
	}
	_, ok := s.probeSet[probe]
	return ok
}

// Search filters by substring q and provider prefix typ (e.g. tracepoint).
func (c *Catalog) Search(q, typ string) []string {
	if c == nil {
		return nil
	}
	s := c.snap.Load()
	if s == nil || len(s.probes) == 0 {
		return nil
	}
	q = strings.ToLower(strings.TrimSpace(q))
	typ = strings.TrimSpace(typ)
	var out []string
	for _, p := range s.probes {
		if typ != "" && !strings.HasPrefix(p, typ+":") && p != typ {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(p), q) {
			continue
		}
		out = append(out, p)
		if len(out) >= 1000 {
			break
		}
	}
	return out
}
