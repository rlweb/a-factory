// Package prompts renders the fixed ticket/bug/epic seed prompts and the
// PR-comment/inline-review-comment relay prompts a-factory feeds to Shelley.
package prompts

import (
	"embed"
	"fmt"
	"strings"
	"text/template"
)

//go:embed templates/*.tmpl
var templatesFS embed.FS

var parsed = template.Must(
	template.New("prompts").Option("missingkey=error").ParseFS(templatesFS, "templates/*.tmpl"),
)

// Data supplies every placeholder available across all prompt templates.
// Not every template uses every field (e.g. Path/Line are only meaningful
// for inline_comment).
type Data struct {
	Number int
	Title  string
	Body   string
	Author string
	Path   string
	Line   int
}

// Names of the templates Render accepts.
const (
	Ticket         = "ticket"
	Bug            = "bug"
	Epic           = "epic"
	PRComment      = "pr_comment"
	InlineComment  = "inline_comment"
)

// Render renders the named template against data. name must be one of the
// constants above.
func Render(name string, data Data) (string, error) {
	var buf strings.Builder
	if err := parsed.ExecuteTemplate(&buf, name+".tmpl", data); err != nil {
		return "", fmt.Errorf("render template %q: %w", name, err)
	}
	return buf.String(), nil
}
