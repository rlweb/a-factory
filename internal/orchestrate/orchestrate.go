// Package orchestrate wires exe.dev + Shelley + GitHub into the four
// operations the CLI's event dispatch calls into: Provision, the three
// Relay* variants, Teardown, and Reap.
//
// The design here is the confirmed end state from a real exe.dev Phase 0
// spike (docs/spike-findings.md), not a guess: two exe.dev command
// surfaces, used for different things because exe.dev itself restricts
// them differently —
//
//   - Exe (bearer-token HTTPS /exec): VM lifecycle only — new/rm/ls. Safe
//     to scope narrowly and store as a repo secret.
//   - Admin (real account SSH): the operations exe.dev refuses over ANY
//     bearer token regardless of --cmds scope — minting a VM-scoped Shelley
//     key (`ssh-key generate-api-key --vm=...`) and GitHub-integration
//     lookup/attach. Also used, connected directly to a VM's own hostname
//     rather than the exe.dev control host, for the readiness check and
//     repo clone (both confirmed to work over plain SSH to <vm>.exe.xyz,
//     exactly as tested manually in the spike).
//
// Once a VM-scoped key is minted, all Shelley traffic (seeding, relaying)
// goes over Shelley's public HTTPS route with that key — confirmed
// fire-and-forget, confirmed to require neither Exe nor Admin.
package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/rlweb/a-factory/internal/classify"
	"github.com/rlweb/a-factory/internal/config"
	"github.com/rlweb/a-factory/internal/exe"
	"github.com/rlweb/a-factory/internal/prompts"
	"github.com/rlweb/a-factory/internal/router"
	"github.com/rlweb/a-factory/internal/shelley"
	"github.com/rlweb/a-factory/internal/state"
)

// exeControlHost is exe.dev's own SSH/control host, used for every Admin
// call except the direct-to-VM ones (readiness check, repo clone).
const exeControlHost = "exe.dev"

// vmHostSuffix turns a VM name into its own directly-reachable SSH host.
const vmHostSuffix = ".exe.xyz"

// GitHub is the subset of ghclient.Client orchestrate needs. Defined here
// (rather than depended on concretely) so tests substitute a fake.
type GitHub interface {
	Comment(ctx context.Context, number int, body string) error
	ListComments(ctx context.Context, number int) ([]state.Comment, error)
	PRBody(ctx context.Context, number int) (string, error)
	OpenIssueNumbers(ctx context.Context, labels ...string) ([]int, error)
}

// ShelleyClient is the subset of *shelley.Client orchestrate needs.
type ShelleyClient interface {
	NewConversation(ctx context.Context, model, message string) (string, error)
	Chat(ctx context.Context, conversationID, message string) error
	UpsertCustomModel(ctx context.Context, m shelley.CustomModel) (string, error)
}

// NewShelleyClient constructs a ShelleyClient bound to a specific VM and its
// VM-scoped bearer token. In production this is
// shelley.New(shelley.DirectTransport{BaseURL: "https://"+vm+".shelley.exe.xyz", Token: token});
// tests substitute a fake.
type NewShelleyClient func(vm, token string) ShelleyClient

// NewAdminClient constructs an exe.AdminClient targeting host — either
// exeControlHost for account-scoped operations, or a VM's own hostname for
// direct-to-VM commands. In production this is the same SSH signer, a
// different host per call; tests substitute a fake.
type NewAdminClient func(host string) exe.AdminClient

// Orchestrator wires exe.dev + Shelley + GitHub together.
type Orchestrator struct {
	Exe        exe.Client
	Admin      NewAdminClient
	NewShelley NewShelleyClient
	GitHub     GitHub
	Config     config.Config

	// RepoOwner/RepoName identify the repo Provision checks out into each
	// new box, via a GitHub integration already configured on the exe.dev
	// account's dashboard for that repo.
	RepoOwner string
	RepoName  string

	// ReadyTimeout/ReadyInterval bound Provision's wait for a freshly
	// created box to come up. This is a normal bounded startup wait, not
	// the prohibited "poll the agent for completion" pattern — see
	// AGENTS.md's "No polling from GitHub Actions" section. Zero values
	// default to 2m/3s.
	ReadyTimeout  time.Duration
	ReadyInterval time.Duration
}

// VMName is a pure function of issue number — no lookup is ever needed to
// find a box.
func VMName(prefix string, issue int) string {
	return fmt.Sprintf("%s-issue-%d", prefix, issue)
}

