package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rlweb/a-factory/internal/config"
	"github.com/rlweb/a-factory/internal/exe"
	"github.com/rlweb/a-factory/internal/orchestrate"
	"github.com/rlweb/a-factory/internal/router"
	"github.com/rlweb/a-factory/internal/shelley"
	"github.com/rlweb/a-factory/internal/state"
)

func TestRepoFromEnv(t *testing.T) {
	cases := []struct {
		name    string
		val     string
		wantErr bool
		owner   string
		repo    string
	}{
		{"valid", "rlweb/a-factory", false, "rlweb", "a-factory"},
		{"missing", "", true, "", ""},
		{"no slash", "rlweb", true, "", ""},
		{"empty owner", "/a-factory", true, "", ""},
		{"empty repo", "rlweb/", true, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("GITHUB_REPOSITORY", tc.val)
			owner, repo, err := repoFromEnv()
			if (err != nil) != tc.wantErr {
				t.Fatalf("repoFromEnv() error = %v, wantErr %v", err, tc.wantErr)
			}
			if !tc.wantErr && (owner != tc.owner || repo != tc.repo) {
				t.Errorf("repoFromEnv() = (%q, %q), want (%q, %q)", owner, repo, tc.owner, tc.repo)
			}
		})
	}
}

// --- fakes for dispatch tests (a smaller, local copy of orchestrate_test's
// fakes — dispatch only needs to prove routing, not orchestration logic,
// which is already covered by internal/orchestrate's own tests) ---

type fakeGitHub struct {
	comments map[int][]state.Comment
	prBodies map[int]string
}

func newFakeGitHub() *fakeGitHub {
	return &fakeGitHub{comments: map[int][]state.Comment{}, prBodies: map[int]string{}}
}
func (f *fakeGitHub) Comment(_ context.Context, number int, body string) error {
	f.comments[number] = append(f.comments[number], state.Comment{Body: body})
	return nil
}
func (f *fakeGitHub) ListComments(_ context.Context, number int) ([]state.Comment, error) {
	return f.comments[number], nil
}
func (f *fakeGitHub) PRBody(_ context.Context, number int) (string, error) {
	return f.prBodies[number], nil
}
func (f *fakeGitHub) OpenIssueNumbers(_ context.Context, _ ...string) ([]int, error) { return nil, nil }

type fakeShelley struct {
	conversationID string
	newConvCalled  bool
	chatCalled     bool
}

func (f *fakeShelley) NewConversation(_ context.Context, _, _ string) (string, error) {
	f.newConvCalled = true
	return f.conversationID, nil
}
func (f *fakeShelley) Chat(_ context.Context, _, _ string) error {
	f.chatCalled = true
	return nil
}
func (f *fakeShelley) UpsertCustomModel(_ context.Context, m shelley.CustomModel) (string, error) {
	return m.ModelName + "-opencode-ai", nil
}

// fakeAdmin implements orchestrate.NewAdminClient's returned exe.AdminClient
// for every host, scripted by a single handler.
type fakeAdmin struct {
	Handler func(host, command string) (string, error)
}

func (f *fakeAdmin) factory() orchestrate.NewAdminClient {
	return func(host string) exe.AdminClient {
		return fakeAdminHost{host: host, parent: f}
	}
}

type fakeAdminHost struct {
	host   string
	parent *fakeAdmin
}

func (h fakeAdminHost) Exec(_ context.Context, command string) (string, error) {
	if h.parent.Handler != nil {
		return h.parent.Handler(h.host, command)
	}
	return "", nil
}

// happyPathAdmin answers every admin call Provision needs: readiness, key
// mint, integration list/attach, clone.
func happyPathAdmin() *fakeAdmin {
	return &fakeAdmin{Handler: func(host, command string) (string, error) {
		switch {
		case strings.Contains(command, "curl"):
			return "200", nil
		case strings.HasPrefix(command, "ssh-key generate-api-key"):
			return "Token:\n  exe1.TEST\n", nil
		case command == "integrations list":
			return "rlweb-example  github  repos=rlweb/example  tag:x\n", nil
		default:
			return "", nil
		}
	}}
}

