// Package hw reads laptop hardware state from sysfs and procfs. Every
// reader degrades to nil rather than failing: a node with no battery, a
// thermal zone that is asleep, or a truncated file must still leave the
// remaining fields reportable.
package hw

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type Battery struct {
	Percent  *int    `json:"percent"`
	Status   *string `json:"status"`
	ACOnline *bool   `json:"acOnline"`
}

type Snapshot struct {
	Node          string   `json:"node"`
	UptimeSeconds *float64 `json:"uptimeSeconds"`
	Load1         *float64 `json:"load1"`
	Load5         *float64 `json:"load5"`
	Load15        *float64 `json:"load15"`
	TempC         *float64 `json:"tempC"`
	Battery       *Battery `json:"battery"`
}

// Read gathers everything the agent reports. root is the prefix the host
// filesystem is mounted under — "/host" in the DaemonSet, a testdata
// directory in tests.
func Read(root, node string) Snapshot {
	s := Snapshot{Node: node}
	s.Load1, s.Load5, s.Load15 = ReadLoad(root)
	s.UptimeSeconds = ReadUptime(root)
	s.TempC = ReadTempC(root)
	s.Battery = ReadBattery(root)
	return s
}

func readTrimmed(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	text := strings.TrimSpace(string(data))
	if text == "" {
		return "", false
	}
	return text, true
}

func readFloat(path string) *float64 {
	text, ok := readTrimmed(path)
	if !ok {
		return nil
	}
	v, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return nil
	}
	return &v
}

// ReadLoad parses /proc/loadavg. All three values are returned together
// or not at all — a partially parsed load average is more misleading than
// no load average.
func ReadLoad(root string) (l1, l5, l15 *float64) {
	text, ok := readTrimmed(filepath.Join(root, "proc", "loadavg"))
	if !ok {
		return nil, nil, nil
	}
	fields := strings.Fields(text)
	if len(fields) < 3 {
		return nil, nil, nil
	}
	out := make([]*float64, 3)
	for idx := 0; idx < 3; idx++ {
		v, err := strconv.ParseFloat(fields[idx], 64)
		if err != nil {
			return nil, nil, nil
		}
		out[idx] = &v
	}
	return out[0], out[1], out[2]
}

// ReadUptime parses the first field of /proc/uptime: seconds since boot.
func ReadUptime(root string) *float64 {
	text, ok := readTrimmed(filepath.Join(root, "proc", "uptime"))
	if !ok {
		return nil
	}
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return nil
	}
	v, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return nil
	}
	return &v
}

// ReadTempC prefers the CPU package sensor: on these laptops acpitz
// reports a chassis reading that barely moves, so trusting "the first
// zone" would show a flat 42C through a thermal event. Falls back to the
// hottest plausible zone, then to nil.
func ReadTempC(root string) *float64 {
	zones, _ := filepath.Glob(filepath.Join(root, "sys", "class", "thermal", "thermal_zone*"))
	sort.Strings(zones)
	preferred := map[string]bool{"x86_pkg_temp": true, "coretemp": true}
	var best *float64
	for _, zone := range zones {
		milli := readFloat(filepath.Join(zone, "temp"))
		if milli == nil {
			continue
		}
		celsius := *milli / 1000
		// A zone reports 0 when the sensor is asleep and absurd values
		// when it is confused; neither is a temperature.
		if celsius <= 0 || celsius > 150 {
			continue
		}
		if typ, ok := readTrimmed(filepath.Join(zone, "type")); ok && preferred[typ] {
			v := celsius
			return &v
		}
		if best == nil || celsius > *best {
			v := celsius
			best = &v
		}
	}
	return best
}

// ReadBattery walks /sys/class/power_supply keyed on each device's type
// file rather than its name: these laptops disagree about whether the
// battery is BAT0 or BAT1 and whether the mains is AC or ACAD.
func ReadBattery(root string) *Battery {
	devices, _ := filepath.Glob(filepath.Join(root, "sys", "class", "power_supply", "*"))
	sort.Strings(devices)
	var bat Battery
	found := false
	for _, dev := range devices {
		typ, ok := readTrimmed(filepath.Join(dev, "type"))
		if !ok {
			continue
		}
		switch typ {
		case "Battery":
			if bat.Percent == nil {
				if pct := readFloat(filepath.Join(dev, "capacity")); pct != nil {
					n := int(*pct)
					bat.Percent = &n
					found = true
				}
			}
			if bat.Status == nil {
				if st, ok := readTrimmed(filepath.Join(dev, "status")); ok {
					status := st
					bat.Status = &status
					found = true
				}
			}
		case "Mains":
			if online := readFloat(filepath.Join(dev, "online")); online != nil {
				on := *online == 1
				bat.ACOnline = &on
				found = true
			}
		}
	}
	if !found {
		return nil
	}
	return &bat
}
