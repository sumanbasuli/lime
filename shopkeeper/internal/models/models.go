package models

import (
	"time"
)

// Scan represents a top-level accessibility scan record.
type Scan struct {
	ID          string    `json:"id"`
	SitemapURL  string    `json:"sitemap_url"`
	Status      string    `json:"status"`
	ScanType    string    `json:"scan_type"`
	Tag         *string   `json:"tag"`
	TotalURLs   int       `json:"total_urls"`
	ScannedURLs int       `json:"scanned_urls"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// URL represents an individual page URL discovered during a scan.
type URL struct {
	ID        string    `json:"id"`
	ScanID    string    `json:"scan_id"`
	URL       string    `json:"url"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}

// Issue represents a deduplicated accessibility violation found during a scan.
type Issue struct {
	ID              string    `json:"id"`
	ScanID          string    `json:"scan_id"`
	ViolationType   string    `json:"violation_type"`
	Description     string    `json:"description"`
	HelpURL         *string   `json:"help_url"`
	Severity        string    `json:"severity"`
	CreatedAt       time.Time `json:"created_at"`
	OccurrenceCount int       `json:"occurrence_count,omitempty"`
	ActRules        []ACTRule `json:"act_rules"`
	SuggestedFixes  []string  `json:"suggested_fixes"`
}

// ACTAccessibilityRequirement represents a WCAG or supporting requirement mapped to an ACT rule.
type ACTAccessibilityRequirement struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	ForConformance bool   `json:"for_conformance"`
	Failed         string `json:"failed"`
	Passed         string `json:"passed"`
	Inapplicable   string `json:"inapplicable"`
}

// ACTRule represents ACT metadata attached to a scan issue at read time.
type ACTRule struct {
	ActRuleID                 string                        `json:"act_rule_id"`
	Title                     string                        `json:"title"`
	Status                    string                        `json:"status"`
	RuleURL                   string                        `json:"rule_url"`
	AccessibilityRequirements []ACTAccessibilityRequirement `json:"accessibility_requirements"`
	Summary                   string                        `json:"summary"`
	SuggestedFixes            []string                      `json:"suggested_fixes"`
}

// IssueOccurrence represents a specific instance of an issue on a particular URL.
type IssueOccurrence struct {
	ID                    string    `json:"id"`
	IssueID               string    `json:"issue_id"`
	URLID                 string    `json:"url_id"`
	HTMLSnippet           *string   `json:"html_snippet"`
	ScreenshotPath        *string   `json:"screenshot_path"`
	ElementScreenshotPath *string   `json:"element_screenshot_path"`
	CSSSelector           *string   `json:"css_selector"`
	CreatedAt             time.Time `json:"created_at"`
	PageURL               string    `json:"page_url,omitempty"`
}

// IssueWithOccurrences groups an issue with all its occurrences.
type IssueWithOccurrences struct {
	Issue       Issue             `json:"issue"`
	Occurrences []IssueOccurrence `json:"occurrences"`
}

// CreateScanRequest is the request body for POST /api/scans.
type CreateScanRequest struct {
	SitemapURL string  `json:"sitemap_url"`
	ScanType   string  `json:"scan_type,omitempty"`
	Tag        *string `json:"tag,omitempty"`
}

// Stats holds aggregate dashboard statistics.
type Stats struct {
	TotalScans  int `json:"total_scans"`
	TotalIssues int `json:"total_issues"`
	TotalPages  int `json:"total_pages"`
}
