package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

type capacityScanRepo struct{ stubRepo }

func (capacityScanRepo) CreateScan(context.Context, string, string, *string, viewport.Settings) (*models.Scan, error) {
	return nil, fmt.Errorf("admission: %w", &repository.AdmissionCapacityError{Kind: "scan", Limit: 128})
}

func (capacityScanRepo) CreateScanWithLinkCheck(context.Context, string, string, *string, viewport.Settings) (*models.Scan, error) {
	return nil, &repository.AdmissionCapacityError{Kind: "link check", Limit: 128}
}

func (capacityScanRepo) CreateRescanFrom(context.Context, string) (*models.Scan, error) {
	return nil, &repository.AdmissionCapacityError{Kind: "scan", Limit: 128}
}

func (capacityScanRepo) ResumeScan(context.Context, string) (*models.Scan, error) {
	return nil, &repository.AdmissionCapacityError{Kind: "scan", Limit: 128}
}

func (capacityScanRepo) RetryFailedURLs(context.Context, string) (*models.Scan, int, error) {
	return nil, 0, &repository.AdmissionCapacityError{Kind: "link check", Limit: 128}
}

type capacityLinkRepo struct{ LinkRepository }

func (capacityLinkRepo) CreateLinkCheck(context.Context, string, string, int, []string) (*models.LinkCheck, error) {
	return nil, &repository.AdmissionCapacityError{Kind: "link check", Limit: 128}
}

func (capacityLinkRepo) CreateLinkCheckFrom(context.Context, string) (*models.LinkCheck, error) {
	return nil, &repository.AdmissionCapacityError{Kind: "link check", Limit: 128}
}

func (capacityLinkRepo) GetLinkCheck(_ context.Context, id string) (*models.LinkCheck, error) {
	return &models.LinkCheck{ID: id, CheckType: "crawl", Status: "completed"}, nil
}

func withAdmissionID(req *http.Request, id string) *http.Request {
	route := chi.NewRouteContext()
	route.URLParams.Add("id", id)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, route))
}

func TestAdmissionCapacityReturnsRetryable503FromEveryHTTPEntryPoint(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	for _, tc := range []struct {
		name   string
		status string
		invoke func(*Handler, *httptest.ResponseRecorder)
	}{
		{"create scan", "", func(h *Handler, w *httptest.ResponseRecorder) {
			h.CreateScan(w, httptest.NewRequest(http.MethodPost, "/api/scans", strings.NewReader(`{"sitemap_url":"https://fixture.test/","scan_type":"single"}`)))
		}},
		{"create scan with links", "", func(h *Handler, w *httptest.ResponseRecorder) {
			h.CreateScan(w, httptest.NewRequest(http.MethodPost, "/api/scans", strings.NewReader(`{"sitemap_url":"https://fixture.test/","scan_type":"single","include_link_check":true}`)))
		}},
		{"rescan", "completed", func(h *Handler, w *httptest.ResponseRecorder) {
			h.RescanScan(w, withAdmissionID(httptest.NewRequest(http.MethodPost, "/api/scans/"+id+"/rescan", nil), id))
		}},
		{"resume", "paused", func(h *Handler, w *httptest.ResponseRecorder) {
			h.ResumeScan(w, withAdmissionID(httptest.NewRequest(http.MethodPost, "/api/scans/"+id+"/resume", nil), id))
		}},
		{"retry failed pages", "completed", func(h *Handler, w *httptest.ResponseRecorder) {
			h.RetryFailedPages(w, withAdmissionID(httptest.NewRequest(http.MethodPost, "/api/scans/"+id+"/retry-failed", nil), id))
		}},
		{"create link check", "", func(h *Handler, w *httptest.ResponseRecorder) {
			h.CreateLinkCheck(w, httptest.NewRequest(http.MethodPost, "/api/link-checks", strings.NewReader(`{"url":"https://fixture.test/","check_type":"single"}`)))
		}},
		{"recheck links", "", func(h *Handler, w *httptest.ResponseRecorder) {
			h.RecheckLinks(w, withAdmissionID(httptest.NewRequest(http.MethodPost, "/api/link-checks/"+id+"/recheck", nil), id))
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := capacityScanRepo{stubRepo{getScan: func(context.Context, string) (*models.Scan, error) {
				return &models.Scan{ID: id, Status: tc.status}, nil
			}}}
			scanner := &stubScanner{scanStarted: make(chan models.Scan, 1)}
			h := New(repo, scanner, nil).WithLinkChecker(capacityLinkRepo{}, nil)
			w := httptest.NewRecorder()
			tc.invoke(h, w)
			if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") != "30" {
				t.Fatalf("admission response = %d retry=%q body=%s", w.Code, w.Header().Get("Retry-After"), w.Body.String())
			}
			var body map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body["error"] == "" {
				t.Fatalf("admission JSON = %v, %v", body, err)
			}
			select {
			case scan := <-scanner.scanStarted:
				t.Fatalf("rejected admission started scan %+v", scan)
			default:
			}
		})
	}
}
