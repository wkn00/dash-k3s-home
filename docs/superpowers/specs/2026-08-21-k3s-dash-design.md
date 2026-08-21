# k3s-dash — design

Date: 2026-08-21
Status: approved, ready for implementation planning

## Goal

One page that answers "are the three laptops and everything running on
them healthy?" without opening a terminal. Read-only. Fronted by the
existing Cloudflare Tunnel.

## The cluster as it actually is

Checked against the live cluster on 2026-08-21, because it constrains the
design:

| Fact | Consequence |
|---|---|
| 3 nodes: `wk` (control-plane), `wk1`, `wk2`, all Ubuntu 26.04 / k3s v1.35.5 | Node cards are a fixed-ish set, but the UI must render whatever `/api/v1/nodes` returns |
| Nodes are real laptops — `/sys/class/power_supply/BAT1`, `ACAD`, thermal zones present | Battery and temperature are worth showing, and require host access |
| Battery and AC device names vary per laptop (`BAT0`/`BAT1`, `AC`/`ACAD`) | The agent globs `/sys/class/power_supply/*`, never hardcodes a name |
| `metrics-server` running in `kube-system` | Live CPU/memory come free; no Prometheus needed |
| **No ingress controller** | An `Ingress` resource would do nothing. Do not write one. |
| `cloudflared` in ns `faheem`, remotely managed | Public hostnames are configured in the Cloudflare dashboard, not in Kubernetes |
| No cert-manager | TLS terminates at Cloudflare; the pod serves plain HTTP |
| ghcr.io/wkn00 packages are private | The namespace needs a `ghcr-creds` pull secret copied from ns `gsm` |
| Go is not installed on the laptop | The image builds Go inside a multi-stage Dockerfile |

## Non-goals

Alerting or notifications. Log viewing. Any write, scale, delete or exec
action. Persistent history across restarts. Authentication inside the app.

## Architecture

One image, `ghcr.io/wkn00/k3s-dash:0.1.0`, two workloads in namespace
`k3s-dash`, selected by the binary's first argument (`server` | `agent`).

### `k3s-dash` — Deployment, replicas: 1

Holds the ring buffer in memory, so a second replica would serve a
different history depending on which pod answered. Stays at 1. History
resets on restart; this is accepted, not a bug to fix.

Every 15s it samples: the Kubernetes API, metrics-server, each node's
kubelet stats, and each agent. The sample is folded into the ring buffer
and cached as the current snapshot. HTTP handlers only ever read that
cache — a browser request never triggers a cluster call, so refreshing
hard cannot amplify load on the API server.

Sources are queried concurrently with a 3s per-source timeout and the
whole sample is bounded at 10s, so one hung kubelet or wedged agent
delays nothing else and simply lands in `degraded`.

### `k3s-dash-agent` — DaemonSet, one pod per node

Battery, AC state, temperature and load average are not in the
Kubernetes API. Nothing else needs host access, so the agent does only
this: read a handful of files under `/sys` and `/proc`, serve them as
JSON on :9100. Read-only hostPath mounts, non-root, no capabilities, not
privileged.

The server discovers agents by listing pods labelled
`app=k3s-dash-agent` in its own namespace and requesting
`http://<podIP>:9100/hw`, keyed by the pod's `spec.nodeName`. No Service
is involved — a ClusterIP would load-balance across nodes and return an
arbitrary laptop's battery, which is exactly wrong here.

## Data sources

| Data | Source |
|---|---|
| Ready condition, roles, kubelet version, node age | `GET /api/v1/nodes` |
| Node and pod CPU / memory | `metrics.k8s.io/v1beta1` |
| Node disk used / capacity | `GET /api/v1/nodes/<n>/proxy/stats/summary` → `.node.fs` |
| Pod phase, restarts, node, age | `GET /api/v1/pods` (all namespaces) |
| Workload ready vs desired | `apps/v1` deployments, statefulsets, daemonsets |
| Warning events, last hour | `GET /api/v1/events`, filtered `type=Warning` |
| Battery %, AC online, charge state, temp, load, uptime | agent `/hw` |

## Contracts

### Agent — `GET /hw`

```json
{
  "node": "wk1",
  "uptimeSeconds": 3005059,
  "load1": 0.96, "load5": 0.65, "load15": 0.52,
  "tempC": 42.0,
  "battery": { "percent": 100, "status": "Full", "acOnline": true }
}
```

Every field except `node` is nullable. A laptop with no battery, an
unreadable thermal zone, or a malformed file yields `null` for that
field and a 200 for the rest. The agent never returns 500 for missing
hardware.

