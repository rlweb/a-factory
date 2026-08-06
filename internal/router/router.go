// Package router maps a GitHub Actions event (event name + raw webhook
// payload) to the Action a-factory should take. It is pure: no I/O, no
// network — every rule is driven off the parsed payload alone, so it is
// fully covered by table tests against fixture JSON.
package router

import (
	"fmt"
	"strings"

	"github.com/google/go-github/v75/github"
)

// Action is the decision the CLI acts on.
type Action int

const (
	// ActionNone means: do nothing. Check Decision.SkipReason for why.
	ActionNone Action = iota
	// ActionProvision creates a box and seeds a Shelley session for an issue.
	ActionProvision
	// ActionRelayIssueComment relays a human issue comment into the running session.
	ActionRelayIssueComment
	// ActionRelayReviewComment relays an inline PR review comment (has path/line).
	ActionRelayReviewComment
	// ActionRelayReview relays a whole PR review (approve/request-changes + body).
	ActionRelayReview
	// ActionTeardown destroys the box for a closed issue.
	ActionTeardown
	// ActionReap runs the cron safety-net: destroy boxes whose issue is closed or missing.
	ActionReap
)

func (a Action) String() string {
	switch a {
	case ActionNone:
		return "none"
	case ActionProvision:
		return "provision"
	case ActionRelayIssueComment:
		return "relay_issue_comment"
	case ActionRelayReviewComment:
		return "relay_review_comment"
	case ActionRelayReview:
		return "relay_review"
	case ActionTeardown:
		return "teardown"
	case ActionReap:
		return "reap"
	default:
		return "unknown"
	}
}

// Decision carries the Action plus whatever fields downstream orchestration
// needs. Only the fields relevant to the Action are populated.
type Decision struct {
	Action Action

	Issue int // issue number (Provision, RelayIssueComment, Teardown)
	PR    int // PR number (RelayReviewComment, RelayReview)

	Title  string   // issue title (Provision only)
	Labels []string // every label on the issue at event time (Provision only) — classify.Classify re-derives mode/model/ambiguity from this, so orchestrate never needs a second fetch

	Author string // comment/review author login
	// Body is the issue body (Provision) or the comment/review body (every
	// Relay* action) — never both at once, since only one Action is set.
	Body string

	Path string // file path (RelayReviewComment only)
	Line int     // line number (RelayReviewComment only)

	ReviewState string // "approved" | "changes_requested" | "commented" (RelayReview only)

	// SkipReason explains why Action is ActionNone. Never set otherwise.
	SkipReason string
}

const typeLabelPrefix = "type:"

var validTypeLabels = map[string]bool{"ticket": true, "bug": true, "epic": true}

func isTypeLabel(name string) bool {
	rest, ok := strings.CutPrefix(name, typeLabelPrefix)
	return ok && validTypeLabels[rest]
}

func isBotSender(u *github.User) bool {
	return u != nil && u.GetType() == "Bot"
}

func labelNames(labels []*github.Label) []string {
	if len(labels) == 0 {
		return nil
	}
	out := make([]string, len(labels))
	for i, l := range labels {
		out[i] = l.GetName()
	}
	return out
}

func hasTypeLabel(labels []string) bool {
	for _, l := range labels {
		if isTypeLabel(l) {
			return true
		}
	}
	return false
}

// Route parses payload as eventName and returns the Decision.
//
// stateMarkerPrefix is matched against comment bodies to skip relaying a
// factory-authored state comment back into its own session (belt-and-suspenders
// alongside the sender-is-Bot check, since the marker is the one thing a human
// could theoretically quote-reply into).
func Route(eventName string, payload []byte, stateMarkerPrefix string) (Decision, error) {
	if eventName == "schedule" {
		return Decision{Action: ActionReap}, nil
	}

	event, err := github.ParseWebHook(eventName, payload)
	if err != nil {
		return Decision{}, fmt.Errorf("parse webhook %q: %w", eventName, err)
	}

	switch e := event.(type) {
	case *github.IssuesEvent:
		return routeIssues(e), nil
	case *github.IssueCommentEvent:
		return routeIssueComment(e, stateMarkerPrefix), nil
	case *github.PullRequestReviewCommentEvent:
		return routeReviewComment(e), nil
	case *github.PullRequestReviewEvent:
		return routeReview(e), nil
	default:
		return Decision{Action: ActionNone, SkipReason: fmt.Sprintf("unhandled event type %q", eventName)}, nil
	}
}

