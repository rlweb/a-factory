package orchestrate

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/rlweb/a-factory/internal/config"
	"github.com/rlweb/a-factory/internal/exe"
	"github.com/rlweb/a-factory/internal/router"
	"github.com/rlweb/a-factory/internal/shelley"
	"github.com/rlweb/a-factory/internal/state"
)

// --- fakes ---

type commentCall struct {
	number int
	body   string
}

type fakeGitHub struct {
	comments   map[int][]state.Comment
	prBodies   map[int]string
	openIssues []int
	err        error

	commentCalls []commentCall
}

func newFakeGitHub() *fakeGitHub {
	return &fakeGitHub{comments: map[int][]state.Comment{}, prBodies: map[int]string{}}
}

func (f *fakeGitHub) Comment(_ context.Context, number int, body string) error {
	if f.err != nil {
		return f.err
	}
	f.commentCalls = append(f.commentCalls, commentCall{number, body})
	f.comments[number] = append(f.comments[number], state.Comment{Body: body})
	return nil
}

func (f *fakeGitHub) ListComments(_ context.Context, number int) ([]state.Comment, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.comments[number], nil
}

func (f *fakeGitHub) PRBody(_ context.Context, number int) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	return f.prBodies[number], nil
}

func (f *fakeGitHub) OpenIssueNumbers(_ context.Context, _ ...string) ([]int, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.openIssues, nil
}

type shelleyCall struct {
	kind    string // "new_conversation" | "chat" | "upsert_custom_model"
	model   string
	message string
}

type fakeShelley struct {
	conversationID string
	modelID        string
	err            error
	calls          []shelleyCall
}

func (f *fakeShelley) NewConversation(_ context.Context, model, message string) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.calls = append(f.calls, shelleyCall{kind: "new_conversation", model: model, message: message})
	return f.conversationID, nil
}

func (f *fakeShelley) Chat(_ context.Context, _, message string) error {
	if f.err != nil {
		return f.err
	}
	f.calls = append(f.calls, shelleyCall{kind: "chat", message: message})
	return nil
}

func (f *fakeShelley) UpsertCustomModel(_ context.Context, m shelley.CustomModel) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	f.calls = append(f.calls, shelleyCall{kind: "upsert_custom_model", model: m.ModelName})
	modelID := f.modelID
	if modelID == "" {
		modelID = m.ModelName + "-opencode-ai"
	}
	return modelID, nil
}

// shelleyRegistry hands out one fakeShelley per VM name and lets tests look
// them back up, mirroring how NewShelleyClient is bound per-VM+token in
// production.
type shelleyRegistry struct {
	byVM map[string]*fakeShelley
}

func newShelleyRegistry() *shelleyRegistry {
	return &shelleyRegistry{byVM: map[string]*fakeShelley{}}
}

func (r *shelleyRegistry) newClient(vm, _ string) ShelleyClient {
	if r.byVM[vm] == nil {
		r.byVM[vm] = &fakeShelley{conversationID: "c_" + vm}
	}
	return r.byVM[vm]
}

// adminCall records one AdminClient.Exec invocation, including which host
// it targeted — production constructs a differently-hosted client per call
// (exe.dev vs a VM's own hostname), so tests need to distinguish them.
type adminCall struct {
	Host    string
	Command string
}

type fakeAdmin struct {
	Calls   []adminCall
	Handler func(host, command string) (string, error)
}

func (f *fakeAdmin) factory() NewAdminClient {
	return func(host string) exe.AdminClient {
		return &fakeAdminHost{host: host, shared: f}
	}
}

type fakeAdminHost struct {
	host   string
	shared *fakeAdmin
}

func (f *fakeAdminHost) Exec(_ context.Context, command string) (string, error) {
	f.shared.Calls = append(f.shared.Calls, adminCall{Host: f.host, Command: command})
	if f.shared.Handler != nil {
		return f.shared.Handler(f.host, command)
	}
	return "", nil
}

// --- test setup helpers ---

func testConfig() config.Config {
	return config.Config{
		VMPrefix:           "a-factory",
		StateMarkerPrefix:  "<!-- a-factory:state",
		CheapModel:         "deepseek-v4-flash",
		StrongModel:        "deepseek-v4-pro",
		BoxImage:           "ghcr.io/rlweb/a-factory:latest",
		VMTag:              "a-factory",
		ShelleyTokenExpiry: "30d",
	}
}

