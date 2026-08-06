package config

import "testing"

func TestIntEnv(t *testing.T) {
	cases := []struct {
		name string
		set  bool
		val  string
		def  int
		want int
	}{
		{"unset falls back", false, "", 7, 7},
		{"empty string falls back", true, "", 7, 7},
		{"valid int used", true, "42", 7, 42},
		{"non-numeric falls back", true, "not-a-number", 7, 7},
		{"whitespace-padded valid int used", true, "  42  ", 7, 42},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			const key = "FACTORY_TEST_INT"
			if tc.set {
				t.Setenv(key, tc.val)
			}
			if got := IntEnv(key, tc.def); got != tc.want {
				t.Errorf("IntEnv() = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestStrEnv(t *testing.T) {
	cases := []struct {
		name string
		set  bool
		val  string
		def  string
		want string
	}{
		{"unset falls back", false, "", "default", "default"},
		{"empty string falls back", true, "", "default", "default"},
		{"valid string used", true, "custom", "default", "custom"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			const key = "FACTORY_TEST_STR"
			if tc.set {
				t.Setenv(key, tc.val)
			}
			if got := StrEnv(key, tc.def); got != tc.want {
				t.Errorf("StrEnv() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestListEnv(t *testing.T) {
	def := []string{"a", "b"}
	cases := []struct {
		name string
		set  bool
		val  string
		want []string
	}{
		{"unset falls back to default", false, "", def},
		{"empty string falls back to default", true, "", def},
		{"single value", true, "x", []string{"x"}},
		{"multiple values trimmed", true, " x , y ,z", []string{"x", "y", "z"}},
		{"all blank entries falls back to default", true, " , ,", def},
		{"blank entries dropped, real ones kept", true, "x,,y", []string{"x", "y"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			const key = "FACTORY_TEST_LIST"
			if tc.set {
				t.Setenv(key, tc.val)
			}
			got := ListEnv(key, def)
			if len(got) != len(tc.want) {
				t.Fatalf("ListEnv() = %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("ListEnv()[%d] = %q, want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestLoadDefaults(t *testing.T) {
	c := Load()
	if c.VMPrefix != DefaultVMPrefix {
		t.Errorf("VMPrefix = %q, want %q", c.VMPrefix, DefaultVMPrefix)
	}
	if c.StateMarkerPrefix != DefaultStateMarkerPrefix {
		t.Errorf("StateMarkerPrefix = %q, want %q", c.StateMarkerPrefix, DefaultStateMarkerPrefix)
	}
	if c.CheapModel != DefaultCheapModel {
		t.Errorf("CheapModel = %q, want %q", c.CheapModel, DefaultCheapModel)
	}
	if c.StrongModel != DefaultStrongModel {
		t.Errorf("StrongModel = %q, want %q", c.StrongModel, DefaultStrongModel)
	}
	if c.BoxImage != DefaultBoxImage {
		t.Errorf("BoxImage = %q, want %q", c.BoxImage, DefaultBoxImage)
	}
	if c.OpenCodeAPIKey != "" {
		t.Errorf("OpenCodeAPIKey = %q, want empty by default", c.OpenCodeAPIKey)
	}
	if c.OpenCodeEndpoint != DefaultOpenCodeEndpoint {
		t.Errorf("OpenCodeEndpoint = %q, want %q", c.OpenCodeEndpoint, DefaultOpenCodeEndpoint)
	}
	if c.MaxTokens != DefaultMaxTokens {
		t.Errorf("MaxTokens = %d, want %d", c.MaxTokens, DefaultMaxTokens)
	}
	if c.VMTag != DefaultVMTag {
		t.Errorf("VMTag = %q, want %q", c.VMTag, DefaultVMTag)
	}
	if c.ShelleyTokenExpiry != DefaultShelleyTokenExpiry {
		t.Errorf("ShelleyTokenExpiry = %q, want %q", c.ShelleyTokenExpiry, DefaultShelleyTokenExpiry)
	}
}

func TestLoadOverrides(t *testing.T) {
	t.Setenv("FACTORY_VM_PREFIX", "custom-prefix")
	t.Setenv("FACTORY_CHEAP_MODEL", "custom-model")
	t.Setenv("FACTORY_VM_CPU", "4")
	t.Setenv("FACTORY_VM_MEMORY", "16GB")
	t.Setenv("FACTORY_VM_DISK", "50GB")
	t.Setenv("FACTORY_VM_TAGS", "preview,staging")
	t.Setenv("FACTORY_VM_ENV", "FOO=bar,BAZ=qux")
	t.Setenv("FACTORY_VM_POOL", "team-pool")
	t.Setenv("FACTORY_VM_INTEGRATIONS", "monitoring,alerts")
	t.Setenv("FACTORY_VM_REGISTRY_AUTH", "user:password")
	t.Setenv("FACTORY_VM_SETUP_SCRIPT", "#!/bin/sh\necho ready")
	c := Load()
	if c.VMPrefix != "custom-prefix" {
		t.Errorf("VMPrefix = %q, want %q", c.VMPrefix, "custom-prefix")
	}
	if c.CheapModel != "custom-model" {
		t.Errorf("CheapModel = %q, want %q", c.CheapModel, "custom-model")
	}
	if c.VMCPU != "4" || c.VMMemory != "16GB" || c.VMDisk != "50GB" {
		t.Errorf("VM sizing = %q/%q/%q, want 4/16GB/50GB", c.VMCPU, c.VMMemory, c.VMDisk)
	}
	if len(c.VMExtraTags) != 2 || c.VMExtraTags[0] != "preview" || c.VMExtraTags[1] != "staging" {
		t.Errorf("VMExtraTags = %v, want [preview staging]", c.VMExtraTags)
	}
	if len(c.VMEnv) != 2 || c.VMEnv[0] != "FOO=bar" || c.VMEnv[1] != "BAZ=qux" {
		t.Errorf("VMEnv = %v, want [FOO=bar BAZ=qux]", c.VMEnv)
	}
	if c.VMPool != "team-pool" || len(c.VMIntegrations) != 2 || c.VMRegistryAuth != "user:password" || c.VMSetupScript != "#!/bin/sh\necho ready" {
		t.Errorf("VM optional settings not loaded correctly: %+v", c)
	}
}
