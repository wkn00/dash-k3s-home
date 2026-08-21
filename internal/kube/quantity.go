package kube

import (
	"errors"
	"strconv"
	"strings"
)

var binarySuffixes = []struct {
	suffix string
	mult   float64
}{
	{"Ki", 1 << 10}, {"Mi", 1 << 20}, {"Gi", 1 << 30}, {"Ti", 1 << 40}, {"Pi", 1 << 50},
}

var decimalSuffixes = map[byte]float64{
	'n': 1e-9, 'u': 1e-6, 'm': 1e-3,
	'k': 1e3, 'K': 1e3, 'M': 1e6, 'G': 1e9, 'T': 1e12, 'P': 1e15,
}

// ParseQuantity converts a Kubernetes quantity into a plain float in the
// resource's base unit: cores for CPU, bytes for memory. The API mixes
// units freely — a node reports "8" cores while metrics-server reports
// "578630136n" for the same resource — so every number crossing this
// boundary goes through here.
func ParseQuantity(s string) (float64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, errors.New("empty quantity")
	}
	for _, bs := range binarySuffixes {
		if strings.HasSuffix(s, bs.suffix) {
			v, err := strconv.ParseFloat(strings.TrimSuffix(s, bs.suffix), 64)
			if err != nil {
				return 0, err
			}
			return v * bs.mult, nil
		}
	}
	if mult, ok := decimalSuffixes[s[len(s)-1]]; ok {
		v, err := strconv.ParseFloat(s[:len(s)-1], 64)
		if err != nil {
			return 0, err
		}
		return v * mult, nil
	}
	return strconv.ParseFloat(s, 64)
}
