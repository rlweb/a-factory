package state

import "testing"

const prefix = "<!-- a-factory:state"

func TestFormatParseRoundTrip(t *testing.T) {
	cases := []struct {
		name string
		in   State
	}{
		{"issue-side full state", State{VM: "a-factory-issue-42", Conversation: "c_8f21", Mode: "build", Model: "deepseek-v4-flash", ShelleyToken: "exe1.ABC123"}},
		{"PR-side state with issue back-reference", State{VM: "a-factory-issue-42", Conversation: "c_8f21", Issue: 42}},
		{"minimal state", State{VM: "a-factory-issue-1", Conversation: "c1"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := "Some human-readable text.\n\n" + Format(prefix, tc.in)
			got, ok := Parse(prefix, body)
			if !ok {
				t.Fatalf("Parse() ok = false, want true for body %q", body)
			}
			if got != tc.in {
				t.Errorf("Parse() = %+v, want %+v", got, tc.in)
			}
		})
	}
}

func TestParseNoMarker(t *testing.T) {
	_, ok := Parse(prefix, "just a regular comment, nothing to see here")
	if ok {
		t.Fatal("Parse() ok = true, want false for a comment with no marker")
	}
}

func TestParseUnterminatedMarker(t *testing.T) {
	_, ok := Parse(prefix, "<!-- a-factory:state vm=x conversation=y") // missing closing -->
	if ok {
		t.Fatal("Parse() ok = true, want false for an unterminated marker")
	}
}

func TestParseIgnoresUnknownKeys(t *testing.T) {
	got, ok := Parse(prefix, "<!-- a-factory:state vm=v1 bogus=ignored conversation=c1 -->")
	if !ok {
		t.Fatal("Parse() ok = false, want true")
	}
	want := State{VM: "v1", Conversation: "c1"}
	if got != want {
		t.Errorf("Parse() = %+v, want %+v", got, want)
	}
}

func TestFindLatest(t *testing.T) {
	comments := []Comment{
		{Body: "human comment, no marker"},
		{Body: Format(prefix, State{VM: "v1", Conversation: "c1"})},
		{Body: "another human reply"},
		{Body: Format(prefix, State{VM: "v1", Conversation: "c2"})}, // most recent — should win
	}
	got, ok := FindLatest(prefix, comments)
	if !ok {
		t.Fatal("FindLatest() ok = false, want true")
	}
	want := State{VM: "v1", Conversation: "c2"}
	if got != want {
		t.Errorf("FindLatest() = %+v, want %+v (the most recent marker should win)", got, want)
	}
}

func TestFindLatestNoMarkerAnywhere(t *testing.T) {
	comments := []Comment{{Body: "hi"}, {Body: "no state here either"}}
	_, ok := FindLatest(prefix, comments)
	if ok {
		t.Fatal("FindLatest() ok = true, want false")
	}
}

func TestFindLatestEmpty(t *testing.T) {
	_, ok := FindLatest(prefix, nil)
	if ok {
		t.Fatal("FindLatest() ok = true, want false for an empty comment list")
	}
}

func TestIssueFromClosingKeywords(t *testing.T) {
	cases := []struct {
		name      string
		body      string
		wantIssue int
		wantOK    bool
	}{
		{"closes lowercase", "This closes #42 for good.", 42, true},
		{"Closes capitalized", "Closes #7", 7, true},
		{"fixes present tense", "fixes #100", 100, true},
		{"fixed past tense", "Fixed #5", 5, true},
		{"resolves present tense", "resolves #9", 9, true},
		{"resolved past tense", "This resolved #3 nicely", 3, true},
		{"no keyword at all", "See #42 for context, does not close it", 0, false},
		{"no issue reference at all", "Refactors the widget module", 0, false},
		{"keyword without hash number is not matched", "closes the loop", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := IssueFromClosingKeywords(tc.body)
			if ok != tc.wantOK {
				t.Fatalf("IssueFromClosingKeywords(%q) ok = %v, want %v", tc.body, ok, tc.wantOK)
			}
			if ok && got != tc.wantIssue {
				t.Errorf("IssueFromClosingKeywords(%q) = %d, want %d", tc.body, got, tc.wantIssue)
			}
		})
	}
}
