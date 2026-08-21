package cli

import (
	"io"
	"strings"
	"testing"
)

func TestRunRejectsBadArgs(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{name: "no subcommand", args: nil, want: "usage:"},
		{name: "empty subcommand", args: []string{""}, want: "unknown subcommand"},
		{name: "unknown subcommand", args: []string{"frobnicate"}, want: `unknown subcommand "frobnicate"`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := Run(tc.args, io.Discard)
			if err == nil {
				t.Fatalf("Run(%q) = nil, want an error", tc.args)
			}
			if got := err.Error(); !strings.Contains(got, tc.want) {
				t.Errorf("Run(%q) error = %q, want it to contain %q", tc.args, got, tc.want)
			}
		})
	}
}
