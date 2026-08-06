// Command a-factory is the Go CLI bundled into the rlweb/a-factory composite
// action. It reads the triggering GitHub Actions event, routes it, and
// dispatches to the matching orchestrate operation, then exits — see
// AGENTS.md's "No polling from GitHub Actions" section for why it never
// waits on the agent's own work.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"golang.org/x/crypto/ssh"

	"github.com/rlweb/a-factory/internal/config"
	"github.com/rlweb/a-factory/internal/exe"
	"github.com/rlweb/a-factory/internal/ghclient"
	"github.com/rlweb/a-factory/internal/orchestrate"
	"github.com/rlweb/a-factory/internal/router"
	"github.com/rlweb/a-factory/internal/shelley"
)

func main() {
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	eventName := os.Getenv("GITHUB_EVENT_NAME")
	if eventName == "" {
		return fmt.Errorf("GITHUB_EVENT_NAME is not set")
	}

	var payload []byte
	if eventName != "schedule" {
		eventPath := os.Getenv("GITHUB_EVENT_PATH")
		if eventPath == "" {
			return fmt.Errorf("GITHUB_EVENT_PATH is not set")
		}
		var err error
		payload, err = os.ReadFile(eventPath)
		if err != nil {
			return fmt.Errorf("read event payload: %w", err)
		}
	}

	cfg := config.Load()

	decision, err := router.Route(eventName, payload, cfg.StateMarkerPrefix)
	if err != nil {
		return fmt.Errorf("route event: %w", err)
	}
	if decision.Action == router.ActionNone {
		log.Printf("no action: %s", decision.SkipReason)
		return nil
	}

	owner, repo, err := repoFromEnv()
	if err != nil {
		return err
	}

	ghToken := os.Getenv("GITHUB_TOKEN")
	if ghToken == "" {
		return fmt.Errorf("GITHUB_TOKEN is not set")
	}
	gh := ghclient.NewTokenClient(ghToken, owner, repo, nil)

	exeToken := os.Getenv("EXE_API_TOKEN")
	if exeToken == "" {
		return fmt.Errorf("EXE_API_TOKEN is not set")
	}
	exeBaseURL := config.StrEnv("EXE_BASE_URL", "https://exe.dev")
	exeClient := exe.NewHTTPClient(exeBaseURL, exeToken, http.DefaultClient)

	// A second, distinct credential: real account SSH access, required for
	// the handful of operations exe.dev refuses over ANY bearer token
	// regardless of scope (minting a VM-scoped Shelley key, GitHub
	// integration lookup/attach). See docs/spike-findings.md and AGENTS.md.
	sshKeyPEM := os.Getenv("EXE_SSH_PRIVATE_KEY")
	if sshKeyPEM == "" {
		return fmt.Errorf("EXE_SSH_PRIVATE_KEY is not set")
	}
	signer, err := ssh.ParsePrivateKey([]byte(sshKeyPEM))
	if err != nil {
		return fmt.Errorf("parse EXE_SSH_PRIVATE_KEY: %w", err)
	}

	o := &orchestrate.Orchestrator{
		Exe: exeClient,
		Admin: func(host string) exe.AdminClient {
			return &exe.SSHAdminClient{Host: host, Signer: signer}
		},
		NewShelley: func(vm, token string) orchestrate.ShelleyClient {
			return shelley.New(shelley.DirectTransport{
				BaseURL: "https://" + vm + ".shelley.exe.xyz",
				Token:   token,
				HTTP:    http.DefaultClient,
			})
		},
		GitHub:    gh,
		Config:    cfg,
		RepoOwner: owner,
		RepoName:  repo,
	}

	return dispatch(ctx, o, decision)
}

// dispatch maps a routed Decision to the Orchestrator method that handles
// it. Kept separate from run so it's testable against a fake-backed
// Orchestrator with no environment/network setup.
func dispatch(ctx context.Context, o *orchestrate.Orchestrator, d router.Decision) error {
	switch d.Action {
	case router.ActionProvision:
		return o.Provision(ctx, d)
	case router.ActionRelayIssueComment:
		return o.RelayIssueComment(ctx, d)
	case router.ActionRelayReviewComment:
		return o.RelayReviewComment(ctx, d)
	case router.ActionRelayReview:
		return o.RelayReview(ctx, d)
	case router.ActionTeardown:
		return o.Teardown(ctx, d)
	case router.ActionReap:
		return o.Reap(ctx)
	default:
		return fmt.Errorf("unhandled action %s", d.Action)
	}
}

func repoFromEnv() (owner, repo string, err error) {
	full := os.Getenv("GITHUB_REPOSITORY")
	parts := strings.SplitN(full, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("GITHUB_REPOSITORY must be set as owner/repo, got %q", full)
	}
	return parts[0], parts[1], nil
}
