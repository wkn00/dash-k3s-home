package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/wkn00/k3s-dash/internal/collect"
	"github.com/wkn00/k3s-dash/internal/kube"
)

func fakeCluster(t *testing.T) *kube.Client {
	t.Helper()
	bodies := map[string]string{
		"/api/v1/nodes": `{"items":[{"metadata":{"name":"wk","labels":{}},
		 "status":{"conditions":[{"type":"Ready","status":"True"}],"nodeInfo":{"kubeletVersion":"v1.35.5+k3s1"},
		 "capacity":{"cpu":"8","memory":"16308880Ki"}}}]}`,
		"/api/v1/pods":                         `{"items":[]}`,
		"/apis/apps/v1/deployments":            `{"items":[]}`,
		"/apis/apps/v1/statefulsets":           `{"items":[]}`,
		"/apis/apps/v1/daemonsets":             `{"items":[]}`,
		"/api/v1/events":                       `{"items":[]}`,
		"/apis/metrics.k8s.io/v1beta1/nodes":   `{"items":[{"metadata":{"name":"wk"},"usage":{"cpu":"2","memory":"8Gi"}}]}`,
		"/api/v1/nodes/wk/proxy/stats/summary": `{"node":{"fs":{"usedBytes":250,"capacityBytes":1000}}}`,
		"/api/v1/namespaces/k3s-dash/pods":     `{"items":[]}`,
		"/api/v1/namespaces":                   `{"items":[]}`,
		"/api/v1/resourcequotas":               `{"items":[]}`,
		"/api/v1/limitranges":                  `{"items":[]}`,
		"/api/v1/persistentvolumeclaims":       `{"items":[]}`,
		"/api/v1/services":                     `{"items":[]}`,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := bodies[r.URL.Path]
		if !ok {
			t.Errorf("unexpected path %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return &kube.Client{Base: srv.URL, HTTP: srv.Client()}
}

func newTestServer(t *testing.T) *Server {
	t.Helper()
	return New(fakeCluster(t), http.DefaultClient, collect.Options{
		Namespace: "k3s-dash", AgentSelector: "app=k3s-dash-agent",
		AgentPort: 9100, PerSource: time.Second,
	}, 15*time.Second, 480)
}

// Before the first sample lands the page must still load and the API must
// still answer — with an honest empty snapshot, not a 500 and not a hang.
func TestStateBeforeFirstSample(t *testing.T) {
	ts := httptest.NewServer(newTestServer(t).Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/state")
	if err != nil {
		t.Fatalf("GET /api/state: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var got struct {
		Nodes []any `json:"nodes"`
		Meta  struct {
			SampledAt string   `json:"sampledAt"`
			Degraded  []string `json:"degraded"`
		} `json:"meta"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Nodes == nil {
		t.Error("nodes = null, want [] so the page can iterate without a guard")
	}
	if got.Meta.Degraded == nil {
		t.Error("meta.degraded = null, want []")
	}
}

func TestSampleOnceThenServeState(t *testing.T) {
	s := newTestServer(t)
	s.SampleOnce(context.Background())

	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/state")
	if err != nil {
		t.Fatalf("GET /api/state: %v", err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var got struct {
		Nodes []struct {
			Name       string   `json:"name"`
			CPUPercent *float64 `json:"cpuPercent"`
			Series     map[string][]*float64
		} `json:"nodes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Nodes) != 1 || got.Nodes[0].Name != "wk" {
		t.Fatalf("nodes = %+v, want one node named wk", got.Nodes)
	}
	if got.Nodes[0].CPUPercent == nil || *got.Nodes[0].CPUPercent != 25 {
		t.Errorf("cpuPercent = %v, want 25", got.Nodes[0].CPUPercent)
	}
	if len(got.Nodes[0].Series["cpuPercent"]) != 1 {
		t.Errorf("series = %v, want one point after one sample", got.Nodes[0].Series)
	}
}

func TestIndexServesThePage(t *testing.T) {
	ts := httptest.NewServer(newTestServer(t).Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatalf("GET /: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
}

func TestHealthz(t *testing.T) {
	ts := httptest.NewServer(newTestServer(t).Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}
}

// The dashboard is read-only by construction; nothing may mutate.
func TestNoWriteMethodsAreRouted(t *testing.T) {
	ts := httptest.NewServer(newTestServer(t).Handler())
	defer ts.Close()

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		t.Run(method, func(t *testing.T) {
			req, _ := http.NewRequest(method, ts.URL+"/api/state", nil)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatalf("%s: %v", method, err)
			}
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				t.Errorf("%s /api/state = 200, want it unrouted", method)
			}
		})
	}
}

func TestRunStopsWithContext(t *testing.T) {
	s := newTestServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after the context was cancelled")
	}
}
