package kube

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// routes serves canned JSON per path, and 404s anything the code asks
// for that the test did not anticipate — an unexpected request is a bug
// worth failing on, not something to paper over.
func routes(t *testing.T, bodies map[string]string) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	return &Client{Base: srv.URL, HTTP: srv.Client()}
}

const nodeListJSON = `{"items":[
 {"metadata":{"name":"wk","labels":{"node-role.kubernetes.io/control-plane":"true"},
              "annotations":{"k3s-dash/name":"Living room ThinkPad","k3s-dash/type":"laptop"},
              "creationTimestamp":"2026-06-22T16:20:00Z"},
  "status":{"conditions":[{"type":"MemoryPressure","status":"False"},{"type":"Ready","status":"True"}],
            "addresses":[{"type":"Hostname","address":"wk"},{"type":"InternalIP","address":"192.168.10.185"}],
            "nodeInfo":{"kubeletVersion":"v1.35.5+k3s1","osImage":"Ubuntu 26.04 LTS",
                        "kernelVersion":"6.14.0-27-generic","architecture":"amd64"},
            "capacity":{"cpu":"8","memory":"16308880Ki"}}},
 {"metadata":{"name":"wk2","labels":{},"creationTimestamp":"2026-06-22T16:21:00Z"},
  "status":{"conditions":[{"type":"Ready","status":"False"}],
            "nodeInfo":{"kubeletVersion":"v1.35.5+k3s1","osImage":"Ubuntu 26.04 LTS"},
            "capacity":{"cpu":"4","memory":"8154440Ki"}}}
]}`

func TestNodes(t *testing.T) {
	c := routes(t, map[string]string{"/api/v1/nodes": nodeListJSON})
	got, err := c.Nodes(context.Background())
	if err != nil {
		t.Fatalf("Nodes: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len(Nodes) = %d, want 2", len(got))
	}
	if !got[0].Ready {
		t.Error("wk Ready = false, want true — the Ready condition is not always first in the list")
	}
	if got[1].Ready {
		t.Error("wk2 Ready = true, want false")
	}
	if !got[0].ControlPlane {
		t.Error("wk ControlPlane = false, want true")
	}
	if got[0].CPUCapacityCores != 8 {
		t.Errorf("wk CPUCapacityCores = %v, want 8", got[0].CPUCapacityCores)
	}
	if got[0].MemoryCapacityBytes != 16308880*1024 {
		t.Errorf("wk MemoryCapacityBytes = %v, want %v", got[0].MemoryCapacityBytes, 16308880*1024)
	}
	if got[0].KernelVersion != "6.14.0-27-generic" {
		t.Errorf("wk KernelVersion = %q, want %q", got[0].KernelVersion, "6.14.0-27-generic")
	}
	if got[0].Architecture != "amd64" {
		t.Errorf("wk Architecture = %q, want %q", got[0].Architecture, "amd64")
	}
	// wk2 omits both, as an older kubelet or a trimmed status would.
	if got[1].KernelVersion != "" || got[1].Architecture != "" {
		t.Errorf("wk2 = %q/%q, want both empty when nodeInfo omits them",
			got[1].KernelVersion, got[1].Architecture)
	}
}

// The address list is not ordered, and Hostname is commonly first, so the
// InternalIP has to be found by type rather than by position.
func TestNodesReadTheInternalIP(t *testing.T) {
	c := routes(t, map[string]string{"/api/v1/nodes": nodeListJSON})
	got, err := c.Nodes(context.Background())
	if err != nil {
		t.Fatalf("Nodes: %v", err)
	}
	if got[0].InternalIP != "192.168.10.185" {
		t.Errorf("wk InternalIP = %q, want %q", got[0].InternalIP, "192.168.10.185")
	}
	if got[1].InternalIP != "" {
		t.Errorf("wk2 InternalIP = %q, want empty when the node reports no addresses", got[1].InternalIP)
	}
}