// Provision classifies the issue, creates its box, mints it a scoped
// Shelley key, attaches GitHub repo access, clones the repo, registers the
// chosen model, seeds a Shelley conversation with the rendered prompt, and
// posts the state marker comment that later Relay calls resolve back to
// this conversation.
//
// If any step after VM creation fails, Provision tears the box back down
// (best-effort) rather than leaving an orphaned, billing box that never got
// a state marker and so isn't relay-reachable — see AGENTS.md.
func (o *Orchestrator) Provision(ctx context.Context, d router.Decision) (err error) {
	result, ok, reason := classify.Classify(d.Labels, o.Config.CheapModel, o.Config.StrongModel)
	if !ok {
		return o.GitHub.Comment(ctx, d.Issue, fmt.Sprintf(
			"I can't start work on this issue yet: %s. Add exactly one of `type:ticket`, `type:bug`, or `type:epic` and I'll pick it up.",
			reason,
		))
	}

	vm := VMName(o.Config.VMPrefix, d.Issue)

	log.Printf("orchestrate: provision #%d: creating VM %s (image=%s cpu=%s memory=%s disk=%s)",
		d.Issue, vm, o.Config.BoxImage, o.Config.VMCPU, o.Config.VMMemory, o.Config.VMDisk)
	newBody, err := o.Exe.Exec(ctx, createVMCommand(vm, o.Config))
	if err != nil {
		return fmt.Errorf("orchestrate: provision #%d: create VM: %w", d.Issue, err)
	}
	newResult, err := exe.ParseNewVM(newBody)
	if err != nil {
		return fmt.Errorf("orchestrate: provision #%d: parse new-VM response: %w", d.Issue, err)
	}
	if newResult.VMName != vm {
		return fmt.Errorf("orchestrate: provision #%d: exe.dev created VM %q, expected %q", d.Issue, newResult.VMName, vm)
	}
	log.Printf("orchestrate: provision #%d: VM %s created", d.Issue, vm)

	committed := false
	defer func() {
		if !committed {
			o.cleanupFailedProvision(vm)
		}
	}()

	if err := o.waitReady(ctx, vm); err != nil {
		return fmt.Errorf("orchestrate: provision #%d: wait ready: %w", d.Issue, err)
	}
	log.Printf("orchestrate: provision #%d: shelley on %s is ready", d.Issue, vm)

	ctrlAdmin := o.Admin(exeControlHost)

	log.Printf("orchestrate: provision #%d: minting Shelley key for %s", d.Issue, vm)
	mintOut, err := ctrlAdmin.Exec(ctx, mintKeyCommand(vm, o.Config.ShelleyTokenExpiry))
	if err != nil {
		return fmt.Errorf("orchestrate: provision #%d: mint Shelley key: %w", d.Issue, err)
	}
	token, err := exe.ParseGeneratedToken(mintOut)
	if err != nil {
		return fmt.Errorf("orchestrate: provision #%d: %w", d.Issue, err)
	}

	log.Printf("orchestrate: provision #%d: looking up GitHub integration for %s/%s", d.Issue, o.RepoOwner, o.RepoName)
	listOut, err := ctrlAdmin.Exec(ctx, integrationsListCommand())
	if err != nil {
		return fmt.Errorf("orchestrate: provision #%d: list GitHub integrations: %w", d.Issue, err)
	}
	integrationName, ok := exe.FindGitHubIntegration(exe.ParseIntegrationsList(listOut), o.RepoOwner, o.RepoName)
	if !ok {
		return o.GitHub.Comment(ctx, d.Issue, fmt.Sprintf(
			"I can't start work on this issue: no exe.dev GitHub integration is configured for %s/%s. "+
				"Set one up on the exe.dev dashboard, then re-label this issue to retry.",
			o.RepoOwner, o.RepoName,
		))
	}
	log.Printf("orchestrate: provision #%d: attaching integration %s to %s", d.Issue, integrationName, vm)
	if _, err := ctrlAdmin.Exec(ctx, attachIntegrationCommand(integrationName, vm)); err != nil {
		return fmt.Errorf("orchestrate: provision #%d: attach GitHub integration: %w", d.Issue, err)
	}

	vmAdmin := o.Admin(vm + vmHostSuffix)
	log.Printf("orchestrate: provision #%d: cloning %s/%s onto %s", d.Issue, o.RepoOwner, o.RepoName, vm)
	if _, err := vmAdmin.Exec(ctx, cloneCommand(o.RepoOwner, o.RepoName)); err != nil {
		return fmt.Errorf("orchestrate: provision #%d: clone repo: %w", d.Issue, err)
	}

	sh := o.NewShelley(vm, token)

	log.Printf("orchestrate: provision #%d: registering model %s", d.Issue, result.Model)
	modelID, err := sh.UpsertCustomModel(ctx, shelley.CustomModel{
		DisplayName:  result.Model,
		ProviderType: "openai",
		Endpoint:     o.Config.OpenCodeEndpoint,
		APIKey:       o.Config.OpenCodeAPIKey,
		ModelName:    result.Model,
		MaxTokens:    o.Config.MaxTokens,
	})
	if err != nil {
		return fmt.Errorf("orchestrate: provision #%d: register model: %w", d.Issue, err)
	}

	prompt, err := prompts.Render(result.Template, prompts.Data{Number: d.Issue, Title: d.Title, Body: d.Body})
	if err != nil {
		return fmt.Errorf("orchestrate: provision #%d: render prompt: %w", d.Issue, err)
	}

	log.Printf("orchestrate: provision #%d: seeding Shelley conversation on model %s", d.Issue, modelID)
	conversationID, err := sh.NewConversation(ctx, modelID, prompt)
	if err != nil {
		return fmt.Errorf("orchestrate: provision #%d: seed conversation: %w", d.Issue, err)
	}

	marker := state.Format(o.Config.StateMarkerPrefix, state.State{
		VM: vm, Conversation: conversationID, Mode: result.Mode.String(), Model: modelID, ShelleyToken: token,
	})
	if err := o.GitHub.Comment(ctx, d.Issue, marker); err != nil {
		return fmt.Errorf("orchestrate: provision #%d: post state comment: %w", d.Issue, err)
	}

	log.Printf("orchestrate: provision #%d: done, conversation %s on %s", d.Issue, conversationID, vm)
	committed = true
	return nil
}

