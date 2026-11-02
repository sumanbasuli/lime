package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/screenshots"
)

func TestServeScreenshotRequiresCommittedVisibleEvidence(t *testing.T) {
	t.Setenv("SHOPKEEPER_SCREENSHOT_DIR", filepath.Join(t.TempDir(), "screenshots"))
	const scanID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const filename = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb_focus_0.png"
	if err := screenshots.EnsureScanDir(scanID); err != nil {
		t.Fatal(err)
	}
	if err := screenshots.WriteFile(screenshots.FilePath(scanID, filename), []byte("image")); err != nil {
		t.Fatal(err)
	}
	visible := false
	var lookupErr error
	h := New(stubRepo{
		getScan: func(context.Context, string) (*models.Scan, error) { return &models.Scan{ID: scanID}, nil },
		screenshotVisible: func(_ context.Context, gotScanID, gotFilename string) (bool, error) {
			if gotScanID != scanID || gotFilename != filename {
				t.Fatalf("visibility lookup = %q %q", gotScanID, gotFilename)
			}
			return visible, lookupErr
		},
	}, nil, nil)
	router := chi.NewRouter()
	router.Get("/api/screenshots/{scanId}/{filename}", h.ServeScreenshot)
	request := func() *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/screenshots/"+scanID+"/"+filename, nil))
		return response
	}
	if response := request(); response.Code != http.StatusNotFound {
		t.Fatalf("uncommitted image response = %d", response.Code)
	}
	visible = true
	if response := request(); response.Code != http.StatusOK || response.Body.String() != "image" {
		t.Fatalf("committed image response = %d %q", response.Code, response.Body.String())
	}
	lookupErr = errors.New("database unavailable")
	if response := request(); response.Code != http.StatusInternalServerError {
		t.Fatalf("visibility lookup failure response = %d", response.Code)
	}
}
