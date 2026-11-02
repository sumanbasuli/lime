package handler

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

const csvFixtureJobID = "11111111-1111-4111-8111-111111111111"

type csvExportRow struct {
	result models.LinkResult
	source models.LinkSource
}

type csvExportRepo struct {
	LinkRepository
	rows       []csvExportRow
	called     int
	failAfter  int
	afterFirst func()
}

func (r *csvExportRepo) GetLinkCheck(_ context.Context, id string) (*models.LinkCheck, error) {
	if id != csvFixtureJobID {
		return nil, nil
	}
	return &models.LinkCheck{ID: id, Status: "completed"}, nil
}

func (r *csvExportRepo) StreamLinkExportRows(ctx context.Context, id string, emit func(models.LinkResult, models.LinkSource) error) error {
	r.called++
	if id != csvFixtureJobID {
		return errors.New("wrong job")
	}
	for i, row := range r.rows {
		if r.failAfter > 0 && i == r.failAfter {
			return errors.New("injected query failure")
		}
		if err := emit(row.result, row.source); err != nil {
			return err
		}
		if i == 0 && r.afterFirst != nil {
			r.afterFirst()
		}
	}
	return ctx.Err()
}

func csvExportRequest(ctx context.Context) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/link-checks/"+csvFixtureJobID+"/export.csv", nil).WithContext(ctx)
	route := chi.NewRouteContext()
	route.URLParams.Add("id", csvFixtureJobID)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, route))
}

func csvFixtureRows() []csvExportRow {
	code := 404
	final := "https://example.test/final"
	kind := "http_status"
	message := "Not found, on page"
	first := models.LinkResult{TargetURL: "https://example.test/a?x=1,2", Status: "broken", StatusCode: &code,
		FinalURL: &final, RedirectCount: 1, LinkType: "external", OccurrenceCount: 2, ErrorKind: &kind, Error: &message}
	second := models.LinkResult{TargetURL: "https://example.test/z", Status: "unchecked", LinkType: "internal"}
	return []csvExportRow{
		{first, models.LinkSource{PageURL: "https://example.test/p1", Element: "a", Attribute: "href", Text: "=SUM(1)"}},
		{first, models.LinkSource{PageURL: "https://example.test/p2", Element: "a", Attribute: "href", Text: "quoted \"link\""}},
		{second, models.LinkSource{}},
	}
}

// This independent expectation mirrors the old whole-result formatter, not
// the new row writer. It protects the exported column order and CSV escaping.
func legacyLinkCSVBytes(rows []csvExportRow) []byte {
	var out bytes.Buffer
	writer := csv.NewWriter(&out)
	_ = writer.Write([]string{"target_url", "status", "status_code", "final_url", "redirect_count", "link_type", "occurrence_count", "error_kind", "error", "source_page", "element", "attribute", "text"})
	for _, row := range rows {
		item, source := row.result, row.source
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
		// Public CSV preserves the destination path but never its saved query.
		target := strings.SplitN(item.TargetURL, "?", 2)[0]
		cells := []string{target, item.Status, code, final, strconv.Itoa(item.RedirectCount), item.LinkType, strconv.Itoa(item.OccurrenceCount),
			kind, message, source.PageURL, source.Element, source.Attribute, source.Text}
		for i, cell := range cells {
			cells[i] = csvSafe(cell)
		}
		_ = writer.Write(cells)
	}
	writer.Flush()
	return out.Bytes()
}

func TestExportLinksCSVParityAndTempCleanup(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	repo := &csvExportRepo{rows: csvFixtureRows()}
	h := &Handler{links: repo}
	w := httptest.NewRecorder()
	h.ExportLinksCSV(w, csvExportRequest(context.Background()))
	if w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), legacyLinkCSVBytes(repo.rows)) {
		t.Fatalf("CSV changed: status=%d body=%q", w.Code, w.Body.String())
	}
	if got, want := w.Header().Get("Content-Length"), strconv.Itoa(len(w.Body.Bytes())); got != want {
		t.Fatalf("content length=%q, want %q", got, want)
	}
	entries, err := os.ReadDir(os.TempDir())
	if err != nil || len(entries) != 0 {
		t.Fatalf("temporary export left files: entries=%v err=%v", entries, err)
	}
	if repo.called != 1 {
		t.Fatalf("stream called %d times", repo.called)
	}
}

func TestExportLinksCSVRequestByteCap(t *testing.T) {
	rows := csvFixtureRows()
	expected := legacyLinkCSVBytes(rows)
	for _, tc := range []struct {
		name     string
		maxBytes int
		wantCode int
	}{
		{"exact size", len(expected), http.StatusOK},
		{"one byte short", len(expected) - 1, http.StatusRequestEntityTooLarge},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("TMPDIR", t.TempDir())
			repo := &csvExportRepo{rows: rows}
			h := &Handler{links: repo}
			req := csvExportRequest(context.Background())
			req.Header.Set("X-Lime-Export-Max-Bytes", strconv.Itoa(tc.maxBytes))
			w := httptest.NewRecorder()
			h.ExportLinksCSV(w, req)
			if w.Code != tc.wantCode {
				t.Fatalf("status=%d, want %d", w.Code, tc.wantCode)
			}
			if tc.wantCode == http.StatusOK && !bytes.Equal(w.Body.Bytes(), expected) {
				t.Fatalf("CSV changed under exact requested cap: %q", w.Body.String())
			}
			if tc.wantCode != http.StatusOK && (strings.Contains(w.Body.String(), "target_url,status") || w.Header().Get("Content-Disposition") != "") {
				t.Fatalf("cap failure leaked partial CSV: body=%q headers=%v", w.Body.String(), w.Header())
			}
			entries, err := os.ReadDir(os.TempDir())
			if err != nil || len(entries) != 0 {
				t.Fatalf("export left temporary files: entries=%v err=%v", entries, err)
			}
		})
	}
}

