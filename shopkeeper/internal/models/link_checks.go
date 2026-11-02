package models

import "time"

// Link checks are separate from accessibility scoring, issues, and screenshots.
type LinkCheck struct {
	ID           string      `json:"id"`
	ScanID       *string     `json:"scan_id"`
	URL          string      `json:"url"`
	CheckType    string      `json:"check_type"`
	Status       string      `json:"status"`
	MaxPages     int         `json:"max_pages"`
	PagesChecked int         `json:"pages_checked"`
	PagesFailed  int         `json:"pages_failed"`
	LinksChecked int         `json:"links_checked"`
	TotalLinks   int         `json:"total_links"`
	Truncated    bool        `json:"truncated"`
	Error        *string     `json:"error"`
	Summary      LinkSummary `json:"summary"`
	SeedURLs     []string    `json:"-"`
	RootPublic   bool        `json:"-"`
	CreatedAt    time.Time   `json:"created_at"`
	UpdatedAt    time.Time   `json:"updated_at"`
	CompletedAt  *time.Time  `json:"completed_at"`
}

type LinkSummary struct {
	Healthy    int `json:"healthy"`
	Redirected int `json:"redirected"`
	Broken     int `json:"broken"`
	Error      int `json:"error"`
	Blocked    int `json:"blocked"`
	Unchecked  int `json:"unchecked"`
	Timeout    int `json:"timeout"`
}

type LinkSource struct {
	PageURL   string `json:"page_url"`
	Element   string `json:"element"`
	Attribute string `json:"attribute"`
	Text      string `json:"text"`
}

type LinkResult struct {
	ID              string       `json:"id"`
	TargetURL       string       `json:"target_url"`
	Status          string       `json:"status"`
	StatusCode      *int         `json:"status_code"`
	FinalURL        *string      `json:"final_url"`
	RedirectCount   int          `json:"redirect_count"`
	LinkType        string       `json:"link_type"`
	OccurrenceCount int          `json:"occurrence_count"`
	Sources         []LinkSource `json:"sources"`
	Error           *string      `json:"error"`
	ErrorKind       *string      `json:"error_kind"`
}

type CreateLinkCheckRequest struct {
	URL       string `json:"url"`
	CheckType string `json:"check_type"`
	MaxPages  int    `json:"max_pages,omitempty"`
}
