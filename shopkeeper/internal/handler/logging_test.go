package handler

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
)

func TestScanReadErrorLogOmitsTargetQuery(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)

	const canary = "QUERY_TOKEN_CANARY"
	h := New(stubRepo{getScan: func(context.Context, string) (*models.Scan, error) {
		return nil, errors.New("GET https://example.test/path?token=" + canary + ": failed")
	}}, nil, nil)
	response := httptest.NewRecorder()
	h.GetScan(response, withScanID(httptest.NewRequest(http.MethodGet, "/api/scans/scan-1", nil), "scan-1"))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d; want 500", response.Code)
	}
	message := output.String()
	if !strings.Contains(message, "[URL details omitted]") || strings.Contains(message, canary) {
		t.Fatalf("unsafe scan error log: %q", message)
	}
}
