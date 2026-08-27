package state

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/wkn00/k3s-dash/internal/collect"
	"github.com/wkn00/k3s-dash/internal/hw"
	"github.com/wkn00/k3s-dash/internal/kube"
	"github.com/wkn00/k3s-dash/internal/ring"
)

func f(v float64) *float64  { return &v }
func strp(s string) *string { return &s }
func boolp(b bool) *bool    { return &b }

func baseRaw() collect.Raw {
	pct := 82
	temp := 44.0
	return collect.Raw{
		At: time.Date(2026, 8, 21, 6, 0, 0, 0, time.UTC),
		Nodes: []kube.Node{
			{Name: "wk", Ready: true, ControlPlane: true, CPUCapacityCores: 8, MemoryCapacityBytes: 16e9,
				KernelVersion: "6.14.0-27-generic", Architecture: "amd64"},
			{Name: "wk1", Ready: true, CPUCapacityCores: 4, MemoryCapacityBytes: 8e9},
		},
		Pods: []kube.Pod{
			{Name: "gsm-frontend-a", Namespace: "gsm", NodeName: "wk1", Phase: "Running",
				Restarts: 2, Labels: map[string]string{"app": "gsm-frontend"}},
			{Name: "gsm-frontend-b", Namespace: "gsm", NodeName: "wk", Phase: "Running",
				Restarts: 5, Labels: map[string]string{"app": "gsm-frontend"}},
			{Name: "other", Namespace: "gsm", NodeName: "wk", Phase: "Running",
				Restarts: 99, Labels: map[string]string{"app": "unrelated"}},
		},
		Workloads: []kube.Workload{
			{Namespace: "gsm", Name: "gsm-frontend", Kind: "Deployment", Ready: 2, Desired: 2,
				Selector: map[string]string{"app": "gsm-frontend"}},
			{Namespace: "nordpil", Name: "nordpil", Kind: "Deployment", Ready: 0, Desired: 1,
				Selector: map[string]string{"app": "nordpil"}},
		},
		Usage: map[string]kube.Usage{
			"wk":  {CPUCores: 2, MemoryBytes: 8e9},
			"wk1": {CPUCores: 1, MemoryBytes: 2e9},
		},
		FS: map[string]kube.Filesystem{"wk": {UsedBytes: 250, CapacityBytes: 1000}},
		HW: map[string]hw.Snapshot{
			"wk": {Node: "wk", TempC: &temp, Load1: f(0.96), CPUModel: strp("Core i7-8650U"),
				Battery: &hw.Battery{Percent: &pct, Status: strp("Discharging"), ACOnline: boolp(false)}},
		},
		Degraded: []string{},
	}
}

func TestAssembleComputesPercentages(t *testing.T) {
	got := Assemble(baseRaw(), ring.NewSet(10), 15*time.Second)

	byName := map[string]Node{}
	for _, n := range got.Nodes {
		byName[n.Name] = n
	}
	wk := byName["wk"]
	if wk.CPUPercent == nil || *wk.CPUPercent != 25 {
		t.Errorf("wk CPUPercent = %v, want 25 (2 of 8 cores)", wk.CPUPercent)
	}
	if wk.MemPercent == nil || *wk.MemPercent != 50 {
		t.Errorf("wk MemPercent = %v, want 50", wk.MemPercent)
	}
	if wk.DiskPercent == nil || *wk.DiskPercent != 25 {
		t.Errorf("wk DiskPercent = %v, want 25", wk.DiskPercent)
	}
	if wk.PodCount != 2 {
		t.Errorf("wk PodCount = %d, want 2", wk.PodCount)
	}
	if wk.Battery == nil || wk.Battery.Percent == nil || *wk.Battery.Percent != 82 {
		t.Errorf("wk Battery = %+v, want 82%%", wk.Battery)
	}
}

// A node with no filesystem reading (wedged kubelet) or no agent must
// still render everything that did arrive.
func TestAssembleLeavesMissingSourcesNil(t *testing.T) {
	got := Assemble(baseRaw(), ring.NewSet(10), 15*time.Second)
	var wk1 Node
	for _, n := range got.Nodes {
		if n.Name == "wk1" {
			wk1 = n
		}
	}
	if wk1.DiskPercent != nil {
		t.Errorf("wk1 DiskPercent = %v, want nil (no kubelet reading)", *wk1.DiskPercent)
	}
	if wk1.TempC != nil {
		t.Errorf("wk1 TempC = %v, want nil (no agent)", *wk1.TempC)
	}
	if wk1.CPUPercent == nil {
		t.Error("wk1 CPUPercent = nil, want 25: missing disk must not suppress CPU")
	}
}

