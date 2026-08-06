package exe

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPClientExec(t *testing.T) {
	var gotAuth, gotContentType, gotPath, gotBody string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		_, _ = w.Write([]byte(`{"email":"test@example.com"}`))
	}))
	defer srv.Close()

	c := NewHTTPClient(srv.URL, "test-token", srv.Client())
	result, err := c.Exec(context.Background(), "whoami")
	if err != nil {
		t.Fatalf("Exec() error = %v", err)
	}

	if gotAuth != "Bearer test-token" {
		t.Errorf("Authorization header = %q, want %q", gotAuth, "Bearer test-token")
	}
	if gotPath != "/exec" {
		t.Errorf("request path = %q, want /exec", gotPath)
	}
	// The request body must be the PLAIN command text, not JSON.
	if gotBody != "whoami" {
		t.Errorf("request body = %q, want plain text %q (not JSON-wrapped)", gotBody, "whoami")
	}
	// No Content-Type should be forced — exe.dev doesn't expect JSON in.
	if gotContentType != "" {
		t.Errorf("Content-Type header = %q, want unset (plain text body)", gotContentType)
	}
	if string(result) != `{"email":"test@example.com"}` {
		t.Errorf("Exec() result = %s, want the raw response body", result)
	}
}

func TestHTTPClientExecJSONError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"command not allowed by token permissions"}`))
	}))
	defer srv.Close()

	c := NewHTTPClient(srv.URL, "bad-token", srv.Client())
	_, err := c.Exec(context.Background(), "ssh-key generate-api-key")
	if err == nil {
		t.Fatal("Exec() error = nil, want an error on a non-2xx response")
	}
	if got := err.Error(); got == "" {
		t.Fatal("expected a non-empty error message")
	}
}

func TestHTTPClientExecPlainTextError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("Message is required"))
	}))
	defer srv.Close()

	c := NewHTTPClient(srv.URL, "token", srv.Client())
	_, err := c.Exec(context.Background(), "shelley prompt vm hi")
	if err == nil {
		t.Fatal("Exec() error = nil, want an error on a non-2xx plain-text response")
	}
}

func TestFakeRecordsCalls(t *testing.T) {
	f := &Fake{}
	_, _ = f.Exec(context.Background(), "ls")
	_, _ = f.Exec(context.Background(), "whoami")

	if len(f.Calls) != 2 || f.Calls[0] != "ls" || f.Calls[1] != "whoami" {
		t.Errorf("Calls = %v, want [ls whoami]", f.Calls)
	}
}

func TestFakeHandler(t *testing.T) {
	f := &Fake{Handler: func(command string) ([]byte, error) {
		return []byte("scripted:" + command), nil
	}}
	result, err := f.Exec(context.Background(), "ls")
	if err != nil {
		t.Fatalf("Exec() error = %v", err)
	}
	if string(result) != "scripted:ls" {
		t.Errorf("Exec() result = %s, want scripted output", result)
	}
}

func TestFakeAdmin(t *testing.T) {
	f := &FakeAdmin{Handler: func(command string) (string, error) {
		return "scripted:" + command, nil
	}}
	result, err := f.Exec(context.Background(), "integrations list")
	if err != nil {
		t.Fatalf("Exec() error = %v", err)
	}
	if result != "scripted:integrations list" {
		t.Errorf("Exec() result = %q, want scripted output", result)
	}
	if len(f.Calls) != 1 || f.Calls[0] != "integrations list" {
		t.Errorf("Calls = %v, want [integrations list]", f.Calls)
	}
}
