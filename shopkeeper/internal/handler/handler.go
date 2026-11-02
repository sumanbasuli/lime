package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/actrules"
	"github.com/sumanbasuli/lime/shopkeeper/internal/buildinfo"
	"github.com/sumanbasuli/lime/shopkeeper/internal/linkchecker"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/reporter"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
	log "github.com/sumanbasuli/lime/shopkeeper/internal/safelog"
	"github.com/sumanbasuli/lime/shopkeeper/internal/screenshots"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

type ScanRepository interface {
	CreateScan(ctx context.Context, sitemapURL, scanType string, tag *string, scanViewport viewport.Settings) (*models.Scan, error)
	CreateRescanFrom(ctx context.Context, sourceScanID string) (*models.Scan, error)
	ListScansPage(ctx context.Context, tag string, limit, offset int) ([]models.Scan, error)
	GetScan(ctx context.Context, id string) (*models.Scan, error)
	ScreenshotVisible(ctx context.Context, scanID, filename string) (bool, error)
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

type pdfPolicyRepository interface {
	GetPDFReportPolicy(ctx context.Context) (*models.PDFReportPolicy, error)
}

// pdfRenderLimiter also retains the slot during response delivery, when the
// generated PDF byte slice is still held in memory.
type pdfRenderLimiter struct {
	mu     sync.Mutex
	active int
}

const maxPDFResponseBytes = 64 << 20
const maxPDFPreflightRequests = 10

func writeAdmissionBusy(w http.ResponseWriter, err error) bool {
	var capacity *repository.AdmissionCapacityError
	if !errors.As(err, &capacity) {
		return false
	}
	w.Header().Set("Retry-After", "30")
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{
		"error": "The scan or link check queue is full; retry later",
	})
	return true
}

func (l *pdfRenderLimiter) tryAcquire(limit int) (func(), bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if limit < 1 {
		limit = 1
	}
	if l.active >= limit {
		return nil, false
	}
	l.active++
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			l.active--
			l.mu.Unlock()
		})
	}, true
}

func writePDFReportSizeError(w http.ResponseWriter, scanID, kind, key, message string) {
	// CSV is served by the dashboard, not by direct Shopkeeper HTTP routes.
	// Keep this path dashboard-relative for both proxied and direct PDF callers.
	query := url.Values{"mode": {"full"}}
	if kind != "" && key != "" {
		query.Set("kind", kind)
		query.Set("key", key)
	}
	csvURL := fmt.Sprintf("/api/scans/%s/issues/report.csv?%s", url.PathEscape(scanID), query.Encode())
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{
		"error":   message,
		"csv_url": csvURL,
	})
}

// Handler holds dependencies for HTTP handlers.
type Handler struct {
	repo           ScanRepository
	scanner        ScanRunner
	reporter       IssueReportGenerator
	pdfLimiter     pdfRenderLimiter
	pdfPreflight   chan struct{}
	issueReadSlots chan struct{}
	links          LinkRepository
	linkRunner     LinkRunner
}

