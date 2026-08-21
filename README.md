# k3s-dash

A read-only dashboard for the three-laptop k3s cluster (`wk`, `wk1`,
`wk2`): node state, CPU/memory/disk, battery, temperature, every
workload's ready-vs-desired, and the last hour of warning events.

One Go binary, no dependencies, no database. The two hours of history live
in the server pod's memory and reset when it restarts, which is intended —
this is a "what is happening now" page, not a metrics store.

```
go test ./...                                          # the whole check
go run ./cmd/k3s-dash agent --root / --addr :9100      # the agent, locally
```

The `server` role needs in-cluster credentials, so it only runs usefully
inside the cluster.

## How it fits together

- **`k3s-dash`** (Deployment) polls the Kubernetes API, metrics-server,
  each kubelet's stats endpoint and each agent every 15s, then serves a
  cached snapshot. Browsers poll that cache, never the cluster.
- **`k3s-dash-agent`** (DaemonSet) reads battery, AC state, temperature and
  load from read-only host mounts of `/sys` and `/proc`. It exists only
  because those four values are not in the Kubernetes API.

Every source degrades independently: a wedged kubelet or a restarting
metrics-server costs its own numbers and nothing else, and the page names
what is missing in `meta.degraded` rather than showing a confident zero.

See `DEPLOY.md` for building, deploying and pointing the Cloudflare Tunnel
at it — including the two things this cluster punishes you for forgetting:
the control-plane taint toleration, and the Access policy on the hostname.
