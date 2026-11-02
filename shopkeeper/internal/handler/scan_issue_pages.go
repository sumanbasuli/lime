package handler

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/actrules"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
	log "github.com/sumanbasuli/lime/shopkeeper/internal/safelog"
)

type scanIssuePageRepository interface {
	ListScanIssuesPage(context.Context, string, int, int) ([]models.Issue, int64, error)
	GetScanIssueOccurrencePage(context.Context, string, string, int, int) (*models.Issue, []models.IssueOccurrence, int64, error)
}

type issuePageGroup struct {
	Summary        models.MCPIssueSummary `json:"summary"`
	ActRules       []models.ACTRule       `json:"act_rules"`
	SuggestedFixes []string               `json:"suggested_fixes"`
}

// The two slots are local to a Shopkeeper process. A slot stays occupied while
// json.Encoder builds and writes the complete response.
func (h *Handler) acquireIssueRead() (func(), bool) {
	select {
	case h.issueReadSlots <- struct{}{}:
		return func() { <-h.issueReadSlots }, true
	default:
		return nil, false
	}
}

func writeIssueReadBusy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "1")
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{
		"error": "Too many scan issue reads are in progress; retry shortly",
	})
}

func writeIssueResponseTooLarge(w http.ResponseWriter) {
	writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{
		"error": "Scan issues are too large for one response; use GET /api/scans/{id}/issues/page?limit=20&offset=0 and GET /api/scans/{id}/issues/{issueId}/occurrences?limit=25&offset=0. If a page is too large, reduce its limit",
	})
}

func issuePageParams(r *http.Request, defaultLimit, maxLimit int) (int, int, bool) {
	query := r.URL.Query()
	limit, offset := defaultLimit, 0
	for key, bounds := range map[string][2]int{"limit": {1, maxLimit}, "offset": {0, 1_000_000}} {
		values, ok := query[key]
		if !ok {
			continue
		}
		if len(values) != 1 {
			return 0, 0, false
		}
		value, err := strconv.Atoi(values[0])
		if err != nil || value < bounds[0] || value > bounds[1] {
			return 0, 0, false
		}
		if key == "limit" {
			limit = value
		} else {
			offset = value
		}
	}
	return limit, offset, true
}

// issueACTFits uses the maximum JSON string expansion, including control
// escapes, without allocating a second serialized copy of ACT metadata.
func issueACTFits(issue models.Issue) bool {
	remaining := int64(64 << 10)
	charge := func(size int64) bool {
		if size < 0 || size > remaining {
			return false
		}
		remaining -= size
		return true
	}
	chargeString := func(value string) bool {
		return int64(len(value)) <= remaining/6 && charge(int64(len(value))*6)
	}
	for _, rule := range issue.ActRules {
		if !charge(256) || !chargeString(rule.ActRuleID) || !chargeString(rule.Title) ||
			!chargeString(rule.Status) || !chargeString(rule.RuleURL) || !chargeString(rule.Summary) {
			return false
		}
		for _, requirement := range rule.AccessibilityRequirements {
			if !charge(192) || !chargeString(requirement.ID) || !chargeString(requirement.Title) ||
				!chargeString(requirement.Failed) || !chargeString(requirement.Passed) || !chargeString(requirement.Inapplicable) {
				return false
			}
		}
		for _, fix := range rule.SuggestedFixes {
			if !charge(64) || !chargeString(fix) {
				return false
			}
		}
	}
	for _, fix := range issue.SuggestedFixes {
		if !charge(64) || !chargeString(fix) {
			return false
		}
	}
	return true
}

func (h *Handler) issuePageScanExists(w http.ResponseWriter, r *http.Request, id string) bool {
	if !validScanID(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid scan ID"})
		return false
	}
	scan, err := h.repo.GetScan(r.Context(), id)
	if err != nil {
		log.Printf("Failed to get scan for issue page: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to get scan"})
		return false
	}
	if scan == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Scan not found"})
		return false
	}
	return true
}

