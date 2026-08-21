// Package server runs the sample loop and serves the page. Handlers read
// a cached snapshot and never call the cluster: a hard refresh, or ten
// open tabs, must not multiply load on the API server.
package server

import (
	"context"
	_ "embed"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/wkn00/k3s-dash/internal/collect"
	"github.com/wkn00/k3s-dash/internal/kube"
	"github.com/wkn00/k3s-dash/internal/ring"
	"github.com/wkn00/k3s-dash/internal/state"
)

//go:embed ui.html
var uiHTML []byte

type Server struct {
	client   *kube.Client
	http     *http.Client
	opts     collect.Options
	interval time.Duration
	buffers  *ring.Set

	mu   sync.RWMutex
	snap state.Snapshot
}

func New(c *kube.Client, hc *http.Client, opts collect.Options, interval time.Duration, capacity int) *Server {
	s := &Server{
		client:   c,
		http:     hc,
		opts:     opts,
		interval: interval,
		buffers:  ring.NewSet(capacity),
	}
	// An empty-but-valid snapshot, so the very first page load renders
	// the chrome instead of erroring on null.
	s.snap = state.Snapshot{
		Nodes:     []state.Node{},
		Workloads: []state.Workload{},
		Events:    []state.Event{},
		Meta:      state.Meta{SampleIntervalSeconds: int(interval.Seconds()), Degraded: []string{}},
	}
	return s
}

func (s *Server) SampleOnce(ctx context.Context) {
	raw := collect.Sample(ctx, s.client, s.http, s.opts)
	snap := state.Assemble(raw, s.buffers, s.interval)
	s.mu.Lock()
	s.snap = snap
	s.mu.Unlock()
	if len(raw.Degraded) > 0 {
		log.Printf("sample degraded: %v", raw.Degraded)
	}
}

func (s *Server) Snapshot() state.Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.snap
}

// Run samples until the context is cancelled. The first sample is taken
// immediately so the page is populated within a second of startup rather
// than after a full interval of "loading".
func (s *Server) Run(ctx context.Context) {
	s.SampleOnce(ctx)
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.SampleOnce(ctx)
		}
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if err := json.NewEncoder(w).Encode(s.Snapshot()); err != nil {
			log.Printf("encode state: %v", err)
		}
	})
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(uiHTML)
	})
	return mux
}
