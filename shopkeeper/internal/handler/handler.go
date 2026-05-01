package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/actrules"
	"github.com/sumanbasuli/lime/shopkeeper/internal/buildinfo"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/screenshots"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

type ScanRepository interface {
	CreateScan(ctx context.Context, sitemapURL, scanType string, tag *string, scanViewport viewport.Settings) (*models.Scan, error)
	ListScans(ctx context.Context) ([]models.Scan, error)
	ListScansByTag(ctx context.Context, tag string) ([]models.Scan, error)
	GetScan(ctx context.Context, id string) (*models.Scan, error)
	GetScanIssues(ctx context.Context, scanID string) ([]models.IssueWithOccurrences, error)
	RetryFailedURLs(ctx context.Context, id string) (*models.Scan, int, error)
	DeleteScan(ctx context.Context, id string) (bool, error)
	RequestPause(ctx context.Context, id string) (*models.Scan, error)
	ResumeScan(ctx context.Context, id string) (*models.Scan, error)
	SetIssueFalsePositive(ctx context.Context, scanID, issueID string, isFalsePositive bool) (*models.Issue, error)
	GetStats(ctx context.Context) (*models.Stats, error)
}

// ScanRunner defines the interface for running async scans.
// This avoids a circular dependency with the scanner package.
type ScanRunner interface {
	RunScan(scan models.Scan)
	RequestPause(scanID string)
}

// IssueReportGenerator defines the interface for rendering issue reports to PDF.
type IssueReportGenerator interface {
	GenerateIssueReportPDF(ctx context.Context, scanID, kind, key string) ([]byte, error)
}

// Handler holds dependencies for HTTP handlers.
type Handler struct {
	repo     ScanRepository
	scanner  ScanRunner
	reporter IssueReportGenerator
}

// New creates a new Handler with the given repository, scanner, and reporter.
func New(repo ScanRepository, scanner ScanRunner, reporter IssueReportGenerator) *Handler {
	return &Handler{repo: repo, scanner: scanner, reporter: reporter}
}

// HealthCheck returns a simple health status.
func (h *Handler) HealthCheck(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"service": "shopkeeper",
	})
}

// Version reports the embedded build version and commit SHA.
func (h *Handler) Version(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"version": buildinfo.Version,
		"commit":  buildinfo.Commit,
	})
}

// CreateScan handles POST /api/scans.
func (h *Handler) CreateScan(w http.ResponseWriter, r *http.Request) {
	var req models.CreateScanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Invalid request body",
		})
		return
	}

	// Default scan_type to "sitemap" if not provided
	if req.ScanType == "" {
		req.ScanType = "sitemap"
	}

	// Validate scan_type
	if req.ScanType != "sitemap" && req.ScanType != "single" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "scan_type must be 'sitemap' or 'single'",
		})
		return
	}

	// Validate URL
	if req.SitemapURL == "" {
		label := "sitemap_url"
		if req.ScanType == "single" {
			label = "URL"
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": label + " is required",
		})
		return
	}
	parsedURL, err := url.ParseRequestURI(req.SitemapURL)
	if err != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "URL must be a valid HTTP/HTTPS URL",
		})
		return
	}

	// Trim empty tag to nil
	if req.Tag != nil && *req.Tag == "" {
		req.Tag = nil
	}

	scanViewport, err := viewport.ResolvePreset(req.ViewportPreset)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("viewport_preset must be one of: %s", strings.Join(viewport.ValidPresetKeys(), ", ")),
		})
		return
	}

	// Create scan record
	scan, err := h.repo.CreateScan(r.Context(), req.SitemapURL, req.ScanType, req.Tag, scanViewport)
	if err != nil {
		log.Printf("Failed to create scan: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to create scan",
		})
		return
	}

	// Launch async scan pipeline
	if h.scanner != nil {
		go h.scanner.RunScan(*scan)
	}

	writeJSON(w, http.StatusCreated, scan)
}

// ListScans handles GET /api/scans.
// Supports optional ?tag= query parameter for filtering.
func (h *Handler) ListScans(w http.ResponseWriter, r *http.Request) {
	tag := r.URL.Query().Get("tag")

	var scans []models.Scan
	var err error

	if tag != "" {
		scans, err = h.repo.ListScansByTag(r.Context(), tag)
	} else {
		scans, err = h.repo.ListScans(r.Context())
	}

	if err != nil {
		log.Printf("Failed to list scans: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to list scans",
		})
		return
	}
	writeJSON(w, http.StatusOK, scans)
}

