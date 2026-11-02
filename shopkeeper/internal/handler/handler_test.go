package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/screenshots"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

func TestServePrivateScreenshot(t *testing.T) {
	t.Setenv("SHOPKEEPER_SCREENSHOT_DIR", filepath.Join(t.TempDir(), "screenshots"))
	const scanID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const filename = "page.png"
	const image = "screenshot image bytes"
	if err := screenshots.EnsureScanDir(scanID); err != nil {
		t.Fatal(err)
	}
	if err := screenshots.WriteFile(screenshots.FilePath(scanID, filename), []byte(image)); err != nil {
		t.Fatal(err)
	}

	scanExists := true
	h := New(stubRepo{getScan: func(context.Context, string) (*models.Scan, error) {
		if scanExists {
			return &models.Scan{ID: scanID}, nil
		}
		return nil, nil
	}, screenshotVisible: func(context.Context, string, string) (bool, error) { return true, nil }}, nil, nil)
	router := chi.NewRouter()
	router.Get("/api/screenshots/{scanId}/{filename}", h.ServeScreenshot)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/screenshots/"+scanID+"/"+filename, nil))
	if response.Code != http.StatusOK || response.Body.String() != image {
		t.Fatalf("private screenshot response = %d %q", response.Code, response.Body.String())
	}
	if cacheControl := response.Header().Get("Cache-Control"); cacheControl != "private, no-store" {
		t.Fatalf("private screenshot cache policy = %q", cacheControl)
	}
	uppercase := httptest.NewRecorder()
	router.ServeHTTP(uppercase, httptest.NewRequest(http.MethodGet, "/api/screenshots/"+strings.ToUpper(scanID)+"/"+filename, nil))
	if uppercase.Code != http.StatusOK || uppercase.Body.String() != image {
		t.Fatalf("uppercase scan ID screenshot response = %d %q", uppercase.Code, uppercase.Body.String())
	}

	// A failed filesystem cleanup cannot leave orphaned evidence available over HTTP.
	scanExists = false
	orphan := httptest.NewRecorder()
	router.ServeHTTP(orphan, httptest.NewRequest(http.MethodGet, "/api/screenshots/"+scanID+"/"+filename, nil))
	if orphan.Code != http.StatusNotFound {
		t.Fatalf("orphaned screenshot response = %d", orphan.Code)
	}
	invalid := httptest.NewRecorder()
	router.ServeHTTP(invalid, httptest.NewRequest(http.MethodGet, "/api/screenshots/not-a-uuid/"+filename, nil))
	if invalid.Code != http.StatusNotFound {
		t.Fatalf("malformed screenshot scan ID response = %d", invalid.Code)
	}
}

type stubRepo struct {
	retryFailedURLs   func(ctx context.Context, id string) (*models.Scan, int, error)
	getScan           func(ctx context.Context, id string) (*models.Scan, error)
	screenshotVisible func(ctx context.Context, scanID, filename string) (bool, error)
	deleteScan        func(ctx context.Context, id string) (bool, error)
	resumeScan        func(ctx context.Context, id string) (*models.Scan, error)
	pdfPolicy         func(ctx context.Context) (*models.PDFReportPolicy, error)
	listScansPage     func(ctx context.Context, tag string, limit, offset int) ([]models.Scan, error)
}

func (s stubRepo) CreateScan(context.Context, string, string, *string, viewport.Settings) (*models.Scan, error) {
	panic("unexpected CreateScan call")
}

func (s stubRepo) CreateRescanFrom(context.Context, string) (*models.Scan, error) {
	panic("unexpected CreateRescanFrom call")
}

func (s stubRepo) ListScans(context.Context) ([]models.Scan, error) {
	panic("unexpected ListScans call")
}

func (s stubRepo) ListScansByTag(context.Context, string) ([]models.Scan, error) {
	panic("unexpected ListScansByTag call")
}

