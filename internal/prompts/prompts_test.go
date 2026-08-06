package prompts

import (
	"os"
	"path/filepath"
	"testing"
)

var sampleData = Data{
	Number: 42,
	Title:  "Add dark mode toggle",
	Body:   "Users want a dark mode toggle in settings.",
	Author: "carol",
	Path:   "src/theme/toggle.ts",
	Line:   24,
}

func goldenPath(t *testing.T, name string) string {
	t.Helper()
	return filepath.Join("testdata", "golden", name+".golden")
}

// TestRenderGolden renders every template against sampleData and compares
// against a committed golden file. Set UPDATE_GOLDEN=1 to (re)write the
// golden files after a deliberate template change.
func TestRenderGolden(t *testing.T) {
	for _, name := range []string{Ticket, Bug, Epic, PRComment, InlineComment} {
		t.Run(name, func(t *testing.T) {
			got, err := Render(name, sampleData)
			if err != nil {
				t.Fatalf("Render(%q) error = %v", name, err)
			}

			path := goldenPath(t, name)
			if os.Getenv("UPDATE_GOLDEN") == "1" {
				if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
					t.Fatalf("write golden file: %v", err)
				}
			}

			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read golden file %s: %v (run with UPDATE_GOLDEN=1 to create it)", path, err)
			}
			if got != string(want) {
				t.Errorf("Render(%q) mismatch.\ngot:\n%s\nwant:\n%s", name, got, string(want))
			}
		})
	}
}

func TestRenderUnknownTemplate(t *testing.T) {
	if _, err := Render("nonexistent", sampleData); err == nil {
		t.Fatal("Render(\"nonexistent\") error = nil, want an error")
	}
}

// TestPlaceholdersRequirePresentFields guards the "fails a test instead of
// silently rendering blank" property: templates reference only fields that
// exist on Data, so a typo'd placeholder breaks Render with an error rather
// than emitting a blank value in production. This is exercised implicitly by
// TestRenderGolden succeeding, but assert it holds for every template name
// explicitly so a future template addition can't skip the guarantee.
func TestPlaceholdersRequirePresentFields(t *testing.T) {
	for _, name := range []string{Ticket, Bug, Epic, PRComment, InlineComment} {
		if _, err := Render(name, Data{}); err != nil {
			t.Errorf("Render(%q, Data{}) error = %v, want nil (zero-value Data must still render, just with blanks)", name, err)
		}
	}
}
