package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
