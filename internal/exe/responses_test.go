package exe

import (
	"reflect"
	"testing"
)

func TestParseLS(t *testing.T) {
	body := []byte(`{"vms":[
		{"vm_name":"a-factory-issue-42","tags":["a-factory"],"status":"running"},
		{"vm_name":"parachute-sable","tags":["spotlessscore-spotlessscore2"],"status":"running"}
	]}`)
	vms, err := ParseLS(body)
	if err != nil {
		t.Fatalf("ParseLS() error = %v", err)
	}
	want := []VM{
		{VMName: "a-factory-issue-42", Tags: []string{"a-factory"}, Status: "running"},
		{VMName: "parachute-sable", Tags: []string{"spotlessscore-spotlessscore2"}, Status: "running"},
	}
	if !reflect.DeepEqual(vms, want) {
		t.Errorf("ParseLS() = %+v, want %+v", vms, want)
	}
}

func TestParseLSEmpty(t *testing.T) {
	vms, err := ParseLS([]byte(`{"vms":[]}`))
	if err != nil {
		t.Fatalf("ParseLS() error = %v", err)
	}
	if len(vms) != 0 {
		t.Errorf("ParseLS() = %+v, want empty", vms)
	}
}

func TestParseLSMalformed(t *testing.T) {
	if _, err := ParseLS([]byte(`not json`)); err == nil {
		t.Fatal("ParseLS() error = nil, want an error for malformed JSON")
	}
}

func TestParseNewVM(t *testing.T) {
	body := []byte(`{"vm_name":"a-factory-issue-42","shelley_url":"https://a-factory-issue-42.shelley.exe.xyz","https_url":"https://a-factory-issue-42.exe.xyz"}`)
	got, err := ParseNewVM(body)
	if err != nil {
		t.Fatalf("ParseNewVM() error = %v", err)
	}
	want := NewVMResult{
		VMName:     "a-factory-issue-42",
		ShelleyURL: "https://a-factory-issue-42.shelley.exe.xyz",
		HTTPSURL:   "https://a-factory-issue-42.exe.xyz",
	}
	if got != want {
		t.Errorf("ParseNewVM() = %+v, want %+v", got, want)
	}
}

func TestParseGeneratedToken(t *testing.T) {
	output := `Token created.

Label:       spike-test
Expires:     Aug 7, 2026
VM:          a-factory-spike-test
Commands:    (defaults)

Token:
  exe1.EXAMPLEEXAMPLEEXAMPLEEX

This token will not be shown again. Store it securely.
Revoke with: ssh-key remove spike-test
`
	token, err := ParseGeneratedToken(output)
	if err != nil {
		t.Fatalf("ParseGeneratedToken() error = %v", err)
	}
	if token != "exe1.EXAMPLEEXAMPLEEXAMPLEEX" {
		t.Errorf("ParseGeneratedToken() = %q, want exe1.EXAMPLEEXAMPLEEXAMPLEEX", token)
	}
}

func TestParseGeneratedTokenNotFound(t *testing.T) {
	if _, err := ParseGeneratedToken("no token here"); err == nil {
		t.Fatal("ParseGeneratedToken() error = nil, want an error when no token is present")
	}
}

func TestParseIntegrationsList(t *testing.T) {
	output := `spotlessscore-spotlessscore2  github  repos=SpotlessScore/spotlessscore2  tag:spotlessscore-spotlessscore2
notify  notify  push notifications to device  auto:all
llm  llm  providers=openai(byok)  auto:all
reflection  reflection  fields=all  auto:all
`
	got := ParseIntegrationsList(output)
	want := []Integration{
		{Name: "spotlessscore-spotlessscore2", Type: "github", Repos: "SpotlessScore/spotlessscore2"},
		{Name: "notify", Type: "notify", Repos: ""},
		{Name: "llm", Type: "llm", Repos: ""},
		{Name: "reflection", Type: "reflection", Repos: ""},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ParseIntegrationsList() = %+v, want %+v", got, want)
	}
}

func TestParseIntegrationsListEmpty(t *testing.T) {
	got := ParseIntegrationsList("")
	if len(got) != 0 {
		t.Errorf("ParseIntegrationsList(\"\") = %+v, want empty", got)
	}
}

func TestFindGitHubIntegration(t *testing.T) {
	integrations := []Integration{
		{Name: "notify", Type: "notify"},
		{Name: "spotlessscore-spotlessscore2", Type: "github", Repos: "SpotlessScore/spotlessscore2"},
	}

	name, ok := FindGitHubIntegration(integrations, "SpotlessScore", "spotlessscore2")
	if !ok || name != "spotlessscore-spotlessscore2" {
		t.Errorf("FindGitHubIntegration() = (%q, %v), want (spotlessscore-spotlessscore2, true)", name, ok)
	}

	_, ok = FindGitHubIntegration(integrations, "rlweb", "a-factory")
	if ok {
		t.Error("FindGitHubIntegration() ok = true, want false for a repo with no matching integration")
	}
}
