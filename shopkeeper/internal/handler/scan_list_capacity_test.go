package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

func TestScanListRequiresPagingOnlyBeyondLegacyThreshold(t *testing.T) {
	type call struct {
		tag           string
		limit, offset int
	}
	var calls []call
	repo := stubRepo{listScansPage: func(_ context.Context, tag string, limit, offset int) ([]models.Scan, error) {
		calls = append(calls, call{tag, limit, offset})
		total := legacyScanListMax + 1
		if tag == "production" {
			total = legacyScanListMax
		}
		if offset > total {
			return []models.Scan{}, nil
		}
		end := offset + limit
		if end > total {
			end = total
		}
		items := make([]models.Scan, 0, end-offset)
		for i := offset; i < end; i++ {
			items = append(items, models.Scan{
				ID: strconv.Itoa(i), SitemapURL: "https://alice:secret@example.test/" + strconv.Itoa(i), Status: "completed",
			})
		}
		return items, nil
	}}
	h := New(repo, nil, nil)
	serve := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		h.ListScans(response, httptest.NewRequest(http.MethodGet, path, nil))
		return response
	}
	tooLarge := serve("/api/scans")
	if tooLarge.Code != http.StatusRequestEntityTooLarge || !strings.Contains(tooLarge.Body.String(), "limit") ||
		strings.Contains(tooLarge.Body.String(), "alice") {
		t.Fatalf("large legacy response = %d %q", tooLarge.Code, tooLarge.Body.String())
	}
	if len(calls) != 1 || calls[0] != (call{"", legacyScanListMax + 1, 0}) {
		t.Fatalf("unpaged query = %+v", calls)
	}

	exact := serve("/api/scans?tag=production")
	var exactItems []models.Scan
	if exact.Code != http.StatusOK || json.Unmarshal(exact.Body.Bytes(), &exactItems) != nil || len(exactItems) != legacyScanListMax {
		t.Fatalf("exact legacy threshold = %d, %d rows", exact.Code, len(exactItems))
	}
	if calls[1] != (call{"production", legacyScanListMax + 1, 0}) {
		t.Fatalf("tagged query = %+v", calls[1])
	}
	if strings.Contains(exact.Body.String(), "alice") || strings.Contains(exact.Body.String(), "secret") {
		t.Fatal("scan list exposed target URL credentials")
	}
	taggedLarge := serve("/api/scans?tag=large")
	if taggedLarge.Code != http.StatusRequestEntityTooLarge || calls[2] != (call{"large", legacyScanListMax + 1, 0}) {
		t.Fatalf("large tagged response = %d, %+v", taggedLarge.Code, calls[2])
	}

	page := serve("/api/scans?limit=2&offset=999")
	var pageItems []models.Scan
	if page.Code != http.StatusOK || json.Unmarshal(page.Body.Bytes(), &pageItems) != nil || len(pageItems) != 2 ||
		pageItems[0].ID != "999" || pageItems[1].ID != "1000" {
		t.Fatalf("explicit page = %d %q", page.Code, page.Body.String())
	}
	if calls[3] != (call{"", 2, 999}) {
		t.Fatalf("paged query = %+v", calls[3])
	}

	defaultPage := serve("/api/scans?offset=1000")
	if defaultPage.Code != http.StatusOK || calls[4] != (call{"", 100, 1000}) {
		t.Fatalf("offset-only page = %d, %+v", defaultPage.Code, calls[4])
	}
}

func TestScanListRejectsInvalidPageParametersBeforeRepository(t *testing.T) {
	repo := stubRepo{listScansPage: func(context.Context, string, int, int) ([]models.Scan, error) {
		t.Fatal("invalid page reached repository")
		return nil, nil
	}}
	h := New(repo, nil, nil)
	for _, path := range []string{
		"/api/scans?limit=", "/api/scans?limit=0", "/api/scans?limit=201", "/api/scans?limit=x",
		"/api/scans?limit=1&limit=2", "/api/scans?offset=", "/api/scans?offset=-1",
		"/api/scans?offset=1000001", "/api/scans?offset=1&offset=2",
	} {
		t.Run(path, func(t *testing.T) {
			response := httptest.NewRecorder()
			h.ListScans(response, httptest.NewRequest(http.MethodGet, path, nil))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("%s = %d %q", path, response.Code, response.Body.String())
			}
		})
	}
}