// cleanupFailedProvision best-effort tears down a partially-provisioned box
// so a mid-flow failure doesn't leave an orphaned, billing VM with no state
// marker (which Reap couldn't otherwise identify as abandoned). Uses a
// detached context so cleanup still runs if the original ctx is
// already canceled/timed out.
func (o *Orchestrator) cleanupFailedProvision(vm string) {
	ctx := context.WithoutCancel(context.Background())
	log.Printf("orchestrate: provision: cleaning up failed provision of %s", vm)
	if _, err := o.Exe.Exec(ctx, destroyVMCommand(vm)); err != nil {
		log.Printf("orchestrate: provision: cleanup: destroy VM %s failed: %v", vm, err)
	}
	if _, err := o.Admin(exeControlHost).Exec(ctx, removeKeyCommand(vm)); err != nil {
		log.Printf("orchestrate: provision: cleanup: remove Shelley key for %s failed: %v", vm, err)
	}
}

func (o *Orchestrator) waitReady(ctx context.Context, vm string) error {
	timeout := o.ReadyTimeout
	if timeout == 0 {
		timeout = 2 * time.Minute
	}
	interval := o.ReadyInterval
	if interval == 0 {
		interval = 3 * time.Second
	}

	admin := o.Admin(vm + vmHostSuffix)
	deadline := time.Now().Add(timeout)
	for attempt := 1; ; attempt++ {
		out, err := admin.Exec(ctx, versionCheckCommand())
		if err == nil && strings.TrimSpace(out) == "200" {
			return nil
		}
		log.Printf("orchestrate: provision: waiting for shelley on %s (attempt %d, out=%q err=%v)",
			vm, attempt, strings.TrimSpace(out), err)
		if time.Now().After(deadline) {
			return fmt.Errorf("shelley on %s did not become ready within %s", vm, timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
	}
}

// resolveConversation looks up the state marker posted on issue at Provision
// time.
func (o *Orchestrator) resolveConversation(ctx context.Context, issue int) (state.State, error) {
	comments, err := o.GitHub.ListComments(ctx, issue)
	if err != nil {
		return state.State{}, fmt.Errorf("list comments on #%d: %w", issue, err)
	}
	st, ok := state.FindLatest(o.Config.StateMarkerPrefix, comments)
	if !ok {
		return state.State{}, fmt.Errorf("no state marker found on #%d; was it ever provisioned?", issue)
	}
	return st, nil
}

// resolveConversationFromPR resolves a PR back to its issue via GitHub's own
// closing keywords in the PR body (every ticket/bug prompt requires the
// agent's PR to say "Closes #N"), then to that issue's state marker.
func (o *Orchestrator) resolveConversationFromPR(ctx context.Context, pr int) (state.State, error) {
	body, err := o.GitHub.PRBody(ctx, pr)
	if err != nil {
		return state.State{}, fmt.Errorf("get PR #%d body: %w", pr, err)
	}
	issue, ok := state.IssueFromClosingKeywords(body)
	if !ok {
		return state.State{}, fmt.Errorf("PR #%d body has no closing keyword (e.g. \"Closes #N\"); can't resolve its issue", pr)
	}
	return o.resolveConversation(ctx, issue)
}

// RelayIssueComment relays a human issue comment into the running session.
func (o *Orchestrator) RelayIssueComment(ctx context.Context, d router.Decision) error {
	st, err := o.resolveConversation(ctx, d.Issue)
	if err != nil {
		return fmt.Errorf("orchestrate: relay issue comment on #%d: %w", d.Issue, err)
	}
	prompt, err := prompts.Render(prompts.PRComment, prompts.Data{Author: d.Author, Body: d.Body})
	if err != nil {
		return fmt.Errorf("orchestrate: relay issue comment on #%d: render prompt: %w", d.Issue, err)
	}
	if err := o.NewShelley(st.VM, st.ShelleyToken).Chat(ctx, st.Conversation, prompt); err != nil {
		return fmt.Errorf("orchestrate: relay issue comment on #%d: %w", d.Issue, err)
	}
	return nil
}

// RelayReviewComment relays an inline PR review comment (path/line) into the
// running session.
func (o *Orchestrator) RelayReviewComment(ctx context.Context, d router.Decision) error {
	st, err := o.resolveConversationFromPR(ctx, d.PR)
	if err != nil {
		return fmt.Errorf("orchestrate: relay review comment on PR #%d: %w", d.PR, err)
	}
	prompt, err := prompts.Render(prompts.InlineComment, prompts.Data{Author: d.Author, Body: d.Body, Path: d.Path, Line: d.Line})
	if err != nil {
		return fmt.Errorf("orchestrate: relay review comment on PR #%d: render prompt: %w", d.PR, err)
	}
	if err := o.NewShelley(st.VM, st.ShelleyToken).Chat(ctx, st.Conversation, prompt); err != nil {
		return fmt.Errorf("orchestrate: relay review comment on PR #%d: %w", d.PR, err)
	}
	return nil
}

// RelayReview relays a whole PR review (approve/request-changes + body) into
// the running session. The doc's spec provides no dedicated template for a
// full review, so it reuses the generic PR-comment template with the review
// state folded into the body.
func (o *Orchestrator) RelayReview(ctx context.Context, d router.Decision) error {
	st, err := o.resolveConversationFromPR(ctx, d.PR)
	if err != nil {
		return fmt.Errorf("orchestrate: relay review on PR #%d: %w", d.PR, err)
	}
	body := d.Body
	if d.ReviewState != "" {
		body = fmt.Sprintf("[%s] %s", d.ReviewState, d.Body)
	}
	prompt, err := prompts.Render(prompts.PRComment, prompts.Data{Author: d.Author, Body: body})
	if err != nil {
		return fmt.Errorf("orchestrate: relay review on PR #%d: render prompt: %w", d.PR, err)
	}
	if err := o.NewShelley(st.VM, st.ShelleyToken).Chat(ctx, st.Conversation, prompt); err != nil {
		return fmt.Errorf("orchestrate: relay review on PR #%d: %w", d.PR, err)
	}
	return nil
}

// Teardown destroys the box for a closed issue and revokes its Shelley key
// (best-effort — the box's own deletion is what actually matters for cost;
// the key revocation is hygiene on top).
func (o *Orchestrator) Teardown(ctx context.Context, d router.Decision) error {
	vm := VMName(o.Config.VMPrefix, d.Issue)
	if _, err := o.Exe.Exec(ctx, destroyVMCommand(vm)); err != nil {
		return fmt.Errorf("orchestrate: teardown #%d: %w", d.Issue, err)
	}
	_, _ = o.Admin(exeControlHost).Exec(ctx, removeKeyCommand(vm))
	return nil
}

// Reap destroys any a-factory box whose issue is no longer open — the cron
// safety net for anything the issues-closed handler missed.
func (o *Orchestrator) Reap(ctx context.Context) error {
	open, err := o.GitHub.OpenIssueNumbers(ctx, "type:ticket", "type:bug", "type:epic")
	if err != nil {
		return fmt.Errorf("orchestrate: reap: list open issues: %w", err)
	}

	body, err := o.Exe.Exec(ctx, listVMsCommand())
	if err != nil {
		return fmt.Errorf("orchestrate: reap: list VMs: %w", err)
	}
	vms, err := exe.ParseLS(body)
	if err != nil {
		return fmt.Errorf("orchestrate: reap: %w", err)
	}

	wanted := make(map[string]bool, len(open))
	for _, issue := range open {
		wanted[VMName(o.Config.VMPrefix, issue)] = true
	}

	var errs []error
	for _, vm := range vms {
		if !hasTag(vm.Tags, o.Config.VMTag) || wanted[vm.VMName] {
			continue
		}
		if _, err := o.Exe.Exec(ctx, destroyVMCommand(vm.VMName)); err != nil {
			errs = append(errs, fmt.Errorf("destroy orphaned box %s: %w", vm.VMName, err))
			continue
		}
		_, _ = o.Admin(exeControlHost).Exec(ctx, removeKeyCommand(vm.VMName))
	}
	return errors.Join(errs...)
}

func hasTag(tags []string, want string) bool {
	for _, t := range tags {
		if t == want {
			return true
		}
	}
	return false
}

// The exe.dev command strings below are isolated in this one place. Every
// one is confirmed against a real account — see docs/spike-findings.md —
// EXCEPT where noted.

func createVMCommand(vm string, cfg config.Config) string {
	args := []string{
		"new",
		"--name=" + shellQuote(vm),
		"--image=" + shellQuote(cfg.BoxImage),
		"--tag=" + shellQuote(cfg.VMTag),
		"--comment=" + shellQuote("Created by a-factory via GitHub Actions."),
		"--json",
		"--no-email",
	}
	for _, tag := range cfg.VMExtraTags {
		args = append(args, "--tag="+shellQuote(tag))
	}
	if cfg.VMCPU != "" {
		args = append(args, "--cpu="+shellQuote(cfg.VMCPU))
	}
	if cfg.VMMemory != "" {
		args = append(args, "--memory="+shellQuote(cfg.VMMemory))
	}
	if cfg.VMDisk != "" {
		args = append(args, "--disk="+shellQuote(cfg.VMDisk))
	}
	// GH_HOST always points `gh` at exe.dev's GitHub-integration proxy —
	// not a per-repo choice, so it's unconditional rather than routed
	// through cfg.VMEnv.
	args = append(args, "--env", shellQuote("GH_HOST="+githubIntegrationProxyHost))
	for _, env := range cfg.VMEnv {
		args = append(args, "--env", shellQuote(env))
	}
	if cfg.VMPool != "" {
		args = append(args, "--pool="+shellQuote(cfg.VMPool))
	}
	for _, integration := range cfg.VMIntegrations {
		args = append(args, "--integration="+shellQuote(integration))
	}
	if cfg.VMRegistryAuth != "" {
		args = append(args, "--registry-auth="+shellQuote(cfg.VMRegistryAuth))
	}
	if cfg.VMSetupScript != "" {
		args = append(args, "--setup-script="+shellQuote(cfg.VMSetupScript))
	}
	return strings.Join(args, " ")
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func destroyVMCommand(vm string) string {
	return "rm " + vm
}

func listVMsCommand() string {
	return "ls"
}

// mintKeyCommand mints a Shelley key scoped to vm, labeled with the VM's own
// name so Teardown/Reap can revoke it later with no state lookup needed.
func mintKeyCommand(vm, expiry string) string {
	return fmt.Sprintf("ssh-key generate-api-key --vm=%s --label=%s --exp=%s", vm, vm, expiry)
}

func removeKeyCommand(vm string) string {
	return "ssh-key remove " + vm
}

func integrationsListCommand() string {
	return "integrations list"
}

// attachIntegrationCommand attaches permanently (no --for/--until): the
// agent needs GitHub access for the box's whole lifetime, which can span
// long-running issues, not a short spike-testing window.
func attachIntegrationCommand(integrationName, vm string) string {
	return fmt.Sprintf("integrations attach %s vm:%s", integrationName, vm)
}

// versionCheckCommand is run directly against a VM's own SSH host (not
// nested through exe.dev's `ssh <vm> ...` REPL verb).
func versionCheckCommand() string {
	return fmt.Sprintf("curl -sf -o /dev/null -w '%%{http_code}' http://localhost:%d/version", shelley.DefaultPort)
}

// githubIntegrationProxyHost is exe.dev's fixed GitHub-integration proxy
// (see https://exe.dev/docs/integrations-github) — one host for every
// integration on the account, disambiguated by the owner/repo path, not a
// per-integration subdomain. No PAT or secret ever touches the box.
const githubIntegrationProxyHost = "github.int.exe.xyz"

// cloneCommand clones owner/repo through the GitHub-integration proxy.
// Clones under /home/exedev — exe.dev's own documented workspace directory
// (confirmed: /root wasn't writable even as root).
func cloneCommand(owner, repo string) string {
	url := fmt.Sprintf("https://%s/%s/%s.git", githubIntegrationProxyHost, owner, repo)
	return fmt.Sprintf("git clone %s /home/exedev/workspace", url)
}
