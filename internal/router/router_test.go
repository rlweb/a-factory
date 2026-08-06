package router

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

const testMarkerPrefix = "<!-- a-factory:state"

func load(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return b
}

func TestRoute(t *testing.T) {
	cases := []struct {
		name      string
		eventName string
		fixture   string
		want      Decision
	}{
		{
			name:      "issues opened with type:ticket label provisions",
			eventName: "issues",
			fixture:   "issues_opened_ticket.json",
			want: Decision{
				Action: ActionProvision, Issue: 42,
				Title: "Add dark mode toggle", Body: "Users want a dark mode toggle in settings.",
				Labels: []string{"type:ticket"},
			},
		},
		{
			// The router only decides WHETHER a type label is involved; it
			// deliberately does not reject multiple type labels itself —
			// that ambiguity check is classify.Classify's job downstream,
			// using the full Labels slice this Decision carries.
			name:      "issues opened with multiple type labels still provisions; ambiguity is classify's job",
			eventName: "issues",
			fixture:   "issues_opened_multiple_type_labels.json",
			want: Decision{
				Action: ActionProvision, Issue: 44,
				Title: "Ambiguous issue", Body: "Has both a ticket and bug label by mistake.",
				Labels: []string{"type:ticket", "type:bug"},
			},
		},
		{
			name:      "issues opened without a type label is skipped",
			eventName: "issues",
			fixture:   "issues_opened_no_label.json",
			want:      Decision{Action: ActionNone, Issue: 43, SkipReason: "opened without a type label"},
		},
		{
			name:      "issues labeled with type:bug provisions",
			eventName: "issues",
			fixture:   "issues_labeled_type_bug.json",
			want: Decision{
				Action: ActionProvision, Issue: 7,
				Title: "Crash on save", Body: "",
				Labels: []string{"type:bug"},
			},
		},
		{
			name:      "issues labeled with a non-type label is skipped",
			eventName: "issues",
			fixture:   "issues_labeled_other.json",
			want:      Decision{Action: ActionNone, Issue: 7, SkipReason: "labeled with a non-type label"},
		},
		{
			name:      "issues closed tears down",
			eventName: "issues",
			fixture:   "issues_closed.json",
			want:      Decision{Action: ActionTeardown, Issue: 99},
		},
		{
			name:      "issue_comment from a human relays",
			eventName: "issue_comment",
			fixture:   "issue_comment_created_human.json",
			want: Decision{
				Action: ActionRelayIssueComment,
				Issue:  42,
				Author: "bob",
				Body:   "Please also handle the system theme preference.",
			},
		},
		{
			name:      "issue_comment from the bot sender is skipped",
			eventName: "issue_comment",
			fixture:   "issue_comment_created_bot.json",
			want:      Decision{Action: ActionNone, Issue: 42, SkipReason: "bot-authored comment"},
		},
		{
			name:      "issue_comment carrying the state marker is skipped even from a human sender",
			eventName: "issue_comment",
			fixture:   "issue_comment_created_marker.json",
			want:      Decision{Action: ActionNone, Issue: 42, SkipReason: "comment carries the factory state marker"},
		},
		{
			name:      "issue_comment on a PR is left to review events",
			eventName: "issue_comment",
			fixture:   "issue_comment_created_on_pr.json",
			want:      Decision{Action: ActionNone, Issue: 55, SkipReason: "issue_comment on a PR; handled by review events"},
		},
		{
			name:      "pull_request_review_comment from a human relays with path/line",
			eventName: "pull_request_review_comment",
			fixture:   "pull_request_review_comment_created.json",
			want: Decision{
				Action: ActionRelayReviewComment,
				PR:     55,
				Author: "carol",
				Body:   "This should use the shared helper instead.",
				Path:   "src/theme/toggle.ts",
				Line:   24,
			},
		},
		{
			name:      "pull_request_review_comment from the bot is skipped",
			eventName: "pull_request_review_comment",
			fixture:   "pull_request_review_comment_bot.json",
			want:      Decision{Action: ActionNone, PR: 55, SkipReason: "bot-authored review comment"},
		},
		{
			name:      "pull_request_review submitted by a human relays",
			eventName: "pull_request_review",
			fixture:   "pull_request_review_submitted.json",
			want: Decision{
				Action:      ActionRelayReview,
				PR:          55,
				Author:      "carol",
				Body:        "Please add a regression test.",
				ReviewState: "changes_requested",
			},
		},
		{
			name:      "pull_request_review from the bot is skipped",
			eventName: "pull_request_review",
			fixture:   "pull_request_review_bot.json",
			want:      Decision{Action: ActionNone, PR: 55, SkipReason: "bot-authored review"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Route(tc.eventName, load(t, tc.fixture), testMarkerPrefix)
			if err != nil {
				t.Fatalf("Route() error = %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("Route() = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestRouteSchedule(t *testing.T) {
	got, err := Route("schedule", nil, testMarkerPrefix)
	if err != nil {
		t.Fatalf("Route() error = %v", err)
	}
	want := Decision{Action: ActionReap}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Route() = %+v, want %+v", got, want)
	}
}

func TestRouteUnhandledEvent(t *testing.T) {
	got, err := Route("push", []byte(`{}`), testMarkerPrefix)
	if err != nil {
		t.Fatalf("Route() error = %v", err)
	}
	if got.Action != ActionNone {
		t.Errorf("Route() Action = %v, want ActionNone", got.Action)
	}
	if got.SkipReason == "" {
		t.Errorf("Route() SkipReason is empty, want a reason")
	}
}

func TestActionString(t *testing.T) {
	cases := map[Action]string{
		ActionNone:               "none",
		ActionProvision:          "provision",
		ActionRelayIssueComment:  "relay_issue_comment",
		ActionRelayReviewComment: "relay_review_comment",
		ActionRelayReview:        "relay_review",
		ActionTeardown:           "teardown",
		ActionReap:               "reap",
		Action(99):               "unknown",
	}
	for action, want := range cases {
		if got := action.String(); got != want {
			t.Errorf("Action(%d).String() = %q, want %q", action, got, want)
		}
	}
}
