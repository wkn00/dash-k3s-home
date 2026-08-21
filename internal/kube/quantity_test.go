package kube

import (
	"math"
	"testing"
)

func TestParseQuantity(t *testing.T) {
	tests := []struct {
		in      string
		want    float64
		wantErr bool
	}{
		{in: "8", want: 8},                      // node capacity: 8 cores
		{in: "578630136n", want: 0.578630136},   // metrics cpu: nanocores
		{in: "290m", want: 0.29},                // metrics cpu: millicores
		{in: "3696868Ki", want: 3696868 * 1024}, // metrics memory
		{in: "16308880Ki", want: 16308880 * 1024},
		{in: "1495Mi", want: 1495 * 1024 * 1024},
		{in: "2Gi", want: 2 * 1024 * 1024 * 1024},
		{in: "1500M", want: 1.5e9}, // decimal M, not Mi
		{in: " 42 ", want: 42},     // whitespace tolerated
		{in: "", wantErr: true},
		{in: "banana", wantErr: true},
		{in: "12Xi", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.in, func(t *testing.T) {
			got, err := ParseQuantity(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("ParseQuantity(%q) = %v, want an error", tc.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseQuantity(%q) error = %v", tc.in, err)
			}
			if math.Abs(got-tc.want) > 1e-6 {
				t.Errorf("ParseQuantity(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
