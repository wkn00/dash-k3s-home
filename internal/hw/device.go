package hw

import (
	"path/filepath"
	"strings"
	"unicode"
)

// Device is what the machine *is*, as opposed to what it is doing: the
// answer to "which box is wk3?" when there are ten of them and they are
// not all the same kind of computer.
//
// Every field is nullable and independent. A generic mini-PC whose vendor
// never filled in the name fields still reports a chassis, and a Raspberry
// Pi with no DMI at all still reports a model.
type Device struct {
	Vendor  *string `json:"vendor"`
	Model   *string `json:"model"`
	Chassis *string `json:"chassis"`
}

// dmiNameFields are the candidates for the model, in the order they are
// consulted when none of them reads as a product name. Vendors disagree
// about which one holds the name a human would use — Lenovo puts a machine
// type ("5017B13") in product_name and "ThinkPad L520" in product_version,
// while Dell and HP do the opposite — so pickModel scores them rather than
// trusting a fixed order.
var dmiNameFields = []string{"product_name", "product_version", "product_family", "board_name"}

// placeholders are the strings firmware ships when the factory left a field
// blank. Rendering one is worse than rendering nothing, because "Default
// string" on a card looks like a real answer to someone scanning quickly.
var placeholders = map[string]bool{
	"":                       true,
	"default string":         true,
	"to be filled by o.e.m.": true,
	"to be filled by oem":    true,
	"system product name":    true,
	"system manufacturer":    true,
	"system version":         true,
	"system name":            true,
	"not specified":          true,
	"not applicable":         true,
	"none":                   true,
	"n/a":                    true,
	"na":                     true,
	"unknown":                true,
	"oem":                    true,
	"invalid":                true,
	"chassis manufacture":    true,
	"type1productconfigid":   true,
	"$(default string)":      true,
}

func isPlaceholder(s string) bool {
	s = strings.TrimSpace(s)
	// A single character is never a product name; it is a revision digit
	// that happened to land in a name field.
	if len(s) < 2 {
		return true
	}
	return placeholders[strings.ToLower(s)]
}

// hypervisors are matched against the vendor and model strings. A VM has no
// honest chassis — QEMU reports type 1 ("Other") — so the only way to say
// "this is not a physical machine" is to recognise the hypervisor.
var hypervisors = []string{
	"qemu", "kvm", "vmware", "virtualbox", "innotek", "xen", "bochs",
	"parallels", "virtual machine", "hvm domu", "google compute engine",
	"amazon ec2", "alibaba cloud", "openstack",
}

// chassisClass maps the SMBIOS chassis byte to a word. Types that carry no
// information (1 "Other", 2 "Unknown") map to "" rather than to a guess:
// the card says nothing instead of saying something wrong.
func chassisClass(code string) string {
	switch strings.TrimSpace(code) {
	case "8", "9", "10", "14", "31": // Portable, Laptop, Notebook, Sub Notebook, Convertible
		return "laptop"
	case "3", "4", "5", "6", "7", "15", "16", "24": // Desktop through Sealed-case PC
		return "desktop"
	case "13":
		return "all-in-one"
	case "11", "30", "32": // Hand Held, Tablet, Detachable
		return "tablet"
	case "17", "22", "23", "25", "28", "29": // Server, RAID, Rack Mount, Multi-system, Blade
		return "server"
	case "33", "34": // IoT Gateway, Embedded PC
		return "embedded"
	case "35":
		return "mini-pc"
	case "36":
		return "stick-pc"
	}
	return ""
}

// vendorNoise are the tokens that identify a company as a company rather
// than identifying the company. Stripping them is what turns "ASUSTeK
// COMPUTER INC." into a word that fits on a card.
var vendorNoise = map[string]bool{
	"inc": true, "inc.": true, "incorporated": true,
	"corp": true, "corp.": true, "corporation": true,
	"co": true, "co.": true, "company": true,
	"ltd": true, "ltd.": true, "limited": true,
	"llc": true, "gmbh": true, "ag": true, "sa": true, "bv": true,
	"computer": true, "computers": true, "technology": true,
	"technologies": true, "systems": true, "electronics": true,
	"international": false, // kept: "Micro-Star International" is the name
}

