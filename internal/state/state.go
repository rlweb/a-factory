// Package state reads and writes the hidden HTML-comment marker a-factory
// uses to track the one genuinely stateful fact per issue: which Shelley
// conversation (and mode/model) is running for it. The VM name itself is a
// pure function of the issue number (see orchestrate), so it never needs to
// be looked up.
//
// Every function here is pure — it operates on already-fetched comment
// bodies, never on the network — so it's fully covered by table tests.
package state

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// State is the state carried by a marker comment.
type State struct {
	VM           string
	Conversation string
	Mode         string
	Model        string
	// ShelleyToken is the VM-scoped bearer token minted for this box via
	// `ssh-key generate-api-key --vm=<vm>` — required to reach Shelley's
	// public HTTPS API for every Relay* call, since it can't be re-derived
	// or re-minted without SSH access (see internal/orchestrate,
	// docs/spike-findings.md). Storing a bearer credential in a GitHub
	// comment is a deliberate tradeoff: it's minted short-lived and scoped
	// to a single throwaway VM, which bounds the blast radius of a leak.
	ShelleyToken string
	// Issue is only set on a PR-side marker, where it back-references the
	// issue that spawned the box. Zero on an issue-side marker.
	Issue int
}

// Comment is the minimal shape state needs from an already-fetched GitHub
// comment. Decoupled from any specific GitHub client type so this package
// stays network-free.
type Comment struct {
	Body string
}

// Format renders s as a single-line hidden HTML comment, using prefix as the
// opening marker (e.g. config.DefaultStateMarkerPrefix, "<!-- a-factory:state").
func Format(prefix string, s State) string {
	parts := make([]string, 0, 5)
	if s.VM != "" {
		parts = append(parts, "vm="+s.VM)
	}
	if s.Conversation != "" {
		parts = append(parts, "conversation="+s.Conversation)
	}
	if s.Mode != "" {
		parts = append(parts, "mode="+s.Mode)
	}
	if s.Model != "" {
		parts = append(parts, "model="+s.Model)
	}
	if s.ShelleyToken != "" {
		parts = append(parts, "shelley_token="+s.ShelleyToken)
	}
	if s.Issue != 0 {
		parts = append(parts, fmt.Sprintf("issue=%d", s.Issue))
	}
	return fmt.Sprintf("%s %s -->", prefix, strings.Join(parts, " "))
}

// Parse extracts a State from a comment body containing a marker with the
// given prefix. ok is false if no marker is present.
func Parse(prefix string, body string) (s State, ok bool) {
	idx := strings.Index(body, prefix)
	if idx < 0 {
		return State{}, false
	}
	rest := body[idx+len(prefix):]
	end := strings.Index(rest, "-->")
	if end < 0 {
		return State{}, false
	}

	for _, field := range strings.Fields(rest[:end]) {
		key, val, hasEquals := strings.Cut(field, "=")
		if !hasEquals {
			continue
		}
		switch key {
		case "vm":
			s.VM = val
		case "conversation":
			s.Conversation = val
		case "mode":
			s.Mode = val
		case "model":
			s.Model = val
		case "shelley_token":
			s.ShelleyToken = val
		case "issue":
			if n, err := strconv.Atoi(val); err == nil {
				s.Issue = n
			}
		}
	}
	return s, true
}

// FindLatest scans comments from most recent to oldest and returns the first
// State found, so the most recently posted marker wins if more than one
// exists.
func FindLatest(prefix string, comments []Comment) (State, bool) {
	for i := len(comments) - 1; i >= 0; i-- {
		if s, ok := Parse(prefix, comments[i].Body); ok {
			return s, true
		}
	}
	return State{}, false
}

var closingKeywordRe = regexp.MustCompile(`(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b`)

// IssueFromClosingKeywords is the defensive fallback for resolving a PR back
// to its issue when the marker comment is missing: it regex-parses GitHub's
// own closing keywords ("closes #42", "fixes #7", "resolves #100", any tense,
// case-insensitive) out of the PR body.
func IssueFromClosingKeywords(prBody string) (int, bool) {
	m := closingKeywordRe.FindStringSubmatch(prBody)
	if m == nil {
		return 0, false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, false
	}
	return n, true
}
