package classify

import "testing"

const cheap = "deepseek-v4-flash"
const strong = "deepseek-v4-pro"

func TestClassify(t *testing.T) {
	cases := []struct {
		name       string
		labels     []string
		wantResult Result
		wantOK     bool
		wantReason string
	}{
		{
			name:       "type:ticket -> build mode, cheap model",
			labels:     []string{"type:ticket"},
			wantResult: Result{Mode: ModeBuild, Model: cheap, Template: "ticket"},
			wantOK:     true,
		},
		{
			name:       "type:bug -> diagnose mode, cheap model",
			labels:     []string{"type:bug"},
			wantResult: Result{Mode: ModeDiagnose, Model: cheap, Template: "bug"},
			wantOK:     true,
		},
		{
			name:       "type:epic -> plan mode, strong model",
			labels:     []string{"type:epic"},
			wantResult: Result{Mode: ModePlan, Model: strong, Template: "epic"},
			wantOK:     true,
		},
		{
			name:       "type label alongside unrelated labels still classifies",
			labels:     []string{"priority:high", "type:ticket", "needs-triage"},
			wantResult: Result{Mode: ModeBuild, Model: cheap, Template: "ticket"},
			wantOK:     true,
		},
		{
			name:       "no labels is ambiguous",
			labels:     nil,
			wantOK:     false,
			wantReason: "no type:ticket, type:bug, or type:epic label found",
		},
		{
			name:       "labels present but none are type labels is ambiguous",
			labels:     []string{"priority:high", "needs-triage"},
			wantOK:     false,
			wantReason: "no type:ticket, type:bug, or type:epic label found",
		},
		{
			name:       "duplicate identical type label is not ambiguous",
			labels:     []string{"type:ticket", "type:ticket"},
			wantResult: Result{Mode: ModeBuild, Model: cheap, Template: "ticket"},
			wantOK:     true,
		},
		{
			name:       "two distinct type labels is ambiguous",
			labels:     []string{"type:ticket", "type:bug"},
			wantOK:     false,
			wantReason: "multiple type labels present (ticket, bug) — exactly one of type:ticket, type:bug, type:epic is required",
		},
		{
			name:       "an unrecognized type: label is ignored, not misclassified",
			labels:     []string{"type:chore"},
			wantOK:     false,
			wantReason: "no type:ticket, type:bug, or type:epic label found",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok, reason := Classify(tc.labels, cheap, strong)
			if ok != tc.wantOK {
				t.Fatalf("Classify() ok = %v, want %v (reason=%q)", ok, tc.wantOK, reason)
			}
			if !tc.wantOK {
				if reason != tc.wantReason {
					t.Errorf("Classify() reason = %q, want %q", reason, tc.wantReason)
				}
				return
			}
			if got != tc.wantResult {
				t.Errorf("Classify() = %+v, want %+v", got, tc.wantResult)
			}
		})
	}
}

func TestModeString(t *testing.T) {
	cases := map[Mode]string{
		ModeUnknown:  "unknown",
		ModeBuild:    "build",
		ModeDiagnose: "diagnose",
		ModePlan:     "plan",
		Mode(99):     "unknown",
	}
	for mode, want := range cases {
		if got := mode.String(); got != want {
			t.Errorf("Mode(%d).String() = %q, want %q", mode, got, want)
		}
	}
}
