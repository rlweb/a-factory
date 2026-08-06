// Package exe is a client for exe.dev's two command surfaces, confirmed
// against a real account (see docs/spike-findings.md):
//
//   - Client: the bearer-token HTTPS surface (POST /exec). The request body
//     is the literal command exactly as typed at the `ssh exe.dev` REPL
//     prompt — plain text, NOT JSON. Response bodies vary per command
//     (JSON for whoami/ls/help/new; some errors are plain text). Tokens are
//     scoped per-command via --cmds.
//   - AdminClient: real account-authenticated SSH. A handful of operations
//     — minting a VM-scoped API key (`ssh-key generate-api-key --vm=...`)
//     and GitHub-integration lookup/attach (`integrations list`/`attach`) —
//     are refused over the bearer-token path with 403 "command not allowed
//     by token permissions" REGARDLESS of --cmds scope (confirmed: even a
//     token explicitly granted `ssh-key` in --cmds still got 403 on
//     generate-api-key). These need a real SSH private key.
package exe

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Client is exe.dev's bearer-token command surface.
type Client interface {
	// Exec runs command (e.g. "whoami", "ls", "new --name=x --image=y")
	// against the exe.dev control plane and returns the raw response body.
	// Callers parse the shape they expect (see ParseLS, ParseNewVM).
	Exec(ctx context.Context, command string) ([]byte, error)
}

// HTTPClient is the real Client, talking to https://exe.dev/exec.
type HTTPClient struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// NewHTTPClient constructs an HTTPClient. If httpClient is nil, http.DefaultClient
// is used; tests should inject an httptest.Server's client instead.
func NewHTTPClient(baseURL, token string, httpClient *http.Client) *HTTPClient {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &HTTPClient{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		HTTP:    httpClient,
	}
}

// Exec implements Client.
func (c *HTTPClient) Exec(ctx context.Context, command string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/exec", strings.NewReader(command))
	if err != nil {
		return nil, fmt.Errorf("exe: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("exe: request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("exe: read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("exe: %s: %s", resp.Status, describeError(body))
	}
	return body, nil
}

// describeError extracts a human-readable message from an error response:
// exe.dev returns JSON {"error":"..."} for most command-dispatch failures,
// but plain text for some validation errors (e.g. Shelley's "Message is
// required") — fall back to the raw body when it isn't the JSON shape.
func describeError(body []byte) string {
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &e) == nil && e.Error != "" {
		return e.Error
	}
	return strings.TrimSpace(string(body))
}
