package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/repository"
)

const testIssueScanID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const testIssueID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

type issuePageFixtureRepo struct {
	stubRepo
	legacy func(context.Context, string) ([]models.IssueWithOccurrences, error)
	groups func(context.Context, string, int, int) ([]models.Issue, int64, error)
	detail func(context.Context, string, string, int, int) (*models.Issue, []models.IssueOccurrence, int64, error)
}

func (r *issuePageFixtureRepo) GetScanIssues(ctx context.Context, id string) ([]models.IssueWithOccurrences, error) {
	return r.legacy(ctx, id)
}
func (r *issuePageFixtureRepo) ListScanIssuesPage(ctx context.Context, id string, limit, offset int) ([]models.Issue, int64, error) {
	return r.groups(ctx, id, limit, offset)
}
func (r *issuePageFixtureRepo) GetScanIssueOccurrencePage(ctx context.Context, id, issueID string, limit, offset int) (*models.Issue, []models.IssueOccurrence, int64, error) {
	return r.detail(ctx, id, issueID, limit, offset)
}

func issueFixtureRouter(h *Handler) http.Handler {
	r := chi.NewRouter()
	r.Get("/api/scans/{id}/issues", h.GetScanIssues)
	r.Get("/api/scans/{id}/issues/page", h.GetScanIssuesPage)
	r.Get("/api/scans/{id}/issues/{issueId}/occurrences", h.GetScanIssueOccurrences)
	return r
}

func TestLegacyIssueTooLargeIs413BeforeEncoding(t *testing.T) {
	repo := &issuePageFixtureRepo{
		stubRepo: stubRepo{getScan: func(context.Context, string) (*models.Scan, error) {
			return &models.Scan{ID: testIssueScanID}, nil
		}},
		legacy: func(context.Context, string) ([]models.IssueWithOccurrences, error) {
			return nil, repository.ErrScanIssuesTooLarge
		},
	}
	response := httptest.NewRecorder()
	issueFixtureRouter(New(repo, nil, nil)).ServeHTTP(response,
		httptest.NewRequest(http.MethodGet, "/api/scans/"+testIssueScanID+"/issues", nil))
	if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), "/issues/page") ||
		!strings.Contains(response.Body.String(), "/occurrences") {
		t.Fatalf("legacy large response = %d %q", response.Code, response.Body.String())
	}
}

func TestDirectIssuePagesReportOversizedSelection(t *testing.T) {
	repo := &issuePageFixtureRepo{
		stubRepo: stubRepo{getScan: func(context.Context, string) (*models.Scan, error) {
			return &models.Scan{ID: testIssueScanID}, nil
		}},
		groups: func(context.Context, string, int, int) ([]models.Issue, int64, error) {
			return nil, 0, repository.ErrScanIssuesTooLarge
		},
		detail: func(context.Context, string, string, int, int) (*models.Issue, []models.IssueOccurrence, int64, error) {
			return nil, nil, 0, repository.ErrScanIssuesTooLarge
		},
	}
	router := issueFixtureRouter(New(repo, nil, nil))
	for _, path := range []string{
		"/api/scans/" + testIssueScanID + "/issues/page?limit=1",
		"/api/scans/" + testIssueScanID + "/issues/" + testIssueID + "/occurrences?limit=1",
	} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), "/issues/page") {
			t.Fatalf("oversized selection %q = %d %q", path, response.Code, response.Body.String())
		}
	}
}