// happyPathExeHandler answers `new` with a matching vm_name and `ls` with an
// empty list — enough for tests that don't care about those specifics.
func happyPathExeHandler(vmName string) func(command string) ([]byte, error) {
	return func(command string) ([]byte, error) {
		if strings.HasPrefix(command, "new ") {
			return []byte(`{"vm_name":"` + vmName + `","shelley_url":"https://` + vmName + `.shelley.exe.xyz"}`), nil
		}
		return []byte(`{"vms":[]}`), nil
	}
}

// happyPathAdminHandler answers every admin call needed for a full
// Provision: readiness, key mint, integration list/attach, clone.
func happyPathAdminHandler(vm, integrationName, owner, repo, token string) func(host, command string) (string, error) {
	return func(host, command string) (string, error) {
		switch {
		case strings.Contains(command, "curl"):
			return "200", nil
		case strings.HasPrefix(command, "ssh-key generate-api-key"):
			return "Token:\n  " + token + "\n", nil
		case command == "integrations list":
			return integrationName + "  github  repos=" + owner + "/" + repo + "  tag:x\n", nil
		case strings.HasPrefix(command, "integrations attach"):
			return "Attached.\n", nil
		case strings.HasPrefix(command, "git clone"):
			return "", nil
		default:
			return "", nil
		}
	}
}

func newTestOrchestrator(t *testing.T, fakeExe *exe.Fake, admin *fakeAdmin, gh *fakeGitHub, sr *shelleyRegistry) *Orchestrator {
	t.Helper()
	return &Orchestrator{
		Exe:           fakeExe,
		Admin:         admin.factory(),
		NewShelley:    sr.newClient,
		GitHub:        gh,
		Config:        testConfig(),
		RepoOwner:     "rlweb",
		RepoName:      "example",
		ReadyTimeout:  50 * time.Millisecond,
		ReadyInterval: time.Millisecond,
	}
}

// --- Provision ---

func TestProvisionSuccess(t *testing.T) {
	vm := "a-factory-issue-42"
	fakeExe := &exe.Fake{Handler: happyPathExeHandler(vm)}
	admin := &fakeAdmin{Handler: happyPathAdminHandler(vm, "rlweb-example", "rlweb", "example", "exe1.TESTTOKEN")}
	gh := newFakeGitHub()
	sr := newShelleyRegistry()
	o := newTestOrchestrator(t, fakeExe, admin, gh, sr)

	d := router.Decision{
		Action: router.ActionProvision, Issue: 42,
		Title: "Add dark mode toggle", Body: "Users want a dark mode toggle in settings.",
		Labels: []string{"type:ticket"},
	}

	if err := o.Provision(context.Background(), d); err != nil {
		t.Fatalf("Provision() error = %v", err)
	}

	// A VM was created.
	if len(fakeExe.Calls) < 1 || !strings.HasPrefix(fakeExe.Calls[0], "new ") || !strings.Contains(fakeExe.Calls[0], vm) {
		t.Fatalf("exe.Calls = %+v, want a create-VM call naming %s first", fakeExe.Calls, vm)
	}

	// Readiness was checked directly against the VM's own host.
	var sawReadiness, sawMint, sawList, sawAttach, sawClone bool
	for _, c := range admin.Calls {
		switch {
		case strings.Contains(c.Command, "curl") && c.Host == vm+vmHostSuffix:
			sawReadiness = true
		case strings.HasPrefix(c.Command, "ssh-key generate-api-key") && c.Host == exeControlHost:
			sawMint = true
			if !strings.Contains(c.Command, "--vm="+vm) {
				t.Errorf("mint command = %q, want it scoped to --vm=%s", c.Command, vm)
			}
		case c.Command == "integrations list" && c.Host == exeControlHost:
			sawList = true
		case strings.HasPrefix(c.Command, "integrations attach") && c.Host == exeControlHost:
			sawAttach = true
			if !strings.Contains(c.Command, "rlweb-example") || !strings.Contains(c.Command, "vm:"+vm) {
				t.Errorf("attach command = %q, want it to attach rlweb-example to vm:%s", c.Command, vm)
			}
		case strings.HasPrefix(c.Command, "git clone") && c.Host == vm+vmHostSuffix:
			sawClone = true
			if !strings.Contains(c.Command, "rlweb-example.int.exe.xyz/rlweb/example.git") {
				t.Errorf("clone command = %q, want the integration-named host", c.Command)
			}
		}
	}
	if !sawReadiness {
		t.Error("never checked readiness against the VM's own host")
	}
	if !sawMint {
		t.Error("never minted a VM-scoped Shelley key")
	}
	if !sawList {
		t.Error("never listed GitHub integrations")
	}
	if !sawAttach {
		t.Error("never attached the GitHub integration")
	}
	if !sawClone {
		t.Error("never cloned the repo")
	}

	// The custom model was registered, then the conversation was seeded, in order.
	sh := sr.byVM[vm]
	if sh == nil || len(sh.calls) != 2 {
		t.Fatalf("shelley calls for %s = %+v, want exactly two calls (register model, then seed conversation)", vm, sh)
	}
	if sh.calls[0].kind != "upsert_custom_model" || sh.calls[0].model != "deepseek-v4-flash" {
		t.Errorf("first shelley call = %+v, want upsert_custom_model for deepseek-v4-flash", sh.calls[0])
	}
	if sh.calls[1].kind != "new_conversation" || sh.calls[1].model != "deepseek-v4-flash-opencode-ai" {
		t.Errorf("second shelley call = %+v, want new_conversation using the ASSIGNED model_id", sh.calls[1])
	}
	if !strings.Contains(sh.calls[1].message, "TICKET #42: Add dark mode toggle") {
		t.Errorf("seed prompt = %q, want it to contain the rendered ticket header", sh.calls[1].message)
	}

	// The state marker was posted on the issue, including the VM-scoped token.
	if len(gh.commentCalls) != 1 || gh.commentCalls[0].number != 42 {
		t.Fatalf("commentCalls = %+v, want one comment on #42", gh.commentCalls)
	}
	posted := gh.commentCalls[0].body
	for _, want := range []string{"vm=" + vm, "conversation=c_" + vm, "mode=build", "model=deepseek-v4-flash-opencode-ai", "shelley_token=exe1.TESTTOKEN"} {
		if !strings.Contains(posted, want) {
			t.Errorf("posted state comment = %q, want it to contain %q", posted, want)
		}
	}
}

