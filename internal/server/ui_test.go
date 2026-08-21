package server

import (
	"strings"
	"testing"
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
