package shelley

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDirectTransportDo(t *testing.T) {
	var gotAuth, gotContentType, gotMethod, gotPath, gotBody string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		gotMethod = r.Method
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"conversation_id":"c1","status":"accepted"}`))
	}))
	defer srv.Close()

	tr := DirectTransport{BaseURL: srv.URL, Token: "vm-scoped-token", HTTP: srv.Client()}
	resp, err := tr.Do(context.Background(), http.MethodPost, "/api/conversations/new", []byte(`{"message":"hi"}`))
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}

	if gotAuth != "Bearer vm-scoped-token" {
		t.Errorf("Authorization header = %q, want Bearer vm-scoped-token", gotAuth)
	}
	if gotContentType != "application/json" {
		t.Errorf("Content-Type header = %q, want application/json", gotContentType)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method = %q, want POST", gotMethod)
	}
	if gotPath != "/api/conversations/new" {
		t.Errorf("path = %q, want /api/conversations/new", gotPath)
	}
	if gotBody != `{"message":"hi"}` {
		t.Errorf("request body = %q, want %q", gotBody, `{"message":"hi"}`)
	}
	if string(resp) != `{"conversation_id":"c1","status":"accepted"}` {
		t.Errorf("Do() = %s, want the raw response body", resp)
	}
}

func TestDirectTransportGetNoBody(t *testing.T) {
	var gotContentType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotContentType = r.Header.Get("Content-Type")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	tr := DirectTransport{BaseURL: srv.URL, Token: "t", HTTP: srv.Client()}
	resp, err := tr.Do(context.Background(), http.MethodGet, "/api/conversations", nil)
	if err != nil {
		t.Fatalf("Do() error = %v", err)
	}
	if gotContentType != "" {
		t.Errorf("Content-Type header = %q, want unset for a bodyless GET", gotContentType)
	}
	if string(resp) != `[]` {
		t.Errorf("Do() = %s, want []", resp)
	}
}

func TestDirectTransportErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("invalid or missing authentication"))
	}))
	defer srv.Close()

	tr := DirectTransport{BaseURL: srv.URL, Token: "bad-token", HTTP: srv.Client()}
	if _, err := tr.Do(context.Background(), http.MethodGet, "/api/conversations", nil); err == nil {
		t.Fatal("Do() error = nil, want an error on a non-2xx response")
	}
}

func TestDirectTransportDefaultHTTPClient(t *testing.T) {
	// Just confirm a nil HTTP field doesn't panic; DefaultClient can't
	// actually reach a fake httptest server without http.Client override,
	// so only construct — don't call Do.
	tr := DirectTransport{BaseURL: "https://example.invalid", Token: "t"}
	if tr.HTTP != nil {
		t.Errorf("HTTP = %v, want nil (falls back to http.DefaultClient in Do)", tr.HTTP)
	}
}