// New creates a new Handler with the given repository, scanner, and reporter.
func New(repo ScanRepository, scanner ScanRunner, reporter IssueReportGenerator) *Handler {
	return &Handler{
		repo:           repo,
		scanner:        scanner,
		reporter:       reporter,
		pdfPreflight:   make(chan struct{}, maxPDFPreflightRequests),
		issueReadSlots: make(chan struct{}, 2),
	}
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
	const maxCreateScanBodyBytes = 1 << 20
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxCreateScanBodyBytes))
	var req models.CreateScanRequest
	if err == nil {
		err = json.NewDecoder(bytes.NewReader(body)).Decode(&req)
	}
	if err != nil {
		status := http.StatusBadRequest
		message := "Invalid request body"
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			status = http.StatusRequestEntityTooLarge
			message = "Request body too large"
		}
		writeJSON(w, status, map[string]string{
			"error": message,
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
	if req.IncludeLinkCheck {
		if _, err := linkchecker.Normalize(req.SitemapURL); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": log.Text(err.Error())})
			return
		}
	}
	scan, err := h.createScan(r.Context(), req.SitemapURL, req.ScanType, req.Tag, scanViewport, req.IncludeLinkCheck)
	if err != nil {
		if writeAdmissionBusy(w, err) {
			return
		}
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

	writeJSON(w, http.StatusCreated, models.PublicScan(*scan))
}

const (
	legacyScanListMax = 1000
	scanListPageMax   = 200
	scanListMaxOffset = 1_000_000
)

// ListScans handles GET /api/scans. The legacy array shape is unchanged for
// small histories. Larger histories require explicit, bounded pagination.
func (h *Handler) ListScans(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	tag := query.Get("tag")
	paged := query.Has("limit") || query.Has("offset")
	limit, offset := legacyScanListMax+1, 0
	if paged {
		limit = 100
		if values, ok := query["limit"]; ok {
			if len(values) != 1 {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "limit must be a single integer from 1 to 200"})
				return
			}
			parsed, err := strconv.Atoi(values[0])
			if err != nil || parsed < 1 || parsed > scanListPageMax {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "limit must be an integer from 1 to 200"})
				return
			}
			limit = parsed
		}
		if values, ok := query["offset"]; ok {
			if len(values) != 1 {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "offset must be a single non-negative integer"})
				return
			}
			parsed, err := strconv.Atoi(values[0])
			if err != nil || parsed < 0 || parsed > scanListMaxOffset {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "offset must be an integer from 0 to 1000000"})
				return
			}
			offset = parsed
		}
	}
	scans, err := h.repo.ListScansPage(r.Context(), tag, limit, offset)
	if err != nil {
		log.Printf("Failed to list scans: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to list scans",
		})
		return
	}
	if !paged && len(scans) > legacyScanListMax {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{
			"error": "Scan history is too large for one response; use limit (1-200) and offset to page through scans",
		})
		return
	}
	writeJSON(w, http.StatusOK, models.PublicScans(scans))
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

	writeJSON(w, http.StatusOK, models.PublicScan(*scan))
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

	release, ok := h.acquireIssueRead()
	if !ok {
		writeIssueReadBusy(w)
		return
	}
	defer release()
	issues, err := h.repo.GetScanIssues(r.Context(), id)
	if err != nil {
		if errors.Is(err, repository.ErrScanIssuesTooLarge) {
			writeIssueResponseTooLarge(w)
			return
		}
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
	for _, item := range issues {
		if !issueACTFits(item.Issue) {
			writeIssueResponseTooLarge(w)
			return
		}
	}

	// GetScanIssues owns these result slices for this request. Redact before
	// encoding instead of duplicating a potentially large result set.
	for i := range issues {
		issues[i].Issue = models.PublicIssue(issues[i].Issue)
		for j := range issues[i].Occurrences {
			occurrence := &issues[i].Occurrences[j]
			occurrence.PageURL = log.PublicURLText(occurrence.PageURL)
		}
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
// It creates a fresh scan using the same target settings and root DNS history.
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

	newScan, err := h.repo.CreateRescanFrom(r.Context(), scan.ID)
	if err != nil {
		if writeAdmissionBusy(w, err) {
			return
		}
		if errors.Is(err, repository.ErrRescanNotReady) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "Only completed, paused, or failed scans can be rescanned"})
			return
		}
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Scan not found"})
			return
		}
		log.Printf("Failed to create rescan: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to create rescan",
		})
		return
	}

	if h.scanner != nil {
		go h.scanner.RunScan(*newScan)
	}

	writeJSON(w, http.StatusCreated, models.PublicScan(*newScan))
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
		if writeAdmissionBusy(w, err) {
			return
		}
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
		Scan:            models.PublicScan(*updatedScan),
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
	if !validScanID(id) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Scan not found"})
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
		finishMissingScanDeletion(w, id)
		return
	}
	if !isTerminalScanStatus(scan.Status) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "Only completed, paused, or failed scans can be deleted",
		})
		return
	}

	var companion *models.LinkCheck
	if h.links != nil {
		companion, err = h.links.GetScanLinkCheck(r.Context(), id)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to load companion link check"})
			return
		}
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
		current, err := h.repo.GetScan(r.Context(), id)
		if err != nil {
			log.Printf("Failed to recheck scan after delete conflict: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to get scan"})
			return
		}
		if current != nil {
			writeJSON(w, http.StatusConflict, map[string]string{
				"error": "Only completed, paused, or failed scans can be deleted",
			})
		} else {
			finishMissingScanDeletion(w, id)
		}
		return
	}
	if companion != nil && h.linkRunner != nil {
		h.linkRunner.Cancel(companion.ID)
	}

	if err := os.RemoveAll(screenshotDir(strings.ToLower(scan.ID))); err != nil {
		log.Printf("Failed to remove screenshots for scan %s: %v", id, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Scan deleted, but screenshot cleanup failed",
		})
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// A prior deletion can commit but fail to remove evidence from a read-only or
// otherwise broken screenshot volume. Allow an exact-ID retry to finish that
// cleanup without requiring a database row that was already removed.
func finishMissingScanDeletion(w http.ResponseWriter, id string) {
	dir := screenshotDir(strings.ToLower(id))
	if _, err := os.Lstat(dir); os.IsNotExist(err) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Scan not found"})
		return
	} else if err != nil {
		log.Printf("Failed to inspect orphaned screenshots for scan %s: %v", id, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to inspect screenshot cleanup"})
		return
	}
	if err := os.RemoveAll(dir); err != nil {
		log.Printf("Failed to remove orphaned screenshots for scan %s: %v", id, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Screenshot cleanup failed; retry deletion"})
		return
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
		writeJSON(w, http.StatusOK, models.PublicScan(*scan))
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

	writeJSON(w, http.StatusOK, models.PublicScan(*updatedScan))
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
		if writeAdmissionBusy(w, err) {
			return
		}
		log.Printf("Failed to resume scan %s: %v", id, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to resume scan",
		})
		return
	}
	if updatedScan == nil {
		current, err := h.repo.GetScan(r.Context(), id)
		if err != nil {
			log.Printf("Failed to recheck scan after resume conflict: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to get scan"})
			return
		}
		if current == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Scan not found"})
		} else {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "Scan is no longer paused"})
		}
		return
	}

	if h.scanner != nil {
		go h.scanner.RunScan(*updatedScan)
	}

	writeJSON(w, http.StatusOK, models.PublicScan(*updatedScan))
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
	policyRepo, ok := h.repo.(pdfPolicyRepository)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "PDF report policy is unavailable",
		})
		return
	}
	if r.Context().Err() != nil {
		return
	}
	// The persisted policy and scan lookup are database work too. Admit that
	// preflight before either read, independently of the configured PDF render
	// limit, whose maximum is ten.
	select {
	case h.pdfPreflight <- struct{}{}:
		defer func() { <-h.pdfPreflight }()
	default:
		w.Header().Set("Retry-After", "1")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "PDF generation is busy; retry shortly",
		})
		return
	}
	policy, err := policyRepo.GetPDFReportPolicy(r.Context())
	if err != nil || policy == nil {
		log.Printf("Failed to get PDF report policy: %v", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "PDF report policy is unavailable",
		})
		return
	}
	if !policy.Enabled {
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error": "PDF exports are disabled in settings",
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
	release, ok := h.pdfLimiter.tryAcquire(policy.Concurrency)
	if !ok {
		w.Header().Set("Retry-After", "1")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "PDF generation is busy; retry shortly",
		})
		return
	}
	defer release()
	if r.Context().Err() != nil {
		return
	}

	pdf, err := h.reporter.GenerateIssueReportPDF(r.Context(), id, kind, key)
	if err != nil {
		if errors.Is(err, reporter.ErrReportBusy) {
			w.Header().Set("Retry-After", "1")
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{
				"error": "HTML report generation is busy; retry shortly",
			})
			return
		}
		if errors.Is(err, reporter.ErrReportTooLarge) {
			writePDFReportSizeError(w, id, kind, key, "Report too large to render safely; use the complete CSV export if enabled")
			return
		}
		if errors.Is(err, reporter.ErrPDFTooLarge) {
			writePDFReportSizeError(w, id, kind, key, "Generated PDF exceeds the 64 MiB download limit; use the complete CSV export if enabled")
			return
		}
		log.Printf("Failed to generate issue report PDF for scan %s: %v", id, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to generate issue report",
		})
		return
	}
	if len(pdf) > maxPDFResponseBytes {
		writePDFReportSizeError(w, id, kind, key, "Generated PDF exceeds the 64 MiB download limit; use the complete CSV export if enabled")
		return
	}

	filename := buildIssueReportFilename(scan.SitemapURL, scan.CreatedAt)
	if kind != "" && key != "" {
		filename = buildScopedIssueReportFilename(scan.SitemapURL, scan.CreatedAt, kind, key)
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(pdf)))
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

	writeJSON(w, http.StatusOK, models.PublicIssue(*issue))
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
	if !validScanID(scanID) {
		http.Error(w, "Screenshot not found", http.StatusNotFound)
		return
	}
	scan, err := h.repo.GetScan(r.Context(), scanID)
	if err != nil {
		log.Printf("Failed to load scan for screenshot: %v", err)
		http.Error(w, "Failed to load screenshot", http.StatusInternalServerError)
		return
	}
	if scan == nil {
		http.Error(w, "Screenshot not found", http.StatusNotFound)
		return
	}
	visible, err := h.repo.ScreenshotVisible(r.Context(), scan.ID, filename)
	if err != nil {
		log.Printf("Failed to check screenshot visibility: %v", err)
		http.Error(w, "Failed to load screenshot", http.StatusInternalServerError)
		return
	}
	if !visible {
		http.Error(w, "Screenshot not found", http.StatusNotFound)
		return
	}

	filePath := filepath.Join(screenshotDir(strings.ToLower(scan.ID)), filename)
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		http.Error(w, "Screenshot not found", http.StatusNotFound)
		return
	}

	if contentType, err := detectFileContentType(filePath); err == nil && contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Cache-Control", "private, no-store")
	http.ServeFile(w, r, filePath)
}

func isTerminalScanStatus(status string) bool {
	return status == "completed" || status == "paused" || status == "failed"
}

func validScanID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for index := 0; index < len(id); index++ {
		character := id[index]
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if character != '-' {
				return false
			}
			continue
		}
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')) {
			return false
		}
	}
	return true
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
	host := reportHostFilenameToken(rawURL)

	return fmt.Sprintf(
		"lime-issue-report-%s-%s.pdf",
		host,
		createdAt.UTC().Format("2006-01-02"),
	)
}

func buildScopedIssueReportFilename(rawURL string, createdAt time.Time, kind, key string) string {
	host := reportHostFilenameToken(rawURL)
	scope := sanitizeFilenameToken(fmt.Sprintf("%s-%s", kind, key))

	return fmt.Sprintf(
		"lime-issue-report-%s-%s-%s.pdf",
		host,
		createdAt.UTC().Format("2006-01-02"),
		scope,
	)
}

func reportHostFilenameToken(rawURL string) string {
	parsedURL, err := url.Parse(rawURL)
	if err != nil || parsedURL.Host == "" {
		return "scan"
	}
	return sanitizeFilenameToken(parsedURL.Host)
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
