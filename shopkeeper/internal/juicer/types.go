package juicer

// RawResult holds the accessibility scan results for a single page.
type RawResult struct {
	URLID          string      `json:"url_id"`
	URL            string      `json:"url"`
	Violations     []Violation `json:"violations"`
	Incomplete     []Violation `json:"incomplete,omitempty"`
	NotApplicable  []RuleID    `json:"notApplicable,omitempty"`
	Passes         []RuleID    `json:"passes,omitempty"`
	Version        string      `json:"version,omitempty"`
	ScreenshotPath string      `json:"screenshot_path"`
	Error          string      `json:"error,omitempty"`
	Canceled       bool        `json:"-"`
}

// Violation represents a single axe-core accessibility violation.
type Violation struct {
	ID          string   `json:"id"`
	Description string   `json:"description"`
	Help        string   `json:"help"`
	HelpURL     string   `json:"helpUrl"`
	Impact      string   `json:"impact"`
	Tags        []string `json:"tags,omitempty"`
	Nodes       []Node   `json:"nodes"`
}

// Node represents a specific DOM element that triggered a violation.
type Node struct {
	HTML                  string   `json:"html"`
	Target                []string `json:"target"`
	FailureSummary        string   `json:"failureSummary,omitempty"`
	RelatedNodes          []Node   `json:"relatedNodes,omitempty"`
	ElementScreenshotPath string   `json:"-"` // populated after scanning
	CaptureIndex          int      `json:"-"`
	HasCaptureIndex       bool     `json:"-"`
}

// RuleID stores a rule identifier from axe output categories we do not persist yet.
type RuleID struct {
	ID string `json:"id"`
}

// axeResult is the full structure returned by the Lighthouse-style axe serializer.
type axeResult struct {
	Violations    []Violation `json:"violations"`
	Incomplete    []Violation `json:"incomplete"`
	NotApplicable []RuleID    `json:"notApplicable"`
	Passes        []RuleID    `json:"passes"`
	Version       string      `json:"version"`
}