func newTestOrchestrator(gh *fakeGitHub, sh *fakeShelley, fakeExe *exe.Fake, admin *fakeAdmin) *orchestrate.Orchestrator {
	return &orchestrate.Orchestrator{
		Exe:        fakeExe,
		Admin:      admin.factory(),
		NewShelley: func(string, string) orchestrate.ShelleyClient { return sh },
		GitHub:     gh,
		Config: config.Config{
			VMPrefix: "a-factory", StateMarkerPrefix: "<!-- a-factory:state",
			CheapModel: "cheap", StrongModel: "strong", BoxImage: "img", VMTag: "a-factory",
			ShelleyTokenExpiry: "30d",
		},
		RepoOwner: "rlweb",
		RepoName:  "example",
	}
}

func TestDispatchProvision(t *testing.T) {
	fakeExe := &exe.Fake{Handler: func(command string) ([]byte, error) {
		if strings.HasPrefix(command, "new ") {
			return []byte(`{"vm_name":"a-factory-issue-1"}`), nil
		}
		return []byte(`{}`), nil
	}}
	sh := &fakeShelley{conversationID: "c1"}
	o := newTestOrchestrator(newFakeGitHub(), sh, fakeExe, happyPathAdmin())

	d := router.Decision{Action: router.ActionProvision, Issue: 1, Labels: []string{"type:ticket"}}
	if err := dispatch(t.Context(), o, d); err != nil {
		t.Fatalf("dispatch(Provision) error = %v", err)
	}
	if !sh.newConvCalled {
		t.Error("dispatch(Provision) did not call NewConversation")
	}
}

func TestDispatchRelayIssueComment(t *testing.T) {
	gh := newFakeGitHub()
	gh.comments[1] = []state.Comment{{Body: state.Format("<!-- a-factory:state", state.State{VM: "vm1", Conversation: "c1", ShelleyToken: "tok"})}}
	sh := &fakeShelley{}
	o := newTestOrchestrator(gh, sh, &exe.Fake{}, &fakeAdmin{})

	d := router.Decision{Action: router.ActionRelayIssueComment, Issue: 1, Author: "a", Body: "b"}
	if err := dispatch(t.Context(), o, d); err != nil {
		t.Fatalf("dispatch(RelayIssueComment) error = %v", err)
	}
	if !sh.chatCalled {
		t.Error("dispatch(RelayIssueComment) did not call Chat")
	}
}

func TestDispatchTeardown(t *testing.T) {
	fakeExe := &exe.Fake{}
	o := newTestOrchestrator(newFakeGitHub(), &fakeShelley{}, fakeExe, &fakeAdmin{})

	d := router.Decision{Action: router.ActionTeardown, Issue: 1}
	if err := dispatch(t.Context(), o, d); err != nil {
		t.Fatalf("dispatch(Teardown) error = %v", err)
	}
	if len(fakeExe.Calls) != 1 || fakeExe.Calls[0] != "rm a-factory-issue-1" {
		t.Errorf("dispatch(Teardown) exe calls = %+v, want a destroy call", fakeExe.Calls)
	}
}

func TestDispatchReap(t *testing.T) {
	fakeExe := &exe.Fake{Handler: func(command string) ([]byte, error) {
		if command == "ls" {
			return []byte(`{"vms":[]}`), nil
		}
		return []byte(`{}`), nil
	}}
	o := newTestOrchestrator(newFakeGitHub(), &fakeShelley{}, fakeExe, &fakeAdmin{})

	d := router.Decision{Action: router.ActionReap}
	if err := dispatch(t.Context(), o, d); err != nil {
		t.Fatalf("dispatch(Reap) error = %v", err)
	}
}

func TestDispatchUnhandledAction(t *testing.T) {
	o := newTestOrchestrator(newFakeGitHub(), &fakeShelley{}, &exe.Fake{}, &fakeAdmin{})
	err := dispatch(t.Context(), o, router.Decision{Action: router.ActionNone})
	if err == nil {
		t.Fatal("dispatch(ActionNone) error = nil, want an error (run() should never call dispatch with ActionNone)")
	}
}

// --- run() tests: only the paths reachable without real network ---

func writeEventFile(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "event.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write event file: %v", err)
	}
	return path
}

func TestRunMissingEventName(t *testing.T) {
	t.Setenv("GITHUB_EVENT_NAME", "")
	if err := run(t.Context()); err == nil {
		t.Fatal("run() error = nil, want an error when GITHUB_EVENT_NAME is unset")
	}
}

func TestRunMissingEventPath(t *testing.T) {
	t.Setenv("GITHUB_EVENT_NAME", "issues")
	t.Setenv("GITHUB_EVENT_PATH", "")
	if err := run(t.Context()); err == nil {
		t.Fatal("run() error = nil, want an error when GITHUB_EVENT_PATH is unset for a non-schedule event")
	}
}

