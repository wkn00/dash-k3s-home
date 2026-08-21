package agent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestHandlerServesHardware(t *testing.T) {
	root := filepath.Join("..", "hw", "testdata", "discharging")
	srv := httptest.NewServer(Handler(root, "wk2"))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/hw")
	if err != nil {
		t.Fatalf("GET /hw: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /hw status = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want %q", got, "application/json")
	}

	var got struct {
		Node    string `json:"node"`
		TempC   *float64
		Battery *struct {
			Percent  *int  `json:"percent"`
			ACOnline *bool `json:"acOnline"`
		} `json:"battery"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Node != "wk2" {
		t.Errorf("node = %q, want %q", got.Node, "wk2")
	}
	if got.Battery == nil || got.Battery.Percent == nil || *got.Battery.Percent != 38 {
		t.Errorf("battery.percent = %v, want 38", got.Battery)
	}
	if got.Battery.ACOnline == nil || *got.Battery.ACOnline {
		t.Error("battery.acOnline = true, want false for the discharging fixture")
	}
}

// A node with nothing readable must still answer 200 — the server treats
// a non-200 as a degraded agent and hides that node's hardware entirely.
func TestHandlerReturns200WhenNothingIsReadable(t *testing.T) {
	srv := httptest.NewServer(Handler(filepath.Join("..", "hw", "testdata", "empty"), "wk9"))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/hw")
	if err != nil {
		t.Fatalf("GET /hw: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 even with no readable hardware", resp.StatusCode)
	}
}

func TestHealthz(t *testing.T) {
	srv := httptest.NewServer(Handler(filepath.Join("..", "hw", "testdata", "empty"), "wk9"))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}
}
