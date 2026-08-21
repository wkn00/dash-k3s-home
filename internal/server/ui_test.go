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
		`id="workloads"`,
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
