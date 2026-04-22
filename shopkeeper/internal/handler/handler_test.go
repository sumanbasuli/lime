package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

type stubRepo struct {
	retryFailedURLs func(ctx context.Context, id string) (*models.Scan, int, error)
}

func (s stubRepo) CreateScan(context.Context, string, string, *string, viewport.Settings) (*models.Scan, error) {
	panic("unexpected CreateScan call")
}

func (s stubRepo) ListScans(context.Context) ([]models.Scan, error) {
	panic("unexpected ListScans call")
}

func (s stubRepo) ListScansByTag(context.Context, string) ([]models.Scan, error) {
	panic("unexpected ListScansByTag call")
}

func (s stubRepo) GetScan(context.Context, string) (*models.Scan, error) {
	panic("unexpected GetScan call")
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

func (s stubRepo) DeleteScan(context.Context, string) (bool, error) {
	panic("unexpected DeleteScan call")
}

func (s stubRepo) RequestPause(context.Context, string) (*models.Scan, error) {
	panic("unexpected RequestPause call")
}

func (s stubRepo) ResumeScan(context.Context, string) (*models.Scan, error) {
	panic("unexpected ResumeScan call")
}

func (s stubRepo) SetIssueFalsePositive(context.Context, string, string, bool) (*models.Issue, error) {
	panic("unexpected SetIssueFalsePositive call")
}

func (s stubRepo) GetStats(context.Context) (*models.Stats, error) {
	panic("unexpected GetStats call")
}

type stubScanner struct {
	runScanCalls []models.Scan
}

func (s *stubScanner) RunScan(scan models.Scan) {
	s.runScanCalls = append(s.runScanCalls, scan)
}

func (s *stubScanner) RequestPause(string) {}

func TestRetryFailedPagesRequeuesCompletedPartialScan(t *testing.T) {
	scanner := &stubScanner{}
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

	if len(scanner.runScanCalls) != 1 {
		t.Fatalf("expected scanner to be launched once, got %d calls", len(scanner.runScanCalls))
	}
	if scanner.runScanCalls[0].ID != "scan-123" {
		t.Fatalf("expected scanner to receive scan-123, got %s", scanner.runScanCalls[0].ID)
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

func withScanID(req *http.Request, scanID string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add("id", scanID)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeContext))
}
