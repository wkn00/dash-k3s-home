package state

import (
	"strings"
	"testing"
	"time"

	"github.com/wkn00/k3s-dash/internal/hw"
	"github.com/wkn00/k3s-dash/internal/kube"
	"github.com/wkn00/k3s-dash/internal/ring"
)

// A %v of a *float64 prints an address, which tells you nothing about why
// a test failed.
func fmtF(p *float64) any {
	if p == nil {
		return "nil"
	}
	return *p
}

func fmtS(p *string) any {
	if p == nil {
		return "nil"
	}
	return *p
}

// Percentages are divisions, so they are compared with a tolerance: 16e9
// of 24e9 and 200/3 are the same number and differ in the last bit.
func nearly(got *float64, want float64) bool {
	return got != nil && (*got-want) < 1e-9 && (want-*got) < 1e-9
}

func byName(nodes []Node) map[string]Node {
	out := map[string]Node{}
	for _, n := range nodes {
		out[n.Name] = n
	}
	return out
}

// The agent's DMI reading reaches the page as one identity block.
func TestAssembleCarriesTheDeviceIdentity(t *testing.T) {
	raw := baseRaw()
	raw.Nodes[0].InternalIP = "192.168.10.185"
	raw.HW["wk"] = hw.Snapshot{
		Node: "wk",
		Device: &hw.Device{
			Vendor:  strp("Lenovo"),
			Model:   strp("ThinkPad L520"),
			Chassis: strp("laptop"),
		},
	}
	got := byName(Assemble(raw, ring.NewSet(10), 15*time.Second).Nodes)

	wk := got["wk"]
	if wk.DeviceVendor == nil || *wk.DeviceVendor != "Lenovo" {
		t.Errorf("DeviceVendor = %v, want Lenovo", fmtS(wk.DeviceVendor))
	}
	if wk.DeviceModel == nil || *wk.DeviceModel != "ThinkPad L520" {
		t.Errorf("DeviceModel = %v, want ThinkPad L520", fmtS(wk.DeviceModel))
	}
	if wk.DeviceClass == nil || *wk.DeviceClass != "laptop" {
		t.Errorf("DeviceClass = %v, want laptop", fmtS(wk.DeviceClass))
	}
	if wk.InternalIP != "192.168.10.185" {
		t.Errorf("InternalIP = %q, want 192.168.10.185", wk.InternalIP)
	}

	// wk1 has no agent reporting, so it has no device — and that must not
	// borrow wk's.
	if wk1 := got["wk1"]; wk1.DeviceModel != nil {
		t.Errorf("wk1 DeviceModel = %v, want nil", fmtS(wk1.DeviceModel))
	}
}

// Annotations are the human's last word. Firmware is often wrong — a
// generic mini-PC reports "Default string" — and re-flashing DMI to fix a
// dashboard is not a reasonable thing to ask of anyone.
func TestAnnotationsOverrideTheDetectedDevice(t *testing.T) {
	raw := baseRaw()
	raw.Nodes[0].Annotations = map[string]string{
		"k3s-dash/name":  "Living room ThinkPad",
		"k3s-dash/model": "Beelink SER5 MAX",
		"k3s-dash/type":  "mini-pc",
	}
	raw.HW["wk"] = hw.Snapshot{
		Node:   "wk",
		Device: &hw.Device{Vendor: strp("Lenovo"), Model: strp("ThinkPad L520"), Chassis: strp("laptop")},
	}
	wk := byName(Assemble(raw, ring.NewSet(10), 15*time.Second).Nodes)["wk"]

	if wk.DisplayName == nil || *wk.DisplayName != "Living room ThinkPad" {
		t.Errorf("DisplayName = %v, want the annotation", fmtS(wk.DisplayName))
	}
	if wk.DeviceModel == nil || *wk.DeviceModel != "Beelink SER5 MAX" {
		t.Errorf("DeviceModel = %v, want the annotation to win over DMI", fmtS(wk.DeviceModel))
	}
	if wk.DeviceClass == nil || *wk.DeviceClass != "mini-pc" {
		t.Errorf("DeviceClass = %v, want the annotation to win over DMI", fmtS(wk.DeviceClass))
	}
	// An overridden model supersedes the detected vendor: "Lenovo · Beelink
	// SER5 MAX" would be a contradiction, not a correction.
	if wk.DeviceVendor != nil {
		t.Errorf("DeviceVendor = %v, want nil once the model is overridden", fmtS(wk.DeviceVendor))
	}
	// The node name itself never changes — it is what kubectl answers to.
	if wk.Name != "wk" {
		t.Errorf("Name = %q, want the unchanged node name", wk.Name)
	}
}

