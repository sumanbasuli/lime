package router

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func TestRequestLogOmitsQueryWithoutChangingHandlerRequest(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)

	const query = "token=QUERY_TOKEN_CANARY&lang=en"
	request := httptest.NewRequest(http.MethodGet, "http://lime.test/api/scans?"+query, nil)
	called := false
	router := chi.NewRouter()
	router.Use(middleware.RequestLogger(diagnosticLogFormatter{}))
	router.Get("/api/scans", func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.URL.RawQuery != query || !strings.Contains(r.RequestURI, query) {
			t.Errorf("handler request query changed: URL=%q URI=%q", r.URL.RawQuery, r.RequestURI)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if !called || response.Code != http.StatusNoContent {
		t.Fatalf("handler behavior changed: called=%v status=%d", called, response.Code)
	}
	message := output.String()
	if !strings.Contains(message, "/api/scans") || !strings.Contains(message, "204") || strings.Contains(message, "QUERY_TOKEN_CANARY") || strings.Contains(message, "lang=en") {
		t.Fatalf("unsafe or incomplete request log: %q", message)
	}
}

func TestRecoveredPanicLogOmitsTargetQuery(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)

	router := chi.NewRouter()
	router.Use(middleware.RequestLogger(diagnosticLogFormatter{}))
	router.Use(middleware.Recoverer)
	router.Get("/api/scans", func(http.ResponseWriter, *http.Request) {
		panic("request failed for https://example.test/path?token=QUERY_TOKEN_CANARY")
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://lime.test/api/scans", nil))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d; want 500", response.Code)
	}
	message := output.String()
	if !strings.Contains(message, "request panic: request failed for [URL details omitted]") || strings.Contains(message, "QUERY_TOKEN_CANARY") {
		t.Fatalf("unsafe panic log: %q", message)
	}
}

func TestRequestLogWithoutChiContextUsesSafeFallback(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)

	handler := middleware.RequestLogger(diagnosticLogFormatter{})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "http://lime.test/a?token=QUERY_TOKEN_CANARY", nil))
	message := output.String()
	if !strings.Contains(message, "[unmatched route]") || !strings.Contains(message, "204") || strings.Contains(message, "QUERY_TOKEN_CANARY") {
		t.Fatalf("unsafe fallback request log: %q", message)
	}
}
