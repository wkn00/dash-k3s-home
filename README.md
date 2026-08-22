# k3s-dash

A read-only dashboard for the k3s cluster it runs in: what each device is
(laptop, mini-PC, Raspberry Pi, VM — make and model), its CPU/memory/disk,
battery, temperature, every workload's ready-vs-desired, and the last hour
of warning events. Built for a homelab of up to about ten mixed devices.

A fleet strip across the top answers "is anything wrong?" without reading
any card, and the cards sort themselves worst-first, so the device that
needs attention is always the first one on the page.

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
- **`k3s-dash-agent`** (DaemonSet) reads battery, AC state, temperature,
  load and the machine's own identity — vendor, model and chassis type from
  SMBIOS, or the device tree on an ARM board — from read-only host mounts of
  `/sys` and `/proc`. It exists only because none of that is in the
  Kubernetes API. It reads no serial numbers: those are root-only, and this
  page is reachable from the internet.

Adding a device means joining it to the cluster. It names itself from its
own firmware, and where the firmware is uninformative — which is most cheap
mini-PCs — three optional annotations override it:

```bash
kubectl annotate node wk3 k3s-dash/name="Kitchen Pi"
kubectl annotate node wk3 k3s-dash/model="Beelink SER5 MAX"
kubectl annotate node wk3 k3s-dash/type=mini-pc
```

Every source degrades independently: a wedged kubelet or a restarting
metrics-server costs its own numbers and nothing else, and the page names
what is missing in `meta.degraded` rather than showing a confident zero.

See `DEPLOY.md` for building, deploying and pointing the Cloudflare Tunnel
at it — including the two things this cluster punishes you for forgetting:
the control-plane taint toleration, and the Access policy on the hostname.
