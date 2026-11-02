package handler

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/linkchecker"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
	log "github.com/sumanbasuli/lime/shopkeeper/internal/safelog"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

type LinkRepository interface {
	CreateLinkCheck(context.Context, string, string, int, []string) (*models.LinkCheck, error)
	CreateLinkCheckFrom(context.Context, string) (*models.LinkCheck, error)
	GetLinkCheck(context.Context, string) (*models.LinkCheck, error)
	GetScanLinkCheck(context.Context, string) (*models.LinkCheck, error)
	ListLinkChecks(context.Context, int, int) ([]models.LinkCheck, int, error)
	GetLinkCheckStats(context.Context) (map[string]int64, error)
	GetLinkResults(context.Context, string, string, int, int) ([]models.LinkResult, int, error)
	StreamLinkExportRows(context.Context, string, func(models.LinkResult, models.LinkSource) error) error
	GetLinkSources(context.Context, string, string, int, int) ([]models.LinkSource, int, bool, error)
	CancelLinkCheck(context.Context, string) (*models.LinkCheck, error)
	DeleteLinkCheck(context.Context, string) (bool, error)
}

type LinkRunner interface{ Cancel(string) }

func (h *Handler) WithLinkChecker(repo LinkRepository, runner LinkRunner) *Handler {
	h.links = repo
	h.linkRunner = runner
	return h
}

func validID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for i, c := range id {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}

func pagination(r *http.Request) (int, int, bool) {
	limit, offset := 50, 0
	var err error
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 200 {
			return 0, 0, false
		}
	}
	if raw := r.URL.Query().Get("offset"); raw != "" {
		offset, err = strconv.Atoi(raw)
		if err != nil || offset < 0 || offset > 1000000 {
			return 0, 0, false
		}
	}
	return limit, offset, true
}

func paginated[T any](items []T, total, limit, offset int) map[string]any {
	return map[string]any{"items": items, "total": total, "limit": limit, "offset": offset, "has_more": offset+len(items) < total}
}

func linkError(w http.ResponseWriter, code int, message string) {
	writeJSON(w, code, map[string]string{"error": message})
}

func (h *Handler) linkJob(w http.ResponseWriter, r *http.Request) *models.LinkCheck {
	id := chi.URLParam(r, "id")
	if !validID(id) {
		linkError(w, 400, "Invalid link check ID")
		return nil
	}
	job, err := h.links.GetLinkCheck(r.Context(), id)
	if err != nil {
		log.Printf("Link check read: %v", err)
		linkError(w, 500, "Failed to load link check")
		return nil
	}
	if job == nil {
		linkError(w, 404, "Link check not found")
	}
	return job
}

func (h *Handler) CreateLinkCheck(w http.ResponseWriter, r *http.Request) {
	var req models.CreateLinkCheckRequest
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384))
	d.DisallowUnknownFields()
	if err := d.Decode(&req); err != nil {
		linkError(w, 400, "Invalid request body")
		return
	}
	normalized, err := linkchecker.Normalize(req.URL)
	if err != nil {
		linkError(w, 400, log.Text(err.Error()))
		return
	}
	if req.CheckType == "" {
		req.CheckType = "crawl"
	}
	if req.CheckType != "crawl" && req.CheckType != "single" {
		linkError(w, 400, "check_type must be 'crawl' or 'single'")
		return
	}
	if req.MaxPages == 0 {
		req.MaxPages = linkchecker.DefaultMaxPages
	}
	if req.MaxPages < 1 || req.MaxPages > linkchecker.MaxPages {
		linkError(w, 400, "max_pages must be between 1 and 500")
		return
	}
	if req.CheckType == "single" {
		req.MaxPages = 1
	}
	job, err := h.links.CreateLinkCheck(r.Context(), normalized, req.CheckType, req.MaxPages, nil)
	if err != nil {
		if writeAdmissionBusy(w, err) {
			return
		}
		log.Printf("Create link check: %v", err)
		linkError(w, 500, "Failed to create link check")
		return
	}
	writeJSON(w, 201, models.PublicLinkCheck(*job))
}

