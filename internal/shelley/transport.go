package shelley

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Transport is how Client talks to Shelley's HTTP API.
type Transport interface {
	Do(ctx context.Context, method, path string, body []byte) ([]byte, error)
}

// DefaultPort is the port Shelley listens on inside the exeuntu base image
// (used only for the readiness check, which hits it via SSH — see
// internal/orchestrate — since the public route requires an authenticated
// VM-scoped key that doesn't exist until after that same check).
const DefaultPort = 9999

// DirectTransport talks to Shelley over its public HTTPS route
// (https://<vm>.shelley.exe.xyz) using a VM-scoped bearer token minted via
// `ssh-key generate-api-key --vm=<vm>` (internal/exe.AdminClient).
//
// This is the confirmed, sanctioned path (see docs/spike-findings.md) — NOT
// a tunnel through exe.dev's /exec. Shelley's local API on
// localhost:9999 requires an `X-Exedev-Userid` header that only exe.dev's
// own authenticated proxy can supply; that proxy sits in front of the
// public route, which is why a VM-scoped key (rather than raw localhost
// access) is required.
type DirectTransport struct {
	// BaseURL is "https://<vm>.shelley.exe.xyz".
	BaseURL string
	// Token is the VM-scoped bearer token for this specific VM.
	Token string
	// HTTP is the client to use. Nil means http.DefaultClient.
	HTTP *http.Client
}

// Do implements Transport.
func (t DirectTransport) Do(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	client := t.HTTP
	if client == nil {
		client = http.DefaultClient
	}

	var reader io.Reader
	if len(body) > 0 {
		reader = strings.NewReader(string(body))
	}

	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(t.BaseURL, "/")+path, reader)
	if err != nil {
		return nil, fmt.Errorf("shelley: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+t.Token)
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("shelley: request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("shelley: read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("shelley: %s: %s", resp.Status, strings.TrimSpace(string(respBody)))
	}
	return respBody, nil
}
