package kube

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGetJSONSendsBearerTokenAndDecodes(t *testing.T) {
	var gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"kind":"NodeList","items":[{"metadata":{"name":"wk1"}}]}`))
	}))
	defer srv.Close()

	c := &Client{Base: srv.URL, Token: "sekrit", HTTP: srv.Client()}
	var out struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := c.GetJSON(context.Background(), "/api/v1/nodes", &out); err != nil {
		t.Fatalf("GetJSON: %v", err)
	}
	if gotAuth != "Bearer sekrit" {
		t.Errorf("Authorization = %q, want %q", gotAuth, "Bearer sekrit")
	}
	if gotPath != "/api/v1/nodes" {
		t.Errorf("path = %q, want %q", gotPath, "/api/v1/nodes")
	}
	if len(out.Items) != 1 || out.Items[0].Metadata.Name != "wk1" {
		t.Errorf("decoded = %+v, want one node named wk1", out.Items)
	}
}

func TestGetJSONReportsHTTPErrorsWithBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"nodes is forbidden"}`))
	}))
	defer srv.Close()

	c := &Client{Base: srv.URL, HTTP: srv.Client()}
	err := c.GetJSON(context.Background(), "/api/v1/nodes", &struct{}{})
	if err == nil {
		t.Fatal("GetJSON = nil, want an error on 403")
	}
	// The RBAC mistake this catches is common enough that the message
	// must name the path and carry the server's reason.
	for _, want := range []string{"/api/v1/nodes", "403", "forbidden"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error = %q, want it to contain %q", err, want)
		}
	}
}

func TestGetJSONHonoursContextCancellation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c := &Client{Base: srv.URL, HTTP: srv.Client()}
	if err := c.GetJSON(ctx, "/api/v1/nodes", &struct{}{}); err == nil {
		t.Fatal("GetJSON = nil, want an error from the cancelled context")
	}
}
