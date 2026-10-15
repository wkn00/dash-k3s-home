// Package server runs the sample loop and serves the page. Handlers read
// a cached snapshot and never call the cluster: a hard refresh, or ten
// open tabs, must not multiply load on the API server.
package server

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/wkn00/k3s-dash/internal/collect"
	"github.com/wkn00/k3s-dash/internal/kube"
	"github.com/wkn00/k3s-dash/internal/ring"
	"github.com/wkn00/k3s-dash/internal/state"
)

//go:embed ui.html
var uiHTML []byte

// The 3D room's scripts: vendored three.js plus our own modules. They are
// served same-origin, so the page still loads nothing from the network.
//
//go:embed static
var staticFS embed.FS

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
	mux.Handle("GET /static/", staticHandler())
	return mux
}

// staticHandler serves the embedded scripts. It pins the JavaScript content
// type rather than trusting the host's mime database (browsers refuse module
// scripts served as text/plain, and a distroless image has no mime.types),
// and it revalidates on every load with a content-hash ETag. embed.FS has no
// modification times, so without this a fixed max-age keeps a stale script in
// browsers and in Cloudflare's edge for the whole window after a release.
func staticHandler() http.Handler {
	etags := map[string]string{}
	_ = fs.WalkDir(staticFS, "static", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if b, err := staticFS.ReadFile(p); err == nil {
			sum := sha256.Sum256(b)
			etags["/"+p] = `"` + hex.EncodeToString(sum[:8]) + `"`
		}
		return nil
	})
	files := http.FileServerFS(staticFS)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".js") || strings.HasSuffix(r.URL.Path, ".mjs") {
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		}
		w.Header().Set("Cache-Control", "no-cache")
		if tag, ok := etags[r.URL.Path]; ok {
			w.Header().Set("ETag", tag)
			if r.Header.Get("If-None-Match") == tag {
				w.WriteHeader(http.StatusNotModified)
				return
			}
		}
		files.ServeHTTP(w, r)
	})
}