// GetScan handles GET /api/scans/{id}.
func (h *Handler) GetScan(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Scan ID is required",
		})
		return
	}

	scan, err := h.repo.GetScan(r.Context(), id)
	if err != nil {
		log.Printf("Failed to get scan: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to get scan",
		})
		return
	}
	if scan == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "Scan not found",
		})
		return
	}

	writeJSON(w, http.StatusOK, scan)
}

// GetScanIssues handles GET /api/scans/{id}/issues.
func (h *Handler) GetScanIssues(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Scan ID is required",
		})
		return
	}

	// Verify scan exists
	scan, err := h.repo.GetScan(r.Context(), id)
	if err != nil {
		log.Printf("Failed to get scan: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to get scan",
		})
		return
	}
	if scan == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "Scan not found",
		})
		return
	}

	issues, err := h.repo.GetScanIssues(r.Context(), id)
	if err != nil {
		log.Printf("Failed to get scan issues: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to get scan issues",
		})
		return
	}

	resolver, resolverErr := actrules.Default()
	if resolverErr != nil {
		log.Printf("ACT resolver unavailable, using empty ACT context: %v", resolverErr)
	}
	if resolver != nil {
		issues = resolver.EnrichIssues(issues)
	}

	writeJSON(w, http.StatusOK, issues)
}

// MarkIssueFalsePositive handles POST /api/scans/{id}/issues/{issueId}/false-positive.
func (h *Handler) MarkIssueFalsePositive(w http.ResponseWriter, r *http.Request) {
	h.updateIssueFalsePositive(w, r, true)
}

// UnmarkIssueFalsePositive handles DELETE /api/scans/{id}/issues/{issueId}/false-positive.
func (h *Handler) UnmarkIssueFalsePositive(w http.ResponseWriter, r *http.Request) {
	h.updateIssueFalsePositive(w, r, false)
}

// RescanScan handles POST /api/scans/{id}/rescan.
// It creates a fresh scan using the same target URL, scan type, tag, and viewport.
func (h *Handler) RescanScan(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Scan ID is required",
		})
		return
	}

	scan, err := h.repo.GetScan(r.Context(), id)
	if err != nil {
		log.Printf("Failed to get scan: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to get scan",
		})
		return
	}
	if scan == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "Scan not found",
		})
		return
	}
	if !isTerminalScanStatus(scan.Status) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "Only completed, paused, or failed scans can be rescanned",
		})
		return
	}

	newScan, err := h.repo.CreateScan(
		r.Context(),
		scan.SitemapURL,
		scan.ScanType,
		scan.Tag,
		viewport.SettingsFromStored(scan.ViewportPreset, scan.ViewportWidth, scan.ViewportHeight),
	)
	if err != nil {
		log.Printf("Failed to create rescan: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to create rescan",
		})
		return
	}

	if h.scanner != nil {
		go h.scanner.RunScan(*newScan)
	}

	writeJSON(w, http.StatusCreated, newScan)
}

// RetryFailedPages handles POST /api/scans/{id}/retry-failed.
// It requeues failed URLs on a completed partial scan without creating a new scan.
func (h *Handler) RetryFailedPages(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Scan ID is required",
		})
		return
	}

	updatedScan, retriedURLCount, err := h.repo.RetryFailedURLs(r.Context(), id)
	if err != nil {
		log.Printf("Failed to retry failed pages for scan %s: %v", id, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to retry failed pages",
		})
		return
	}
	if updatedScan == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "Scan not found",
		})
		return
	}
	if updatedScan.Status != "pending" || retriedURLCount == 0 {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "Only completed partial scans with failed pages can retry failed pages",
		})
		return
	}

	if h.scanner != nil {
		go h.scanner.RunScan(*updatedScan)
	}

	writeJSON(w, http.StatusOK, models.RetryFailedPagesResponse{
		Scan:            *updatedScan,
		RetriedURLCount: retriedURLCount,
	})
}