// Annotations carry the human's overrides for a device's name and type.
// They are annotations rather than labels because a label value cannot
// contain a space, and "Living room ThinkPad" has two.
func TestNodesReadAnnotations(t *testing.T) {
	c := routes(t, map[string]string{"/api/v1/nodes": nodeListJSON})
	got, err := c.Nodes(context.Background())
	if err != nil {
		t.Fatalf("Nodes: %v", err)
	}
	if got[0].Annotations["k3s-dash/name"] != "Living room ThinkPad" {
		t.Errorf("wk annotation name = %q, want %q",
			got[0].Annotations["k3s-dash/name"], "Living room ThinkPad")
	}
	// A node with no annotations must still be safe to index.
	if got[1].Annotations["k3s-dash/name"] != "" {
		t.Errorf("wk2 annotation name = %q, want empty", got[1].Annotations["k3s-dash/name"])
	}
}

func TestNodeUsage(t *testing.T) {
	c := routes(t, map[string]string{"/apis/metrics.k8s.io/v1beta1/nodes": `{"items":[
	 {"metadata":{"name":"wk"},"usage":{"cpu":"578630136n","memory":"3696868Ki"}},
	 {"metadata":{"name":"wk1"},"usage":{"cpu":"290m","memory":"1495Mi"}}]}`})
	got, err := c.NodeUsage(context.Background())
	if err != nil {
		t.Fatalf("NodeUsage: %v", err)
	}
	if u := got["wk"]; u.CPUCores < 0.578 || u.CPUCores > 0.579 {
		t.Errorf("wk CPUCores = %v, want ~0.5786", u.CPUCores)
	}
	if u := got["wk1"]; u.MemoryBytes != 1495*1024*1024 {
		t.Errorf("wk1 MemoryBytes = %v, want %v", u.MemoryBytes, 1495*1024*1024)
	}
}

func TestNodeFilesystem(t *testing.T) {
	c := routes(t, map[string]string{"/api/v1/nodes/wk1/proxy/stats/summary": `{"node":{"nodeName":"wk1",
	 "fs":{"availableBytes":35122483200,"capacityBytes":61628878848,"usedBytes":23342632960}}}`})
	got, err := c.NodeFilesystem(context.Background(), "wk1")
	if err != nil {
		t.Fatalf("NodeFilesystem: %v", err)
	}
	if got.CapacityBytes != 61628878848 || got.UsedBytes != 23342632960 {
		t.Errorf("Filesystem = %+v, want capacity 61628878848 used 23342632960", got)
	}
}

