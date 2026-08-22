package state

// fleetKey is the ring-buffer key the aggregate series live under. A
// Kubernetes node name is a DNS-1123 subdomain — lowercase alphanumerics,
// '-' and '.' only — so no real node can ever claim this key.
const fleetKey = "__fleet__"

// Fleet is the whole cluster in one line, which is what the page needs
// before it needs any individual card: at ten devices, scanning ten cards
// to discover that everything is fine is the wrong way round.
//
// The percentages are capacity-weighted, not averaged. A mean of the
// per-node percentages lets a busy 4-core board outvote an idle 16-core
// one, and the resulting number describes no machine that exists.
type Fleet struct {
	Devices           int                   `json:"devices"`
	Ready             int                   `json:"ready"`
	OnBattery         int                   `json:"onBattery"`
	Pods              int                   `json:"pods"`
	WorkloadsDegraded int                   `json:"workloadsDegraded"`
	WorkloadsTotal    int                   `json:"workloadsTotal"`
	CPUCores          float64               `json:"cpuCores"`
	MemTotalBytes     float64               `json:"memTotalBytes"`
	CPUPercent        *float64              `json:"cpuPercent"`
	MemPercent        *float64              `json:"memPercent"`
	DiskPercent       *float64              `json:"diskPercent"`
	HottestNode       *string               `json:"hottestNode"`
	HottestC          *float64              `json:"hottestC"`
	Series            map[string][]*float64 `json:"series"`
}

// weighted accumulates a used-over-capacity ratio across nodes. Only nodes
// that actually reported contribute to either side: counting a silent
// node's capacity as "0% used" would drag the fleet number down and hide
// the very problem that made it silent.
type weighted struct{ used, capacity float64 }

func (w *weighted) add(used, capacity float64) {
	if capacity <= 0 {
		return
	}
	w.used += used
	w.capacity += capacity
}

func (w weighted) percent() *float64 { return ratio(w.used, w.capacity) }

// summarise folds the assembled nodes into the fleet line. It runs on the
// finished []Node rather than on the raw sample so that every number in it
// is the same number the cards show, arrived at the same way.
func summarise(nodes []Node, workloads []Workload) Fleet {
	fleet := Fleet{Devices: len(nodes)}
	var cpu, mem, disk weighted

	for _, n := range nodes {
		if n.Ready {
			fleet.Ready++
		}
		fleet.Pods += n.PodCount
		fleet.CPUCores += n.CPUCores
		fleet.MemTotalBytes += n.MemTotalBytes

		// CPUPercent is a ratio, so it has to be turned back into cores
		// before it can be summed against other nodes' cores.
		if n.CPUPercent != nil {
			cpu.add(*n.CPUPercent/100*n.CPUCores, n.CPUCores)
		}
		if n.MemUsedBytes != nil {
			mem.add(*n.MemUsedBytes, n.MemTotalBytes)
		}
		if n.DiskUsedBytes != nil && n.DiskTotalBytes != nil {
			disk.add(*n.DiskUsedBytes, *n.DiskTotalBytes)
		}
		if n.TempC != nil && (fleet.HottestC == nil || *n.TempC > *fleet.HottestC) {
			temp, name := *n.TempC, n.Name
			fleet.HottestC, fleet.HottestNode = &temp, &name
		}
		// "On battery" means discharging, not "has a battery": a laptop
		// plugged in at 100% is not something anyone needs to be told.
		if n.Battery != nil && n.Battery.Status != nil && *n.Battery.Status == "Discharging" {
			fleet.OnBattery++
		}
	}

	fleet.WorkloadsTotal = len(workloads)
	for _, w := range workloads {
		if !w.Healthy {
			fleet.WorkloadsDegraded++
		}
	}

	fleet.CPUPercent = cpu.percent()
	fleet.MemPercent = mem.percent()
	fleet.DiskPercent = disk.percent()
	return fleet
}