func TestCreateVMCommandIncludesConfiguredOptions(t *testing.T) {
	cfg := testConfig()
	cfg.VMExtraTags = []string{"preview", "custom tag"}
	cfg.VMCPU = "4"
	cfg.VMMemory = "16GB"
	cfg.VMDisk = "50GB"
	cfg.VMEnv = []string{"FOO=bar", "QUOTED=it's safe"}
	cfg.VMPool = "team-pool"
	cfg.VMIntegrations = []string{"monitoring"}
	cfg.VMRegistryAuth = "user:p@ss"
	cfg.VMSetupScript = "#!/bin/sh\necho ready"

	got := createVMCommand("a-factory-issue-42", cfg)
	for _, want := range []string{
		"new --name='a-factory-issue-42'",
		"--image='ghcr.io/rlweb/a-factory:latest'",
		"--tag='a-factory'",
		"--tag='preview'",
		"--tag='custom tag'",
		"--cpu='4'",
		"--memory='16GB'",
		"--disk='50GB'",
		"--env 'FOO=bar'",
		"--env 'QUOTED=it'\\''s safe'",
		"--pool='team-pool'",
		"--integration='monitoring'",
		"--registry-auth='user:p@ss'",
		"--setup-script='#!/bin/sh\necho ready'",
		"--comment='Created by a-factory via GitHub Actions.'",
		"--json",
		"--no-email",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("createVMCommand() = %q, want substring %q", got, want)
		}
	}
	if strings.Contains(got, "--prompt") {
		t.Errorf("createVMCommand() = %q, must not include --prompt", got)
	}
}

func TestProvisionAmbiguousLabelsDoesNotCreateAVM(t *testing.T) {
	fakeExe := &exe.Fake{Handler: happyPathExeHandler("unused")}
	admin := &fakeAdmin{}
	gh := newFakeGitHub()
	sr := newShelleyRegistry()
	o := newTestOrchestrator(t, fakeExe, admin, gh, sr)

	d := router.Decision{Action: router.ActionProvision, Issue: 44, Labels: []string{"type:ticket", "type:bug"}}

	if err := o.Provision(context.Background(), d); err != nil {
		t.Fatalf("Provision() error = %v, want nil (ambiguity is reported via a comment, not an error)", err)
	}
	if len(fakeExe.Calls) != 0 {
		t.Errorf("exe.Calls = %+v, want no VM created for an ambiguous classification", fakeExe.Calls)
	}
	if len(gh.commentCalls) != 1 || !strings.Contains(gh.commentCalls[0].body, "multiple type labels") {
		t.Errorf("commentCalls = %+v, want one clarifying comment mentioning the ambiguity", gh.commentCalls)
	}
}

