package juicer

// RawResult holds the accessibility scan results for a single page.
type RawResult struct {
	URLID          string      `json:"url_id"`
	URL            string      `json:"url"`
	Violations     []Violation `json:"violations"`
	ScreenshotPath string      `json:"screenshot_path"`
	Error          string      `json:"error,omitempty"`
}

// Violation represents a single axe-core accessibility violation.
type Violation struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Help        string `json:"help"`
	HelpURL     string `json:"helpUrl"`
	Impact      string `json:"impact"`
	Nodes       []Node `json:"nodes"`
}

// Node represents a specific DOM element that triggered a violation.
type Node struct {
	HTML                  string   `json:"html"`
	Target                []string `json:"target"`
	ElementScreenshotPath string   `json:"-"` // populated after scanning
}

// axeResult is the full structure returned by axe.run() — we only care about violations.
type axeResult struct {
	Violations []Violation `json:"violations"`
}