func TestRunUnhandledEventExitsCleanly(t *testing.T) {
	// A "push" event routes to ActionNone, so run() must return nil without
	// ever needing GITHUB_TOKEN/EXE_API_TOKEN/EXE_SSH_PRIVATE_KEY/GITHUB_REPOSITORY.
	t.Setenv("GITHUB_EVENT_NAME", "push")
	t.Setenv("GITHUB_EVENT_PATH", writeEventFile(t, `{}`))
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("EXE_API_TOKEN", "")
	t.Setenv("EXE_SSH_PRIVATE_KEY", "")
	t.Setenv("GITHUB_REPOSITORY", "")

	if err := run(t.Context()); err != nil {
		t.Fatalf("run() error = %v, want nil for an unhandled event", err)
	}
}

func TestRunMissingGitHubTokenForARealAction(t *testing.T) {
	t.Setenv("GITHUB_EVENT_NAME", "issues")
	t.Setenv("GITHUB_EVENT_PATH", writeEventFile(t, `{
		"action": "opened",
		"issue": {"number": 1, "title": "x", "labels": [{"name":"type:ticket"}]},
		"sender": {"login":"a","type":"User"}
	}`))
	t.Setenv("GITHUB_REPOSITORY", "rlweb/a-factory")
	t.Setenv("GITHUB_TOKEN", "")

	if err := run(t.Context()); err == nil {
		t.Fatal("run() error = nil, want an error when GITHUB_TOKEN is unset for a real action")
	}
}

func TestRunMissingExeTokenForARealAction(t *testing.T) {
	t.Setenv("GITHUB_EVENT_NAME", "issues")
	t.Setenv("GITHUB_EVENT_PATH", writeEventFile(t, `{
		"action": "opened",
		"issue": {"number": 1, "title": "x", "labels": [{"name":"type:ticket"}]},
		"sender": {"login":"a","type":"User"}
	}`))
	t.Setenv("GITHUB_REPOSITORY", "rlweb/a-factory")
	t.Setenv("GITHUB_TOKEN", "test-token")
	t.Setenv("EXE_API_TOKEN", "")

	if err := run(t.Context()); err == nil {
		t.Fatal("run() error = nil, want an error when EXE_API_TOKEN is unset for a real action")
	}
}

func TestRunMissingSSHPrivateKeyForARealAction(t *testing.T) {
	t.Setenv("GITHUB_EVENT_NAME", "issues")
	t.Setenv("GITHUB_EVENT_PATH", writeEventFile(t, `{
		"action": "opened",
		"issue": {"number": 1, "title": "x", "labels": [{"name":"type:ticket"}]},
		"sender": {"login":"a","type":"User"}
	}`))
	t.Setenv("GITHUB_REPOSITORY", "rlweb/a-factory")
	t.Setenv("GITHUB_TOKEN", "test-token")
	t.Setenv("EXE_API_TOKEN", "test-token")
	t.Setenv("EXE_SSH_PRIVATE_KEY", "")

	if err := run(t.Context()); err == nil {
		t.Fatal("run() error = nil, want an error when EXE_SSH_PRIVATE_KEY is unset for a real action")
	}
}

func TestRunInvalidSSHPrivateKey(t *testing.T) {
	t.Setenv("GITHUB_EVENT_NAME", "issues")
	t.Setenv("GITHUB_EVENT_PATH", writeEventFile(t, `{
		"action": "opened",
		"issue": {"number": 1, "title": "x", "labels": [{"name":"type:ticket"}]},
		"sender": {"login":"a","type":"User"}
	}`))
	t.Setenv("GITHUB_REPOSITORY", "rlweb/a-factory")
	t.Setenv("GITHUB_TOKEN", "test-token")
	t.Setenv("EXE_API_TOKEN", "test-token")
	t.Setenv("EXE_SSH_PRIVATE_KEY", "not a valid key")

	if err := run(t.Context()); err == nil {
		t.Fatal("run() error = nil, want an error when EXE_SSH_PRIVATE_KEY is malformed")
	}
}

func TestRunInvalidPayload(t *testing.T) {
	t.Setenv("GITHUB_EVENT_NAME", "issues")
	t.Setenv("GITHUB_EVENT_PATH", writeEventFile(t, `not json`))
	if err := run(t.Context()); err == nil {
		t.Fatal("run() error = nil, want an error for a malformed event payload")
	}
}
