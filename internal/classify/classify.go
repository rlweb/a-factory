// Package classify maps an issue's "type:*" label to the mode, model, and
// prompt template a-factory uses to work it. Pure function — no I/O.
package classify

import (
	"fmt"
	"strings"
)

// Mode is the agent mode a classified issue runs in.
type Mode int

const (
	ModeUnknown Mode = iota
	// ModeBuild implements the change test-first and opens a PR (type:ticket).
	ModeBuild
	// ModeDiagnose reproduces a bug before fixing it, then opens a PR (type:bug).
	ModeDiagnose
	// ModePlan researches and decomposes an epic into sub-tickets; writes no
	// production code (type:epic).
	ModePlan
)

func (m Mode) String() string {
	switch m {
	case ModeBuild:
		return "build"
	case ModeDiagnose:
		return "diagnose"
	case ModePlan:
		return "plan"
	default:
		return "unknown"
	}
}

// Result is the resolved classification for an issue.
type Result struct {
	Mode     Mode
	Model    string
	Template string // "ticket" | "bug" | "epic" — the prompt template to render
}

const typeLabelPrefix = "type:"

var typeInfo = map[string]struct {
	mode           Mode
	template       string
	useStrongModel bool
}{
	"ticket": {ModeBuild, "ticket", false},
	"bug":    {ModeDiagnose, "bug", false},
	"epic":   {ModePlan, "epic", true},
}

// Classify inspects an issue's labels for exactly one recognized "type:*"
// label and returns the resulting Result.
//
// If zero or more than one distinct type is present, ok is false and reason
// explains why — the caller should post a clarifying comment on the issue
// rather than guess.
func Classify(labels []string, cheapModel, strongModel string) (result Result, ok bool, reason string) {
	seen := make(map[string]bool)
	var matched []string
	for _, l := range labels {
		rest, isType := strings.CutPrefix(l, typeLabelPrefix)
		if !isType {
			continue
		}
		if _, known := typeInfo[rest]; !known {
			continue
		}
		if !seen[rest] {
			seen[rest] = true
			matched = append(matched, rest)
		}
	}

	switch len(matched) {
	case 0:
		return Result{}, false, "no type:ticket, type:bug, or type:epic label found"
	case 1:
		info := typeInfo[matched[0]]
		model := cheapModel
		if info.useStrongModel {
			model = strongModel
		}
		return Result{Mode: info.mode, Model: model, Template: info.template}, true, ""
	default:
		return Result{}, false, fmt.Sprintf(
			"multiple type labels present (%s) — exactly one of type:ticket, type:bug, type:epic is required",
			strings.Join(matched, ", "),
		)
	}
}