// GetScanIssuesPage handles GET /api/scans/{id}/issues/page.
func (h *Handler) GetScanIssuesPage(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	limit, offset, valid := issuePageParams(r, 20, 50)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "limit must be 1-50 and offset must be 0-1000000, each supplied once"})
		return
	}
	if !h.issuePageScanExists(w, r, id) {
		return
	}
	pageRepo, ok := h.repo.(scanIssuePageRepository)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Scan issue paging is unavailable"})
		return
	}
	release, ok := h.acquireIssueRead()
	if !ok {
		writeIssueReadBusy(w)
		return
	}
	defer release()
	issues, total, err := pageRepo.ListScanIssuesPage(r.Context(), id, limit, offset)
	if errors.Is(err, repository.ErrScanIssuesTooLarge) {
		writeIssueResponseTooLarge(w)
		return
	}
	if err != nil {
		log.Printf("Failed to get scan issue page: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to get scan issue page"})
		return
	}
	resolver, resolverErr := actrules.Default()
	if resolverErr != nil {
		log.Printf("ACT resolver unavailable, using empty ACT context: %v", resolverErr)
	}
	groups := make([]issuePageGroup, 0, len(issues))
	for _, issue := range issues {
		if resolver != nil {
			issue.ActRules, issue.SuggestedFixes = resolver.Resolve(issue.ViolationType)
		}
		if !issueACTFits(issue) {
			writeIssueResponseTooLarge(w)
			return
		}
		issueID, severity := issue.ID, issue.Severity
		helpURL := issue.HelpURL
		if helpURL != nil {
			publicHelp := log.PublicURLText(*helpURL)
			helpURL = &publicHelp
		}
		publicIssue := models.PublicIssue(issue)
		groups = append(groups, issuePageGroup{
			Summary: models.MCPIssueSummary{
				Kind: "failed", Key: issue.ID, IssueID: &issueID,
				RuleID: issue.ViolationType, Title: issue.Description,
				HelpURL: helpURL, Severity: &severity,
				IsFalsePositive: issue.IsFalsePositive, OccurrenceCount: issue.OccurrenceCount,
			},
			ActRules: publicIssue.ActRules, SuggestedFixes: publicIssue.SuggestedFixes,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"issues": groups, "total": total, "limit": limit, "offset": offset,
	})
}

// GetScanIssueOccurrences handles GET /api/scans/{id}/issues/{issueId}/occurrences.
func (h *Handler) GetScanIssueOccurrences(w http.ResponseWriter, r *http.Request) {
	id, issueID := chi.URLParam(r, "id"), chi.URLParam(r, "issueId")
	limit, offset, valid := issuePageParams(r, 25, 100)
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "limit must be 1-100 and offset must be 0-1000000, each supplied once"})
		return
	}
	if !validScanID(issueID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid issue ID"})
		return
	}
	if !h.issuePageScanExists(w, r, id) {
		return
	}
	pageRepo, ok := h.repo.(scanIssuePageRepository)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Scan issue paging is unavailable"})
		return
	}
	release, ok := h.acquireIssueRead()
	if !ok {
		writeIssueReadBusy(w)
		return
	}
	defer release()
	issue, occurrences, total, err := pageRepo.GetScanIssueOccurrencePage(r.Context(), id, issueID, limit, offset)
	if errors.Is(err, repository.ErrScanIssuesTooLarge) {
		writeIssueResponseTooLarge(w)
		return
	}
	if err != nil {
		log.Printf("Failed to get scan issue occurrences: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to get scan issue occurrences"})
		return
	}
	if issue == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Issue not found in scan"})
		return
	}
	resolver, resolverErr := actrules.Default()
	if resolverErr != nil {
		log.Printf("ACT resolver unavailable, using empty ACT context: %v", resolverErr)
	}
	if resolver != nil {
		issue.ActRules, issue.SuggestedFixes = resolver.Resolve(issue.ViolationType)
	}
	if !issueACTFits(*issue) {
		writeIssueResponseTooLarge(w)
		return
	}
	publicIssue := models.PublicIssue(*issue)
	for i := range occurrences {
		occurrences[i].PageURL = log.PublicURLText(occurrences[i].PageURL)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"issue": publicIssue, "occurrences": occurrences, "total": total,
		"limit": limit, "offset": offset,
		"has_more": int64(offset+len(occurrences)) < total,
	})
}