func TestDirectScanIssuePagesShapeRedactionAndOwnership(t *testing.T) {
	const rawURL = "https://user:secret@example.test/page?keep=yes"
	const safeURL = "https://example.test/page"
	var groupCalls, detailCalls int
	repo := &issuePageFixtureRepo{
		stubRepo: stubRepo{getScan: func(_ context.Context, id string) (*models.Scan, error) {
			if id != testIssueScanID {
				return nil, nil
			}
			return &models.Scan{ID: id}, nil
		}},
		groups: func(_ context.Context, id string, limit, offset int) ([]models.Issue, int64, error) {
			groupCalls++
			if id != testIssueScanID || limit != 2 || offset != 1 {
				t.Errorf("group args = %q %d %d", id, limit, offset)
			}
			return []models.Issue{{ID: testIssueID, ViolationType: "image-alt", Description: "Missing alt", Severity: "serious", IsFalsePositive: true, OccurrenceCount: 3}}, 3, nil
		},
		detail: func(_ context.Context, id, issueID string, limit, offset int) (*models.Issue, []models.IssueOccurrence, int64, error) {
			detailCalls++
			if id != testIssueScanID || issueID != testIssueID || limit != 2 || offset != 1 {
				t.Errorf("detail args = %q %q %d %d", id, issueID, limit, offset)
			}
			return &models.Issue{ID: testIssueID, ViolationType: "image-alt", Description: "Missing alt", Severity: "serious", OccurrenceCount: 3},
				[]models.IssueOccurrence{{ID: "occurrence-1", PageURL: rawURL}}, 3, nil
		},
	}
	router := issueFixtureRouter(New(repo, nil, nil))
	groups := httptest.NewRecorder()
	router.ServeHTTP(groups, httptest.NewRequest(http.MethodGet,
		"/api/scans/"+testIssueScanID+"/issues/page?limit=2&offset=1", nil))
	if groups.Code != http.StatusOK || groupCalls != 1 || !strings.Contains(groups.Body.String(), `"act_rules"`) ||
		!strings.Contains(groups.Body.String(), `"suggested_fixes"`) {
		t.Fatalf("groups = %d %q", groups.Code, groups.Body.String())
	}
	var groupBody struct {
		Issues []struct {
			Summary models.MCPIssueSummary `json:"summary"`
		} `json:"issues"`
		Total  int64 `json:"total"`
		Limit  int   `json:"limit"`
		Offset int   `json:"offset"`
	}
	if err := json.Unmarshal(groups.Body.Bytes(), &groupBody); err != nil || groupBody.Total != 3 ||
		len(groupBody.Issues) != 1 || groupBody.Issues[0].Summary.Key != testIssueID ||
		!groupBody.Issues[0].Summary.IsFalsePositive || groupBody.Issues[0].Summary.OccurrenceCount != 3 {
		t.Fatalf("group payload = %+v error=%v", groupBody, err)
	}

	detail := httptest.NewRecorder()
	router.ServeHTTP(detail, httptest.NewRequest(http.MethodGet,
		"/api/scans/"+testIssueScanID+"/issues/"+testIssueID+"/occurrences?limit=2&offset=1", nil))
	var detailBody struct {
		Issue       models.Issue             `json:"issue"`
		Occurrences []models.IssueOccurrence `json:"occurrences"`
		Total       int64                    `json:"total"`
		HasMore     bool                     `json:"has_more"`
	}
	if detail.Code != http.StatusOK || json.Unmarshal(detail.Body.Bytes(), &detailBody) != nil || detailCalls != 1 ||
		!detailBody.HasMore || detailBody.Total != 3 || len(detailBody.Occurrences) != 1 ||
		detailBody.Occurrences[0].PageURL != safeURL || !strings.Contains(detail.Body.String(), `"act_rules"`) ||
		strings.Contains(detail.Body.String(), "user:secret") {
		t.Fatalf("detail = %d %q", detail.Code, detail.Body.String())
	}

	for _, path := range []string{
		"/api/scans/" + testIssueScanID + "/issues/page?limit=51",
		"/api/scans/" + testIssueScanID + "/issues/page?offset=-1",
		"/api/scans/" + testIssueScanID + "/issues/page?limit=1&limit=2",
		"/api/scans/" + testIssueScanID + "/issues/" + testIssueID + "/occurrences?limit=101",
		"/api/scans/" + testIssueScanID + "/issues/not-an-id/occurrences",
	} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid page %q = %d %q", path, response.Code, response.Body.String())
		}
	}
	missing := httptest.NewRecorder()
	router.ServeHTTP(missing, httptest.NewRequest(http.MethodGet,
		"/api/scans/cccccccc-cccc-4ccc-8ccc-cccccccccccc/issues/page", nil))
	if missing.Code != http.StatusNotFound || groupCalls != 1 || detailCalls != 1 {
		t.Fatalf("missing scan = %d; calls=%d/%d", missing.Code, groupCalls, detailCalls)
	}
}

type heldIssueWriter struct {
	http.ResponseWriter
	entered chan<- struct{}
	release <-chan struct{}
}

func (w heldIssueWriter) Write(data []byte) (int, error) {
	w.entered <- struct{}{}
	<-w.release
	return w.ResponseWriter.Write(data)
}

func TestIssueReadPermitHeldUntilResponseWriteFinishes(t *testing.T) {
	var calls atomic.Int32
	repo := &issuePageFixtureRepo{
		stubRepo: stubRepo{getScan: func(context.Context, string) (*models.Scan, error) {
			return &models.Scan{ID: testIssueScanID}, nil
		}},
		legacy: func(context.Context, string) ([]models.IssueWithOccurrences, error) {
			calls.Add(1)
			return []models.IssueWithOccurrences{}, nil
		},
	}
	h := New(repo, nil, nil)
	router := issueFixtureRouter(h)
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	done := make(chan struct{}, 2)
	for range 2 {
		go func() {
			response := httptest.NewRecorder()
			router.ServeHTTP(heldIssueWriter{ResponseWriter: response, entered: entered, release: release},
				httptest.NewRequest(http.MethodGet, "/api/scans/"+testIssueScanID+"/issues", nil))
			done <- struct{}{}
		}()
	}
	<-entered
	<-entered
	busy := httptest.NewRecorder()
	router.ServeHTTP(busy, httptest.NewRequest(http.MethodGet, "/api/scans/"+testIssueScanID+"/issues", nil))
	if busy.Code != http.StatusServiceUnavailable || busy.Header().Get("Retry-After") != "1" || calls.Load() != 2 {
		t.Fatalf("third read = %d calls=%d", busy.Code, calls.Load())
	}
	close(release)
	<-done
	<-done
	available := httptest.NewRecorder()
	router.ServeHTTP(available, httptest.NewRequest(http.MethodGet, "/api/scans/"+testIssueScanID+"/issues", nil))
	if available.Code != http.StatusOK || calls.Load() != 3 {
		t.Fatalf("read after release = %d calls=%d", available.Code, calls.Load())
	}
}

func TestACTPayloadAllowanceIncludesExpandedStrings(t *testing.T) {
	if !issueACTFits(models.Issue{ActRules: []models.ACTRule{{ActRuleID: "test", Title: "Short"}}}) {
		t.Fatal("ordinary ACT metadata was rejected")
	}
	if issueACTFits(models.Issue{ActRules: []models.ACTRule{{Summary: strings.Repeat("x", 11<<10)}}}) {
		t.Fatal("oversized ACT metadata was admitted")
	}
}
