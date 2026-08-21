package cli

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/wkn00/k3s-dash/internal/collect"
	"github.com/wkn00/k3s-dash/internal/kube"
	"github.com/wkn00/k3s-dash/internal/server"
)

func runServer(args []string) error {
	fs := flag.NewFlagSet("server", flag.ContinueOnError)
	addr := fs.String("addr", ":8080", "listen address")
	interval := fs.Duration("interval", 15*time.Second, "sample interval")
	window := fs.Duration("window", 2*time.Hour, "how much history to keep in memory")
	agentPort := fs.Int("agent-port", 9100, "port the DaemonSet agents listen on")
	agentSelector := fs.String("agent-selector", "app=k3s-dash-agent", "label selector for agent pods")
	perSource := fs.Duration("per-source-timeout", 3*time.Second, "timeout for a single source")
	if err := fs.Parse(args); err != nil {
		return err
	}

	namespace := os.Getenv("POD_NAMESPACE")
	if namespace == "" {
		namespace = "k3s-dash"
	}

	client, err := kube.InCluster()
	if err != nil {
		return err
	}

	capacity := int(*window / *interval)
	srv := server.New(client, &http.Client{Timeout: *perSource}, collect.Options{
		Namespace:     namespace,
		AgentSelector: *agentSelector,
		AgentPort:     *agentPort,
		PerSource:     *perSource,
	}, *interval, capacity)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go srv.Run(ctx)

	httpSrv := &http.Server{Addr: *addr, Handler: srv.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()

	log.Printf("k3s-dash server listening on %s (namespace %s, %d samples of history)", *addr, namespace, capacity)
	if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