func (h *Handler) ListLinkChecks(w http.ResponseWriter, r *http.Request) {
	limit, offset, ok := pagination(r)
	if !ok {
		linkError(w, 400, "limit must be 1–200 and offset must be 0–1000000")
		return
	}
	items, total, err := h.links.ListLinkChecks(r.Context(), limit, offset)
	if err != nil {
		linkError(w, 500, "Failed to list link checks")
		return
	}
	writeJSON(w, 200, paginated(models.PublicLinkChecks(items), total, limit, offset))
}

func (h *Handler) LinkCheckStats(w http.ResponseWriter, r *http.Request) {
	stats, err := h.links.GetLinkCheckStats(r.Context())
	if err != nil {
		linkError(w, 500, "Failed to load link check statistics")
		return
	}
	writeJSON(w, 200, stats)
}

func (h *Handler) GetLinkCheck(w http.ResponseWriter, r *http.Request) {
	if job := h.linkJob(w, r); job != nil {
		writeJSON(w, 200, models.PublicLinkCheck(*job))
	}
}

func (h *Handler) GetScanLinkCheck(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !validID(id) {
		linkError(w, 400, "Invalid scan ID")
		return
	}
	scan, err := h.repo.GetScan(r.Context(), id)
	if err != nil {
		linkError(w, 500, "Failed to load scan")
		return
	}
	if scan == nil {
		linkError(w, 404, "Scan not found")
		return
	}
	job, err := h.links.GetScanLinkCheck(r.Context(), id)
	if err != nil {
		linkError(w, 500, "Failed to load companion link check")
		return
	}
	if job == nil {
		writeJSON(w, 200, nil)
		return
	}
	writeJSON(w, 200, models.PublicLinkCheck(*job))
}

func (h *Handler) LinkResults(w http.ResponseWriter, r *http.Request) {
	job := h.linkJob(w, r)
	if job == nil {
		return
	}
	limit, offset, ok := pagination(r)
	if !ok {
		linkError(w, 400, "limit must be 1–200 and offset must be 0–1000000")
		return
	}
	status := r.URL.Query().Get("status")
	switch status {
	case "", "healthy", "redirected", "broken", "error", "blocked", "unchecked":
	default:
		linkError(w, 400, "Unknown result status")
		return
	}
	items, total, err := h.links.GetLinkResults(r.Context(), job.ID, status, limit, offset)
	if err != nil {
		linkError(w, 500, "Failed to load link results")
		return
	}
	writeJSON(w, 200, paginated(models.PublicLinkResults(items), total, limit, offset))
}

func (h *Handler) LinkSources(w http.ResponseWriter, r *http.Request) {
	job := h.linkJob(w, r)
	if job == nil {
		return
	}
	resultID := chi.URLParam(r, "resultId")
	if !validID(resultID) {
		linkError(w, 400, "Invalid result ID")
		return
	}
	limit, offset, ok := pagination(r)
	if !ok {
		linkError(w, 400, "limit must be 1–200 and offset must be 0–1000000")
		return
	}
	items, total, found, err := h.links.GetLinkSources(r.Context(), job.ID, resultID, limit, offset)
	if err != nil {
		linkError(w, 500, "Failed to load source references")
		return
	}
	if !found {
		linkError(w, 404, "Result not found in this link check")
		return
	}
	writeJSON(w, 200, paginated(models.PublicLinkSources(items), total, limit, offset))
}

func (h *Handler) CancelLinkCheck(w http.ResponseWriter, r *http.Request) {
	job := h.linkJob(w, r)
	if job == nil {
		return
	}
	if job.Status != "queued" && job.Status != "running" {
		linkError(w, 409, "Only queued or running link checks can be cancelled")
		return
	}
	updated, err := h.links.CancelLinkCheck(r.Context(), job.ID)
	if err != nil {
		linkError(w, 500, "Failed to cancel link check")
		return
	}
	if updated == nil {
		linkError(w, 409, "Link check is no longer active")
		return
	}
	if h.linkRunner != nil {
		h.linkRunner.Cancel(job.ID)
	}
	writeJSON(w, 200, models.PublicLinkCheck(*updated))
}