func TestAssembleDividesByZeroSafely(t *testing.T) {
	raw := baseRaw()
	raw.Nodes[0].CPUCapacityCores = 0
	raw.Nodes[0].MemoryCapacityBytes = 0
	raw.FS["wk"] = kube.Filesystem{UsedBytes: 5, CapacityBytes: 0}
	got := Assemble(raw, ring.NewSet(10), 15*time.Second)
	if got.Nodes[0].CPUPercent != nil || got.Nodes[0].MemPercent != nil || got.Nodes[0].DiskPercent != nil {
		t.Errorf("percentages = %+v, want nil when capacity is zero, not Inf or NaN", got.Nodes[0])
	}
}

func TestAssembleAttributesRestartsBySelector(t *testing.T) {
	got := Assemble(baseRaw(), ring.NewSet(10), 15*time.Second)
	byName := map[string]Workload{}
	for _, w := range got.Workloads {
		byName[w.Name] = w
	}
	// 2 + 5 from the two matching pods; the unrelated pod's 99 must not
	// be counted just because it shares a namespace.
	if got := byName["gsm-frontend"].Restarts; got != 7 {
		t.Errorf("gsm-frontend Restarts = %d, want 7", got)
	}
}

func TestAssembleSortsUnhealthyWorkloadsFirst(t *testing.T) {
	got := Assemble(baseRaw(), ring.NewSet(10), 15*time.Second)
	if len(got.Workloads) == 0 || got.Workloads[0].Name != "nordpil" {
		t.Errorf("first workload = %+v, want the unhealthy nordpil first", got.Workloads)
	}
	if got.Workloads[0].Healthy {
		t.Error("nordpil Healthy = true, want false at 0/1")
	}
}

func TestAssembleDropsStaleEventsAndSortsNewestFirst(t *testing.T) {
	raw := baseRaw()
	raw.Warnings = []kube.Event{
		{At: raw.At.Add(-90 * time.Minute), Reason: "Ancient", Object: "Pod/old"},
		{At: raw.At.Add(-10 * time.Minute), Reason: "Recent", Object: "Pod/a"},
		{At: raw.At.Add(-30 * time.Minute), Reason: "Middle", Object: "Pod/b"},
	}
	got := Assemble(raw, ring.NewSet(10), 15*time.Second)
	if len(got.Events) != 2 {
		t.Fatalf("len(Events) = %d, want 2 — events older than an hour are dropped", len(got.Events))
	}
	if got.Events[0].Reason != "Recent" || got.Events[1].Reason != "Middle" {
		t.Errorf("Events = %+v, want newest first", got.Events)
	}
}

func TestAssembleFeedsAndReadsSeries(t *testing.T) {
	buffers := ring.NewSet(10)
	raw := baseRaw()
	Assemble(raw, buffers, 15*time.Second)
	raw.Usage["wk"] = kube.Usage{CPUCores: 4, MemoryBytes: 8e9}
	got := Assemble(raw, buffers, 15*time.Second)

	series := got.Nodes[0].Series["cpuPercent"]
	if len(series) != 2 {
		t.Fatalf("len(series[cpuPercent]) = %d, want 2 after two samples", len(series))
	}
	if series[0] == nil || *series[0] != 25 || series[1] == nil || *series[1] != 50 {
		t.Errorf("series[cpuPercent] = %v, %v, want 25 then 50", series[0], series[1])
	}
	for _, metric := range []string{"cpuPercent", "memPercent", "tempC", "batteryPercent"} {
		if got.Nodes[0].Series[metric] == nil {
			t.Errorf("Series[%q] = nil, want a slice so the page need not nil-check", metric)
		}
	}
}

func TestSnapshotMarshalsWithStableKeys(t *testing.T) {
	got := Assemble(baseRaw(), ring.NewSet(10), 15*time.Second)
	blob, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, want := range []string{`"nodes"`, `"workloads"`, `"events"`, `"meta"`, `"sampledAt"`, `"degraded"`, `"series"`} {
		if !strings.Contains(string(blob), want) {
			t.Errorf("JSON missing %s", want)
		}
	}
}