// DeleteScan handles DELETE /api/scans/{id}.
// Deletion is limited to terminal scans to avoid conflicts with the active scanner.
func (h *Handler) DeleteScan(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Scan ID is required",
		})
		return
	}

	scan, err := h.repo.GetScan(r.Context(), id)
	if err != nil {
		log.Printf("Failed to get scan: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to get scan",
		})
		return
	}
	if scan == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "Scan not found",
		})
		return
	}
	if !isTerminalScanStatus(scan.Status) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "Only completed, paused, or failed scans can be deleted",
		})
		return
	}

	deleted, err := h.repo.DeleteScan(r.Context(), id)
	if err != nil {
		log.Printf("Failed to delete scan: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to delete scan",
		})
		return
	}
	if !deleted {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "Scan not found",
		})
		return
	}

	if err := os.RemoveAll(screenshotDir(id)); err != nil {
		log.Printf("Failed to remove screenshots for scan %s: %v", id, err)
	}

	w.WriteHeader(http.StatusNoContent)
}

// PauseScan handles POST /api/scans/{id}/pause.
// It requests a cooperative pause for an active scan.
func (h *Handler) PauseScan(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Scan ID is required",
		})
		return
	}

	scan, err := h.repo.GetScan(r.Context(), id)
	if err != nil {
		log.Printf("Failed to get scan: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to get scan",
		})
		return
	}
	if scan == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "Scan not found",
		})
		return
	}

	if !isPausableScanStatus(scan.Status) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "Only active scans can be paused",
		})
		return
	}

	if scan.PauseRequested {
		writeJSON(w, http.StatusOK, scan)
		return
	}

	updatedScan, err := h.repo.RequestPause(r.Context(), id)
	if err != nil {
		log.Printf("Failed to request pause for scan %s: %v", id, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to pause scan",
		})
		return
	}
	if updatedScan == nil {
		currentScan, currentErr := h.repo.GetScan(r.Context(), id)
		if currentErr != nil {
			log.Printf("Failed to reload scan %s after pause request race: %v", id, currentErr)
		}
		if currentScan == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{
				"error": "Scan not found",
			})
			return
		}
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "Scan is no longer active",
		})
		return
	}

	if h.scanner != nil {
		h.scanner.RequestPause(id)
	}

	writeJSON(w, http.StatusOK, updatedScan)
}

// ResumeScan handles POST /api/scans/{id}/resume.
// It resumes a paused scan from its persisted URL and result state.
func (h *Handler) ResumeScan(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Scan ID is required",
		})
		return
	}

	scan, err := h.repo.GetScan(r.Context(), id)
	if err != nil {
		log.Printf("Failed to get scan: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to get scan",
		})
		return
	}
	if scan == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "Scan not found",
		})
		return
	}
	if scan.Status != "paused" {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "Only paused scans can be resumed",
		})
		return
	}

	updatedScan, err := h.repo.ResumeScan(r.Context(), id)
	if err != nil {
		log.Printf("Failed to resume scan %s: %v", id, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to resume scan",
		})
		return
	}
	if updatedScan == nil {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "Scan is no longer paused",
		})
		return
	}

	if h.scanner != nil {
		go h.scanner.RunScan(*updatedScan)
	}

	writeJSON(w, http.StatusOK, updatedScan)
}

// DownloadIssueReport handles GET /api/scans/{id}/issues/report.pdf.
func (h *Handler) DownloadIssueReport(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Scan ID is required",
		})
		return
	}
	if h.reporter == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "Issue report generation is unavailable",
		})
		return
	}

	kind := r.URL.Query().Get("kind")
	key := r.URL.Query().Get("key")
	if (kind == "") != (key == "") || (kind != "" && kind != "failed" && kind != "needs_review") {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "kind and key must describe a failed or needs_review issue scope",
		})
		return
	}

	scan, err := h.repo.GetScan(r.Context(), id)
	if err != nil {
		log.Printf("Failed to get scan: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to get scan",
		})
		return
	}
	if scan == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "Scan not found",
		})
		return
	}

	pdf, err := h.reporter.GenerateIssueReportPDF(r.Context(), id, kind, key)
	if err != nil {
		log.Printf("Failed to generate issue report PDF for scan %s: %v", id, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to generate issue report",
		})
		return
	}

	filename := buildIssueReportFilename(scan.SitemapURL, scan.CreatedAt)
	if kind != "" && key != "" {
		filename = buildScopedIssueReportFilename(scan.SitemapURL, scan.CreatedAt, kind, key)
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(pdf); err != nil {
		log.Printf("Failed to stream issue report PDF for scan %s: %v", id, err)
	}
}