func (h *Handler) RecheckLinks(w http.ResponseWriter, r *http.Request) {
	job := h.linkJob(w, r)
	if job == nil {
		return
	}
	if job.Status == "queued" || job.Status == "running" {
		linkError(w, 409, "Wait for completion or cancel before rechecking")
		return
	}
	if job.CheckType == "scan" && len(job.SeedURLs) == 0 && !repository.IsMCPActionCall(r.Context()) {
		linkError(w, 409, "No scan page inventory was saved; rescan the accessibility scan with link checking enabled")
		return
	}
	created, err := h.links.CreateLinkCheckFrom(r.Context(), job.ID)
	if err != nil {
		if writeAdmissionBusy(w, err) {
			return
		}
		if errors.Is(err, repository.ErrRecheckNotReady) {
			linkError(w, 409, "Wait for completion or cancel before rechecking")
			return
		}
		if errors.Is(err, repository.ErrRecheckEmptyInventory) {
			linkError(w, 409, "No scan page inventory was saved; rescan the accessibility scan with link checking enabled")
			return
		}
		if errors.Is(err, pgx.ErrNoRows) {
			linkError(w, 404, "Link check not found")
			return
		}
		linkError(w, 500, "Failed to create recheck")
		return
	}
	writeJSON(w, 201, models.PublicLinkCheck(*created))
}

func (h *Handler) DeleteLinkCheck(w http.ResponseWriter, r *http.Request) {
	job := h.linkJob(w, r)
	if job == nil {
		return
	}
	// Deleting a companion removes only link evidence. The historical scan
	// selection remains true, so a future rescan can create a fresh companion.
	if job.Status == "queued" || job.Status == "running" {
		linkError(w, 409, "Cancel an active link check before deleting it")
		return
	}
	deleted, err := h.links.DeleteLinkCheck(r.Context(), job.ID)
	if err != nil {
		linkError(w, 500, "Failed to delete link check")
		return
	}
	if !deleted {
		current, err := h.links.GetLinkCheck(r.Context(), job.ID)
		if err != nil {
			linkError(w, 500, "Failed to reload link check")
			return
		}
		if current != nil {
			linkError(w, 409, "Link check became active; cancel before deleting it")
			return
		}
		linkError(w, 404, "Link check not found")
		return
	}
	w.WriteHeader(204)
}

func csvSafe(value string) string {
	trimmed := strings.TrimLeft(value, " \t\r\n")
	if trimmed != "" && strings.ContainsRune("=+-@", rune(trimmed[0])) {
		return "'" + value
	}
	return value
}

const maxLinkCSVBytes int64 = 512 << 20
const linkCSVMaxBytesHeader = "X-Lime-Export-Max-Bytes"

var (
	errLinkCSVTooLarge = errors.New("link CSV exceeds size limit")
	linkCSVPermit      = make(chan struct{}, 1)
)

type cappedLinkCSVWriter struct {
	writer io.Writer
	max    int64
	size   int64
}

func (w *cappedLinkCSVWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.max-w.size {
		return 0, errLinkCSVTooLarge
	}
	n, err := w.writer.Write(p)
	w.size += int64(n)
	return n, err
}

func writeLinkCSVRow(writer *csv.Writer, item models.LinkResult, source models.LinkSource) error {
	item = models.PublicLinkResult(item)
	source = models.PublicLinkSource(source)
	code, final, kind, message := "", "", "", ""
	if item.StatusCode != nil {
		code = strconv.Itoa(*item.StatusCode)
	}
	if item.FinalURL != nil {
		final = *item.FinalURL
	}
	if item.ErrorKind != nil {
		kind = *item.ErrorKind
	}
	if item.Error != nil {
		message = *item.Error
	}
	row := []string{item.TargetURL, item.Status, code, final, strconv.Itoa(item.RedirectCount), item.LinkType,
		strconv.Itoa(item.OccurrenceCount), kind, message, source.PageURL, source.Element, source.Attribute, source.Text}
	for i := range row {
		row[i] = csvSafe(row[i])
	}
	return writer.Write(row)
}