// The pods table is the placement answer: which device is this pod
// actually on. Sort order puts unhealthy pods first, then higher restart
// counts, mirroring the workload table's trouble-first convention.
func TestAssembleSortsPodsTroubleFirst(t *testing.T) {
	raw := baseRaw()
	raw.Pods = append(raw.Pods, kube.Pod{
		Name: "stuck", Namespace: "gsm", NodeName: "", Phase: "Pending", Restarts: 0,
	})
	got := Assemble(raw, ring.NewSet(10), 15*time.Second)

	if len(got.Pods) != 4 {
		t.Fatalf("len(Pods) = %d, want 4", len(got.Pods))
	}
	if got.Pods[0].Name != "stuck" || got.Pods[0].Healthy {
		t.Errorf("first pod = %+v, want the unhealthy pending pod first", got.Pods[0])
	}
	if got.Pods[0].Node != "" {
		t.Errorf("stuck pod Node = %q, want empty (unscheduled)", got.Pods[0].Node)
	}

	// Among healthy pods, the one with more restarts sorts first.
	if got.Pods[1].Name != "other" || got.Pods[1].Restarts != 99 {
		t.Errorf("second pod = %+v, want the 99-restart pod next", got.Pods[1])
	}
}

func TestAssembleCarriesPodPlacement(t *testing.T) {
	got := Assemble(baseRaw(), ring.NewSet(10), 15*time.Second)
	byName := map[string]Pod{}
	for _, p := range got.Pods {
		byName[p.Name] = p
	}
	a := byName["gsm-frontend-a"]
	if a.Node != "wk1" || a.Namespace != "gsm" || a.Phase != "Running" || !a.Healthy || a.Restarts != 2 {
		t.Errorf("gsm-frontend-a = %+v, want node wk1, namespace gsm, Running, healthy, 2 restarts", a)
	}
}

// A device's drill-down needs each pod's owning workload to group by, found
// the same way restart attribution finds it: by label selector, not by name
// prefix. A pod with no matching workload (most kube-system pods) gets no
// owner rather than a guess.
func TestAssembleAttributesPodOwnerBySelector(t *testing.T) {
	got := Assemble(baseRaw(), ring.NewSet(10), 15*time.Second)
	byName := map[string]Pod{}
	for _, p := range got.Pods {
		byName[p.Name] = p
	}
	if got := byName["gsm-frontend-a"].Workload; got != "gsm-frontend" {
		t.Errorf("gsm-frontend-a Workload = %q, want %q", got, "gsm-frontend")
	}
	if got := byName["other"].Workload; got != "" {
		t.Errorf("other Workload = %q, want empty — its labels match no tracked workload", got)
	}
}

// The spec a card prints comes from two sources, and the card has to
// survive either one being absent: kernel and architecture come from the
// API server, the CPU model comes from the node's own agent.
func TestAssembleCarriesHardwareSpec(t *testing.T) {
	got := Assemble(baseRaw(), ring.NewSet(10), 15*time.Second)

	byName := map[string]Node{}
	for _, n := range got.Nodes {
		byName[n.Name] = n
	}
	wk := byName["wk"]
	if wk.CPUModel == nil || *wk.CPUModel != "Core i7-8650U" {
		t.Errorf("wk CPUModel = %v, want %q", wk.CPUModel, "Core i7-8650U")
	}
	if wk.KernelVersion != "6.14.0-27-generic" {
		t.Errorf("wk KernelVersion = %q, want %q", wk.KernelVersion, "6.14.0-27-generic")
	}
	if wk.Architecture != "amd64" {
		t.Errorf("wk Architecture = %q, want %q", wk.Architecture, "amd64")
	}

	// wk1 has no agent reporting, so it has no CPU model — but the
	// capacities the API server supplies must still be there, because a
	// down agent must not blank the rest of the spec line.
	wk1 := byName["wk1"]
	if wk1.CPUModel != nil {
		t.Errorf("wk1 CPUModel = %v, want nil — no agent reported for this node", *wk1.CPUModel)
	}
	if wk1.CPUCores != 4 || wk1.MemTotalBytes != 8e9 {
		t.Errorf("wk1 cores/mem = %v/%v, want 4/8e9", wk1.CPUCores, wk1.MemTotalBytes)
	}
}
