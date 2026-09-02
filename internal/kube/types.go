package kube

import "time"

// Node is the subset of v1.Node the dashboard shows.
type Node struct {
	Name                string
	Ready               bool
	ControlPlane        bool
	KubeletVersion      string
	OSImage             string
	KernelVersion       string
	Architecture        string
	InternalIP          string
	Annotations         map[string]string
	CreatedAt           time.Time
	CPUCapacityCores    float64
	MemoryCapacityBytes float64
}

type Pod struct {
	Name      string
	Namespace string
	NodeName  string
	Phase     string
	IP        string
	Restarts  int
	Labels    map[string]string
	CreatedAt time.Time
}

type Usage struct {
	CPUCores    float64
	MemoryBytes float64
}

type Filesystem struct {
	UsedBytes     float64
	CapacityBytes float64
}

type Workload struct {
	Namespace string
	Name      string
	Kind      string
	Ready     int
	Desired   int
	Selector  map[string]string
}

type Namespace struct {
	Name      string
	Phase     string
	CreatedAt time.Time
}

// ResourceQuota keeps Hard/Used as raw API quantity strings rather than
// parsed floats: the key set varies per quota (cpu, memory, pods, object
// counts, ...) and the state layer parses only the keys it renders.
type ResourceQuota struct {
	Namespace string
	Name      string
	Hard      map[string]string
	Used      map[string]string
}

type LimitRangeItem struct {
	Type           string
	Default        map[string]string
	DefaultRequest map[string]string
	Min            map[string]string
	Max            map[string]string
}

type LimitRange struct {
	Namespace string
	Name      string
	Limits    []LimitRangeItem
}

type PersistentVolumeClaim struct {
	Namespace     string
	Name          string
	Phase         string
	StorageClass  string
	AccessModes   []string
	CapacityBytes float64
}

type ServicePort struct {
	Port     int
	Protocol string
}

type Service struct {
	Namespace string
	Name      string
	Type      string
	ClusterIP string
	Ports     []ServicePort
}

type Event struct {
	At        time.Time
	Namespace string
	Object    string
	Reason    string
	Message   string
	Count     int
}

// MatchesSelector reports whether labels satisfy every key in selector.
// An empty selector matches nothing: treating it as "matches all" would
// attribute every pod in the cluster to a single workload.
func MatchesSelector(labels, selector map[string]string) bool {
	if len(selector) == 0 {
		return false
	}
	for k, v := range selector {
		if labels[k] != v {
			return false
		}
	}
	return true
}