func TestProvisionCreateVMNameMismatchErrors(t *testing.T) {
	fakeExe := &exe.Fake{Handler: func(command string) ([]byte, error) {
		return []byte(`{"vm_name":"totally-different-name"}`), nil
	}}
	admin := &fakeAdmin{}
	gh := newFakeGitHub()
	sr := newShelleyRegistry()
	o := newTestOrchestrator(t, fakeExe, admin, gh, sr)

	d := router.Decision{Action: router.ActionProvision, Issue: 1, Labels: []string{"type:ticket"}}
	if err := o.Provision(context.Background(), d); err == nil {
		t.Fatal("Provision() error = nil, want an error when exe.dev's vm_name doesn't match what we asked for")
	}
}

func TestProvisionWaitReadyTimeoutCleansUp(t *testing.T) {
	vm := "a-factory-issue-1"
	fakeExe := &exe.Fake{Handler: happyPathExeHandler(vm)}
	admin := &fakeAdmin{Handler: func(host, command string) (string, error) {
		if strings.Contains(command, "curl") {
			return "000", nil // never ready
		}
		return "", nil
	}}
	gh := newFakeGitHub()
	sr := newShelleyRegistry()
	o := newTestOrchestrator(t, fakeExe, admin, gh, sr)

	d := router.Decision{Action: router.ActionProvision, Issue: 1, Labels: []string{"type:ticket"}}
	if err := o.Provision(context.Background(), d); err == nil {
		t.Fatal("Provision() error = nil, want a timeout error when Shelley never becomes ready")
	}

	// Cleanup: the VM must have been destroyed (best-effort) since Provision
	// never committed.
	var destroyed bool
	for _, c := range fakeExe.Calls {
		if c == "rm "+vm {
			destroyed = true
		}
	}
	if !destroyed {
		t.Errorf("exe.Calls = %+v, want the partially-provisioned VM destroyed on failure", fakeExe.Calls)
	}
}

func TestProvisionNoGitHubIntegrationPostsCommentAndCleansUp(t *testing.T) {
	vm := "a-factory-issue-7"
	fakeExe := &exe.Fake{Handler: happyPathExeHandler(vm)}
	admin := &fakeAdmin{Handler: func(host, command string) (string, error) {
		switch {
		case strings.Contains(command, "curl"):
			return "200", nil
		case strings.HasPrefix(command, "ssh-key generate-api-key"):
			return "Token:\n  exe1.X\n", nil
		case command == "integrations list":
			return "some-other-integration  github  repos=someone-else/other-repo  tag:x\n", nil
		}
		return "", nil
	}}
	gh := newFakeGitHub()
	sr := newShelleyRegistry()
	o := newTestOrchestrator(t, fakeExe, admin, gh, sr)

	d := router.Decision{Action: router.ActionProvision, Issue: 7, Labels: []string{"type:ticket"}}
	if err := o.Provision(context.Background(), d); err != nil {
		t.Fatalf("Provision() error = %v, want nil (missing integration is reported via a comment)", err)
	}
	if len(gh.commentCalls) != 1 || !strings.Contains(gh.commentCalls[0].body, "no exe.dev GitHub integration") {
		t.Errorf("commentCalls = %+v, want a clarifying comment about the missing integration", gh.commentCalls)
	}

	var destroyed bool
	for _, c := range fakeExe.Calls {
		if c == "rm "+vm {
			destroyed = true
		}
	}
	if !destroyed {
		t.Errorf("exe.Calls = %+v, want the VM destroyed when no integration is found", fakeExe.Calls)
	}
}

// --- Relay* ---

