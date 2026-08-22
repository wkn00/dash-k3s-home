package state

import (
	"strings"

	"github.com/wkn00/k3s-dash/internal/hw"
	"github.com/wkn00/k3s-dash/internal/kube"
)

// Annotation keys a human can set to correct or replace what the agent
// detected:
//
//	kubectl annotate node wk3 k3s-dash/name="Kitchen Pi"
//	kubectl annotate node wk3 k3s-dash/model="Beelink SER5 MAX"
//	kubectl annotate node wk3 k3s-dash/type=mini-pc
//
// These are annotations rather than labels because a label value may not
// contain a space, and every useful value here does.
const (
	AnnotationName  = "k3s-dash/name"
	AnnotationModel = "k3s-dash/model"
	AnnotationType  = "k3s-dash/type"
)

// annotation returns a trimmed annotation, or nil when it is absent or
// blank. A blank annotation is a typo, not an instruction to erase what was
// detected.
func annotation(annotations map[string]string, key string) *string {
	value := strings.TrimSpace(annotations[key])
	if value == "" {
		return nil
	}
	return &value
}

// identify merges what the agent read from firmware with what a human wrote
// on the node. The human wins: firmware is frequently wrong — a generic
// mini-PC ships "Default string" in every name field — and re-flashing DMI
// to correct a dashboard is not a reasonable thing to ask of anyone.
func identify(kn kube.Node, snap *hw.Snapshot) (displayName, vendor, model, class *string) {
	if snap != nil && snap.Device != nil {
		vendor, model, class = snap.Device.Vendor, snap.Device.Model, snap.Device.Chassis
	}

	displayName = annotation(kn.Annotations, AnnotationName)
	if override := annotation(kn.Annotations, AnnotationModel); override != nil {
		// The detected vendor described the detected model, so it cannot be
		// carried over: "Lenovo · Beelink SER5 MAX" is a contradiction
		// rather than a correction.
		model, vendor = override, nil
	}
	if override := annotation(kn.Annotations, AnnotationType); override != nil {
		class = override
	}
	return displayName, vendor, model, class
}