func (h *Handler) updateIssueFalsePositive(w http.ResponseWriter, r *http.Request, isFalsePositive bool) {
	scanID := chi.URLParam(r, "id")
	if scanID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Scan ID is required",
		})
		return
	}

	issueID := chi.URLParam(r, "issueId")
	if issueID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Issue ID is required",
		})
		return
	}

	issue, err := h.repo.SetIssueFalsePositive(r.Context(), scanID, issueID, isFalsePositive)
	if err != nil {
		log.Printf("Failed to update false-positive state: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to update issue state",
		})
		return
	}
	if issue == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": "Issue not found for scan",
		})
		return
	}

	resolver, resolverErr := actrules.Default()
	if resolverErr != nil {
		log.Printf("ACT resolver unavailable, using empty ACT context: %v", resolverErr)
	}
	if resolver != nil {
		issue.ActRules, issue.SuggestedFixes = resolver.Resolve(issue.ViolationType)
	}
	if issue.ActRules == nil {
		issue.ActRules = []models.ACTRule{}
	}
	if issue.SuggestedFixes == nil {
		issue.SuggestedFixes = []string{}
	}

	writeJSON(w, http.StatusOK, issue)
}

// GetStats handles GET /api/stats.
func (h *Handler) GetStats(w http.ResponseWriter, r *http.Request) {
	stats, err := h.repo.GetStats(r.Context())
	if err != nil {
		log.Printf("Failed to get stats: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to get stats",
		})
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

// ServeScreenshot handles GET /api/screenshots/{scanId}/{filename}.
// It serves screenshot image files from the screenshots directory.
func (h *Handler) ServeScreenshot(w http.ResponseWriter, r *http.Request) {
	scanID := chi.URLParam(r, "scanId")
	filename := chi.URLParam(r, "filename")

	// Sanitize: prevent path traversal
	if strings.Contains(scanID, "..") || strings.Contains(filename, "..") || strings.Contains(filename, "/") {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	filePath := filepath.Join(screenshotDir(scanID), filename)
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		http.Error(w, "Screenshot not found", http.StatusNotFound)
		return
	}

	if contentType, err := detectFileContentType(filePath); err == nil && contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, filePath)
}

func isTerminalScanStatus(status string) bool {
	return status == "completed" || status == "paused" || status == "failed"
}

func isPausableScanStatus(status string) bool {
	return status == "pending" || status == "profiling" || status == "scanning" || status == "processing"
}

func screenshotDir(scanID string) string {
	return screenshots.ScanDir(scanID)
}

func detectFileContentType(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	buf := make([]byte, 512)
	n, err := file.Read(buf)
	if err != nil {
		return "", err
	}

	return http.DetectContentType(buf[:n]), nil
}

func buildIssueReportFilename(rawURL string, createdAt time.Time) string {
	host := sanitizeFilenameToken(rawURL)

	return fmt.Sprintf(
		"lime-issue-report-%s-%s.pdf",
		host,
		createdAt.UTC().Format("2006-01-02"),
	)
}

func buildScopedIssueReportFilename(rawURL string, createdAt time.Time, kind, key string) string {
	host := sanitizeFilenameToken(rawURL)
	scope := sanitizeFilenameToken(fmt.Sprintf("%s-%s", kind, key))

	return fmt.Sprintf(
		"lime-issue-report-%s-%s-%s.pdf",
		host,
		createdAt.UTC().Format("2006-01-02"),
		scope,
	)
}

func sanitizeFilenameToken(rawValue string) string {
	host := "scan"
	if parsedURL, err := url.Parse(rawValue); err == nil && parsedURL.Host != "" {
		host = parsedURL.Host
	} else if rawValue != "" {
		host = rawValue
	}

	host = strings.ToLower(host)
	host = strings.ReplaceAll(host, ".", "-")

	var sanitized strings.Builder
	for _, r := range host {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			sanitized.WriteRune(r)
		} else if r == '_' || r == '/' || r == ':' {
			sanitized.WriteRune('-')
		}
	}
	if sanitized.Len() == 0 {
		sanitized.WriteString("scan")
	}

	return sanitized.String()
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