func TestRelayIssueComment(t *testing.T) {
	fakeExe := &exe.Fake{}
	admin := &fakeAdmin{}
	gh := newFakeGitHub()
	vm := "a-factory-issue-42"
	gh.comments[42] = []state.Comment{
		{Body: state.Format(testConfig().StateMarkerPrefix, state.State{VM: vm, Conversation: "c1", Mode: "build", Model: "m", ShelleyToken: "tok"})},
	}
	sr := newShelleyRegistry()
	o := newTestOrchestrator(t, fakeExe, admin, gh, sr)

	d := router.Decision{Action: router.ActionRelayIssueComment, Issue: 42, Author: "bob", Body: "please also handle system theme"}
	if err := o.RelayIssueComment(context.Background(), d); err != nil {
		t.Fatalf("RelayIssueComment() error = %v", err)
	}

	sh := sr.byVM[vm]
	if sh == nil || len(sh.calls) != 1 || sh.calls[0].kind != "chat" {
		t.Fatalf("shelley calls for %s = %+v, want exactly one chat call", vm, sh)
	}
	if !strings.Contains(sh.calls[0].message, "@bob") || !strings.Contains(sh.calls[0].message, "please also handle system theme") {
		t.Errorf("chat message = %q, want it to contain the author and body", sh.calls[0].message)
	}
}

func TestRelayIssueCommentNoStateMarker(t *testing.T) {
	fakeExe := &exe.Fake{}
	admin := &fakeAdmin{}
	gh := newFakeGitHub() // no comments seeded
	sr := newShelleyRegistry()
	o := newTestOrchestrator(t, fakeExe, admin, gh, sr)

	d := router.Decision{Action: router.ActionRelayIssueComment, Issue: 99, Author: "bob", Body: "hi"}
	if err := o.RelayIssueComment(context.Background(), d); err == nil {
		t.Fatal("RelayIssueComment() error = nil, want an error when the issue was never provisioned")
	}
}

func TestRelayReviewComment(t *testing.T) {
	fakeExe := &exe.Fake{}
	admin := &fakeAdmin{}
	gh := newFakeGitHub()
	vm := "a-factory-issue-42"
	gh.prBodies[55] = "Implements the toggle.\n\nCloses #42"
	gh.comments[42] = []state.Comment{
		{Body: state.Format(testConfig().StateMarkerPrefix, state.State{VM: vm, Conversation: "c1", ShelleyToken: "tok"})},
	}
	sr := newShelleyRegistry()
	o := newTestOrchestrator(t, fakeExe, admin, gh, sr)

	d := router.Decision{
		Action: router.ActionRelayReviewComment, PR: 55,
		Author: "carol", Body: "use the shared helper", Path: "src/theme/toggle.ts", Line: 24,
	}
	if err := o.RelayReviewComment(context.Background(), d); err != nil {
		t.Fatalf("RelayReviewComment() error = %v", err)
	}

	sh := sr.byVM[vm]
	if sh == nil || len(sh.calls) != 1 {
		t.Fatalf("shelley calls for %s = %+v, want exactly one chat call", vm, sh)
	}
	msg := sh.calls[0].message
	for _, want := range []string{"@carol", "src/theme/toggle.ts:24", "use the shared helper"} {
		if !strings.Contains(msg, want) {
			t.Errorf("chat message = %q, want it to contain %q", msg, want)
		}
	}
}

func TestRelayReviewCommentNoClosingKeyword(t *testing.T) {
	fakeExe := &exe.Fake{}
	admin := &fakeAdmin{}
	gh := newFakeGitHub()
	gh.prBodies[55] = "This PR does stuff, no closing keyword here."
	sr := newShelleyRegistry()
	o := newTestOrchestrator(t, fakeExe, admin, gh, sr)

	d := router.Decision{Action: router.ActionRelayReviewComment, PR: 55, Author: "carol", Body: "x"}
	if err := o.RelayReviewComment(context.Background(), d); err == nil {
		t.Fatal("RelayReviewComment() error = nil, want an error when the PR body has no closing keyword")
	}
}