func routeIssues(e *github.IssuesEvent) Decision {
	issue := e.GetIssue()
	num := issue.GetNumber()

	switch e.GetAction() {
	case "closed":
		return Decision{Action: ActionTeardown, Issue: num}

	case "opened":
		labels := labelNames(issue.Labels)
		if !hasTypeLabel(labels) {
			return Decision{Action: ActionNone, Issue: num, SkipReason: "opened without a type label"}
		}
		return Decision{Action: ActionProvision, Issue: num, Title: issue.GetTitle(), Body: issue.GetBody(), Labels: labels}

	case "labeled":
		added := e.GetLabel()
		if added == nil || !isTypeLabel(added.GetName()) {
			return Decision{Action: ActionNone, Issue: num, SkipReason: "labeled with a non-type label"}
		}
		return Decision{
			Action: ActionProvision, Issue: num,
			Title: issue.GetTitle(), Body: issue.GetBody(), Labels: labelNames(issue.Labels),
		}

	default:
		return Decision{Action: ActionNone, Issue: num, SkipReason: "unhandled issues action: " + e.GetAction()}
	}
}

func routeIssueComment(e *github.IssueCommentEvent, stateMarkerPrefix string) Decision {
	if e.GetAction() != "created" {
		return Decision{Action: ActionNone, SkipReason: "issue_comment action is not created"}
	}

	issue := e.GetIssue()
	num := issue.GetNumber()

	if issue.IsPullRequest() {
		return Decision{Action: ActionNone, Issue: num, SkipReason: "issue_comment on a PR; handled by review events"}
	}

	if isBotSender(e.GetSender()) {
		return Decision{Action: ActionNone, Issue: num, SkipReason: "bot-authored comment"}
	}

	comment := e.GetComment()
	body := comment.GetBody()
	if stateMarkerPrefix != "" && strings.Contains(body, stateMarkerPrefix) {
		return Decision{Action: ActionNone, Issue: num, SkipReason: "comment carries the factory state marker"}
	}

	return Decision{
		Action: ActionRelayIssueComment,
		Issue:  num,
		Author: comment.GetUser().GetLogin(),
		Body:   body,
	}
}

func routeReviewComment(e *github.PullRequestReviewCommentEvent) Decision {
	pr := e.GetPullRequest().GetNumber()

	if e.GetAction() != "created" {
		return Decision{Action: ActionNone, PR: pr, SkipReason: "pull_request_review_comment action is not created"}
	}
	if isBotSender(e.GetSender()) {
		return Decision{Action: ActionNone, PR: pr, SkipReason: "bot-authored review comment"}
	}

	c := e.GetComment()
	return Decision{
		Action: ActionRelayReviewComment,
		PR:     pr,
		Author: c.GetUser().GetLogin(),
		Body:   c.GetBody(),
		Path:   c.GetPath(),
		Line:   c.GetLine(),
	}
}

func routeReview(e *github.PullRequestReviewEvent) Decision {
	pr := e.GetPullRequest().GetNumber()

	if e.GetAction() != "submitted" {
		return Decision{Action: ActionNone, PR: pr, SkipReason: "pull_request_review action is not submitted"}
	}
	if isBotSender(e.GetSender()) {
		return Decision{Action: ActionNone, PR: pr, SkipReason: "bot-authored review"}
	}

	r := e.GetReview()
	return Decision{
		Action:      ActionRelayReview,
		PR:          pr,
		Author:      r.GetUser().GetLogin(),
		Body:        r.GetBody(),
		ReviewState: r.GetState(),
	}
}
