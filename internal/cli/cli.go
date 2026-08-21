// Package cli routes the single binary into its two roles. The Deployment
// and the DaemonSet run the same image and differ only in argv, so there
// is one build to push and one image to keep in sync.
package cli

import (
	"errors"
	"fmt"
	"io"
)

func Run(args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: k3s-dash <server|agent>")
	}
	switch args[0] {
	case "server":
		return runServer(args[1:])
	case "agent":
		return runAgent(args[1:])
	default:
		return fmt.Errorf("unknown subcommand %q (want server or agent)", args[0])
	}
}
