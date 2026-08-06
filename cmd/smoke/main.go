// Command smoke exercises a-factory against REAL exe.dev + Shelley: creates
// one throwaway box, mints it a scoped key, registers a custom model,
// seeds a conversation, reads back the response, and tears everything down.
// Mirrors the manual Phase 0 spike end to end — never part of
// `go test ./...` or `make verify`. Run manually with FACTORY_SMOKE=1 once
// EXE_API_TOKEN/EXE_SSH_PRIVATE_KEY are available, or via a
// workflow_dispatch-only GitHub Actions job. See AGENTS.md and
// docs/spike-findings.md.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/rlweb/a-factory/internal/exe"
	"github.com/rlweb/a-factory/internal/shelley"
)

func main() {
	if os.Getenv("FACTORY_SMOKE") != "1" {
		fmt.Fprintln(os.Stderr, "smoke: refusing to run without FACTORY_SMOKE=1 (this hits a real exe.dev account and spends real money)")
		os.Exit(1)
	}

	issue := flag.Int("issue", 999999, "throwaway issue number to derive the test VM name from")
	vmPrefix := flag.String("vm-prefix", "a-factory-smoke", "VM name prefix, kept distinct from production a-factory boxes")
	keep := flag.Bool("keep", false, "skip teardown, for manual inspection")
	model := flag.String("model", "", "custom model name to register via OpenCode (requires OPENCODE_API_KEY); empty uses Shelley's built-in default model")
	flag.Parse()

	token := os.Getenv("EXE_API_TOKEN")
	if token == "" {
		log.Fatal("smoke: EXE_API_TOKEN is not set")
	}
	sshKeyPEM := os.Getenv("EXE_SSH_PRIVATE_KEY")
	if sshKeyPEM == "" {
		log.Fatal("smoke: EXE_SSH_PRIVATE_KEY is not set")
	}
	signer, err := ssh.ParsePrivateKey([]byte(sshKeyPEM))
	if err != nil {
		log.Fatalf("smoke: parse EXE_SSH_PRIVATE_KEY: %v", err)
	}
	baseURL := os.Getenv("EXE_BASE_URL")
	if baseURL == "" {
		baseURL = "https://exe.dev"
	}

	exeClient := exe.NewHTTPClient(baseURL, token, http.DefaultClient)
	admin := func(host string) exe.AdminClient { return &exe.SSHAdminClient{Host: host, Signer: signer} }
	vm := fmt.Sprintf("%s-issue-%d", *vmPrefix, *issue)
	ctx := context.Background()

	log.Printf("smoke: creating VM %s", vm)
	if _, err := exeClient.Exec(ctx, fmt.Sprintf("new --name=%s --image=ghcr.io/rlweb/a-factory:latest --tag=a-factory-smoke", vm)); err != nil {
		log.Fatalf("smoke: create VM: %v", err)
	}

	if !*keep {
		defer func() {
			log.Printf("smoke: destroying VM %s", vm)
			if _, err := exeClient.Exec(ctx, "rm "+vm); err != nil {
				log.Printf("smoke: destroy VM: %v (you may need to clean this up manually)", err)
			}
			if _, err := admin(exeControlHost).Exec(ctx, "ssh-key remove "+vm); err != nil {
				log.Printf("smoke: revoke key: %v (you may need to clean this up manually)", err)
			}
		}()
	}

	vmAdmin := admin(vm + ".exe.xyz")

	log.Printf("smoke: waiting for Shelley to come up on %s", vm)
	deadline := time.Now().Add(2 * time.Minute)
	for {
		out, err := vmAdmin.Exec(ctx, fmt.Sprintf("curl -sf -o /dev/null -w '%%{http_code}' http://localhost:%d/version", shelley.DefaultPort))
		if err == nil && strings.TrimSpace(out) == "200" {
			break
		}
		if time.Now().After(deadline) {
			log.Fatalf("smoke: Shelley never became ready on %s", vm)
		}
		time.Sleep(3 * time.Second)
	}

	log.Printf("smoke: minting a VM-scoped Shelley key")
	mintOut, err := admin(exeControlHost).Exec(ctx, fmt.Sprintf("ssh-key generate-api-key --vm=%s --label=%s --exp=1d", vm, vm))
	if err != nil {
		log.Fatalf("smoke: mint key: %v", err)
	}
	shelleyToken, err := exe.ParseGeneratedToken(mintOut)
	if err != nil {
		log.Fatalf("smoke: parse minted token: %v", err)
	}

	sh := shelley.New(shelley.DirectTransport{
		BaseURL: fmt.Sprintf("https://%s.shelley.exe.xyz", vm),
		Token:   shelleyToken,
		HTTP:    http.DefaultClient,
	})

	modelID := ""
	if *model != "" {
		opencodeKey := os.Getenv("OPENCODE_API_KEY")
		if opencodeKey == "" {
			log.Fatal("smoke: -model was set but OPENCODE_API_KEY is not")
		}
		log.Printf("smoke: registering custom model %s", *model)
		modelID, err = sh.UpsertCustomModel(ctx, shelley.CustomModel{
			DisplayName:  *model,
			ProviderType: "openai",
			Endpoint:     "https://opencode.ai/zen/go/v1",
			APIKey:       opencodeKey,
			ModelName:    *model,
			MaxTokens:    8192,
		})
		if err != nil {
			log.Fatalf("smoke: register model: %v", err)
		}
		log.Printf("smoke: registered as model_id=%s", modelID)
	}

	log.Printf("smoke: seeding a trivial conversation")
	conversationID, err := sh.NewConversation(ctx, modelID, "Reply with exactly the word: pong")
	if err != nil {
		log.Fatalf("smoke: NewConversation: %v", err)
	}
	log.Printf("smoke: conversation id = %s", conversationID)

	log.Printf("smoke: waiting for a response")
	time.Sleep(15 * time.Second)

	body, err := sh.GetConversation(ctx, conversationID)
	if err != nil {
		log.Fatalf("smoke: GetConversation: %v", err)
	}
	log.Printf("smoke: GetConversation response = %s", body)

	log.Println("smoke: PASS")
}

const exeControlHost = "exe.dev"
