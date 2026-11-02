package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

const rawTarget = "https://alice:s%40cret@example.test/path?owner=a@b"
const publicTarget = "https://example.test/path"

type publicResponseRepo struct {
	stubRepo
	scan          models.Scan
	createdTarget string
	issueRows     []models.IssueWithOccurrences
}

func (r *publicResponseRepo) CreateScan(_ context.Context, target, kind string, _ *string, _ viewport.Settings) (*models.Scan, error) {
	r.createdTarget = target
	return &models.Scan{ID: "new-scan", SitemapURL: target, ScanType: kind}, nil
}
func (r *publicResponseRepo) CreateRescanFrom(_ context.Context, sourceScanID string) (*models.Scan, error) {
	if sourceScanID != r.scan.ID {
		return nil, fmt.Errorf("unexpected source scan %s", sourceScanID)
	}
	r.createdTarget = r.scan.SitemapURL
	return &models.Scan{ID: "new-scan", SitemapURL: r.scan.SitemapURL, ScanType: r.scan.ScanType, RootPublic: r.scan.RootPublic}, nil
}
func (r *publicResponseRepo) ListScans(context.Context) ([]models.Scan, error) {
	return []models.Scan{r.scan}, nil
}
func (r *publicResponseRepo) ListScansByTag(context.Context, string) ([]models.Scan, error) {
	return []models.Scan{r.scan}, nil
}
func (r *publicResponseRepo) ListScansPage(context.Context, string, int, int) ([]models.Scan, error) {
	return []models.Scan{r.scan}, nil
}
func (r *publicResponseRepo) GetScan(context.Context, string) (*models.Scan, error) {
	return &r.scan, nil
}
func (r *publicResponseRepo) GetScanIssues(context.Context, string) ([]models.IssueWithOccurrences, error) {
	if r.issueRows != nil {
		return r.issueRows, nil
	}
	return []models.IssueWithOccurrences{{Occurrences: []models.IssueOccurrence{{PageURL: rawTarget}}}}, nil
}
func (r *publicResponseRepo) RetryFailedURLs(context.Context, string) (*models.Scan, int, error) {
	updated := r.scan
	updated.Status = "pending"
	return &updated, 1, nil
}
func (r *publicResponseRepo) RequestPause(context.Context, string) (*models.Scan, error) {
	updated := r.scan
	updated.PauseRequested = true
	return &updated, nil
}
func (r *publicResponseRepo) ResumeScan(context.Context, string) (*models.Scan, error) {
	updated := r.scan
	updated.Status = "pending"
	return &updated, nil
}

func TestScanRESTResponsesRedactUserinfoAndPreserveRawState(t *testing.T) {
	tests := []struct {
		name, method, path, status string
		call                       func(*Handler, http.ResponseWriter, *http.Request)
		wantStatus                 int
	}{
		{"create", "POST", "/api/scans", "completed", (*Handler).CreateScan, http.StatusCreated},
		{"list", "GET", "/api/scans", "completed", (*Handler).ListScans, http.StatusOK},
		{"list by tag", "GET", "/api/scans?tag=test", "completed", (*Handler).ListScans, http.StatusOK},
		{"get", "GET", "/api/scans/scan-1", "completed", (*Handler).GetScan, http.StatusOK},
		{"rescan", "POST", "/api/scans/scan-1/rescan", "completed", (*Handler).RescanScan, http.StatusCreated},
		{"retry", "POST", "/api/scans/scan-1/retry-failed", "completed", (*Handler).RetryFailedPages, http.StatusOK},
		{"pause", "POST", "/api/scans/scan-1/pause", "scanning", (*Handler).PauseScan, http.StatusOK},
		{"pause already requested", "POST", "/api/scans/scan-1/pause", "requested", (*Handler).PauseScan, http.StatusOK},
		{"resume", "POST", "/api/scans/scan-1/resume", "paused", (*Handler).ResumeScan, http.StatusOK},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			repo := &publicResponseRepo{scan: models.Scan{ID: "scan-1", SitemapURL: rawTarget, Status: tc.status, ScanType: "single"}}
			if tc.status == "requested" {
				repo.scan.Status, repo.scan.PauseRequested = "scanning", true
			}
			h := New(repo, nil, nil)
			var body *strings.Reader
			if tc.name == "create" {
				body = strings.NewReader(`{"sitemap_url":"` + rawTarget + `","scan_type":"single"}`)
			} else {
				body = strings.NewReader("")
			}
			req := httptest.NewRequest(tc.method, tc.path, body)
			if tc.name != "create" && !strings.HasPrefix(tc.name, "list") {
				req = withScanID(req, "scan-1")
			}
			response := httptest.NewRecorder()
			tc.call(h, response, req)
			if response.Code != tc.wantStatus {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), "alice") || strings.Contains(response.Body.String(), "s%40cret") || !strings.Contains(response.Body.String(), publicTarget) {
				t.Fatalf("unsafe or missing public URL: %s", response.Body.String())
			}
			if repo.scan.SitemapURL != rawTarget {
				t.Fatal("stored scan URL was changed")
			}
			if (tc.name == "create" || tc.name == "rescan") && repo.createdTarget != rawTarget {
				t.Fatalf("scan target changed before creation: %q", repo.createdTarget)
			}
		})
	}
}

