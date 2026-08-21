// Package agent serves one node's hardware readings. It exists because
// battery state, AC state and temperature are not in the Kubernetes API;
// everything else the dashboard shows is, which is why this stays small.
package agent

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/wkn00/k3s-dash/internal/hw"
)

func Handler(root, node string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /hw", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(hw.Read(root, node)); err != nil {
			log.Printf("encode hw snapshot: %v", err)
		}
	})
	return mux
}