`tempC` picks the first thermal zone whose `type` is `x86_pkg_temp` or
`coretemp`; failing that, the hottest readable zone; failing that, null.
Values are millidegrees and divided by 1000.

### Server — `GET /api/state`

One document holding the whole page: `nodes[]` (identity, ready, uptime,
cpu, memory, disk, temp, battery, podCount, plus a `series` object of
sparkline arrays), `workloads[]` (namespace, name, kind, ready, desired,
restarts, nodes, age), `events[]` (time, namespace, object, reason,
message), and `meta` (sampledAt, sampleIntervalSeconds, degraded[]).

`degraded[]` names any source that failed on the last sample — e.g.
`["metrics-server", "agent/wk2"]` — and the UI shows it rather than
silently displaying stale or empty numbers.

Also `GET /` (the page) and `GET /healthz` (liveness/readiness, matching
the convention in nordpil and priset).

## Ring buffer

Per node, per metric (cpuPercent, memPercent, tempC, batteryPercent): a
fixed 480-slot circular buffer at 15s = 2 hours. Fixed allocation, no
growth, no eviction pass. A failed sample stores `null` so a gap renders
as a gap instead of a straight line across missing time.

## The page

Server-rendered HTML, vanilla JS, inline SVG sparklines, no build step
and no chart library. Polls `/api/state` every 5s.

- **Node strip** — one card per node: Ready pill, uptime, then CPU,
  memory, temperature and battery as current value plus a 2h sparkline,
  and disk as a bar. Amber/red on NotReady, on battery, hot, or a full
  disk.
- **Workloads** — grouped by namespace, anything below desired replicas
  sorted to the top and highlighted.
- **Warnings** — last hour of Warning events, newest first.
- Dark-mode aware. One screen, no routing.

## Security

RBAC is get/list/watch only, cluster-wide, on: nodes, nodes/proxy, pods,
events, namespaces, apps/v1 (deployments, statefulsets, daemonsets), and
metrics.k8s.io. No write verb appears anywhere in the ClusterRole.

Both containers: `runAsNonRoot`, uid 1000, `allowPrivilegeEscalation:
false`, all capabilities dropped, read-only root filesystem. The agent's
`/sys` and `/proc` hostPath mounts are `readOnly: true`.

No authentication in the app, by decision: access is controlled by a
Cloudflare Access policy on the tunnel hostname. The Access policy must
be attached when the hostname is created — without it, that URL exposes
the contents of every namespace to anyone holding it.

## Failure modes

Each source degrades independently; one failure never blanks the page.

| Failure | Behaviour |
|---|---|
| metrics-server down | CPU/memory show "—", everything else renders, `degraded` lists it |
| An agent pod unreachable or not yet scheduled | That node's battery/temp show "—"; its k8s-derived fields still render |
| Node NotReady | Card goes red; last known values stay visible, marked stale |
| kubelet stats proxy fails | Disk shows "—" for that node only |
| API server unreachable | Last good snapshot served, `meta.sampledAt` ages visibly, banner after 60s |

## Testing

Table-driven Go tests, written before the implementation.

- `/sys` and `/proc` parsers against fixtures captured from the real
  files on `wk` (charging, discharging, full, no battery, missing
  thermal zone, malformed and empty files, trailing newlines). These
  must degrade to null and must never panic.
- Ring buffer: wraparound at capacity, gap storage, retention window,
  series read while a write is in flight.
- State assembly with each source independently failing, asserting the
  rest of the document is intact and `degraded` is accurate.
- `httptest` fake API server + fake agents, asserting the `/api/state`
  shape end to end.

Manual verification before completion: port-forward the service, load
the page, and confirm all three laptops report a real battery percentage
and temperature.

## Deployment

`k8s/` holds only manifests safe to apply as a set:
`00-namespace.yaml`, `01-rbac.yaml`, `02-deployment.yaml`,
`03-service.yaml`, `04-daemonset.yaml`.

```bash
docker build -t ghcr.io/wkn00/k3s-dash:0.1.0 .
docker push ghcr.io/wkn00/k3s-dash:0.1.0
kubectl apply -f k8s/00-namespace.yaml
kubectl get secret ghcr-creds -n gsm -o json \
  | python3 -c "import json,sys; s=json.load(sys.stdin); s['metadata']={'name':'ghcr-creds','namespace':'k3s-dash'}; json.dump(s,sys.stdout)" \
  | kubectl apply -f -
kubectl apply -f k8s/
```

Then, in the Cloudflare dashboard, point a hostname at
`http://k3s-dash.k3s-dash.svc.cluster.local:80` and attach an Access
policy to it.
