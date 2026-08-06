package ghclient

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/google/go-github/v75/github"
)

func newTestClient(t *testing.T, mux *http.ServeMux) *Client {
	t.Helper()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	gh := github.NewClient(srv.Client())
	base, err := url.Parse(srv.URL + "/")
	if err != nil {
		t.Fatalf("parse test server URL: %v", err)
	}
	gh.BaseURL = base
	return New(gh, "rlweb", "example")
}

func TestComment(t *testing.T) {
	var gotBody struct {
		Body string `json:"body"`
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/rlweb/example/issues/42/comments", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		_ = json.NewEncoder(w).Encode(github.IssueComment{Body: github.Ptr(gotBody.Body)})
	})

	c := newTestClient(t, mux)
	if err := c.Comment(t.Context(), 42, "hello from the factory"); err != nil {
		t.Fatalf("Comment() error = %v", err)
	}
	if gotBody.Body != "hello from the factory" {
		t.Errorf("posted body = %q, want %q", gotBody.Body, "hello from the factory")
	}
}

func TestListComments(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/rlweb/example/issues/42/comments", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]*github.IssueComment{
			{Body: github.Ptr("first comment")},
			{Body: github.Ptr("second comment")},
		})
	})

	c := newTestClient(t, mux)
	comments, err := c.ListComments(t.Context(), 42)
	if err != nil {
		t.Fatalf("ListComments() error = %v", err)
	}
	if len(comments) != 2 || comments[0].Body != "first comment" || comments[1].Body != "second comment" {
		t.Errorf("ListComments() = %+v, want two comments in order", comments)
	}
}

func TestListCommentsPagination(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/rlweb/example/issues/42/comments", func(w http.ResponseWriter, r *http.Request) {
		page := r.URL.Query().Get("page")
		if page == "" || page == "1" {
			w.Header().Set("Link", `<http://x/repos/rlweb/example/issues/42/comments?page=2>; rel="next"`)
			_ = json.NewEncoder(w).Encode([]*github.IssueComment{{Body: github.Ptr("page1")}})
			return
		}
		_ = json.NewEncoder(w).Encode([]*github.IssueComment{{Body: github.Ptr("page2")}})
	})

	c := newTestClient(t, mux)
	comments, err := c.ListComments(t.Context(), 42)
	if err != nil {
		t.Fatalf("ListComments() error = %v", err)
	}
	if len(comments) != 2 || comments[0].Body != "page1" || comments[1].Body != "page2" {
		t.Errorf("ListComments() = %+v, want both pages concatenated in order", comments)
	}
}

func TestAddLabels(t *testing.T) {
	var gotLabels []string
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/rlweb/example/issues/7/labels", func(w http.ResponseWriter, r *http.Request) {
		var body []string
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotLabels = body
		_ = json.NewEncoder(w).Encode([]*github.Label{})
	})

	c := newTestClient(t, mux)
	if err := c.AddLabels(t.Context(), 7, "needs-clarification"); err != nil {
		t.Fatalf("AddLabels() error = %v", err)
	}
	if len(gotLabels) != 1 || gotLabels[0] != "needs-clarification" {
		t.Errorf("posted labels = %v, want [needs-clarification]", gotLabels)
	}
}

func TestPRBody(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/rlweb/example/pulls/55", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(github.PullRequest{
			Number: github.Ptr(55),
			Body:   github.Ptr("Implements the toggle.\n\nCloses #42"),
		})
	})

	c := newTestClient(t, mux)
	body, err := c.PRBody(t.Context(), 55)
	if err != nil {
		t.Fatalf("PRBody() error = %v", err)
	}
	if body != "Implements the toggle.\n\nCloses #42" {
		t.Errorf("PRBody() = %q, want it to contain the closing keyword", body)
	}
}

func TestOpenIssueNumbers(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/rlweb/example/issues", func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("state"); got != "open" {
			t.Errorf("state query param = %q, want open", got)
		}
		_ = json.NewEncoder(w).Encode([]*github.Issue{
			{Number: github.Ptr(1)},
			{Number: github.Ptr(2)},
			{ // a PR shows up in the issues list too; must be filtered out
				Number:           github.Ptr(3),
				PullRequestLinks: &github.PullRequestLinks{URL: github.Ptr("https://api.github.com/repos/rlweb/example/pulls/3")},
			},
		})
	})

	c := newTestClient(t, mux)
	nums, err := c.OpenIssueNumbers(t.Context(), "type:ticket", "type:bug", "type:epic")
	if err != nil {
		t.Fatalf("OpenIssueNumbers() error = %v", err)
	}
	if len(nums) != 2 || nums[0] != 1 || nums[1] != 2 {
		t.Errorf("OpenIssueNumbers() = %v, want [1 2] (PR #3 filtered out)", nums)
	}
}

func TestErrorsAreWrapped(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/rlweb/example/issues/1/comments", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	c := newTestClient(t, mux)
	err := c.Comment(t.Context(), 1, "hi")
	if err == nil {
		t.Fatal("Comment() error = nil, want an error on a 500 response")
	}
	if got := err.Error(); got == "" {
		t.Fatal("expected a non-empty wrapped error message")
	}
}
