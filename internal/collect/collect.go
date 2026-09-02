// Package collect gathers one sample from every source at once. Each
// source is fetched under its own timeout and its own error, so a wedged
// kubelet or a restarting metrics-server costs exactly its own numbers
// and nothing else on the page.
package collect

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"sync"
	"time"

	"github.com/wkn00/k3s-dash/internal/hw"
	"github.com/wkn00/k3s-dash/internal/kube"
)

type Options struct {
	Namespace     string
	AgentSelector string
	AgentPort     int
	PerSource     time.Duration
	// AgentURL builds the /hw URL for an agent pod. Overridden in tests;
	// in production it is the pod IP and the agent port.
	AgentURL func(kube.Pod) string
}

func (o Options) agentURL(p kube.Pod) string {
	if o.AgentURL != nil {
		return o.AgentURL(p)
	}
	return fmt.Sprintf("http://%s:%d/hw", p.IP, o.AgentPort)
}

type Raw struct {
	At          time.Time
	Nodes       []kube.Node
	Pods        []kube.Pod
	Workloads   []kube.Workload
	Warnings    []kube.Event
	Namespaces  []kube.Namespace
	Quotas      []kube.ResourceQuota
	LimitRanges []kube.LimitRange
	PVCs        []kube.PersistentVolumeClaim
	Services    []kube.Service
	Usage       map[string]kube.Usage
	FS          map[string]kube.Filesystem
	HW          map[string]hw.Snapshot
	Degraded    []string
}

// gatherer serialises writes from the fan-out goroutines.
type gatherer struct {
	mu       sync.Mutex
	degraded []string
}

func (g *gatherer) fail(source string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.degraded = append(g.degraded, source)
}

func Sample(ctx context.Context, c *kube.Client, hc *http.Client, opts Options) Raw {
	raw := Raw{
		At:    time.Now().UTC(),
		Usage: map[string]kube.Usage{},
		FS:    map[string]kube.Filesystem{},
		HW:    map[string]hw.Snapshot{},
	}
	g := &gatherer{}

	// Phase one: everything that depends on nothing.
	var agentPods []kube.Pod
	var wg sync.WaitGroup
	run := func(source string, fn func(ctx context.Context) error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, opts.PerSource)
			defer cancel()
			if err := fn(cctx); err != nil {
				g.fail(source)
			}
		}()
	}

	run("kubernetes/nodes", func(ctx context.Context) (err error) {
		raw.Nodes, err = c.Nodes(ctx)
		return err
	})
	run("kubernetes/pods", func(ctx context.Context) (err error) {
		raw.Pods, err = c.Pods(ctx)
		return err
	})
	run("kubernetes/workloads", func(ctx context.Context) (err error) {
		raw.Workloads, err = c.Workloads(ctx)
		return err
	})
	run("kubernetes/events", func(ctx context.Context) (err error) {
		raw.Warnings, err = c.Warnings(ctx)
		return err
	})
	run("metrics-server", func(ctx context.Context) error {
		usage, err := c.NodeUsage(ctx)
		if err != nil {
			return err
		}
		raw.Usage = usage
		return nil
	})
	run("kubernetes/agents", func(ctx context.Context) (err error) {
		agentPods, err = c.PodsMatching(ctx, opts.Namespace, url.QueryEscape(opts.AgentSelector))
		return err
	})
	run("kubernetes/namespaces", func(ctx context.Context) (err error) {
		raw.Namespaces, err = c.Namespaces(ctx)
		return err
	})
	run("kubernetes/quotas", func(ctx context.Context) (err error) {
		raw.Quotas, err = c.ResourceQuotas(ctx)
		return err
	})
	run("kubernetes/limitranges", func(ctx context.Context) (err error) {
		raw.LimitRanges, err = c.LimitRanges(ctx)
		return err
	})
	run("kubernetes/pvcs", func(ctx context.Context) (err error) {
		raw.PVCs, err = c.PersistentVolumeClaims(ctx)
		return err
	})
	run("kubernetes/services", func(ctx context.Context) (err error) {
		raw.Services, err = c.Services(ctx)
		return err
	})
	wg.Wait()

	// Phase two: the per-node work, which needed phase one's lists.
	var mu sync.Mutex
	for _, node := range raw.Nodes {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, opts.PerSource)
			defer cancel()
			fs, err := c.NodeFilesystem(cctx, name)
			if err != nil {
				g.fail("kubelet/" + name)
				return
			}
			mu.Lock()
			raw.FS[name] = fs
			mu.Unlock()
		}(node.Name)
	}
	for _, pod := range agentPods {
		if pod.IP == "" || pod.NodeName == "" {
			// Not scheduled or not assigned an IP yet; it will appear on
			// a later sample.
			continue
		}
		wg.Add(1)
		go func(p kube.Pod) {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, opts.PerSource)
			defer cancel()
			snap, err := fetchHW(cctx, hc, opts.agentURL(p))
			if err != nil {
				g.fail("agent/" + p.NodeName)
				return
			}
			mu.Lock()
			raw.HW[p.NodeName] = snap
			mu.Unlock()
		}(pod)
	}
	wg.Wait()

	sort.Strings(g.degraded)
	raw.Degraded = g.degraded
	if raw.Degraded == nil {
		raw.Degraded = []string{}
	}
	return raw
}

func fetchHW(ctx context.Context, hc *http.Client, url string) (hw.Snapshot, error) {
	var snap hw.Snapshot
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return snap, err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return snap, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return snap, fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	return snap, json.NewDecoder(resp.Body).Decode(&snap)
}
