package hw

import (
	"path/filepath"
	"testing"
)

// Every fixture here is a real vendor's real DMI layout. They disagree with
// each other in ways no single field can resolve, which is the whole reason
// ReadDevice exists rather than a one-line read of product_name.
func TestReadDevice(t *testing.T) {
	tests := []struct {
		fixture string
		wantNil bool
		vendor  *string
		model   *string
		chassis *string
		why     string
	}{
		{
			fixture: "charging",
			vendor:  strPtr("Lenovo"), model: strPtr("ThinkPad L520"), chassis: strPtr("laptop"),
			why: "Lenovo puts a machine-type code in product_name and the name people use in product_version",
		},
		{
			fixture: "discharging",
			vendor:  strPtr("ASUSTeK"), model: strPtr("ROG Zephyrus G14 GA401QM"), chassis: strPtr("laptop"),
			why: "product_version is a firmware revision here, so product_name has to win",
		},
		{
			fixture: "nobattery",
			vendor:  nil, model: strPtr("Raspberry Pi 4 Model B Rev 1.4"), chassis: strPtr("sbc"),
			why: "an SBC has no DMI at all, and its device-tree model already carries the vendor",
		},
		{
			fixture: "minipc",
			vendor:  strPtr("AZW"), model: strPtr("SER5"), chassis: strPtr("mini-pc"),
			why: "nothing here reads as a product name, so the first non-placeholder is still better than nil",
		},
		{
			fixture: "vm",
			vendor:  strPtr("QEMU"), model: strPtr("Standard PC (Q35 + ICH9, 2009)"), chassis: strPtr("vm"),
			why: "chassis_type 1 is Other; the hypervisor is only identifiable from the vendor string",
		},
		{
			fixture: "malformed",
			vendor:  nil, model: nil, chassis: strPtr("desktop"),
			why: "placeholder names are worse than no name, but the chassis number is still real",
		},
		{
			fixture: "empty",
			wantNil: true,
			why:     "nothing mounted",
		},
	}
	for _, tc := range tests {
		t.Run(tc.fixture, func(t *testing.T) {
			got := ReadDevice(filepath.Join("testdata", tc.fixture))
			if tc.wantNil {
				if got != nil {
					t.Fatalf("ReadDevice = %+v, want nil", *got)
				}
				return
			}
			if got == nil {
				t.Fatal("ReadDevice = nil, want a value")
			}
			eqS(t, "Vendor", got.Vendor, tc.vendor)
			eqS(t, "Model", got.Model, tc.model)
			eqS(t, "Chassis", got.Chassis, tc.chassis)
			if t.Failed() {
				t.Logf("expectation: %s", tc.why)
			}
		})
	}
}

// The SMBIOS chassis byte is the only machine-readable answer to "what kind
// of computer is this", so the mapping is worth pinning down directly.
func TestChassisClass(t *testing.T) {
	tests := []struct {
		code string
		want string
	}{
		{"8", "laptop"}, {"9", "laptop"}, {"10", "laptop"}, {"14", "laptop"}, {"31", "laptop"},
		{"3", "desktop"}, {"4", "desktop"}, {"6", "desktop"}, {"7", "desktop"}, {"15", "desktop"},
		{"13", "all-in-one"},
		{"11", "tablet"}, {"30", "tablet"}, {"32", "tablet"},
		{"17", "server"}, {"23", "server"}, {"25", "server"}, {"28", "server"},
		{"35", "mini-pc"}, {"36", "stick-pc"},
		{"34", "embedded"},
		{"1", ""},  // Other: says nothing
		{"2", ""},  // Unknown: says nothing
		{"99", ""}, // not a chassis type at all
		{"", ""},
		{"laptop", ""}, // the file holds a number, never a word
	}
	for _, tc := range tests {
		t.Run(tc.code, func(t *testing.T) {
			if got := chassisClass(tc.code); got != tc.want {
				t.Errorf("chassisClass(%q) = %q, want %q", tc.code, got, tc.want)
			}
		})
	}
}

// Vendors ship a handful of strings that mean "the factory never filled
// this in". Showing one on a card is worse than showing nothing, because it
// looks like a real answer.
func TestPlaceholderNamesAreRejected(t *testing.T) {
	for _, s := range []string{
		"Default string", "default string", "To Be Filled By O.E.M.",
		"To be filled by O.E.M.", "System Product Name", "System manufacturer",
		"Not Specified", "Not Applicable", "None", "N/A", "Unknown",
		"OEM", "INVALID", "System Version", "  ", "x",
	} {
		if !isPlaceholder(s) {
			t.Errorf("isPlaceholder(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"ThinkPad L520", "SER5", "NUC11TNHi7", "Latitude 7490"} {
		if isPlaceholder(s) {
			t.Errorf("isPlaceholder(%q) = true, want false", s)
		}
	}
}

// Corporate suffixes and shouty casing are noise. Short initialisms are not:
// "AZW" and "HP" are how those vendors are actually written.
func TestTidyVendor(t *testing.T) {
	tests := []struct{ in, want string }{
		{"LENOVO", "Lenovo"},
		{"Dell Inc.", "Dell"},
		{"ASUSTeK COMPUTER INC.", "ASUSTeK"},
		{"Hewlett-Packard", "Hewlett-Packard"},
		{"HP", "HP"},
		{"AZW", "AZW"},
		{"ASUS", "ASUS"},
		{"GIGABYTE", "Gigabyte"},
		{"innotek GmbH", "innotek"},
		{"Micro-Star International Co., Ltd.", "Micro-Star International"},
		{"Raspberry Pi Ltd", "Raspberry Pi"},
	}
	for _, tc := range tests {
		t.Run(tc.in, func(t *testing.T) {
			if got := tidyVendor(tc.in); got != tc.want {
				t.Errorf("tidyVendor(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// "HP · HP EliteDesk 800 G4" reads as a stutter. When the model already
// opens with the vendor, the vendor has nothing left to add.
func TestVendorIsDroppedWhenTheModelAlreadySaysIt(t *testing.T) {
	tests := []struct {
		vendor, model string
		wantVendor    *string
	}{
		{"HP", "HP EliteDesk 800 G4", nil},
		{"Raspberry Pi", "Raspberry Pi 5 Model B", nil},
		{"lenovo", "Lenovo IdeaCentre", nil},
		{"Lenovo", "ThinkPad L520", strPtr("Lenovo")},
		{"Dell", "Latitude 7490", strPtr("Dell")},
	}
	for _, tc := range tests {
		t.Run(tc.vendor+"/"+tc.model, func(t *testing.T) {
			eqS(t, "vendor", dropRedundantVendor(tc.vendor, tc.model), tc.wantVendor)
		})
	}
}

// Read must carry the device through, and a fixture with no DMI must not
// cost the readings that did work.
func TestReadIncludesTheDevice(t *testing.T) {
	got := Read(filepath.Join("testdata", "charging"), "wk")
	if got.Device == nil {
		t.Fatal("Device = nil, want the ThinkPad")
	}
	if got.Device.Model == nil || *got.Device.Model != "ThinkPad L520" {
		t.Errorf("Device.Model = %v, want %q", fmtS(got.Device.Model), "ThinkPad L520")
	}

	bare := Read(filepath.Join("testdata", "empty"), "wk9")
	if bare.Device != nil {
		t.Errorf("Device = %+v on an empty root, want nil", *bare.Device)
	}
}
