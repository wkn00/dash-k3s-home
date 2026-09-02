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

// SeriesMetrics are the sparklines a node card draws, in display order.
var SeriesMetrics = []string{"cpuPercent", "memPercent", "tempC", "batteryPercent"}

// FleetSeriesMetrics are the sparklines the fleet strip draws. Battery is
// absent on purpose: a fleet battery percentage would be an average across
// machines that are not all plugged into the same thing. The fleet answers
// that question with a count of what is unplugged instead.
var FleetSeriesMetrics = []string{"cpuPercent", "memPercent", "diskPercent", "tempC"}

type Node struct {
	Name           string                `json:"name"`
	DisplayName    *string               `json:"displayName"`
	Ready          bool                  `json:"ready"`
	ControlPlane   bool                  `json:"controlPlane"`
	DeviceVendor   *string               `json:"deviceVendor"`
	DeviceModel    *string               `json:"deviceModel"`
	DeviceClass    *string               `json:"deviceClass"`
	InternalIP     string                `json:"internalIP"`
	JoinedAt       time.Time             `json:"joinedAt"`
	KubeletVersion string                `json:"kubeletVersion"`
	OSImage        string                `json:"osImage"`
	KernelVersion  string                `json:"kernelVersion"`
	Architecture   string                `json:"architecture"`
	CPUModel       *string               `json:"cpuModel"`
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

// Pod is the placement answer: which device is this actually running on
// right now. Phase is the word the API server itself uses (Running,
// Pending, Succeeded, Failed, Unknown), so the status pill never invents
// wording the cluster didn't say.
type Pod struct {
	Namespace string    `json:"namespace"`
	Name      string    `json:"name"`
	Node      string    `json:"node"`
	Phase     string    `json:"phase"`
	Healthy   bool      `json:"healthy"`
	Restarts  int       `json:"restarts"`
	CreatedAt time.Time `json:"createdAt"`
	// Workload is the owning Deployment/StatefulSet's name, found by the
	// same selector match that attributes restarts below — empty for a
	// pod nothing in raw.Workloads claims, e.g. most kube-system pods.
	Workload string `json:"workload"`
}

// QuotaItem is one resource line out of a namespace's ResourceQuota, hard
// and used already parsed into the resource's base unit. Percent is nil
// when Hard is zero or absent, the same "don't show a fake number" rule
// every other ratio on this page follows.
type QuotaItem struct {
	Resource string   `json:"resource"`
	Hard     float64  `json:"hard"`
	Used     float64  `json:"used"`
	Percent  *float64 `json:"percent"`
}

type LimitRangeItem struct {
	Type           string            `json:"type"`
	Default        map[string]string `json:"default"`
	DefaultRequest map[string]string `json:"defaultRequest"`
	Min            map[string]string `json:"min"`
	Max            map[string]string `json:"max"`
}

type PVC struct {
	Name          string   `json:"name"`
	Phase         string   `json:"phase"`
	Bound         bool     `json:"bound"`
	StorageClass  string   `json:"storageClass"`
	AccessModes   []string `json:"accessModes"`
	CapacityBytes float64  `json:"capacityBytes"`
}

type ServicePort struct {
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
}

type Service struct {
	Name      string        `json:"name"`
	Type      string        `json:"type"`
	ClusterIP string        `json:"clusterIP"`
	Ports     []ServicePort `json:"ports"`
}

// Namespace rolls up everything the page shows about one namespace: pod
// and workload counts (matched by the same .Namespace field Workloads and
// Pods already carry), plus its own quota, limit ranges, PVCs and
// services. A namespace with none of those has empty slices, never nil —
// the page ranges over them without a null check.
type Namespace struct {
	Name               string           `json:"name"`
	Phase              string           `json:"phase"`
	CreatedAt          time.Time        `json:"createdAt"`
	PodCount           int              `json:"podCount"`
	WorkloadCount      int              `json:"workloadCount"`
	UnhealthyWorkloads int              `json:"unhealthyWorkloads"`
	Quota              []QuotaItem      `json:"quota"`
	LimitRanges        []LimitRangeItem `json:"limitRanges"`
	PVCs               []PVC            `json:"pvcs"`
	Services           []Service        `json:"services"`
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
	Nodes      []Node      `json:"nodes"`
	Fleet      Fleet       `json:"fleet"`
	Workloads  []Workload  `json:"workloads"`
	Pods       []Pod       `json:"pods"`
	Namespaces []Namespace `json:"namespaces"`
	Events     []Event     `json:"events"`
	Meta       Meta        `json:"meta"`
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
		Nodes:      make([]Node, 0, len(raw.Nodes)),
		Workloads:  make([]Workload, 0, len(raw.Workloads)),
		Pods:       make([]Pod, 0, len(raw.Pods)),
		Namespaces: make([]Namespace, 0, len(raw.Namespaces)),
		Events:     []Event{},
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
			KernelVersion:  kn.KernelVersion,
			Architecture:   kn.Architecture,
			InternalIP:     kn.InternalIP,
			JoinedAt:       kn.CreatedAt,
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
		var agent *hw.Snapshot
		if snapshot, ok := raw.HW[kn.Name]; ok {
			agent = &snapshot
			n.TempC = snapshot.TempC
			n.Battery = snapshot.Battery
			n.UptimeSeconds = snapshot.UptimeSeconds
			n.Load1 = snapshot.Load1
			n.CPUModel = snapshot.CPUModel
		}
		n.DisplayName, n.DeviceVendor, n.DeviceModel, n.DeviceClass = identify(kn, agent)

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
	// Name order, not trouble order. Sorting by severity needs the warning
	// and critical thresholds, and those live in the page — duplicating
	// them here is how the two copies drift apart. The page re-sorts with
	// the thresholds it already owns.
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

	// One row per pod is the placement answer the workload table can't
	// give: a Deployment's ready count says nothing about which of ten
	// devices its replicas actually landed on.
	for _, pod := range raw.Pods {
		var owner string
		for _, kw := range raw.Workloads {
			if pod.Namespace == kw.Namespace && kube.MatchesSelector(pod.Labels, kw.Selector) {
				owner = kw.Name
				break
			}
		}
		snap.Pods = append(snap.Pods, Pod{
			Namespace: pod.Namespace,
			Name:      pod.Name,
			Node:      pod.NodeName,
			Phase:     pod.Phase,
			Healthy:   pod.Phase == "Running" || pod.Phase == "Succeeded",
			Restarts:  pod.Restarts,
			CreatedAt: pod.CreatedAt,
			Workload:  owner,
		})
	}
	sort.Slice(snap.Pods, func(i, j int) bool {
		a, b := snap.Pods[i], snap.Pods[j]
		if a.Healthy != b.Healthy {
			return !a.Healthy // trouble first, same as the workload table
		}
		if a.Restarts != b.Restarts {
			return a.Restarts > b.Restarts
		}
		if a.Namespace != b.Namespace {
			return a.Namespace < b.Namespace
		}
		return a.Name < b.Name
	})

	podsPerNamespace := map[string]int{}
	for _, pod := range raw.Pods {
		podsPerNamespace[pod.Namespace]++
	}
	workloadsPerNamespace := map[string]int{}
	unhealthyPerNamespace := map[string]int{}
	for _, w := range snap.Workloads {
		workloadsPerNamespace[w.Namespace]++
		if !w.Healthy {
			unhealthyPerNamespace[w.Namespace]++
		}
	}

	for _, kn := range raw.Namespaces {
		ns := Namespace{
			Name:               kn.Name,
			Phase:              kn.Phase,
			CreatedAt:          kn.CreatedAt,
			PodCount:           podsPerNamespace[kn.Name],
			WorkloadCount:      workloadsPerNamespace[kn.Name],
			UnhealthyWorkloads: unhealthyPerNamespace[kn.Name],
			Quota:              []QuotaItem{},
			LimitRanges:        []LimitRangeItem{},
			PVCs:               []PVC{},
			Services:           []Service{},
		}
		for _, q := range raw.Quotas {
			if q.Namespace != kn.Name {
				continue
			}
			for resource, hardStr := range q.Hard {
				hard, err := kube.ParseQuantity(hardStr)
				if err != nil {
					continue
				}
				var used float64
				if usedStr, ok := q.Used[resource]; ok {
					used, _ = kube.ParseQuantity(usedStr)
				}
				ns.Quota = append(ns.Quota, QuotaItem{Resource: resource, Hard: hard, Used: used, Percent: ratio(used, hard)})
			}
		}
		sort.Slice(ns.Quota, func(i, j int) bool { return ns.Quota[i].Resource < ns.Quota[j].Resource })

		for _, lr := range raw.LimitRanges {
			if lr.Namespace != kn.Name {
				continue
			}
			for _, item := range lr.Limits {
				ns.LimitRanges = append(ns.LimitRanges, LimitRangeItem(item))
			}
		}

		for _, p := range raw.PVCs {
			if p.Namespace != kn.Name {
				continue
			}
			ns.PVCs = append(ns.PVCs, PVC{
				Name: p.Name, Phase: p.Phase, Bound: p.Phase == "Bound",
				StorageClass: p.StorageClass, AccessModes: p.AccessModes, CapacityBytes: p.CapacityBytes,
			})
		}

		for _, s := range raw.Services {
			if s.Namespace != kn.Name {
				continue
			}
			svc := Service{Name: s.Name, Type: s.Type, ClusterIP: s.ClusterIP}
			for _, p := range s.Ports {
				svc.Ports = append(svc.Ports, ServicePort(p))
			}
			ns.Services = append(ns.Services, svc)
		}

		snap.Namespaces = append(snap.Namespaces, ns)
	}
	// Trouble first, same convention as Workloads and Pods.
	sort.Slice(snap.Namespaces, func(i, j int) bool {
		a, b := snap.Namespaces[i], snap.Namespaces[j]
		if (a.UnhealthyWorkloads > 0) != (b.UnhealthyWorkloads > 0) {
			return a.UnhealthyWorkloads > 0
		}
		return a.Name < b.Name
	})

	snap.Fleet = summarise(snap.Nodes, snap.Workloads)
	// The fleet strip draws its own sparklines, so the aggregate needs a
	// history of its own — recomputing one from the node series would
	// average percentages the same way summarise refuses to.
	buffers.Add(fleetKey, "cpuPercent", raw.At, snap.Fleet.CPUPercent)
	buffers.Add(fleetKey, "memPercent", raw.At, snap.Fleet.MemPercent)
	buffers.Add(fleetKey, "diskPercent", raw.At, snap.Fleet.DiskPercent)
	buffers.Add(fleetKey, "tempC", raw.At, snap.Fleet.HottestC)
	snap.Fleet.Series = buffers.Series(fleetKey, FleetSeriesMetrics)

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