func TestIssueRESTResponseRedactsOccurrencePageURL(t *testing.T) {
	repo := &publicResponseRepo{scan: models.Scan{ID: "scan-1", SitemapURL: rawTarget}}
	h := New(repo, nil, nil)
	response := httptest.NewRecorder()
	h.GetScanIssues(response, withScanID(httptest.NewRequest(http.MethodGet, "/api/scans/scan-1/issues", nil), "scan-1"))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var issues []models.IssueWithOccurrences
	if err := json.Unmarshal(response.Body.Bytes(), &issues); err != nil {
		t.Fatal(err)
	}
	if len(issues) != 1 || len(issues[0].Occurrences) != 1 || issues[0].Occurrences[0].PageURL != publicTarget {
		t.Fatalf("unsafe issue response: %+v", issues)
	}
}

func TestIssueRESTResponseRedactsRequestOwnedOccurrencesInPlace(t *testing.T) {
	const secondRaw = "http://bob:p%40ss@example.test/next?reply=editor@example.test"
	const secondPublic = "http://example.test/next"
	snippet := "<button>Continue</button>"
	helpURL := rawTarget
	repo := &publicResponseRepo{
		scan: models.Scan{ID: "scan-1", SitemapURL: rawTarget},
		// The production repository also returns fresh slices for each request.
		issueRows: []models.IssueWithOccurrences{
			{
				Issue: models.Issue{ID: "issue-1", IsFalsePositive: true, HelpURL: &helpURL},
				Occurrences: []models.IssueOccurrence{
					{ID: "occurrence-1", PageURL: rawTarget, HTMLSnippet: &snippet},
					{ID: "occurrence-2", PageURL: secondRaw},
				},
			},
			{
				Issue:       models.Issue{ID: "issue-2"},
				Occurrences: []models.IssueOccurrence{{ID: "occurrence-3", PageURL: "https://example.test/safe"}},
			},
		},
	}
	response := httptest.NewRecorder()
	New(repo, nil, nil).GetScanIssues(response, withScanID(httptest.NewRequest(http.MethodGet, "/api/scans/scan-1/issues", nil), "scan-1"))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var issues []models.IssueWithOccurrences
	if err := json.Unmarshal(response.Body.Bytes(), &issues); err != nil {
		t.Fatal(err)
	}
	if len(issues) != 2 || issues[0].Issue.ID != "issue-1" || !issues[0].Issue.IsFalsePositive || len(issues[0].Occurrences) != 2 || issues[1].Issue.ID != "issue-2" || len(issues[1].Occurrences) != 1 {
		t.Fatalf("issue groups changed: %+v", issues)
	}
	if issues[0].Occurrences[0].ID != "occurrence-1" || issues[0].Occurrences[0].PageURL != publicTarget || issues[0].Occurrences[0].HTMLSnippet == nil || *issues[0].Occurrences[0].HTMLSnippet != snippet || issues[0].Occurrences[1].ID != "occurrence-2" || issues[0].Occurrences[1].PageURL != secondPublic || issues[1].Occurrences[0].PageURL != "https://example.test/safe" {
		t.Fatalf("occurrence data changed unexpectedly: %+v", issues)
	}
	if issues[0].Issue.HelpURL == nil || *issues[0].Issue.HelpURL != publicTarget || helpURL != rawTarget {
		t.Fatalf("help URL projection changed stored value or exposed credentials: %+v", issues[0].Issue.HelpURL)
	}
	if repo.issueRows[0].Occurrences[0].PageURL != publicTarget || repo.issueRows[0].Occurrences[1].PageURL != secondPublic {
		t.Fatal("response projection allocated a second occurrence slice")
	}
	if strings.Contains(response.Body.String(), "alice") || strings.Contains(response.Body.String(), "bob:p%40ss") {
		t.Fatalf("URL userinfo leaked: %s", response.Body.String())
	}
}