func (s stubRepo) ListScansPage(ctx context.Context, tag string, limit, offset int) ([]models.Scan, error) {
	if s.listScansPage == nil {
		panic("unexpected ListScansPage call")
	}
	return s.listScansPage(ctx, tag, limit, offset)
}

func (s stubRepo) GetScan(ctx context.Context, id string) (*models.Scan, error) {
	if s.getScan == nil {
		panic("unexpected GetScan call")
	}
	return s.getScan(ctx, id)
}

func (s stubRepo) ScreenshotVisible(ctx context.Context, scanID, filename string) (bool, error) {
	if s.screenshotVisible == nil {
		panic("unexpected ScreenshotVisible call")
	}
	return s.screenshotVisible(ctx, scanID, filename)
}

func (s stubRepo) GetPDFReportPolicy(ctx context.Context) (*models.PDFReportPolicy, error) {
	if s.pdfPolicy == nil {
		panic("unexpected GetPDFReportPolicy call")
	}
	return s.pdfPolicy(ctx)
}

func (s stubRepo) GetScanIssues(context.Context, string) ([]models.IssueWithOccurrences, error) {
	panic("unexpected GetScanIssues call")
}

func (s stubRepo) RetryFailedURLs(ctx context.Context, id string) (*models.Scan, int, error) {
	if s.retryFailedURLs == nil {
		panic("unexpected RetryFailedURLs call")
	}

	return s.retryFailedURLs(ctx, id)
}

func (s stubRepo) DeleteScan(ctx context.Context, id string) (bool, error) {
	if s.deleteScan == nil {
		panic("unexpected DeleteScan call")
	}
	return s.deleteScan(ctx, id)
}

func (s stubRepo) RequestPause(context.Context, string) (*models.Scan, error) {
	panic("unexpected RequestPause call")
}

func (s stubRepo) ResumeScan(ctx context.Context, id string) (*models.Scan, error) {
	if s.resumeScan == nil {
		panic("unexpected ResumeScan call")
	}
	return s.resumeScan(ctx, id)
}

func (s stubRepo) SetIssueFalsePositive(context.Context, string, string, bool) (*models.Issue, error) {
	panic("unexpected SetIssueFalsePositive call")
}

func (s stubRepo) GetStats(context.Context) (*models.Stats, error) {
	panic("unexpected GetStats call")
}

type stubScanner struct {
	scanStarted chan models.Scan
}

func (s *stubScanner) RunScan(scan models.Scan) {
	if s.scanStarted != nil {
		s.scanStarted <- scan
	}
}

func (s *stubScanner) RequestPause(string) {}

func TestRetryFailedPagesRequeuesCompletedPartialScan(t *testing.T) {
	scanner := &stubScanner{scanStarted: make(chan models.Scan, 1)}
	reopenedScan := &models.Scan{
		ID:          "scan-123",
		Status:      "pending",
		TotalURLs:   2167,
		ScannedURLs: 1554,
	}
	handler := New(stubRepo{
		retryFailedURLs: func(ctx context.Context, id string) (*models.Scan, int, error) {
			if id != "scan-123" {
				t.Fatalf("expected scan id scan-123, got %s", id)
			}
			return reopenedScan, 613, nil
		},
	}, scanner, nil)

	req := httptest.NewRequest(http.MethodPost, "/api/scans/scan-123/retry-failed", nil)
	req = withScanID(req, "scan-123")
	recorder := httptest.NewRecorder()

	handler.RetryFailedPages(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", recorder.Code)
	}

	select {
	case started := <-scanner.scanStarted:
		if started.ID != "scan-123" {
			t.Fatalf("expected scanner to receive scan-123, got %s", started.ID)
		}
	case <-time.After(time.Second):
		t.Fatal("scanner was not launched")
	}

	var response models.RetryFailedPagesResponse
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("expected valid JSON response: %v", err)
	}
	if response.Scan.ID != "scan-123" {
		t.Fatalf("expected response scan-123, got %s", response.Scan.ID)
	}
	if response.RetriedURLCount != 613 {
		t.Fatalf("expected retried count 613, got %d", response.RetriedURLCount)
	}
}

