package handler

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/viewport"
)

type selectionRepo struct {
	stubRepo
	legacyCalls, linkCalls int
}

func (r *selectionRepo) CreateScan(_ context.Context, target, kind string, tag *string, v viewport.Settings) (*models.Scan, error) {
	r.legacyCalls++
	return &models.Scan{ID: "fixture", SitemapURL: target, ScanType: kind}, nil
}
func (r *selectionRepo) CreateScanWithLinkCheck(_ context.Context, target, kind string, tag *string, v viewport.Settings) (*models.Scan, error) {
	r.linkCalls++
	return &models.Scan{ID: "fixture", SitemapURL: target, ScanType: kind, IncludeLinkCheck: true}, nil
}

func TestCreateScanOptionalLinkSelectionAndDefaultOff(t *testing.T) {
	for _, include := range []bool{false, true} {
		repo := &selectionRepo{}
		h := New(repo, nil, nil)
		body := `{"sitemap_url":"https://example.test/","scan_type":"single"}`
		if include {
			body = `{"sitemap_url":"https://example.test/","scan_type":"single","include_link_check":true}`
		}
		w := httptest.NewRecorder()
		h.CreateScan(w, httptest.NewRequest("POST", "/api/scans", strings.NewReader(body)))
		if w.Code != 201 {
			t.Fatalf("create status=%d body=%s", w.Code, w.Body.String())
		}
		var scan models.Scan
		if err := json.Unmarshal(w.Body.Bytes(), &scan); err != nil {
			t.Fatal(err)
		}
		if scan.IncludeLinkCheck != include {
			t.Fatal("selection was lost")
		}
		if include && repo.linkCalls != 1 {
			t.Fatal("atomic companion path not called")
		}
		if !include && repo.legacyCalls != 1 {
			t.Fatal("default changed legacy scan path")
		}
	}
}

func TestCreateScanWithLinksRejectsCredentialsBeforePersisting(t *testing.T) {
	repo := &selectionRepo{}
	h := New(repo, nil, nil)
	w := httptest.NewRecorder()
	h.CreateScan(w, httptest.NewRequest("POST", "/api/scans", strings.NewReader(`{"sitemap_url":"https://user:secret@example.test/","scan_type":"single","include_link_check":true}`)))
	if w.Code != http.StatusBadRequest || repo.linkCalls != 0 || repo.legacyCalls != 0 {
		t.Fatal("credentials accepted or persisted before validation")
	}
}

