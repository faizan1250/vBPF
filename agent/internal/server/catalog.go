package server

import (
	"context"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Catalog caches bpftrace probe names from `bpftrace -l`.
type Catalog struct {
	mu       sync.RWMutex
	probes   []string
	listFunc func(ctx context.Context) ([]string, error)
}

// NewCatalog builds a catalog; nil listFunc uses the real bpftrace binary.
func NewCatalog(bpftracePath string, listFunc func(ctx context.Context) ([]string, error)) *Catalog {
	if listFunc == nil {
		bin := bpftracePath
		if bin == "" {
			bin = "bpftrace"
		}
		listFunc = func(ctx context.Context) ([]string, error) {
			cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			out, err := exec.CommandContext(cctx, bin, "-l").Output()
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
	return &Catalog{listFunc: listFunc}
}

// Refresh reloads the cache; a failure leaves the previous snapshot intact.
func (c *Catalog) Refresh(ctx context.Context) error {
	probes, err := c.listFunc(ctx)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.probes = probes
	c.mu.Unlock()
	return nil
}

// Snapshot returns a copy of the cached probes.
func (c *Catalog) Snapshot() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]string, len(c.probes))
	copy(out, c.probes)
	return out
}

// Contains reports whether probe exactly matches a catalog entry.
func (c *Catalog) Contains(probe string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, p := range c.probes {
		if p == probe {
			return true
		}
	}
	return false
}

// Search filters by substring q and provider prefix typ (e.g. tracepoint).
func (c *Catalog) Search(q, typ string) []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	q = strings.ToLower(strings.TrimSpace(q))
	typ = strings.TrimSpace(typ)
	var out []string
	for _, p := range c.probes {
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