// tidyVendor strips the corporate suffixes and un-shouts all-caps names.
// The length guard is the point: "LENOVO" is shouting, but "HP", "AZW",
// "MSI" and "ASUS" are how those vendors are actually written, and title
// casing them would produce "Hp" and "Azw".
func tidyVendor(vendor string) string {
	kept := make([]string, 0, 4)
	for _, field := range strings.Fields(vendor) {
		trimmed := strings.TrimSuffix(field, ",")
		if noise, known := vendorNoise[strings.ToLower(trimmed)]; known && noise {
			continue
		}
		kept = append(kept, trimmed)
	}
	for i, field := range kept {
		if len(field) > 4 && field == strings.ToUpper(field) && hasLetter(field) {
			kept[i] = strings.ToUpper(field[:1]) + strings.ToLower(field[1:])
		}
	}
	return strings.TrimSpace(strings.Join(kept, " "))
}

func hasLetter(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) {
			return true
		}
	}
	return false
}

// dropRedundantVendor returns nil when the model already opens with the
// vendor's name. "HP · HP EliteDesk 800 G4" reads as a stutter, and on a
// card the space it wastes is space a real fact could have used.
func dropRedundantVendor(vendor, model string) *string {
	if vendor == "" {
		return nil
	}
	if strings.HasPrefix(strings.ToLower(model), strings.ToLower(vendor)) {
		return nil
	}
	return &vendor
}

// looksLikeAProductName distinguishes "ThinkPad L520" from "5017B13" and
// "M15883-306". A name a person would say out loud has both a space and a
// lowercase letter; a part number has neither, or only one of the two.
func looksLikeAProductName(s string) bool {
	return strings.ContainsRune(s, ' ') && strings.IndexFunc(s, unicode.IsLower) >= 0
}

// pickModel prefers the first candidate that reads as a product name and
// falls back to the first that is merely present. The fallback matters:
// "SER5" is not a name by any test, but it is what is printed on the box,
// and it beats an empty line on the card.
func pickModel(candidates []string) string {
	var first string
	for _, candidate := range candidates {
		if isPlaceholder(candidate) {
			continue
		}
		if looksLikeAProductName(candidate) {
			return candidate
		}
		if first == "" {
			first = candidate
		}
	}
	return first
}

// ReadDevice identifies the machine. It tries the device tree first, since
// a board that has one (every Raspberry Pi and most ARM SBCs) has no DMI at
// all, then falls back to SMBIOS.
//
// It reads only the world-readable DMI fields. The serial numbers and
// product_uuid beside them are root-only, and this page is reachable
// through a public tunnel — a dashboard has no business publishing the
// serial number of the laptop it runs on.
func ReadDevice(root string) *Device {
	if dev := readDeviceTree(root); dev != nil {
		return dev
	}
	return readDMI(root)
}

// readDeviceTree reads /sys/firmware/devicetree/base/model, whose contents
// are NUL-terminated because the kernel exposes the raw property bytes.
// Trimming that is not optional: the string reaches JSON otherwise.
func readDeviceTree(root string) *Device {
	text, ok := readTrimmed(filepath.Join(root, "sys", "firmware", "devicetree", "base", "model"))
	if !ok {
		return nil
	}
	model := strings.TrimSpace(strings.TrimRight(text, "\x00"))
	if isPlaceholder(model) {
		return nil
	}
	dev := &Device{Model: &model}

	// The device-tree model is a whole sentence — "Raspberry Pi 5 Model B
	// Rev 1.0" — with the vendor already at the front of it, so there is no
	// separate vendor field to report. The class is not in the tree either,
	// but a board that describes itself this way is an SBC by construction.
	class := "sbc"
	dev.Chassis = &class
	return dev
}

func readDMI(root string) *Device {
	dir := filepath.Join(root, "sys", "class", "dmi", "id")
	field := func(name string) string {
		text, ok := readTrimmed(filepath.Join(dir, name))
		if !ok {
			return ""
		}
		return text
	}

	candidates := make([]string, 0, len(dmiNameFields))
	for _, name := range dmiNameFields {
		candidates = append(candidates, field(name))
	}
	model := pickModel(candidates)

	vendor := field("sys_vendor")
	if isPlaceholder(vendor) {
		vendor = field("board_vendor")
	}
	if isPlaceholder(vendor) {
		vendor = ""
	}
	vendor = tidyVendor(vendor)

	class := chassisClass(field("chassis_type"))
	if isVirtual(vendor, model) {
		class = "vm"
	}

	if vendor == "" && model == "" && class == "" {
		return nil
	}
	dev := &Device{Vendor: dropRedundantVendor(vendor, model)}
	if model != "" {
		dev.Model = &model
	}
	if class != "" {
		dev.Chassis = &class
	}
	return dev
}

func isVirtual(vendor, model string) bool {
	haystack := strings.ToLower(vendor + " " + model)
	for _, marker := range hypervisors {
		if strings.Contains(haystack, marker) {
			return true
		}
	}
	return false
}
