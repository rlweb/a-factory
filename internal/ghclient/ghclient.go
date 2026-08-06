// Package ghclient is a thin wrapper over go-github, scoped to exactly what
// internal/orchestrate needs: posting comments, reading them back for state
// resolution, adding labels, and reading a PR's body to resolve it back to
// its issue via GitHub's own closing keywords.
package ghclient

import (
	"context"
	"fmt"
	"net/http"

	"github.com/google/go-github/v75/github"
	"github.com/rlweb/a-factory/internal/state"
)

// Client is a repo-scoped GitHub API client.
type Client struct {
	gh    *github.Client
	Owner string
	Repo  string
}

// New wraps an already-configured *github.Client. Tests point gh.BaseURL at
// an httptest.Server; production code builds gh via NewTokenClient.
func New(gh *github.Client, owner, repo string) *Client {
	return &Client{gh: gh, Owner: owner, Repo: repo}
}

// NewTokenClient builds a production Client authenticated with a bearer
// token (the Actions job's own GITHUB_TOKEN — this is a distinct credential
// from the in-VM agent's own git/gh access via exe.dev's GitHub integration).
func NewTokenClient(token, owner, repo string, httpClient *http.Client) *Client {
	return New(github.NewClient(httpClient).WithAuthToken(token), owner, repo)
}

// Comment posts a comment on an issue or PR (GitHub's API treats PRs as
// issues for commenting purposes, so one method covers both).
func (c *Client) Comment(ctx context.Context, number int, body string) error {
	_, _, err := c.gh.Issues.CreateComment(ctx, c.Owner, c.Repo, number, &github.IssueComment{
		Body: github.Ptr(body),
	})
	if err != nil {
		return fmt.Errorf("ghclient: post comment on #%d: %w", number, err)
	}
	return nil
}

// ListComments returns an issue's (or PR's) comments as state.Comment,
// oldest first, matching the shape internal/state operates on.
func (c *Client) ListComments(ctx context.Context, number int) ([]state.Comment, error) {
	var out []state.Comment
	opts := &github.IssueListCommentsOptions{ListOptions: github.ListOptions{PerPage: 100}}
	for {
		comments, resp, err := c.gh.Issues.ListComments(ctx, c.Owner, c.Repo, number, opts)
		if err != nil {
			return nil, fmt.Errorf("ghclient: list comments on #%d: %w", number, err)
		}
		for _, cm := range comments {
			out = append(out, state.Comment{Body: cm.GetBody()})
		}
		if resp.NextPage == 0 {
			break
		}
		opts.Page = resp.NextPage
	}
	return out, nil
}

// AddLabels adds labels to an issue or PR.
func (c *Client) AddLabels(ctx context.Context, number int, labels ...string) error {
	if _, _, err := c.gh.Issues.AddLabelsToIssue(ctx, c.Owner, c.Repo, number, labels); err != nil {
		return fmt.Errorf("ghclient: add labels to #%d: %w", number, err)
	}
	return nil
}

// PRBody returns a pull request's body (used to resolve it back to the
// issue it closes via state.IssueFromClosingKeywords).
func (c *Client) PRBody(ctx context.Context, number int) (string, error) {
	pr, _, err := c.gh.PullRequests.Get(ctx, c.Owner, c.Repo, number)
	if err != nil {
		return "", fmt.Errorf("ghclient: get PR #%d: %w", number, err)
	}
	return pr.GetBody(), nil
}

// OpenIssueNumbers lists the numbers of all currently-open issues carrying
// any of the given labels (used by the reaper to find orphaned boxes).
func (c *Client) OpenIssueNumbers(ctx context.Context, labels ...string) ([]int, error) {
	var out []int
	opts := &github.IssueListByRepoOptions{
		State:       "open",
		Labels:      labels,
		ListOptions: github.ListOptions{PerPage: 100},
	}
	for {
		issues, resp, err := c.gh.Issues.ListByRepo(ctx, c.Owner, c.Repo, opts)
		if err != nil {
			return nil, fmt.Errorf("ghclient: list open issues: %w", err)
		}
		for _, i := range issues {
			if i.IsPullRequest() {
				continue
			}
			out = append(out, i.GetNumber())
		}
		if resp.NextPage == 0 {
			break
		}
		opts.ListOptions.Page = resp.NextPage
	}
	return out, nil
}