func TestExportLinksCSVRejectsInvalidRequestByteCapBeforeWork(t *testing.T) {
	for _, raw := range []string{"", "0", "-1", "abc", "536870913"} {
		t.Run("cap="+raw, func(t *testing.T) {
			repo := &csvExportRepo{rows: csvFixtureRows()}
			h := &Handler{links: repo}
			req := csvExportRequest(context.Background())
			req.Header.Set("X-Lime-Export-Max-Bytes", raw)
			w := httptest.NewRecorder()
			h.ExportLinksCSV(w, req)
			if w.Code != http.StatusBadRequest || repo.called != 0 {
				t.Fatalf("invalid cap status=%d stream calls=%d", w.Code, repo.called)
			}
		})
	}
	t.Run("duplicate cap", func(t *testing.T) {
		repo := &csvExportRepo{rows: csvFixtureRows()}
		h := &Handler{links: repo}
		req := csvExportRequest(context.Background())
		req.Header.Add("X-Lime-Export-Max-Bytes", "100")
		req.Header.Add("X-Lime-Export-Max-Bytes", "200")
		w := httptest.NewRecorder()
		h.ExportLinksCSV(w, req)
		if w.Code != http.StatusBadRequest || repo.called != 0 {
			t.Fatalf("duplicate cap status=%d stream calls=%d", w.Code, repo.called)
		}
	})
}

func TestExportLinksCSVFailuresBeforeHeaders(t *testing.T) {
	for _, tc := range []struct {
		name      string
		maxBytes  int64
		failAfter int
		cancel    bool
		wantCode  int
	}{
		{"query failure", maxLinkCSVBytes, 1, false, http.StatusInternalServerError},
		{"size cap", 100, 0, false, http.StatusRequestEntityTooLarge},
		{"cancellation", maxLinkCSVBytes, 0, true, http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("TMPDIR", t.TempDir())
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			repo := &csvExportRepo{rows: csvFixtureRows(), failAfter: tc.failAfter}
			if tc.cancel {
				repo.afterFirst = cancel
			}
			h := &Handler{links: repo}
			w := httptest.NewRecorder()
			h.exportLinksCSVWithLimit(w, csvExportRequest(ctx), tc.maxBytes)
			if w.Code != tc.wantCode || strings.Contains(w.Body.String(), "target_url,status") || w.Header().Get("Content-Disposition") != "" {
				t.Fatalf("failure leaked partial CSV: status=%d body=%q headers=%v", w.Code, w.Body.String(), w.Header())
			}
			entries, err := os.ReadDir(os.TempDir())
			if err != nil || len(entries) != 0 {
				t.Fatalf("failed export left files: entries=%v err=%v", entries, err)
			}
		})
	}
}

func TestExportLinksCSVPermitIsNonblocking(t *testing.T) {
	linkCSVPermit <- struct{}{}
	defer func() { <-linkCSVPermit }()
	repo := &csvExportRepo{rows: csvFixtureRows()}
	h := &Handler{links: repo}
	w := httptest.NewRecorder()
	h.ExportLinksCSV(w, csvExportRequest(context.Background()))
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") != "30" || repo.called != 0 {
		t.Fatalf("occupied export status=%d retry=%q calls=%d", w.Code, w.Header().Get("Retry-After"), repo.called)
	}
}

func TestExportLinksCSVTempCreationFailureBeforeHeaders(t *testing.T) {
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "missing"))
	repo := &csvExportRepo{rows: csvFixtureRows()}
	h := &Handler{links: repo}
	w := httptest.NewRecorder()
	h.ExportLinksCSV(w, csvExportRequest(context.Background()))
	if w.Code != http.StatusInternalServerError || w.Header().Get("Content-Disposition") != "" || repo.called != 0 {
		t.Fatalf("temp error status=%d headers=%v calls=%d body=%q", w.Code, w.Header(), repo.called, w.Body.String())
	}
}

type failingCSVWriter struct{ err error }

func (w failingCSVWriter) Write([]byte) (int, error) { return 0, w.err }

func TestCappedLinkCSVWriterPropagatesDiskFailure(t *testing.T) {
	diskErr := errors.New("disk write failed")
	w := &cappedLinkCSVWriter{writer: failingCSVWriter{diskErr}, max: maxLinkCSVBytes}
	if n, err := io.WriteString(w, "CSV data"); n != 0 || !errors.Is(err, diskErr) || w.size != 0 {
		t.Fatalf("disk failure n=%d err=%v size=%d", n, err, w.size)
	}
}

func TestCappedLinkCSVWriterFourMiBBoundary(t *testing.T) {
	const mcpLimit = 4 << 20
	w := &cappedLinkCSVWriter{writer: io.Discard, max: mcpLimit}
	if n, err := w.Write(bytes.Repeat([]byte{'x'}, mcpLimit)); n != mcpLimit || err != nil || w.size != mcpLimit {
		t.Fatalf("exact bound n=%d err=%v size=%d", n, err, w.size)
	}
	if n, err := w.Write([]byte{'y'}); n != 0 || !errors.Is(err, errLinkCSVTooLarge) || w.size != mcpLimit {
		t.Fatalf("over bound n=%d err=%v size=%d", n, err, w.size)
	}
}
