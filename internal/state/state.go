// Package state turns one raw sample into the document the page renders.
// Every derived number is a pointer: nil means "not known this sample",
// which the UI shows as an em dash rather than as zero. A dashboard that
// prints 0% for a source it could not reach is worse than one that admits
// it does not know.
package state

import (
	"sort"
	"time"

	"github.com/wkn00/k3s-dash/internal/collect"
	"github.com/wkn00/k3s-dash/internal/hw"
	"github.com/wkn00/k3s-dash/internal/kube"
	"github.com/wkn00/k3s-dash/internal/ring"
)

// EventWindow is how far back the warnings panel looks.
const EventWindow = time.Hour

// SeriesMetrics are the sparklines the page draws, in display order.
var SeriesMetrics = []string{"cpuPercent", "memPercent", "tempC", "batteryPercent"}

type Node struct {
	Name           string                `json:"name"`
	Ready          bool                  `json:"ready"`
	ControlPlane   bool                  `json:"controlPlane"`
	KubeletVersion string                `json:"kubeletVersion"`
	OSImage        string                `json:"osImage"`
	UptimeSeconds  *float64              `json:"uptimeSeconds"`
	Load1          *float64              `json:"load1"`
	CPUPercent     *float64              `json:"cpuPercent"`
	CPUCores       float64               `json:"cpuCores"`
	MemPercent     *float64              `json:"memPercent"`
	MemUsedBytes   *float64              `json:"memUsedBytes"`
	MemTotalBytes  float64               `json:"memTotalBytes"`
	DiskPercent    *float64              `json:"diskPercent"`
	DiskUsedBytes  *float64              `json:"diskUsedBytes"`
	DiskTotalBytes *float64              `json:"diskTotalBytes"`
	TempC          *float64              `json:"tempC"`
	Battery        *hw.Battery           `json:"battery"`
	PodCount       int                   `json:"podCount"`
	Series         map[string][]*float64 `json:"series"`
}

type Workload struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Ready     int    `json:"ready"`
	Desired   int    `json:"desired"`
	Restarts  int    `json:"restarts"`
	Healthy   bool   `json:"healthy"`
}

type Event struct {
	At        time.Time `json:"at"`
	Namespace string    `json:"namespace"`
	Object    string    `json:"object"`
	Reason    string    `json:"reason"`
	Message   string    `json:"message"`
	Count     int       `json:"count"`
}

type Meta struct {
	SampledAt             time.Time `json:"sampledAt"`
	SampleIntervalSeconds int       `json:"sampleIntervalSeconds"`
	Degraded              []string  `json:"degraded"`
}

type Snapshot struct {
	Nodes     []Node     `json:"nodes"`
	Workloads []Workload `json:"workloads"`
	Events    []Event    `json:"events"`
	Meta      Meta       `json:"meta"`
}

// ratio guards every percentage in the program. Capacity is zero whenever
// the source that supplies it failed, and 5/0 renders as "+Inf%".
func ratio(used, capacity float64) *float64 {
	if capacity <= 0 {
		return nil
	}
	v := used / capacity * 100
	return &v
}

func Assemble(raw collect.Raw, buffers *ring.Set, interval time.Duration) Snapshot {
	snap := Snapshot{
		Nodes:     make([]Node, 0, len(raw.Nodes)),
		Workloads: make([]Workload, 0, len(raw.Workloads)),
		Events:    []Event{},
		Meta: Meta{
			SampledAt:             raw.At,
			SampleIntervalSeconds: int(interval.Seconds()),
			Degraded:              raw.Degraded,
		},
	}
	if snap.Meta.Degraded == nil {
		snap.Meta.Degraded = []string{}
	}

	podsPerNode := map[string]int{}
	for _, pod := range raw.Pods {
		podsPerNode[pod.NodeName]++
	}

	for _, kn := range raw.Nodes {
		n := Node{
			Name:           kn.Name,
			Ready:          kn.Ready,
			ControlPlane:   kn.ControlPlane,
			KubeletVersion: kn.KubeletVersion,
			OSImage:        kn.OSImage,
			CPUCores:       kn.CPUCapacityCores,
			MemTotalBytes:  kn.MemoryCapacityBytes,
			PodCount:       podsPerNode[kn.Name],
		}
		if usage, ok := raw.Usage[kn.Name]; ok {
			n.CPUPercent = ratio(usage.CPUCores, kn.CPUCapacityCores)
			used := usage.MemoryBytes
			n.MemUsedBytes = &used
			n.MemPercent = ratio(usage.MemoryBytes, kn.MemoryCapacityBytes)
		}
		if fs, ok := raw.FS[kn.Name]; ok {
			used, total := fs.UsedBytes, fs.CapacityBytes
			n.DiskUsedBytes, n.DiskTotalBytes = &used, &total
			n.DiskPercent = ratio(fs.UsedBytes, fs.CapacityBytes)
		}
		if snapshot, ok := raw.HW[kn.Name]; ok {
			n.TempC = snapshot.TempC
			n.Battery = snapshot.Battery
			n.UptimeSeconds = snapshot.UptimeSeconds
			n.Load1 = snapshot.Load1
		}

		var batteryPercent *float64
		if n.Battery != nil && n.Battery.Percent != nil {
			v := float64(*n.Battery.Percent)
			batteryPercent = &v
		}
		buffers.Add(kn.Name, "cpuPercent", raw.At, n.CPUPercent)
		buffers.Add(kn.Name, "memPercent", raw.At, n.MemPercent)
		buffers.Add(kn.Name, "tempC", raw.At, n.TempC)
		buffers.Add(kn.Name, "batteryPercent", raw.At, batteryPercent)
		n.Series = buffers.Series(kn.Name, SeriesMetrics)

		snap.Nodes = append(snap.Nodes, n)
	}
	sort.Slice(snap.Nodes, func(i, j int) bool { return snap.Nodes[i].Name < snap.Nodes[j].Name })

	for _, kw := range raw.Workloads {
		w := Workload{
			Namespace: kw.Namespace,
			Name:      kw.Name,
			Kind:      kw.Kind,
			Ready:     kw.Ready,
			Desired:   kw.Desired,
			Healthy:   kw.Ready >= kw.Desired,
		}
		// Restarts are attributed by label selector, not by name prefix:
		// "gsm-frontend-*" would also swallow a "gsm-frontend-canary".
		for _, pod := range raw.Pods {
			if pod.Namespace == kw.Namespace && kube.MatchesSelector(pod.Labels, kw.Selector) {
				w.Restarts += pod.Restarts
			}
		}
		snap.Workloads = append(snap.Workloads, w)
	}
	sort.Slice(snap.Workloads, func(i, j int) bool {
		a, b := snap.Workloads[i], snap.Workloads[j]
		if a.Healthy != b.Healthy {
			return !a.Healthy // trouble first: this is what the page is for
		}
		if a.Namespace != b.Namespace {
			return a.Namespace < b.Namespace
		}
		return a.Name < b.Name
	})

	cutoff := raw.At.Add(-EventWindow)
	for _, ev := range raw.Warnings {
		if ev.At.Before(cutoff) {
			continue
		}
		snap.Events = append(snap.Events, Event(ev))
	}
	sort.Slice(snap.Events, func(i, j int) bool { return snap.Events[i].At.After(snap.Events[j].At) })

	return snap
}