func TestCreateLinkCheckParseErrorDoesNotEchoSubmittedQuery(t *testing.T) {
	h := &Handler{}
	w := httptest.NewRecorder()
	h.CreateLinkCheck(w, httptest.NewRequest(http.MethodPost, "/api/link-checks", strings.NewReader(
		`{"url":"https://example.test/%ZZ?token=QUERY_TOKEN_CANARY","check_type":"single"}`)))
	if w.Code != http.StatusBadRequest || strings.Contains(w.Body.String(), "QUERY_TOKEN_CANARY") {
		t.Fatalf("unsafe parse rejection: status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestCreateScanAcceptsSmallChunkedBodyWithUnknownField(t *testing.T) {
	repo := &selectionRepo{}
	h := New(repo, nil, nil)
	body := `{"sitemap_url":"https://example.test/","scan_type":"single","ignored":"value"}`
	req := httptest.NewRequest(http.MethodPost, "/api/scans", strings.NewReader(body))
	req.ContentLength = -1
	req.TransferEncoding = []string{"chunked"}
	w := httptest.NewRecorder()

	h.CreateScan(w, req)
	if w.Code != http.StatusCreated || repo.legacyCalls != 1 {
		t.Fatalf("small chunked scan status=%d repo calls=%d body=%s", w.Code, repo.legacyCalls, w.Body.String())
	}
}

func TestCreateScanRejectsOversizedBodiesBeforePersisting(t *testing.T) {
	large := strings.Repeat("x", 1<<20)
	cases := []struct {
		name    string
		body    string
		chunked bool
	}{
		{"known field", `{"sitemap_url":"https://example.test/","tag":"` + large + `"}`, false},
		{"unknown field", `{"sitemap_url":"https://example.test/","ignored":"` + large + `"}`, true},
		{"trailing bytes", `{"sitemap_url":"https://example.test/"}` + large, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := &selectionRepo{}
			h := New(repo, nil, nil)
			req := httptest.NewRequest(http.MethodPost, "/api/scans", strings.NewReader(tc.body))
			if tc.chunked {
				req.ContentLength = -1
				req.TransferEncoding = []string{"chunked"}
			}
			w := httptest.NewRecorder()

			h.CreateScan(w, req)
			if w.Code != http.StatusRequestEntityTooLarge || repo.legacyCalls != 0 || repo.linkCalls != 0 {
				t.Fatalf("oversized scan status=%d repo calls=%d/%d body=%s", w.Code, repo.legacyCalls, repo.linkCalls, w.Body.String())
			}
		})
	}
}

func TestLinkPaginationAndUUIDValidation(t *testing.T) {
	for _, query := range []string{"?limit=0", "?limit=201", "?limit=no", "?offset=-1", "?offset=1000001"} {
		if _, _, ok := pagination(httptest.NewRequest("GET", "/"+query, nil)); ok {
			t.Errorf("accepted %s", query)
		}
	}
	limit, offset, ok := pagination(httptest.NewRequest("GET", "/", nil))
	if !ok || limit != 50 || offset != 0 {
		t.Fatal("wrong pagination defaults")
	}
	if !validID("11111111-1111-4111-8111-111111111111") || validID("not-a-uuid") || validID("11111111-1111-4111-8111-11111111111z") {
		t.Fatal("UUID validation failed")
	}
}

func TestCSVNeutralizesUntrustedFormulaCells(t *testing.T) {
	for _, raw := range []string{"=HYPERLINK(\"bad\")", " +cmd", "-1+2", "@evil", "\t=SUM(1)", "\n+formula"} {
		if safe := csvSafe(raw); !strings.HasPrefix(safe, "'") {
			t.Errorf("formula not neutralized: %q -> %q", raw, safe)
		}
	}
	for _, raw := range []string{"https://example.test/", "Plain text", ""} {
		if csvSafe(raw) != raw {
			t.Errorf("ordinary value changed %q", raw)
		}
	}
}

func TestLinkCSVRowHidesQueryAndURLBearingError(t *testing.T) {
	const raw = "https://example.test/path?token=QUERY_TOKEN_CANARY"
	final := "https://other.test/final?token=QUERY_TOKEN_CANARY"
	errText := "GET " + raw + ": timeout"
	var body bytes.Buffer
	writer := csv.NewWriter(&body)
	if err := writeLinkCSVRow(writer, models.LinkResult{TargetURL: raw, FinalURL: &final, Error: &errText}, models.LinkSource{PageURL: raw}); err != nil {
		t.Fatal(err)
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(body.String(), "QUERY_TOKEN_CANARY") || !strings.Contains(body.String(), "https://example.test/path") || !strings.Contains(body.String(), "https://other.test/final") {
		t.Fatalf("unsafe link CSV row: %q", body.String())
	}
}

type recheckLinkRepo struct {
	LinkRepository
	job     models.LinkCheck
	fromID  string
	created models.LinkCheck
}

func (r *recheckLinkRepo) GetLinkCheck(_ context.Context, id string) (*models.LinkCheck, error) {
	if id != r.job.ID {
		return nil, nil
	}
	return &r.job, nil
}

func (r *recheckLinkRepo) CreateLinkCheckFrom(_ context.Context, sourceJobID string) (*models.LinkCheck, error) {
	r.fromID = sourceJobID
	return &r.created, nil
}

func TestRecheckUsesSourceJobForDetachedCreation(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	repo := &recheckLinkRepo{
		job:     models.LinkCheck{ID: id, URL: "https://example.test/", CheckType: "scan", Status: "completed", SeedURLs: []string{"https://example.test/page"}},
		created: models.LinkCheck{ID: "22222222-2222-4222-8222-222222222222", URL: "https://example.test/", CheckType: "scan", Status: "queued"},
	}
	h := &Handler{links: repo}
	req := httptest.NewRequest(http.MethodPost, "/api/link-checks/"+id+"/recheck", nil)
	route := chi.NewRouteContext()
	route.URLParams.Add("id", id)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, route))
	w := httptest.NewRecorder()
	h.RecheckLinks(w, req)
	if w.Code != http.StatusCreated || repo.fromID != id {
		t.Fatalf("recheck status=%d from=%q body=%s", w.Code, repo.fromID, w.Body.String())
	}
}
