package hw

import (
	"path/filepath"
	"testing"
)

func fPtr(v float64) *float64 { return &v }
func intPtr(v int) *int       { return &v }
func strPtr(v string) *string { return &v }
func boolPtr(v bool) *bool    { return &v }

func eqF(t *testing.T, name string, got, want *float64) {
	t.Helper()
	switch {
	case got == nil && want == nil:
	case got == nil || want == nil:
		t.Errorf("%s = %v, want %v", name, fmtF(got), fmtF(want))
	case *got != *want:
		t.Errorf("%s = %v, want %v", name, *got, *want)
	}
}

func fmtF(p *float64) any {
	if p == nil {
		return "nil"
	}
	return *p
}

func TestReadTempC(t *testing.T) {
	tests := []struct {
		fixture string
		want    *float64
		why     string
	}{
		{"charging", fPtr(41), "x86_pkg_temp wins over acpitz even though acpitz is hotter"},
		{"discharging", fPtr(67.5), "only acpitz present, so it is used"},
		{"nobattery", nil, "no thermal zones at all"},
		{"malformed", nil, "a zone reading 0 is asleep, not freezing"},
		{"empty", nil, "nothing mounted"},
	}
	for _, tc := range tests {
		t.Run(tc.fixture, func(t *testing.T) {
			got := ReadTempC(filepath.Join("testdata", tc.fixture))
			eqF(t, "ReadTempC", got, tc.want)
			if t.Failed() {
				t.Logf("expectation: %s", tc.why)
			}
		})
	}
}

func TestReadBattery(t *testing.T) {
	tests := []struct {
		fixture  string
		wantNil  bool
		percent  *int
		status   *string
		acOnline *bool
	}{
		{fixture: "charging", percent: intPtr(100), status: strPtr("Full"), acOnline: boolPtr(true)},
		{fixture: "discharging", percent: intPtr(38), status: strPtr("Discharging"), acOnline: boolPtr(false)},
		{fixture: "nobattery", percent: nil, status: nil, acOnline: boolPtr(true)},
		{fixture: "malformed", percent: nil, status: nil, acOnline: nil, wantNil: true},
		{fixture: "empty", wantNil: true},
	}
	for _, tc := range tests {
		t.Run(tc.fixture, func(t *testing.T) {
			got := ReadBattery(filepath.Join("testdata", tc.fixture))
			if tc.wantNil {
				if got != nil {
					t.Fatalf("ReadBattery = %+v, want nil", *got)
				}
				return
			}
			if got == nil {
				t.Fatal("ReadBattery = nil, want a value")
			}
			if (got.Percent == nil) != (tc.percent == nil) || (got.Percent != nil && *got.Percent != *tc.percent) {
				t.Errorf("Percent = %v, want %v", got.Percent, tc.percent)
			}
			if (got.Status == nil) != (tc.status == nil) || (got.Status != nil && *got.Status != *tc.status) {
				t.Errorf("Status = %v, want %v", got.Status, tc.status)
			}
			if (got.ACOnline == nil) != (tc.acOnline == nil) || (got.ACOnline != nil && *got.ACOnline != *tc.acOnline) {
				t.Errorf("ACOnline = %v, want %v", got.ACOnline, tc.acOnline)
			}
		})
	}
}

func TestReadLoadAndUptime(t *testing.T) {
	tests := []struct {
		fixture string
		l1      *float64
		uptime  *float64
	}{
		{"charging", fPtr(0.96), fPtr(3005059.65)},
		{"discharging", fPtr(2.10), fPtr(86400)},
		{"malformed", nil, nil},
		{"empty", nil, nil},
	}
	for _, tc := range tests {
		t.Run(tc.fixture, func(t *testing.T) {
			root := filepath.Join("testdata", tc.fixture)
			got1, _, _ := ReadLoad(root)
			eqF(t, "ReadLoad l1", got1, tc.l1)
			eqF(t, "ReadUptime", ReadUptime(root), tc.uptime)
		})
	}
}

// A missing sensor must never take the whole reading down with it.
func TestReadNeverPanicsAndKeepsGoodFields(t *testing.T) {
	for _, fixture := range []string{"charging", "discharging", "nobattery", "malformed", "empty"} {
		t.Run(fixture, func(t *testing.T) {
			got := Read(filepath.Join("testdata", fixture), "wk1")
			if got.Node != "wk1" {
				t.Errorf("Node = %q, want %q", got.Node, "wk1")
			}
		})
	}
	t.Run("partial fixture still reports load", func(t *testing.T) {
		got := Read(filepath.Join("testdata", "nobattery"), "wk2")
		if got.Load1 == nil {
			t.Error("Load1 = nil, want a value: a missing battery must not suppress load")
		}
		if got.Battery != nil && got.Battery.Percent != nil {
			t.Error("Battery.Percent is set, want nil on a node with no battery")
		}
	})
}