func TestWorkloadsAcrossKinds(t *testing.T) {
	c := routes(t, map[string]string{
		"/apis/apps/v1/deployments": `{"items":[{"metadata":{"name":"gsm-frontend","namespace":"gsm"},
		 "spec":{"replicas":2,"selector":{"matchLabels":{"app":"gsm-frontend"}}},"status":{"readyReplicas":2}}]}`,
		"/apis/apps/v1/statefulsets": `{"items":[{"metadata":{"name":"gradeloop-postgres","namespace":"gradeloop"},
		 "spec":{"replicas":1,"selector":{"matchLabels":{"app":"pg"}}},"status":{"readyReplicas":0}}]}`,
		"/apis/apps/v1/daemonsets": `{"items":[{"metadata":{"name":"longhorn-manager","namespace":"longhorn-system"},
		 "spec":{"selector":{"matchLabels":{"app":"longhorn-manager"}}},
		 "status":{"desiredNumberScheduled":3,"numberReady":3}}]}`,
	})
	got, err := c.Workloads(context.Background())
	if err != nil {
		t.Fatalf("Workloads: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("len(Workloads) = %d, want 3", len(got))
	}
	byName := map[string]Workload{}
	for _, w := range got {
		byName[w.Name] = w
	}
	if w := byName["gsm-frontend"]; w.Kind != "Deployment" || w.Ready != 2 || w.Desired != 2 {
		t.Errorf("gsm-frontend = %+v, want Deployment 2/2", w)
	}
	// A StatefulSet with readyReplicas absent from the JSON must read as
	// 0 ready, not as "field missing so assume fine".
	if w := byName["gradeloop-postgres"]; w.Kind != "StatefulSet" || w.Ready != 0 || w.Desired != 1 {
		t.Errorf("gradeloop-postgres = %+v, want StatefulSet 0/1", w)
	}
	// DaemonSets carry their counts in different fields entirely.
	if w := byName["longhorn-manager"]; w.Kind != "DaemonSet" || w.Ready != 3 || w.Desired != 3 {
		t.Errorf("longhorn-manager = %+v, want DaemonSet 3/3", w)
	}
}

func TestWarningsPrefersLastTimestampThenEventTime(t *testing.T) {
	c := routes(t, map[string]string{"/api/v1/events": `{"items":[
	 {"metadata":{"creationTimestamp":"2026-08-21T05:00:00Z"},"type":"Warning","reason":"BackOff",
	  "message":"Back-off restarting failed container","count":9,
	  "lastTimestamp":"2026-08-21T06:00:00Z",
	  "involvedObject":{"kind":"Pod","name":"gsm-backend-1","namespace":"gsm"}},
	 {"metadata":{"creationTimestamp":"2026-08-21T04:00:00Z"},"type":"Warning","reason":"FailedMount",
	  "message":"Unable to attach volume","count":1,
	  "eventTime":"2026-08-21T04:30:00Z",
	  "involvedObject":{"kind":"Pod","name":"nordpil-0","namespace":"nordpil"}}]}`})
	got, err := c.Warnings(context.Background())
	if err != nil {
		t.Fatalf("Warnings: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len(Warnings) = %d, want 2", len(got))
	}
	if got[0].At.Format("15:04") != "06:00" {
		t.Errorf("first event At = %v, want lastTimestamp 06:00", got[0].At)
	}
	if got[1].At.Format("15:04") != "04:30" {
		t.Errorf("second event At = %v, want eventTime 04:30 when lastTimestamp is absent", got[1].At)
	}
	if got[0].Object != "Pod/gsm-backend-1" {
		t.Errorf("Object = %q, want %q", got[0].Object, "Pod/gsm-backend-1")
	}
}

func TestNamespaces(t *testing.T) {
	c := routes(t, map[string]string{"/api/v1/namespaces": `{"items":[
	 {"metadata":{"name":"gsm","creationTimestamp":"2026-06-22T16:20:00Z"},"status":{"phase":"Active"}},
	 {"metadata":{"name":"dying","creationTimestamp":"2026-08-01T00:00:00Z"},"status":{"phase":"Terminating"}}
	]}`})
	got, err := c.Namespaces(context.Background())
	if err != nil {
		t.Fatalf("Namespaces: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("len(Namespaces) = %d, want 2", len(got))
	}
	if got[0].Name != "gsm" || got[0].Phase != "Active" {
		t.Errorf("gsm = %+v, want Name gsm, Phase Active", got[0])
	}
	if got[1].Phase != "Terminating" {
		t.Errorf("dying Phase = %q, want Terminating", got[1].Phase)
	}
}

func TestResourceQuotas(t *testing.T) {
	c := routes(t, map[string]string{"/api/v1/resourcequotas": `{"items":[
	 {"metadata":{"name":"compute","namespace":"gsm"},
	  "status":{"hard":{"limits.cpu":"4","pods":"20"},"used":{"limits.cpu":"1500m","pods":"6"}}}
	]}`})
	got, err := c.ResourceQuotas(context.Background())
	if err != nil {
		t.Fatalf("ResourceQuotas: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len(ResourceQuotas) = %d, want 1", len(got))
	}
	q := got[0]
	if q.Namespace != "gsm" || q.Name != "compute" {
		t.Errorf("q = %+v, want namespace gsm, name compute", q)
	}
	if q.Hard["limits.cpu"] != "4" || q.Used["limits.cpu"] != "1500m" {
		t.Errorf("q.Hard/Used = %v/%v, want raw quantity strings passed through", q.Hard, q.Used)
	}
}

func TestLimitRanges(t *testing.T) {
	c := routes(t, map[string]string{"/api/v1/limitranges": `{"items":[
	 {"metadata":{"name":"defaults","namespace":"gsm"},
	  "spec":{"limits":[{"type":"Container","default":{"cpu":"500m"},"defaultRequest":{"cpu":"100m"},"min":{"cpu":"50m"},"max":{"cpu":"2"}}]}}
	]}`})
	got, err := c.LimitRanges(context.Background())
	if err != nil {
		t.Fatalf("LimitRanges: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len(LimitRanges) = %d, want 1", len(got))
	}
	lr := got[0]
	if lr.Namespace != "gsm" || len(lr.Limits) != 1 {
		t.Fatalf("lr = %+v, want namespace gsm with 1 limit item", lr)
	}
	item := lr.Limits[0]
	if item.Type != "Container" || item.Default["cpu"] != "500m" || item.Min["cpu"] != "50m" || item.Max["cpu"] != "2" {
		t.Errorf("item = %+v, want Container with default/min/max cpu populated", item)
	}
}

func TestPersistentVolumeClaims(t *testing.T) {
	c := routes(t, map[string]string{"/api/v1/persistentvolumeclaims": `{"items":[
	 {"metadata":{"name":"priset-data","namespace":"priset"},
	  "spec":{"storageClassName":"longhorn","accessModes":["ReadWriteOnce"]},
	  "status":{"phase":"Bound","capacity":{"storage":"5Gi"}}}
	]}`})
	got, err := c.PersistentVolumeClaims(context.Background())
	if err != nil {
		t.Fatalf("PersistentVolumeClaims: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len(PVCs) = %d, want 1", len(got))
	}
	p := got[0]
	if p.Namespace != "priset" || p.Name != "priset-data" || p.Phase != "Bound" || p.StorageClass != "longhorn" {
		t.Errorf("p = %+v, want priset/priset-data Bound on longhorn", p)
	}
	if len(p.AccessModes) != 1 || p.AccessModes[0] != "ReadWriteOnce" {
		t.Errorf("AccessModes = %v, want [ReadWriteOnce]", p.AccessModes)
	}
	if p.CapacityBytes != 5*1<<30 {
		t.Errorf("CapacityBytes = %v, want %v (5Gi)", p.CapacityBytes, 5*1<<30)
	}
}

func TestServices(t *testing.T) {
	c := routes(t, map[string]string{"/api/v1/services": `{"items":[
	 {"metadata":{"name":"k3s-dash","namespace":"k3s-dash"},
	  "spec":{"type":"ClusterIP","clusterIP":"10.43.54.248","ports":[{"port":80,"protocol":"TCP"}]}}
	]}`})
	got, err := c.Services(context.Background())
	if err != nil {
		t.Fatalf("Services: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len(Services) = %d, want 1", len(got))
	}
	s := got[0]
	if s.Namespace != "k3s-dash" || s.Name != "k3s-dash" || s.Type != "ClusterIP" || s.ClusterIP != "10.43.54.248" {
		t.Errorf("s = %+v, want k3s-dash/k3s-dash ClusterIP 10.43.54.248", s)
	}
	if len(s.Ports) != 1 || s.Ports[0].Port != 80 || s.Ports[0].Protocol != "TCP" {
		t.Errorf("Ports = %+v, want one port 80/TCP", s.Ports)
	}
}

func TestMatchesSelector(t *testing.T) {
	tests := []struct {
		name     string
		labels   map[string]string
		selector map[string]string
		want     bool
	}{
		{"exact", map[string]string{"app": "gsm"}, map[string]string{"app": "gsm"}, true},
		{"superset of labels matches", map[string]string{"app": "gsm", "tier": "web"}, map[string]string{"app": "gsm"}, true},
		{"value mismatch", map[string]string{"app": "other"}, map[string]string{"app": "gsm"}, false},
		{"missing label", map[string]string{}, map[string]string{"app": "gsm"}, false},
		// An empty selector matching everything would attribute every pod
		// in the cluster to one workload.
		{"empty selector matches nothing", map[string]string{"app": "gsm"}, map[string]string{}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := MatchesSelector(tc.labels, tc.selector); got != tc.want {
				t.Errorf("MatchesSelector(%v, %v) = %v, want %v", tc.labels, tc.selector, got, tc.want)
			}
		})
	}
}