func TestRelayReview(t *testing.T) {
	fakeExe := &exe.Fake{}
	admin := &fakeAdmin{}
	gh := newFakeGitHub()
	vm := "a-factory-issue-42"
	gh.prBodies[55] = "Closes #42"
	gh.comments[42] = []state.Comment{
		{Body: state.Format(testConfig().StateMarkerPrefix, state.State{VM: vm, Conversation: "c1", ShelleyToken: "tok"})},
	}
	sr := newShelleyRegistry()
	o := newTestOrchestrator(t, fakeExe, admin, gh, sr)

	d := router.Decision{
		Action: router.ActionRelayReview, PR: 55,
		Author: "carol", Body: "Please add a regression test.", ReviewState: "changes_requested",
	}
	if err := o.RelayReview(context.Background(), d); err != nil {
		t.Fatalf("RelayReview() error = %v", err)
	}

	sh := sr.byVM[vm]
	msg := sh.calls[0].message
	if !strings.Contains(msg, "[changes_requested]") || !strings.Contains(msg, "Please add a regression test.") {
		t.Errorf("chat message = %q, want the review state folded into the body", msg)
	}
}

// --- Teardown / Reap ---

func TestTeardown(t *testing.T) {
	fakeExe := &exe.Fake{}
	admin := &fakeAdmin{}
	gh := newFakeGitHub()
	sr := newShelleyRegistry()
	o := newTestOrchestrator(t, fakeExe, admin, gh, sr)

	if err := o.Teardown(context.Background(), router.Decision{Action: router.ActionTeardown, Issue: 42}); err != nil {
		t.Fatalf("Teardown() error = %v", err)
	}
	if len(fakeExe.Calls) != 1 || fakeExe.Calls[0] != "rm a-factory-issue-42" {
		t.Errorf("exe.Calls = %+v, want a single destroy call for a-factory-issue-42", fakeExe.Calls)
	}
	var revoked bool
	for _, c := range admin.Calls {
		if c.Host == exeControlHost && c.Command == "ssh-key remove a-factory-issue-42" {
			revoked = true
		}
	}
	if !revoked {
		t.Errorf("admin.Calls = %+v, want the Shelley key revoked too", admin.Calls)
	}
}

func TestReap(t *testing.T) {
	gh := newFakeGitHub()
	gh.openIssues = []int{1, 2}

	fakeExe := &exe.Fake{Handler: func(command string) ([]byte, error) {
		if command == "ls" {
			return []byte(`{"vms":[
				{"vm_name":"a-factory-issue-1","tags":["a-factory"]},
				{"vm_name":"a-factory-issue-2","tags":["a-factory"]},
				{"vm_name":"a-factory-issue-3","tags":["a-factory"]},
				{"vm_name":"some-other-vm","tags":["other-project"]}
			]}`), nil
		}
		return nil, nil
	}}
	admin := &fakeAdmin{}
	sr := newShelleyRegistry()
	o := newTestOrchestrator(t, fakeExe, admin, gh, sr)

	if err := o.Reap(context.Background()); err != nil {
		t.Fatalf("Reap() error = %v", err)
	}

	var destroyed []string
	for _, c := range fakeExe.Calls {
		if strings.HasPrefix(c, "rm ") {
			destroyed = append(destroyed, c)
		}
	}
	if len(destroyed) != 1 || destroyed[0] != "rm a-factory-issue-3" {
		t.Errorf("destroyed = %v, want exactly one destroy call for the orphaned a-factory-issue-3 (not issue-1/2, still open; not some-other-vm, wrong tag)", destroyed)
	}
}

func TestReapPartialFailureContinuesAndJoinsErrors(t *testing.T) {
	gh := newFakeGitHub()
	gh.openIssues = nil // every box is an orphan

	fakeExe := &exe.Fake{Handler: func(command string) ([]byte, error) {
		if command == "ls" {
			return []byte(`{"vms":[
				{"vm_name":"a-factory-issue-1","tags":["a-factory"]},
				{"vm_name":"a-factory-issue-2","tags":["a-factory"]}
			]}`), nil
		}
		if command == "rm a-factory-issue-1" {
			return nil, errors.New("destroy failed")
		}
		return nil, nil
	}}
	admin := &fakeAdmin{}
	sr := newShelleyRegistry()
	o := newTestOrchestrator(t, fakeExe, admin, gh, sr)

	err := o.Reap(context.Background())
	if err == nil {
		t.Fatal("Reap() error = nil, want the destroy failure for issue-1 to surface")
	}

	var destroyCommands []string
	for _, c := range fakeExe.Calls {
		if strings.HasPrefix(c, "rm ") {
			destroyCommands = append(destroyCommands, c)
		}
	}
	if len(destroyCommands) != 2 {
		t.Errorf("destroy calls = %v, want both issue-1 and issue-2 attempted even though issue-1 failed", destroyCommands)
	}
}