func TestRetryFailedPagesRejectsIneligibleScans(t *testing.T) {
	testCases := []struct {
		name       string
		scan       *models.Scan
		retryCount int
	}{
		{
			name:       "completed scan without failed pages",
			scan:       &models.Scan{ID: "scan-1", Status: "completed"},
			retryCount: 0,
		},
		{
			name:       "active scan",
			scan:       &models.Scan{ID: "scan-2", Status: "scanning"},
			retryCount: 0,
		},
		{
			name:       "paused scan",
			scan:       &models.Scan{ID: "scan-3", Status: "paused"},
			retryCount: 0,
		},
		{
			name:       "fully failed scan",
			scan:       &models.Scan{ID: "scan-4", Status: "failed"},
			retryCount: 0,
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			handler := New(stubRepo{
				retryFailedURLs: func(context.Context, string) (*models.Scan, int, error) {
					return testCase.scan, testCase.retryCount, nil
				},
			}, &stubScanner{}, nil)

			req := httptest.NewRequest(http.MethodPost, "/api/scans/"+testCase.scan.ID+"/retry-failed", nil)
			req = withScanID(req, testCase.scan.ID)
			recorder := httptest.NewRecorder()

			handler.RetryFailedPages(recorder, req)

			if recorder.Code != http.StatusConflict {
				t.Fatalf("expected status 409, got %d", recorder.Code)
			}
		})
	}
}

func TestRetryFailedPagesReturnsNotFoundWhenScanMissing(t *testing.T) {
	handler := New(stubRepo{
		retryFailedURLs: func(context.Context, string) (*models.Scan, int, error) {
			return nil, 0, nil
		},
	}, &stubScanner{}, nil)

	req := httptest.NewRequest(http.MethodPost, "/api/scans/missing/retry-failed", nil)
	req = withScanID(req, "missing")
	recorder := httptest.NewRecorder()

	handler.RetryFailedPages(recorder, req)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected status 404, got %d", recorder.Code)
	}
}

func TestDeleteScanRechecksStateBeforeRemovingScreenshots(t *testing.T) {
	t.Setenv("SHOPKEEPER_SCREENSHOT_DIR", filepath.Join(t.TempDir(), "screenshots"))
	const scanID = "11111111-1111-4111-8111-111111111111"
	const filename = "page.png"
	if err := screenshots.EnsureScanDir(scanID); err != nil {
		t.Fatal(err)
	}
	file := screenshots.FilePath(scanID, filename)
	if err := screenshots.WriteFile(file, []byte("retained evidence")); err != nil {
		t.Fatal(err)
	}

	for _, testCase := range []struct {
		name       string
		secondScan *models.Scan
		wantStatus int
		fileKept   bool
	}{
		{name: "reactivated", secondScan: &models.Scan{ID: scanID, Status: "pending"}, wantStatus: http.StatusConflict, fileKept: true},
		{name: "removed elsewhere", wantStatus: http.StatusNoContent},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			reads := 0
			h := New(stubRepo{
				getScan: func(context.Context, string) (*models.Scan, error) {
					reads++
					if reads == 1 {
						return &models.Scan{ID: scanID, Status: "completed"}, nil
					}
					return testCase.secondScan, nil
				},
				deleteScan: func(context.Context, string) (bool, error) { return false, nil },
			}, nil, nil)
			recorder := httptest.NewRecorder()
			h.DeleteScan(recorder, withScanID(httptest.NewRequest(http.MethodDelete, "/api/scans/"+scanID, nil), scanID))
			if recorder.Code != testCase.wantStatus || reads != 2 {
				t.Fatalf("delete response = %d after %d reads", recorder.Code, reads)
			}
			_, err := os.Stat(file)
			if testCase.fileKept && err != nil {
				t.Fatalf("active scan must retain screenshot: %v", err)
			}
			if !testCase.fileKept && !os.IsNotExist(err) {
				t.Fatalf("orphaned screenshot was not cleaned up: %v", err)
			}
		})
	}
}

