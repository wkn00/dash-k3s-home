package kube

import (
	"context"
	"time"
)

type objectMeta struct {
	Name              string            `json:"name"`
	Namespace         string            `json:"namespace"`
	Labels            map[string]string `json:"labels"`
	Annotations       map[string]string `json:"annotations"`
	CreationTimestamp time.Time         `json:"creationTimestamp"`
}

func (c *Client) Nodes(ctx context.Context) ([]Node, error) {
	var raw struct {
		Items []struct {
			Metadata objectMeta `json:"metadata"`
			Status   struct {
				Conditions []struct {
					Type   string `json:"type"`
					Status string `json:"status"`
				} `json:"conditions"`
				Addresses []struct {
					Type    string `json:"type"`
					Address string `json:"address"`
				} `json:"addresses"`
				NodeInfo struct {
					KubeletVersion string `json:"kubeletVersion"`
					OSImage        string `json:"osImage"`
					KernelVersion  string `json:"kernelVersion"`
					Architecture   string `json:"architecture"`
				} `json:"nodeInfo"`
				Capacity struct {
					CPU    string `json:"cpu"`
					Memory string `json:"memory"`
				} `json:"capacity"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := c.GetJSON(ctx, "/api/v1/nodes", &raw); err != nil {
		return nil, err
	}
	out := make([]Node, 0, len(raw.Items))
	for _, item := range raw.Items {
		n := Node{
			Name:           item.Metadata.Name,
			KubeletVersion: item.Status.NodeInfo.KubeletVersion,
			OSImage:        item.Status.NodeInfo.OSImage,
			KernelVersion:  item.Status.NodeInfo.KernelVersion,
			Architecture:   item.Status.NodeInfo.Architecture,
			Annotations:    item.Metadata.Annotations,
			CreatedAt:      item.Metadata.CreationTimestamp,
		}
		if n.Annotations == nil {
			// Callers index this to read the display overrides; a nil map
			// reads fine but a nil map on a struct invites a later write
			// that panics.
			n.Annotations = map[string]string{}
		}
		_, n.ControlPlane = item.Metadata.Labels["node-role.kubernetes.io/control-plane"]
		for _, cond := range item.Status.Conditions {
			// Ready is not reliably the first condition, so scan.
			if cond.Type == "Ready" {
				n.Ready = cond.Status == "True"
			}
		}
		for _, addr := range item.Status.Addresses {
			// Hostname is usually first in the list, so scan for the type
			// rather than taking addresses[0].
			if addr.Type == "InternalIP" && n.InternalIP == "" {
				n.InternalIP = addr.Address
			}
		}
		n.CPUCapacityCores, _ = ParseQuantity(item.Status.Capacity.CPU)
		n.MemoryCapacityBytes, _ = ParseQuantity(item.Status.Capacity.Memory)
		out = append(out, n)
	}
	return out, nil
}

func (c *Client) podsFrom(ctx context.Context, path string) ([]Pod, error) {
	var raw struct {
		Items []struct {
			Metadata objectMeta `json:"metadata"`
			Spec     struct {
				NodeName string `json:"nodeName"`
			} `json:"spec"`
			Status struct {
				Phase             string `json:"phase"`
				PodIP             string `json:"podIP"`
				ContainerStatuses []struct {
					RestartCount int `json:"restartCount"`
				} `json:"containerStatuses"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := c.GetJSON(ctx, path, &raw); err != nil {
		return nil, err
	}
	out := make([]Pod, 0, len(raw.Items))
	for _, item := range raw.Items {
		p := Pod{
			Name:      item.Metadata.Name,
			Namespace: item.Metadata.Namespace,
			NodeName:  item.Spec.NodeName,
			Phase:     item.Status.Phase,
			Labels:    item.Metadata.Labels,
			CreatedAt: item.Metadata.CreationTimestamp,
			IP:        item.Status.PodIP,
		}
		for _, cs := range item.Status.ContainerStatuses {
			p.Restarts += cs.RestartCount
		}
		out = append(out, p)
	}
	return out, nil
}

func (c *Client) Pods(ctx context.Context) ([]Pod, error) {
	return c.podsFrom(ctx, "/api/v1/pods")
}

// PodsMatching is how the server finds its agents: list the DaemonSet's
// pods in its own namespace and talk to each pod IP directly. A Service
// would load-balance across nodes and return an arbitrary laptop's
// battery, which is exactly the wrong answer.
func (c *Client) PodsMatching(ctx context.Context, namespace, labelSelector string) ([]Pod, error) {
	return c.podsFrom(ctx, "/api/v1/namespaces/"+namespace+"/pods?labelSelector="+labelSelector)
}

func (c *Client) NodeUsage(ctx context.Context) (map[string]Usage, error) {
	var raw struct {
		Items []struct {
			Metadata objectMeta `json:"metadata"`
			Usage    struct {
				CPU    string `json:"cpu"`
				Memory string `json:"memory"`
			} `json:"usage"`
		} `json:"items"`
	}
	if err := c.GetJSON(ctx, "/apis/metrics.k8s.io/v1beta1/nodes", &raw); err != nil {
		return nil, err
	}
	out := make(map[string]Usage, len(raw.Items))
	for _, item := range raw.Items {
		var u Usage
		u.CPUCores, _ = ParseQuantity(item.Usage.CPU)
		u.MemoryBytes, _ = ParseQuantity(item.Usage.Memory)
		out[item.Metadata.Name] = u
	}
	return out, nil
}

// NodeFilesystem reads the kubelet's own stats through the API server's
// node proxy — disk usage is not exposed by metrics-server. This is the
// one call that needs the nodes/proxy RBAC verb.
func (c *Client) NodeFilesystem(ctx context.Context, node string) (Filesystem, error) {
	var raw struct {
		Node struct {
			FS struct {
				UsedBytes     float64 `json:"usedBytes"`
				CapacityBytes float64 `json:"capacityBytes"`
			} `json:"fs"`
		} `json:"node"`
	}
	if err := c.GetJSON(ctx, "/api/v1/nodes/"+node+"/proxy/stats/summary", &raw); err != nil {
		return Filesystem{}, err
	}
	return Filesystem{UsedBytes: raw.Node.FS.UsedBytes, CapacityBytes: raw.Node.FS.CapacityBytes}, nil
}

// Workloads flattens the three controller kinds into one list. Each kind
// stores its counts in different fields, which is the whole reason this
// function exists rather than three call sites.
func (c *Client) Workloads(ctx context.Context) ([]Workload, error) {
	var raw struct {
		Items []struct {
			Metadata objectMeta `json:"metadata"`
			Spec     struct {
				Replicas *int `json:"replicas"`
				Selector struct {
					MatchLabels map[string]string `json:"matchLabels"`
				} `json:"selector"`
			} `json:"spec"`
			Status struct {
				ReadyReplicas          int `json:"readyReplicas"`
				DesiredNumberScheduled int `json:"desiredNumberScheduled"`
				NumberReady            int `json:"numberReady"`
			} `json:"status"`
		} `json:"items"`
	}

	kinds := []struct {
		path string
		kind string
	}{
		{"/apis/apps/v1/deployments", "Deployment"},
		{"/apis/apps/v1/statefulsets", "StatefulSet"},
		{"/apis/apps/v1/daemonsets", "DaemonSet"},
	}

	var out []Workload
	for _, k := range kinds {
		raw.Items = nil
		if err := c.GetJSON(ctx, k.path, &raw); err != nil {
			return nil, err
		}
		for _, item := range raw.Items {
			w := Workload{
				Namespace: item.Metadata.Namespace,
				Name:      item.Metadata.Name,
				Kind:      k.kind,
				Selector:  item.Spec.Selector.MatchLabels,
			}
			if k.kind == "DaemonSet" {
				w.Desired = item.Status.DesiredNumberScheduled
				w.Ready = item.Status.NumberReady
			} else {
				w.Desired = 1 // spec.replicas defaults to 1 when omitted
				if item.Spec.Replicas != nil {
					w.Desired = *item.Spec.Replicas
				}
				w.Ready = item.Status.ReadyReplicas
			}
			out = append(out, w)
		}
	}
	return out, nil
}

func (c *Client) Namespaces(ctx context.Context) ([]Namespace, error) {
	var raw struct {
		Items []struct {
			Metadata objectMeta `json:"metadata"`
			Status   struct {
				Phase string `json:"phase"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := c.GetJSON(ctx, "/api/v1/namespaces", &raw); err != nil {
		return nil, err
	}
	out := make([]Namespace, 0, len(raw.Items))
	for _, item := range raw.Items {
		out = append(out, Namespace{
			Name:      item.Metadata.Name,
			Phase:     item.Status.Phase,
			CreatedAt: item.Metadata.CreationTimestamp,
		})
	}
	return out, nil
}

func (c *Client) ResourceQuotas(ctx context.Context) ([]ResourceQuota, error) {
	var raw struct {
		Items []struct {
			Metadata objectMeta `json:"metadata"`
			Status   struct {
				Hard map[string]string `json:"hard"`
				Used map[string]string `json:"used"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := c.GetJSON(ctx, "/api/v1/resourcequotas", &raw); err != nil {
		return nil, err
	}
	out := make([]ResourceQuota, 0, len(raw.Items))
	for _, item := range raw.Items {
		out = append(out, ResourceQuota{
			Namespace: item.Metadata.Namespace,
			Name:      item.Metadata.Name,
			Hard:      item.Status.Hard,
			Used:      item.Status.Used,
		})
	}
	return out, nil
}

func (c *Client) LimitRanges(ctx context.Context) ([]LimitRange, error) {
	var raw struct {
		Items []struct {
			Metadata objectMeta `json:"metadata"`
			Spec     struct {
				Limits []struct {
					Type           string            `json:"type"`
					Default        map[string]string `json:"default"`
					DefaultRequest map[string]string `json:"defaultRequest"`
					Min            map[string]string `json:"min"`
					Max            map[string]string `json:"max"`
				} `json:"limits"`
			} `json:"spec"`
		} `json:"items"`
	}
	if err := c.GetJSON(ctx, "/api/v1/limitranges", &raw); err != nil {
		return nil, err
	}
	out := make([]LimitRange, 0, len(raw.Items))
	for _, item := range raw.Items {
		lr := LimitRange{Namespace: item.Metadata.Namespace, Name: item.Metadata.Name}
		for _, l := range item.Spec.Limits {
			lr.Limits = append(lr.Limits, LimitRangeItem{
				Type: l.Type, Default: l.Default, DefaultRequest: l.DefaultRequest, Min: l.Min, Max: l.Max,
			})
		}
		out = append(out, lr)
	}
	return out, nil
}

func (c *Client) PersistentVolumeClaims(ctx context.Context) ([]PersistentVolumeClaim, error) {
	var raw struct {
		Items []struct {
			Metadata objectMeta `json:"metadata"`
			Spec     struct {
				StorageClassName string   `json:"storageClassName"`
				AccessModes      []string `json:"accessModes"`
			} `json:"spec"`
			Status struct {
				Phase    string `json:"phase"`
				Capacity struct {
					Storage string `json:"storage"`
				} `json:"capacity"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := c.GetJSON(ctx, "/api/v1/persistentvolumeclaims", &raw); err != nil {
		return nil, err
	}
	out := make([]PersistentVolumeClaim, 0, len(raw.Items))
	for _, item := range raw.Items {
		p := PersistentVolumeClaim{
			Namespace:    item.Metadata.Namespace,
			Name:         item.Metadata.Name,
			Phase:        item.Status.Phase,
			StorageClass: item.Spec.StorageClassName,
			AccessModes:  item.Spec.AccessModes,
		}
		p.CapacityBytes, _ = ParseQuantity(item.Status.Capacity.Storage)
		out = append(out, p)
	}
	return out, nil
}

func (c *Client) Services(ctx context.Context) ([]Service, error) {
	var raw struct {
		Items []struct {
			Metadata objectMeta `json:"metadata"`
			Spec     struct {
				Type      string `json:"type"`
				ClusterIP string `json:"clusterIP"`
				Ports     []struct {
					Port     int    `json:"port"`
					Protocol string `json:"protocol"`
				} `json:"ports"`
			} `json:"spec"`
		} `json:"items"`
	}
	if err := c.GetJSON(ctx, "/api/v1/services", &raw); err != nil {
		return nil, err
	}
	out := make([]Service, 0, len(raw.Items))
	for _, item := range raw.Items {
		s := Service{
			Namespace: item.Metadata.Namespace,
			Name:      item.Metadata.Name,
			Type:      item.Spec.Type,
			ClusterIP: item.Spec.ClusterIP,
		}
		for _, p := range item.Spec.Ports {
			s.Ports = append(s.Ports, ServicePort{Port: p.Port, Protocol: p.Protocol})
		}
		out = append(out, s)
	}
	return out, nil
}

func (c *Client) Warnings(ctx context.Context) ([]Event, error) {
	var raw struct {
		Items []struct {
			Metadata       objectMeta `json:"metadata"`
			Type           string     `json:"type"`
			Reason         string     `json:"reason"`
			Message        string     `json:"message"`
			Count          int        `json:"count"`
			LastTimestamp  time.Time  `json:"lastTimestamp"`
			EventTime      time.Time  `json:"eventTime"`
			InvolvedObject struct {
				Kind      string `json:"kind"`
				Name      string `json:"name"`
				Namespace string `json:"namespace"`
			} `json:"involvedObject"`
		} `json:"items"`
	}
	if err := c.GetJSON(ctx, "/api/v1/events?fieldSelector=type%3DWarning", &raw); err != nil {
		return nil, err
	}
	out := make([]Event, 0, len(raw.Items))
	for _, item := range raw.Items {
		// Which timestamp is populated depends on which component emitted
		// the event; take the most specific one that is set.
		at := item.LastTimestamp
		if at.IsZero() {
			at = item.EventTime
		}
		if at.IsZero() {
			at = item.Metadata.CreationTimestamp
		}
		out = append(out, Event{
			At:        at,
			Namespace: item.InvolvedObject.Namespace,
			Object:    item.InvolvedObject.Kind + "/" + item.InvolvedObject.Name,
			Reason:    item.Reason,
			Message:   item.Message,
			Count:     item.Count,
		})
	}
	return out, nil
}