func (h *Handler) ExportLinksCSV(w http.ResponseWriter, r *http.Request) {
	maxBytes := maxLinkCSVBytes
	if values := r.Header.Values(linkCSVMaxBytesHeader); len(values) > 0 {
		if len(values) != 1 {
			linkError(w, http.StatusBadRequest, "Invalid link CSV export limit")
			return
		}
		requested, err := strconv.ParseInt(values[0], 10, 64)
		if err != nil || requested < 1 || requested > maxLinkCSVBytes {
			linkError(w, http.StatusBadRequest, "Invalid link CSV export limit")
			return
		}
		// A caller may only lower the hard cap; ordinary downloads keep 512 MiB.
		maxBytes = requested
	}
	h.exportLinksCSVWithLimit(w, r, maxBytes)
}

// Spooling before headers preserves an all-or-error CSV even if the database,
// formatting, or temporary storage fails partway through an active check.
func (h *Handler) exportLinksCSVWithLimit(w http.ResponseWriter, r *http.Request, maxBytes int64) {
	job := h.linkJob(w, r)
	if job == nil {
		return
	}
	select {
	case linkCSVPermit <- struct{}{}:
		defer func() { <-linkCSVPermit }()
	default:
		w.Header().Set("Retry-After", "30")
		linkError(w, http.StatusServiceUnavailable, "Another link CSV export is in progress; retry later")
		return
	}
	if err := r.Context().Err(); err != nil {
		linkError(w, http.StatusInternalServerError, "Link CSV export was cancelled")
		return
	}
	file, err := os.CreateTemp("", "lime-link-export-*")
	if err != nil {
		linkError(w, http.StatusInternalServerError, "Failed to prepare link CSV export")
		return
	}
	defer func() {
		_ = file.Close()
		_ = os.Remove(file.Name())
	}()
	if err := os.Remove(file.Name()); err != nil {
		linkError(w, http.StatusInternalServerError, "Failed to protect temporary link CSV")
		return
	}
	capped := &cappedLinkCSVWriter{writer: file, max: maxBytes}
	writer := csv.NewWriter(capped)
	if err := writer.Write([]string{"target_url", "status", "status_code", "final_url", "redirect_count", "link_type", "occurrence_count", "error_kind", "error", "source_page", "element", "attribute", "text"}); err != nil {
		linkError(w, http.StatusInternalServerError, "Failed to format link CSV")
		return
	}
	err = h.links.StreamLinkExportRows(r.Context(), job.ID, func(item models.LinkResult, source models.LinkSource) error {
		if err := r.Context().Err(); err != nil {
			return err
		}
		return writeLinkCSVRow(writer, item, source)
	})
	if err == nil {
		writer.Flush()
		err = writer.Error()
	}
	if err == nil {
		err = r.Context().Err()
	}
	if errors.Is(err, errLinkCSVTooLarge) {
		message := "Link CSV exceeds the 512 MiB export limit"
		if maxBytes < maxLinkCSVBytes {
			message = "Link CSV exceeds the requested export limit"
		}
		linkError(w, http.StatusRequestEntityTooLarge, message)
		return
	}
	if err != nil {
		linkError(w, http.StatusInternalServerError, "Failed to export link CSV")
		return
	}
	if err := file.Sync(); err != nil {
		linkError(w, http.StatusInternalServerError, "Failed to finish link CSV export")
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		linkError(w, http.StatusInternalServerError, "Failed to prepare link CSV download")
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="lime-links-`+job.ID+`.csv"`)
	w.Header().Set("Content-Length", strconv.FormatInt(capped.size, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, file)
}

func (h *Handler) createScan(ctx context.Context, target, kind string, tag *string, v viewport.Settings, include bool) (*models.Scan, error) {
	if include {
		if repo, ok := h.repo.(interface {
			CreateScanWithLinkCheck(context.Context, string, string, *string, viewport.Settings) (*models.Scan, error)
		}); ok {
			return repo.CreateScanWithLinkCheck(ctx, target, kind, tag, v)
		}
		return nil, errors.New("companion link checker repository is unavailable")
	}
	return h.repo.CreateScan(ctx, target, kind, tag, v)
}
