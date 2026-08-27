package server

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wkn00/k3s-dash/internal/state"
)

// The dependency-free contract for the page. These are the mistakes worth
// catching automatically; everything else about the page is judged by
// looking at it.
func TestPageIsSelfContained(t *testing.T) {
	page := string(uiHTML)

	// The SVG namespace URI is a constant, not a fetch, so match on the
	// constructs that actually pull bytes over the network.
	for _, forbidden := range []string{"<script src", "<link rel=\"stylesheet\"", "cdn.", "//unpkg", "integrity=", "@import"} {
		if strings.Contains(page, forbidden) {
			t.Errorf("page references %q — it must load no external resources", forbidden)
		}
	}
	for _, required := range []string{
		"/api/state",
		"prefers-color-scheme",
		`id="nodes"`,
		`id="events"`,
		`id="degraded"`,
	} {
		if !strings.Contains(page, required) {
			t.Errorf("page is missing %q", required)
		}
	}
	if strings.Contains(page, "innerHTML =") && !strings.Contains(page, "textContent") {
		t.Error("page builds DOM with innerHTML only; event messages come from the cluster and must go through textContent")
	}
}

// Severity must never be carried by colour alone: the fixed status palette
// puts warning below 3:1 on the light surface by design, and the agreed
// mitigation is a word alongside the colour.
func TestSeverityShipsAWordNotJustAColour(t *testing.T) {
	page := string(uiHTML)
	for _, word := range []string{"NotReady", "degraded", "on battery", "overheating", "almost full"} {
		if !strings.Contains(page, word) {
			t.Errorf("page is missing the severity wording %q", word)
		}
	}
}

// Both dark-mode scopes must be present: the media query covers the OS
// setting, the data-theme scope covers an explicit toggle.
func TestDarkModeIsSelectedForBothScopes(t *testing.T) {
	page := string(uiHTML)
	for _, scope := range []string{`:root:where(:not([data-theme="light"]))`, `:root[data-theme="dark"]`} {
		if !strings.Contains(page, scope) {
			t.Errorf("page is missing the dark-mode scope %s", scope)
		}
	}
}

// The spec line names the hardware behind a node — model, cores, RAM,
// disk, OS. The key names come from state.Node's own JSON tags rather
// than from string literals here, so renaming a tag in Go and forgetting
// the page fails this test instead of silently rendering "undefined".
func TestPageRendersTheHardwareSpec(t *testing.T) {
	blob, err := json.Marshal(state.Node{})
	if err != nil {
		t.Fatalf("marshal state.Node: %v", err)
	}
	var keys map[string]any
	if err := json.Unmarshal(blob, &keys); err != nil {
		t.Fatalf("unmarshal state.Node: %v", err)
	}

	page := string(uiHTML)
	for _, field := range []string{
		"cpuModel", "cpuCores", "memTotalBytes", "diskTotalBytes",
		"osImage", "kernelVersion", "architecture",
	} {
		if _, ok := keys[field]; !ok {
			t.Errorf("state.Node no longer marshals %q — the page cannot render it", field)
			continue
		}
		if !strings.Contains(page, "."+field) {
			t.Errorf("page never reads n.%s, so the spec line is missing it", field)
		}
	}

	// Cores and bytes are unitless numbers in the payload; the card has to
	// say which is which.
	for _, unit := range []string{"cores", "RAM", "disk"} {
		if !strings.Contains(page, unit) {
			t.Errorf("page is missing the spec unit wording %q", unit)
		}
	}
}

// The identity block is the answer to "which box is this?" — the part of
// the card a person reads before any number on it. As with the spec line,
// the key names come from state.Node's own JSON tags, so renaming a tag in
// Go and forgetting the page fails here rather than rendering "undefined".
func TestPageRendersTheDeviceIdentity(t *testing.T) {
	keys := marshalledKeys(t, state.Node{})
	page := string(uiHTML)

	for _, field := range []string{
		"displayName", "deviceVendor", "deviceModel", "deviceClass",
		"internalIP", "joinedAt",
	} {
		if _, ok := keys[field]; !ok {
			t.Errorf("state.Node no longer marshals %q — the page cannot render it", field)
			continue
		}
		if !strings.Contains(page, "."+field) {
			t.Errorf("page never reads n.%s, so the device is less identified than it could be", field)
		}
	}
}