// An annotated node with no agent at all must still identify itself.
func TestAnnotationsWorkWithoutAnAgent(t *testing.T) {
	raw := baseRaw()
	raw.HW = map[string]hw.Snapshot{}
	raw.Nodes[1].Annotations = map[string]string{"k3s-dash/model": "Raspberry Pi 5", "k3s-dash/type": "sbc"}
	wk1 := byName(Assemble(raw, ring.NewSet(10), 15*time.Second).Nodes)["wk1"]

	if wk1.DeviceModel == nil || *wk1.DeviceModel != "Raspberry Pi 5" {
		t.Errorf("DeviceModel = %v, want the annotation with no agent present", fmtS(wk1.DeviceModel))
	}
	if wk1.DeviceClass == nil || *wk1.DeviceClass != "sbc" {
		t.Errorf("DeviceClass = %v, want the annotation with no agent present", fmtS(wk1.DeviceClass))
	}
}

// A blank annotation is a typo, not an instruction to erase what was
// detected.
func TestBlankAnnotationsAreIgnored(t *testing.T) {
	raw := baseRaw()
	raw.Nodes[0].Annotations = map[string]string{"k3s-dash/model": "   ", "k3s-dash/name": ""}
	raw.HW["wk"] = hw.Snapshot{Node: "wk", Device: &hw.Device{Model: strp("ThinkPad L520")}}
	wk := byName(Assemble(raw, ring.NewSet(10), 15*time.Second).Nodes)["wk"]

	if wk.DeviceModel == nil || *wk.DeviceModel != "ThinkPad L520" {
		t.Errorf("DeviceModel = %v, want the detected model to survive a blank annotation", fmtS(wk.DeviceModel))
	}
	if wk.DisplayName != nil {
		t.Errorf("DisplayName = %v, want nil for an empty annotation", fmtS(wk.DisplayName))
	}
}

// The node's age in the cluster, which is not the same as the OS uptime
// beside it: a rebooted laptop is minutes old by uptime and months old here.
func TestAssembleCarriesTheJoinDate(t *testing.T) {
	raw := baseRaw()
	joined := time.Date(2026, 6, 22, 16, 20, 0, 0, time.UTC)
	raw.Nodes[0].CreatedAt = joined
	wk := byName(Assemble(raw, ring.NewSet(10), 15*time.Second).Nodes)["wk"]

	if !wk.JoinedAt.Equal(joined) {
		t.Errorf("JoinedAt = %v, want %v", wk.JoinedAt, joined)
	}
}

// Fleet CPU and memory are capacity-weighted. A mean of the per-node
// percentages would let a busy 4-core board outvote an idle 16-core one,
// which is exactly backwards.
func TestFleetPercentagesAreCapacityWeighted(t *testing.T) {
	raw := baseRaw()
	// wk: 2 of 8 cores, 8e9 of 16e9 bytes. wk1: 1 of 4 cores, 2e9 of 8e9.
	// Weighted CPU is 3/12 = 25%; the unweighted mean would also be 25%,
	// so make them disagree.
	raw.Usage["wk1"] = kube.Usage{CPUCores: 4, MemoryBytes: 8e9}
	// Now: cores 6 of 12 = 50% weighted, but the mean of 25% and 100% is
	// 62.5% — a number no node is anywhere near.
	fleet := Assemble(raw, ring.NewSet(10), 15*time.Second).Fleet

	if !nearly(fleet.CPUPercent, 50) {
		t.Errorf("Fleet.CPUPercent = %v, want 50 (6 of 12 cores), not the 62.5%% mean", fmtF(fleet.CPUPercent))
	}
	if !nearly(fleet.MemPercent, 200/3.0) {
		t.Errorf("Fleet.MemPercent = %v, want 16e9 of 24e9", fmtF(fleet.MemPercent))
	}
	if fleet.CPUCores != 12 {
		t.Errorf("Fleet.CPUCores = %v, want 12", fleet.CPUCores)
	}
	if fleet.MemTotalBytes != 24e9 {
		t.Errorf("Fleet.MemTotalBytes = %v, want 24e9", fleet.MemTotalBytes)
	}
}

// Only the nodes that actually reported may contribute to the denominator.
// Counting a silent node's capacity as "0% used" would drag the fleet
// number down and hide a real problem.
func TestFleetIgnoresNodesThatDidNotReport(t *testing.T) {
	raw := baseRaw()
	delete(raw.Usage, "wk1")
	fleet := Assemble(raw, ring.NewSet(10), 15*time.Second).Fleet

	if !nearly(fleet.CPUPercent, 25) {
		t.Errorf("Fleet.CPUPercent = %v, want 25 — wk1 is silent, not idle", fmtF(fleet.CPUPercent))
	}
	// Capacity totals are inventory, not measurement, so they still count
	// every node the API server listed.
	if fleet.CPUCores != 12 {
		t.Errorf("Fleet.CPUCores = %v, want 12 — capacity is known even when usage is not", fleet.CPUCores)
	}
}

