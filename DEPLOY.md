# Deploying k3s-dash

Namespace `k3s-dash`: one Deployment (the dashboard) plus a DaemonSet (the
per-node hardware agent), fronted by the existing Cloudflare Tunnel.

## What the cluster forces

Checked against the live cluster, because it changes the manifests.

| Fact | Consequence |
|---|---|
| **No ingress controller** | Never add an `Ingress` — it would silently do nothing. Exposure is a tunnel hostname pointed at the Service. |
| **`wk` is tainted `node-role.kubernetes.io/control-plane:NoSchedule`** | The DaemonSet needs the toleration in `04-daemonset.yaml`, or it skips `wk` and the control-plane laptop reports no battery and no temperature — with no error anywhere to explain why. |
| ghcr.io/wkn00 packages are private | Copy `ghcr-creds` from ns `gsm` **before** applying the rest, or the pods sit in `ImagePullBackOff`. |
| History is in memory | `replicas: 1`. A restart resets the sparklines; this is intended, not a bug to fix. |
| No cert-manager | TLS terminates at Cloudflare; the pod serves plain HTTP. |
| `metrics-server` is running | CPU and memory come free. Disk does not — it comes from each kubelet's stats endpoint via the API server's node proxy, which is why the ClusterRole includes `nodes/proxy`. |

## Deploy

```bash
docker build -t ghcr.io/wkn00/k3s-dash:0.1.1 .
docker push ghcr.io/wkn00/k3s-dash:0.1.1

kubectl apply -f k8s/00-namespace.yaml

# Private ghcr packages: copy the pull secret into the new namespace.
kubectl get secret ghcr-creds -n gsm -o json \
  | python3 -c "import json,sys; s=json.load(sys.stdin); s['metadata']={'name':'ghcr-creds','namespace':'k3s-dash'}; json.dump(s,sys.stdout)" \
  | kubectl apply -f -

kubectl apply -f k8s/
kubectl -n k3s-dash rollout status deploy/k3s-dash
kubectl -n k3s-dash rollout status ds/k3s-dash-agent
```

## Verify

```bash
kubectl -n k3s-dash get pods -o wide
```

Expect **one** `k3s-dash-*` pod and **three** `k3s-dash-agent-*` pods — one
per node, `wk` included. Only two agents means the control-plane toleration
is missing.

```bash
kubectl -n k3s-dash port-forward svc/k3s-dash 8088:80 &
curl -s localhost:8088/api/state | python3 -m json.tool | head -40
```

`meta.degraded` must be `[]`. Anything listed there is a real failure —
most often a missing RBAC verb, which shows as `403` in the pod log. Every
node should carry a non-null `cpuPercent`, `memPercent`, `diskPercent`,
`tempC` and `battery.percent`; a null `tempC` means that node's agent
cannot read `/host/sys`.

## Cloudflare

In the Cloudflare dashboard, add a public hostname to the existing tunnel:

- Service: `http://k3s-dash.k3s-dash.svc.cluster.local:80`

**Attach an Access policy to the hostname at the same time you create it.**
The app has no login of its own, by design: that URL shows every
namespace's workloads and every node's state to anyone who reaches it.

## Upgrading

Bump the tag in `02-deployment.yaml` and `04-daemonset.yaml` **together** —
they run the same image and are expected to stay in lockstep.