// Every chassis class the agent can report needs a glyph. A class with no
// entry would silently fall back to the generic box, which is the one
// outcome that looks like the feature works when it does not.
func TestEveryChassisClassHasAGlyph(t *testing.T) {
	page := string(uiHTML)
	for _, class := range []string{
		"laptop", "desktop", "mini-pc", "all-in-one", "server",
		"sbc", "embedded", "tablet", "stick-pc", "vm",
	} {
		if !strings.Contains(page, class) {
			t.Errorf("page has no glyph or wording for chassis class %q", class)
		}
	}
	if !strings.Contains(page, "unidentified device") {
		t.Error("page is missing the wording for a device with no usable DMI")
	}
	// The hint has to name the escape hatch, or an unidentifiable device is
	// a dead end for whoever is looking at it.
	if !strings.Contains(page, "k3s-dash/model") {
		t.Error("page never mentions the annotation that names an unidentified device")
	}
}

// The fleet strip is what makes ten devices readable, so the page has to
// actually consume it.
func TestPageRendersTheFleetSummary(t *testing.T) {
	keys := marshalledKeys(t, state.Fleet{})
	page := string(uiHTML)

	if !strings.Contains(page, `id="fleet"`) {
		t.Error("page is missing the fleet strip")
	}
	for _, field := range []string{
		"devices", "ready", "onBattery", "pods", "workloadsDegraded",
		"cpuCores", "memTotalBytes", "cpuPercent", "memPercent",
		"diskPercent", "hottestNode", "hottestC", "workloadsTotal",
	} {
		if _, ok := keys[field]; !ok {
			t.Errorf("state.Fleet no longer marshals %q — the page cannot render it", field)
			continue
		}
		if !strings.Contains(page, "."+field) {
			t.Errorf("page never reads fleet.%s", field)
		}
	}
}

// Ten cards do not fit on a screen at the height three cards used, so the
// page ships two densities and remembers which one was chosen.
func TestPageOffersADensityToggle(t *testing.T) {
	page := string(uiHTML)
	for _, required := range []string{`id="density-compact"`, `id="density-detailed"`, "aria-pressed", "localStorage"} {
		if !strings.Contains(page, required) {
			t.Errorf("page is missing %q from the density toggle", required)
		}
	}
	// Storage throws outright in a private window, and a dashboard that
	// fails to render because it could not remember a layout preference
	// would be a poor trade.
	if !strings.Contains(page, "try { localStorage") {
		t.Error("page reads localStorage without a guard; it throws in a private window")
	}
}

// The placement answer — which device a pod is actually on — now lives in
// each device card's drill-down rather than a standalone table, so it has
// to read every field state.Pod marshals, the same way the node card is
// checked against state.Node.
func TestPageRendersPodPlacement(t *testing.T) {
	keys := marshalledKeys(t, state.Pod{})
	page := string(uiHTML)

	for _, required := range []string{"drill-toggle", "drill-list", "drill-scroll"} {
		if !strings.Contains(page, required) {
			t.Errorf("page is missing %q, the device drill-down", required)
		}
	}
	for _, field := range []string{"namespace", "name", "node", "phase", "healthy", "restarts", "createdAt", "workload"} {
		if _, ok := keys[field]; !ok {
			t.Errorf("state.Pod no longer marshals %q — the page cannot render it", field)
			continue
		}
		if !strings.Contains(page, "."+field) {
			t.Errorf("page never reads p.%s, so the drill-down is missing it", field)
		}
	}
}

// Clicking a device is how you find out what's running on it — the whole
// point of this redesign — so the toggle has to actually be wired up, and
// the expand state has to survive the next poll's re-render rather than
// snapping shut on its own.
func TestDeviceCardsExpandToShowWorkloadsAndPods(t *testing.T) {
	page := string(uiHTML)
	for _, required := range []string{
		"expandedDevices", "aria-expanded", "addEventListener(\"click\"",
	} {
		if !strings.Contains(page, required) {
			t.Errorf("page is missing %q from the device drill-down toggle", required)
		}
	}
}

// marshalledKeys is the JSON object a value produces, so tests can assert
// against the tags Go actually emits rather than against string literals
// that drift.
func marshalledKeys(t *testing.T, v any) map[string]any {
	t.Helper()
	blob, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal %T: %v", v, err)
	}
	var keys map[string]any
	if err := json.Unmarshal(blob, &keys); err != nil {
		t.Fatalf("unmarshal %T: %v", v, err)
	}
	return keys
}
