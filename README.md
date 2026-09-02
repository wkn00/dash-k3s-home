# dash-k3s-home

A zero-dependency Go dashboard for a homelab k3s cluster — one binary, no
database, no client-go, showing what's actually happening on your nodes
right now.

## Overview

`k3s-dash` answers "is my cluster okay?" at a glance. For a homelab of up
to about ten mixed devices (laptops, mini-PCs, Raspberry Pis, VMs), it shows
per node:

- what the device physically is — vendor, model, chassis type, read straight
  from SMBIOS or the ARM device tree
- CPU, memory, and disk usage
- battery level, AC/charging state, and temperature (for anything that has
  them)
- every workload's ready-vs-desired replica count
- the last hour of Warning events

A fleet strip across the top gives a one-glance "is anything wrong?"
summary, and node cards sort themselves worst-first, so whatever needs
attention is always at the top of the page.

## Features

- **Zero external Go dependencies.** `go.mod` has no `require` block — the
  Kubernetes API client, JSON handling, and HTTP server are all hand-rolled
  against the standard library. The Docker image builds fully offline.
- **Never lies with a fake zero.** Every value is a nullable field. If a
  data source is unreachable, the UI shows an em dash and the snapshot's
  `meta.degraded` lists exactly what failed — not a confident "0%".
- **Per-source fault isolation.** A wedged kubelet or a restarting
  metrics-server only costs its own numbers; nothing else on the page is
  affected.
- **Hardware detection that isn't fooled by cheap firmware.** Most mini-PCs
  report `Default string` or `To Be Filled By O.E.M.` for their own model —
  detected and suppressed rather than printed. Three node annotations
  (`k3s-dash/name`, `k3s-dash/model`, `k3s-dash/type`) override it when
  firmware has nothing useful to say.
- **Live history without a metrics stack.** ~2 hours of sparkline history
  per node lives in an in-memory ring buffer — reset on restart, by design.
  This is a "right now" view, not a Prometheus replacement.
- **Read-only, cluster-wide, by design.** RBAC grants only `get/list/watch`;
  no write verb should ever be added.

## Architecture

One binary, two roles selected by CLI argument — the same image runs both:

- **`server`** (Deployment, `replicas: 1`) polls the Kubernetes API,
  metrics-server, each node's kubelet stats endpoint, and every agent pod
  every 15s, assembles one snapshot, and caches it in memory. Browsers only
  ever read that cache via `/api/state` — opening ten tabs can't multiply
  load on the API server.
- **`agent`** (DaemonSet, one pod per node) reads battery, AC state,
  temperature, load average, and device identity from read-only host mounts
  of `/sys` and `/proc` — none of which the Kubernetes API exposes. It reads
  no serial numbers; this page is reachable from the internet.

See [`project-docs/k3s-dash.md`](../project-docs/k3s-dash.md) for the full
package-by-package breakdown, or read the design docs under
`docs/superpowers/`.

## Project structure

```
cmd/k3s-dash/          entrypoint — delegates to internal/cli
internal/cli/          argv-based role router ("server" | "agent")
internal/kube/         hand-rolled read-only Kubernetes API client (no client-go)
internal/collect/      fans out to all data sources concurrently, per-source timeout
internal/hw/           host hardware readers: SMBIOS, device-tree, battery, temp
internal/agent/        agent HTTP handler (GET /hw)
internal/state/        raw sample -> rendered snapshot (nullable fields, worst-first sort)
internal/ring/         fixed-capacity in-memory ring buffer for sparkline history
internal/server/       dashboard HTTP server + embedded static UI (go:embed)
k8s/                   deploy manifests, applied in numeric order
```

## Getting started

Requires Go 1.25+.

```bash
go test ./...                                       # full test suite (78 tests)
go run ./cmd/k3s-dash agent --root / --addr :9100    # run the agent role locally
```

The `server` role needs in-cluster credentials (it reads the ServiceAccount
token from `/var/run/secrets/kubernetes.io/serviceaccount`) and has no
out-of-cluster mode, so it's only meaningfully run inside a real cluster.

Build the container image:

```bash
docker build -t ghcr.io/wkn00/k3s-dash:<tag> .
```

Multi-stage: `golang:1.25-alpine` builds a static, stripped binary; the
final image is `gcr.io/distroless/static:nonroot`, running as a non-root
user with a read-only root filesystem.

## Deployment

```bash
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/
kubectl -n k3s-dash rollout status deploy/k3s-dash
kubectl -n k3s-dash rollout status ds/k3s-dash-agent
```

See **[DEPLOY.md](DEPLOY.md)** for the full walkthrough, including the
private-registry pull-secret step, the control-plane taint toleration the
DaemonSet needs, verification commands, adding a new device, and wiring up
a Cloudflare Tunnel hostname (with an Access policy — this app has no login
of its own).

## Status

Actively developed. Broad test coverage relative to project size — 78 test
functions across every `internal/` package, including fixture data for
laptop (charging/discharging), mini-PC, VM, no-battery, and malformed-input
hardware profiles.
