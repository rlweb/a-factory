// Package config centralizes environment-variable configuration for a-factory.
//
// Values come from GitHub Actions variables (vars.*) passed through as env vars.
// When a variable is unset at every level, GitHub expands it to an empty string
// in the workflow, so every reader here treats "" the same as unset and falls
// back to a baked default. This is the only package that reads os.Getenv —
// everything else takes typed config as a parameter, which is what keeps it
// testable without env-var juggling.
package config

import (
	"os"
	"strconv"
	"strings"
)

// raw reads an env var, treating both undefined and empty-string as "not set".
func raw(name string) (string, bool) {
	v := os.Getenv(name)
	if v == "" {
		return "", false
	}
	return v, true
}

// IntEnv reads a numeric env var with a default. Empty/unset/non-numeric all
// fall back to def.
func IntEnv(name string, def int) int {
	v, ok := raw(name)
	if !ok {
		return def
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		return def
	}
	return n
}

// StrEnv reads a string env var with a default.
func StrEnv(name string, def string) string {
	v, ok := raw(name)
	if !ok {
		return def
	}
	return v
}

// ListEnv reads a comma-separated env var with a default. Blank entries are
// trimmed and dropped; if nothing is left, def is returned.
func ListEnv(name string, def []string) []string {
	v, ok := raw(name)
	if !ok {
		return def
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return def
	}
	return out
}

// Baked defaults — the shared baseline; org/repo vars override via env.
const (
	DefaultVMPrefix           = "a-factory"
	DefaultStateMarkerPrefix  = "<!-- a-factory:state"
	DefaultCheapModel         = "deepseek-v4-flash"
	DefaultStrongModel        = "deepseek-v4-pro"
	DefaultBoxImage           = "ghcr.io/rlweb/a-factory:latest"
	DefaultOpenCodeEndpoint   = "https://opencode.ai/zen/go/v1"
	DefaultMaxTokens          = 8192
	DefaultVMTag              = "a-factory"
	DefaultShelleyTokenExpiry = "30d"
)

// Config is the resolved, typed configuration for a single CLI invocation.
type Config struct {
	// VMPrefix names each box: "<VMPrefix>-issue-<n>".
	VMPrefix string
	// StateMarkerPrefix tags every factory-authored comment carrying state,
	// so relay routing can both parse it and skip re-triggering on it.
	StateMarkerPrefix string
	// CheapModel is used for type:ticket / type:bug (Build / Diagnose+build).
	CheapModel string
	// StrongModel is used for type:epic (Plan mode).
	StrongModel string
	// BoxImage is the exe.dev VM image a-factory provisions.
	BoxImage string
	// OpenCodeAPIKey authenticates the custom-model registrations Provision
	// sends to Shelley (proxies to OpenCode's LLM gateway). No default —
	// operationally required, deliberately not faked.
	OpenCodeAPIKey string
	// OpenCodeEndpoint is the OpenCode Zen gateway URL registered for every
	// custom model.
	OpenCodeEndpoint string
	// MaxTokens is the per-call token cap registered for every custom model.
	MaxTokens int
	// VMTag tags every box a-factory creates, so Reap can identify its own
	// VMs via exe.dev's own tag attribute rather than name-prefix matching.
	VMTag string
	// VMExtraTags are additional tags added alongside VMTag.
	VMExtraTags []string
	// VMCPU, VMMemory, and VMDisk override exe.dev's resource defaults when set.
	VMCPU    string
	VMMemory string
	VMDisk   string
	// VMEnv passes comma-separated KEY=VALUE entries to exe.dev.
	VMEnv []string
	// VMPool selects an exe.dev team pool when set.
	VMPool string
	// VMIntegrations attaches additional exe.dev integrations at creation time.
	VMIntegrations []string
	// VMRegistryAuth supplies USERNAME:PASSWORD for a private image registry.
	VMRegistryAuth string
	// VMSetupScript runs once on first boot.
	VMSetupScript string
	// ShelleyTokenExpiry is the --exp value for the VM-scoped Shelley key
	// minted at Provision time (e.g. "30d", "1y", "never").
	ShelleyTokenExpiry string
}

// Load resolves Config from the environment.
func Load() Config {
	return Config{
		VMPrefix:           StrEnv("FACTORY_VM_PREFIX", DefaultVMPrefix),
		StateMarkerPrefix:  StrEnv("FACTORY_STATE_MARKER_PREFIX", DefaultStateMarkerPrefix),
		CheapModel:         StrEnv("FACTORY_CHEAP_MODEL", DefaultCheapModel),
		StrongModel:        StrEnv("FACTORY_STRONG_MODEL", DefaultStrongModel),
		BoxImage:           StrEnv("FACTORY_BOX_IMAGE", DefaultBoxImage),
		OpenCodeAPIKey:     StrEnv("OPENCODE_API_KEY", ""),
		OpenCodeEndpoint:   StrEnv("FACTORY_OPENCODE_ENDPOINT", DefaultOpenCodeEndpoint),
		MaxTokens:          IntEnv("FACTORY_MAX_TOKENS", DefaultMaxTokens),
		VMTag:              StrEnv("FACTORY_VM_TAG", DefaultVMTag),
		VMExtraTags:        ListEnv("FACTORY_VM_TAGS", nil),
		VMCPU:              StrEnv("FACTORY_VM_CPU", ""),
		VMMemory:           StrEnv("FACTORY_VM_MEMORY", ""),
		VMDisk:             StrEnv("FACTORY_VM_DISK", ""),
		VMEnv:              ListEnv("FACTORY_VM_ENV", nil),
		VMPool:             StrEnv("FACTORY_VM_POOL", ""),
		VMIntegrations:     ListEnv("FACTORY_VM_INTEGRATIONS", nil),
		VMRegistryAuth:     StrEnv("FACTORY_VM_REGISTRY_AUTH", ""),
		VMSetupScript:      StrEnv("FACTORY_VM_SETUP_SCRIPT", ""),
		ShelleyTokenExpiry: StrEnv("FACTORY_SHELLEY_TOKEN_EXPIRY", DefaultShelleyTokenExpiry),
	}
}