// With nothing reporting at all there is no fleet percentage to state, and
// nil is how this program says "not known".
func TestFleetPercentagesAreNilWithNoReporters(t *testing.T) {
	raw := baseRaw()
	raw.Usage = map[string]kube.Usage{}
	raw.FS = map[string]kube.Filesystem{}
	raw.HW = map[string]hw.Snapshot{} // temperature comes from the agent, not metrics-server
	fleet := Assemble(raw, ring.NewSet(10), 15*time.Second).Fleet

	if fleet.CPUPercent != nil || fleet.MemPercent != nil || fleet.DiskPercent != nil {
		t.Errorf("Fleet percentages = %v/%v/%v, want all nil",
			fmtF(fleet.CPUPercent), fmtF(fleet.MemPercent), fmtF(fleet.DiskPercent))
	}
	if fleet.HottestC != nil || fleet.HottestNode != nil {
		t.Errorf("Fleet hottest = %v/%v, want nil with no temperatures", fmtF(fleet.HottestC), fmtS(fleet.HottestNode))
	}
}

func TestFleetCounts(t *testing.T) {
	raw := baseRaw()
	raw.Nodes[1].Ready = false
	hot := 71.5
	pct := 40
	raw.HW["wk1"] = hw.Snapshot{Node: "wk1", TempC: &hot,
		Battery: &hw.Battery{Percent: &pct, Status: strp("Discharging"), ACOnline: boolp(false)}}
	fleet := Assemble(raw, ring.NewSet(10), 15*time.Second).Fleet

	if fleet.Devices != 2 {
		t.Errorf("Fleet.Devices = %d, want 2", fleet.Devices)
	}
	if fleet.Ready != 1 {
		t.Errorf("Fleet.Ready = %d, want 1", fleet.Ready)
	}
	// wk is Discharging in baseRaw and wk1 is Discharging here.
	if fleet.OnBattery != 2 {
		t.Errorf("Fleet.OnBattery = %d, want 2", fleet.OnBattery)
	}
	if fleet.Pods != 3 {
		t.Errorf("Fleet.Pods = %d, want 3", fleet.Pods)
	}
	if fleet.WorkloadsDegraded != 1 {
		t.Errorf("Fleet.WorkloadsDegraded = %d, want 1 (nordpil is 0/1)", fleet.WorkloadsDegraded)
	}
	if fleet.WorkloadsTotal != 2 {
		t.Errorf("Fleet.WorkloadsTotal = %d, want 2", fleet.WorkloadsTotal)
	}
	if fleet.HottestC == nil || *fleet.HottestC != 71.5 {
		t.Errorf("Fleet.HottestC = %v, want 71.5", fmtF(fleet.HottestC))
	}
	if fleet.HottestNode == nil || *fleet.HottestNode != "wk1" {
		t.Errorf("Fleet.HottestNode = %v, want wk1", fmtS(fleet.HottestNode))
	}
}

// "On battery" means discharging, not "has a battery". A laptop plugged in
// at 100% is not a device anyone needs to be told about.
func TestOnBatteryCountsOnlyDischargingNodes(t *testing.T) {
	raw := baseRaw()
	full := 100
	raw.HW["wk"] = hw.Snapshot{Node: "wk",
		Battery: &hw.Battery{Percent: &full, Status: strp("Full"), ACOnline: boolp(true)}}
	if got := Assemble(raw, ring.NewSet(10), 15*time.Second).Fleet.OnBattery; got != 0 {
		t.Errorf("Fleet.OnBattery = %d, want 0 for a node on AC", got)
	}
}

// The fleet strip draws its own sparklines, so the aggregate needs a
// history of its own rather than a sum recomputed from the node series.
func TestFleetHasItsOwnSeries(t *testing.T) {
	buffers := ring.NewSet(10)
	raw := baseRaw()
	for i := 0; i < 3; i++ {
		raw.At = raw.At.Add(time.Duration(i) * time.Minute)
		Assemble(raw, buffers, 15*time.Second)
	}
	fleet := Assemble(raw, buffers, 15*time.Second).Fleet

	for _, metric := range FleetSeriesMetrics {
		series, ok := fleet.Series[metric]
		if !ok {
			t.Errorf("Fleet.Series is missing %q", metric)
			continue
		}
		if len(series) != 4 {
			t.Errorf("Fleet.Series[%q] has %d points, want 4", metric, len(series))
		}
	}
	// The reserved key cannot collide with a node: a Kubernetes node name is
	// a DNS subdomain and may not contain an underscore.
	if !strings.Contains(fleetKey, "_") {
		t.Errorf("fleetKey = %q, want a name no DNS-1123 node name can take", fleetKey)
	}
}

// Sorting stays by name here. Trouble-first ordering needs the severity
// thresholds, and those live in the page — duplicating 75/90 and 80/92 into
// Go is how the two drift apart.
func TestNodesStaySortedByName(t *testing.T) {
	raw := baseRaw()
	raw.Nodes = []kube.Node{{Name: "wk2"}, {Name: "wk"}, {Name: "wk1"}}
	got := Assemble(raw, ring.NewSet(10), 15*time.Second).Nodes

	for i, want := range []string{"wk", "wk1", "wk2"} {
		if got[i].Name != want {
			t.Errorf("Nodes[%d] = %q, want %q", i, got[i].Name, want)
		}
	}
}