func TestDeleteScanRetriesOrphanedScreenshotCleanup(t *testing.T) {
	t.Setenv("SHOPKEEPER_SCREENSHOT_DIR", filepath.Join(t.TempDir(), "screenshots"))
	const scanID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	if err := screenshots.EnsureScanDir(scanID); err != nil {
		t.Fatal(err)
	}
	file := screenshots.FilePath(scanID, "page.png")
	if err := screenshots.WriteFile(file, []byte("orphan")); err != nil {
		t.Fatal(err)
	}
	h := New(stubRepo{getScan: func(context.Context, string) (*models.Scan, error) { return nil, nil }}, nil, nil)
	response := httptest.NewRecorder()
	uppercaseID := strings.ToUpper(scanID)
	h.DeleteScan(response, withScanID(httptest.NewRequest(http.MethodDelete, "/api/scans/"+uppercaseID, nil), uppercaseID))
	if response.Code != http.StatusNoContent {
		t.Fatalf("orphan cleanup response = %d", response.Code)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("orphaned screenshot was not removed: %v", err)
	}
	response = httptest.NewRecorder()
	h.DeleteScan(response, withScanID(httptest.NewRequest(http.MethodDelete, "/api/scans/"+uppercaseID, nil), uppercaseID))
	if response.Code != http.StatusNotFound {
		t.Fatalf("second orphan cleanup response = %d", response.Code)
	}
}

func TestDeleteScanUppercaseIDRemovesCanonicalScreenshots(t *testing.T) {
	t.Setenv("SHOPKEEPER_SCREENSHOT_DIR", filepath.Join(t.TempDir(), "screenshots"))
	const scanID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	if err := screenshots.EnsureScanDir(scanID); err != nil {
		t.Fatal(err)
	}
	file := screenshots.FilePath(scanID, "page.png")
	if err := screenshots.WriteFile(file, []byte("evidence")); err != nil {
		t.Fatal(err)
	}
	h := New(stubRepo{
		getScan: func(context.Context, string) (*models.Scan, error) {
			return &models.Scan{ID: scanID, Status: "completed"}, nil
		},
		deleteScan: func(context.Context, string) (bool, error) { return true, nil },
	}, nil, nil)
	uppercaseID := strings.ToUpper(scanID)
	response := httptest.NewRecorder()
	h.DeleteScan(response, withScanID(httptest.NewRequest(http.MethodDelete, "/api/scans/"+uppercaseID, nil), uppercaseID))
	if response.Code != http.StatusNoContent {
		t.Fatalf("uppercase deletion response = %d", response.Code)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("canonical screenshot was not removed: %v", err)
	}
}

func TestResumeScanReportsNotFoundWhenDeleteWins(t *testing.T) {
	const scanID = "scan-123"
	reads := 0
	h := New(stubRepo{
		getScan: func(context.Context, string) (*models.Scan, error) {
			reads++
			if reads == 1 {
				return &models.Scan{ID: scanID, Status: "paused"}, nil
			}
			return nil, nil
		},
		resumeScan: func(context.Context, string) (*models.Scan, error) { return nil, nil },
	}, nil, nil)
	recorder := httptest.NewRecorder()
	h.ResumeScan(recorder, withScanID(httptest.NewRequest(http.MethodPost, "/api/scans/"+scanID+"/resume", nil), scanID))
	if recorder.Code != http.StatusNotFound || reads != 2 {
		t.Fatalf("resume after delete = %d after %d reads", recorder.Code, reads)
	}
}

func withScanID(req *http.Request, scanID string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("id", scanID)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeContext))
}
