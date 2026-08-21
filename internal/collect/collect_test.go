package collect

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"github.com/wkn00/k3s-dash/internal/kube"
)

// cluster serves a healthy three-node cluster, with per-path overrides
// so a test can make exactly one source fail.
func cluster(t *testing.T, fail map[string]int) *kube.Client {
	t.Helper()
	bodies := map[string]string{
		"/api/v1/nodes": `{"items":[
		 {"metadata":{"name":"wk","labels":{"node-role.kubernetes.io/control-plane":"true"}},
		  "status":{"conditions":[{"type":"Ready","status":"True"}],"nodeInfo":{"kubeletVersion":"v1.35.5+k3s1"},
		            "capacity":{"cpu":"8","memory":"16308880Ki"}}},
		 {"metadata":{"name":"wk1","labels":{}},
		  "status":{"conditions":[{"type":"Ready","status":"True"}],"nodeInfo":{"kubeletVersion":"v1.35.5+k3s1"},
		            "capacity":{"cpu":"4","memory":"8154440Ki"}}}]}`,
		"/api/v1/pods":                          `{"items":[{"metadata":{"name":"gsm-frontend-a","namespace":"gsm","labels":{"app":"gsm-frontend"}},"spec":{"nodeName":"wk1"},"status":{"phase":"Running","podIP":"10.42.1.5","containerStatuses":[{"restartCount":2}]}}]}`,
		"/apis/apps/v1/deployments":             `{"items":[{"metadata":{"name":"gsm-frontend","namespace":"gsm"},"spec":{"replicas":1,"selector":{"matchLabels":{"app":"gsm-frontend"}}},"status":{"readyReplicas":1}}]}`,
		"/apis/apps/v1/statefulsets":            `{"items":[]}`,
		"/apis/apps/v1/daemonsets":              `{"items":[]}`,
		"/api/v1/events":                        `{"items":[]}`,
		"/apis/metrics.k8s.io/v1beta1/nodes":    `{"items":[{"metadata":{"name":"wk"},"usage":{"cpu":"578630136n","memory":"3696868Ki"}},{"metadata":{"name":"wk1"},"usage":{"cpu":"290m","memory":"1495Mi"}}]}`,
		"/api/v1/nodes/wk/proxy/stats/summary":  `{"node":{"fs":{"usedBytes":100,"capacityBytes":1000}}}`,
		"/api/v1/nodes/wk1/proxy/stats/summary": `{"node":{"fs":{"usedBytes":200,"capacityBytes":1000}}}`,
		"/api/v1/namespaces/k3s-dash/pods":      `{"items":[{"metadata":{"name":"agent-a","namespace":"k3s-dash"},"spec":{"nodeName":"wk"},"status":{"phase":"Running","podIP":"10.42.0.9"}},{"metadata":{"name":"agent-b","namespace":"k3s-dash"},"spec":{"nodeName":"wk1"},"status":{"phase":"Running","podIP":"10.42.1.9"}}]}`,
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if code, ok := fail[r.URL.Path]; ok {
			w.WriteHeader(code)
			_, _ = w.Write([]byte(`{"message":"induced failure"}`))
			return
		}
		body, ok := bodies[r.URL.Path]
		if !ok {
			t.Errorf("unexpected request path %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return &kube.Client{Base: srv.URL, HTTP: srv.Client()}
}

// agents serves /hw for every node, unless the node is listed in broken.
func agents(t *testing.T, broken map[string]bool) (*httptest.Server, func(kube.Pod) string) {
	t.Helper()
	byIP := map[string]string{"10.42.0.9": "wk", "10.42.1.9": "wk1"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		node := r.URL.Query().Get("node")
		if broken[node] {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		temp := 41.5
		pct := 100
		_ = json.NewEncoder(w).Encode(map[string]any{
			"node": node, "tempC": temp,
			"battery": map[string]any{"percent": pct, "status": "Full", "acOnline": true},
		})
	}))
	t.Cleanup(srv.Close)
	return srv, func(p kube.Pod) string {
		return fmt.Sprintf("%s/hw?node=%s", srv.URL, byIP[p.IP])
	}
}

func opts(agentURL func(kube.Pod) string) Options {
	return Options{
		Namespace:     "k3s-dash",
		AgentSelector: "app=k3s-dash-agent",
		AgentPort:     9100,
		PerSource:     2 * time.Second,
		AgentURL:      agentURL,
	}
}

func TestSampleHealthyCluster(t *testing.T) {
	_, agentURL := agents(t, nil)
	got := Sample(context.Background(), cluster(t, nil), http.DefaultClient, opts(agentURL))

	if len(got.Degraded) != 0 {
		t.Errorf("Degraded = %v, want empty on a healthy cluster", got.Degraded)
	}
	if len(got.Nodes) != 2 {
		t.Errorf("len(Nodes) = %d, want 2", len(got.Nodes))
	}
	if len(got.FS) != 2 {
		t.Errorf("len(FS) = %d, want 2", len(got.FS))
	}
	if len(got.HW) != 2 {
		t.Errorf("len(HW) = %d, want 2", len(got.HW))
	}
	if hwSnap, ok := got.HW["wk1"]; !ok || hwSnap.TempC == nil || *hwSnap.TempC != 41.5 {
		t.Errorf("HW[wk1] = %+v, want tempC 41.5 keyed by node name", hwSnap)
	}
	if got.At.IsZero() {
		t.Error("At is zero, want the sample time")
	}
}

func TestSampleDegradesPerSource(t *testing.T) {
	tests := []struct {
		name         string
		failPath     string
		brokenAgent  string
		wantDegraded string
		check        func(t *testing.T, r Raw)
	}{
		{
			name: "metrics-server down", failPath: "/apis/metrics.k8s.io/v1beta1/nodes",
			wantDegraded: "metrics-server",
			check: func(t *testing.T, r Raw) {
				if len(r.Nodes) != 2 {
					t.Error("nodes disappeared when metrics-server failed")
				}
				if len(r.Usage) != 0 {
					t.Errorf("Usage = %v, want empty", r.Usage)
				}
			},
		},
		{
			name: "one kubelet wedged", failPath: "/api/v1/nodes/wk1/proxy/stats/summary",
			wantDegraded: "kubelet/wk1",
			check: func(t *testing.T, r Raw) {
				if _, ok := r.FS["wk"]; !ok {
					t.Error("wk filesystem missing: one bad kubelet must not lose the others")
				}
				if _, ok := r.FS["wk1"]; ok {
					t.Error("wk1 filesystem present, want it absent")
				}
			},
		},
		{
			name: "one agent unreachable", brokenAgent: "wk1",
			wantDegraded: "agent/wk1",
			check: func(t *testing.T, r Raw) {
				if _, ok := r.HW["wk"]; !ok {
					t.Error("wk hardware missing: one bad agent must not lose the others")
				}
			},
		},
		{
			name: "events forbidden", failPath: "/api/v1/events",
			wantDegraded: "kubernetes/events",
			check: func(t *testing.T, r Raw) {
				if len(r.Workloads) != 1 {
					t.Error("workloads disappeared when events failed")
				}
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fail := map[string]int{}
			if tc.failPath != "" {
				fail[tc.failPath] = http.StatusInternalServerError
			}
			broken := map[string]bool{}
			if tc.brokenAgent != "" {
				broken[tc.brokenAgent] = true
			}
			_, agentURL := agents(t, broken)
			got := Sample(context.Background(), cluster(t, fail), http.DefaultClient, opts(agentURL))

			if !slices.Contains(got.Degraded, tc.wantDegraded) {
				t.Errorf("Degraded = %v, want it to contain %q", got.Degraded, tc.wantDegraded)
			}
			tc.check(t, got)
		})
	}
}

// A hung source must not hold the whole sample past its own timeout.
func TestSampleBoundsASlowSource(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	t.Cleanup(slow.Close)
	_, agentURL := agents(t, nil)
	_ = agentURL
	o := opts(nil)
	o.PerSource = 150 * time.Millisecond
	o.AgentURL = func(p kube.Pod) string { return slow.URL + "/hw" }

	start := time.Now()
	got := Sample(context.Background(), cluster(t, nil), http.DefaultClient, o)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("Sample took %v, want it bounded near PerSource", elapsed)
	}
	if len(got.Nodes) != 2 {
		t.Error("nodes missing: a slow agent must not affect the Kubernetes reads")
	}
	if len(got.Degraded) == 0 {
		t.Error("Degraded is empty, want the timed-out agents listed")
	}
}
