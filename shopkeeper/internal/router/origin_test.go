package router

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRejectCrossOriginWrites(t *testing.T) {
	cases := []struct {
		name, method, target, origin, fetchSite, forwardedProto string
		originPresent, allowed                                  bool
	}{
		{"foreign text/plain scan form", "POST", "http://api.example.test/api/scans", "https://foreign.test", "cross-site", "", true, false},
		{"null origin link form", "POST", "http://api.example.test/api/link-checks", "null", "", "", true, false},
		{"foreign bodyless action", "POST", "http://api.example.test/api/scans/id/pause", "https://foreign.test", "", "", true, false},
		{"fetch metadata without origin", "POST", "http://api.example.test/api/scans/id/pause", "", "cross-site", "", false, false},
		{"same-site metadata without origin", "POST", "http://api.example.test/api/scans/id/pause", "", "same-site", "", false, false},
		{"empty origin", "POST", "http://api.example.test/api/scans", "", "", "", true, false},
		{"same origin JSON", "POST", "http://api.example.test/api/scans", "http://api.example.test", "same-origin", "", true, true},
		{"public HTTPS proxy", "POST", "http://ui.example.test/api/scans", "https://ui.example.test", "same-origin", "https", true, true},
		{"public HTTPS proxy chain", "POST", "http://ui.example.test/api/scans", "https://ui.example.test", "same-origin", "https, http", true, true},
		{"localhost development CORS", "POST", "http://localhost:8080/api/scans", "http://localhost:3001", "same-site", "", true, true},
		{"localhost development to remote backend", "POST", "http://api.example.test/api/scans", "http://localhost:3001", "cross-site", "", true, true},
		{"localhost development without fetch metadata", "POST", "http://api.example.test/api/scans", "http://localhost:3001", "", "", true, true},
		{"origin-free CLI", "POST", "http://api.example.test/api/scans", "", "", "", false, true},
		{"foreign read", "GET", "http://api.example.test/api/scans", "https://foreign.test", "cross-site", "", true, true},
		{"foreign preflight", "OPTIONS", "http://api.example.test/api/scans", "https://foreign.test", "cross-site", "", true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			handler := rejectCrossOriginWrites(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls++
				w.WriteHeader(http.StatusNoContent)
			}))
			req := httptest.NewRequest(tc.method, tc.target, strings.NewReader(`{"url":"https://example.test/?pad=="}`))
			if tc.originPresent {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.fetchSite != "" {
				req.Header.Set("Sec-Fetch-Site", tc.fetchSite)
			}
			if tc.forwardedProto != "" {
				req.Header.Set("X-Forwarded-Proto", tc.forwardedProto)
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if tc.allowed {
				if w.Code != http.StatusNoContent || calls != 1 {
					t.Fatalf("allowed request status=%d handler calls=%d", w.Code, calls)
				}
			} else if w.Code != http.StatusForbidden || calls != 0 {
				t.Fatalf("cross-origin request status=%d handler calls=%d", w.Code, calls)
			}
		})
	}
}

func TestMountedAPIRoutesRejectCrossOriginBeforeHandlers(t *testing.T) {
	// No repository is needed: the Origin guard must stop the request before
	// scan creation reaches its database dependency.
	router := Setup(nil, nil, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/scans", strings.NewReader(`{"sitemap_url":"https://example.test/"}`))
	req.Header.Set("Origin", "https://foreign.test")
	req.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("cross-origin scan status=%d body=%s", w.Code, w.Body.String())
	}
}
