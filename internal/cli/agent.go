package cli

import (
	"flag"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/wkn00/k3s-dash/internal/agent"
)

func runAgent(args []string) error {
	fs := flag.NewFlagSet("agent", flag.ContinueOnError)
	addr := fs.String("addr", ":9100", "listen address")
	root := fs.String("root", "/host", "prefix under which the host filesystem is mounted")
	if err := fs.Parse(args); err != nil {
		return err
	}
	node := os.Getenv("NODE_NAME")
	if node == "" {
		// Only reached outside Kubernetes; in the DaemonSet NODE_NAME is
		// set from spec.nodeName via the downward API.
		node, _ = os.Hostname()
	}
	srv := &http.Server{
		Addr:              *addr,
		Handler:           agent.Handler(*root, node),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("k3s-dash agent listening on %s for node %s (host root %s)", *addr, node, *root)
	return srv.ListenAndServe()
}
