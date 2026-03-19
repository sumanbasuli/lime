package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/campuspress/lime/shopkeeper/internal/models"
	"github.com/campuspress/lime/shopkeeper/internal/repository"
	"github.com/go-chi/chi/v5"
)

const screenshotBaseDir = "/app/screenshots"

// ScanRunner defines the interface for running async scans.
// This avoids a circular dependency with the scanner package.
type ScanRunner interface {
	RunScan(scanID, targetURL, scanType string)
}

// Handler holds dependencies for HTTP handlers.
type Handler struct {
	repo    *repository.Repository
	scanner ScanRunner
}

// New creates a new Handler with the given repository and scanner.
func New(repo *repository.Repository, scanner ScanRunner) *Handler {
	return &Handler{repo: repo, scanner: scanner}
}

// HealthCheck returns a simple health status.
func (h *Handler) HealthCheck(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"service": "shopkeeper",
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

	// Create scan record
	scan, err := h.repo.CreateScan(r.Context(), req.SitemapURL, req.ScanType, req.Tag)
	if err != nil {
		log.Printf("Failed to create scan: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to create scan",
		})
		return
	}

	// Launch async scan pipeline
	if h.scanner != nil {
		go h.scanner.RunScan(scan.ID, scan.SitemapURL, scan.ScanType)
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

	writeJSON(w, http.StatusOK, issues)
}

// RescanScan handles POST /api/scans/{id}/rescan.
// It creates a fresh scan using the same target URL, scan type, and tag.
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
			"error": "Only completed or failed scans can be rescanned",
		})
		return
	}

	newScan, err := h.repo.CreateScan(r.Context(), scan.SitemapURL, scan.ScanType, scan.Tag)
	if err != nil {
		log.Printf("Failed to create rescan: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Failed to create rescan",
		})
		return
	}

	if h.scanner != nil {
		go h.scanner.RunScan(newScan.ID, newScan.SitemapURL, newScan.ScanType)
	}

	writeJSON(w, http.StatusCreated, newScan)
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
			"error": "Only completed or failed scans can be deleted",
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

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, filePath)
}

func isTerminalScanStatus(status string) bool {
	return status == "completed" || status == "failed"
}

func screenshotDir(scanID string) string {
	return filepath.Join(screenshotBaseDir, scanID)
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
