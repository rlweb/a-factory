package exe

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// VM is one entry from `ls`'s JSON response. exe.dev returns many more
// fields than this; only the ones a-factory actually uses are modeled.
type VM struct {
	VMName string   `json:"vm_name"`
	Tags   []string `json:"tags"`
	Status string   `json:"status"`
}

type lsResponse struct {
	VMs []VM `json:"vms"`
}

// ParseLS parses `ls`'s response body: {"vms":[{"vm_name":...,"tags":[...]},...]}.
func ParseLS(body []byte) ([]VM, error) {
	var out lsResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("exe: parse ls response: %w", err)
	}
	return out.VMs, nil
}

// NewVMResult is `new`'s JSON response — only the fields a-factory uses.
type NewVMResult struct {
	VMName     string `json:"vm_name"`
	ShelleyURL string `json:"shelley_url"`
	HTTPSURL   string `json:"https_url"`
}

// ParseNewVM parses `new`'s response body.
func ParseNewVM(body []byte) (NewVMResult, error) {
	var out NewVMResult
	if err := json.Unmarshal(body, &out); err != nil {
		return NewVMResult{}, fmt.Errorf("exe: parse new response: %w", err)
	}
	return out, nil
}

var generatedTokenRe = regexp.MustCompile(`(?m)^\s*(exe1\.\S+)\s*$`)

// ParseGeneratedToken extracts the bearer token from `ssh-key
// generate-api-key`'s plain-text SSH REPL output, e.g.:
//
//	Token created.
//	...
//	Token:
//	  exe1.EXAMPLEEXAMPLEEXAMPLEEX
//	...
func ParseGeneratedToken(output string) (string, error) {
	m := generatedTokenRe.FindStringSubmatch(output)
	if m == nil {
		return "", fmt.Errorf("exe: no token (exe1.*) found in generate-api-key output: %q", output)
	}
	return m[1], nil
}

// Integration is one row from `integrations list`'s plain-text SSH REPL
// output, e.g.:
//
//	spotlessscore-spotlessscore2  github  repos=SpotlessScore/spotlessscore2  tag:...
type Integration struct {
	Name  string
	Type  string
	Repos string // "" for non-github integrations, else "owner/repo"
}

var columnSplitRe = regexp.MustCompile(`\s{2,}`)

// ParseIntegrationsList parses `integrations list`'s plain-text output.
// Columns are separated by 2+ spaces (aligned table output), preserving
// single-spaced multi-word descriptions within a column.
func ParseIntegrationsList(output string) []Integration {
	var out []Integration
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		cols := columnSplitRe.Split(line, -1)
		if len(cols) < 2 {
			continue
		}
		integ := Integration{Name: cols[0], Type: cols[1]}
		for _, c := range cols[2:] {
			if repos, ok := strings.CutPrefix(c, "repos="); ok {
				integ.Repos = repos
			}
		}
		out = append(out, integ)
	}
	return out
}

// FindGitHubIntegration returns the name of the integration whose Repos
// matches "owner/repo" (case-sensitive, matching GitHub's own casing), or
// ok=false if none does.
func FindGitHubIntegration(integrations []Integration, owner, repo string) (name string, ok bool) {
	want := owner + "/" + repo
	for _, i := range integrations {
		if i.Type == "github" && i.Repos == want {
			return i.Name, true
		}
	}
	return "", false
}
