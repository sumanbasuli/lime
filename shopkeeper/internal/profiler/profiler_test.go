package profiler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDiscoverRetriesTransientNestedSitemapFailures(t *testing.T) {
	var mu sync.Mutex
	requests := map[string]int{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests[r.URL.Path]++
		count := requests[r.URL.Path]
		mu.Unlock()

		switch r.URL.Path {
		case "/index.xml":
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprintf(w, `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
				<sitemap><loc>%s/a.xml</loc></sitemap>
				<sitemap><loc>%s/b.xml</loc></sitemap>
				<sitemap><loc>%s/c.xml</loc></sitemap>
			</sitemapindex>`, serverURL(t, r), serverURL(t, r), serverURL(t, r))
		case "/a.xml":
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprint(w, `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a</loc></url></urlset>`)
		case "/b.xml":
			if count == 1 {
				w.WriteHeader(599)
				fmt.Fprint(w, "retry me")
				return
			}
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprint(w, `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/b</loc></url></urlset>`)
		case "/c.xml":
			if count == 1 {
				w.WriteHeader(599)
				fmt.Fprint(w, "retry me")
				return
			}
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprint(w, `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/c</loc></url></urlset>`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	withTestHTTPClient(t, server.Client(), func() {
		urls, err := Discover(context.Background(), server.URL+"/index.xml")
		if err != nil {
			t.Fatalf("Discover returned error: %v", err)
		}

		slices.Sort(urls)
		expected := []string{
			"https://example.com/a",
			"https://example.com/b",
			"https://example.com/c",
		}
		if !slices.Equal(urls, expected) {
			t.Fatalf("unexpected URLs: got %v want %v", urls, expected)
		}
	})
}

func TestDiscoverFailsWhenNestedSitemapRemainsUnavailable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/index.xml":
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprintf(w, `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
				<sitemap><loc>%s/a.xml</loc></sitemap>
				<sitemap><loc>%s/b.xml</loc></sitemap>
			</sitemapindex>`, serverURL(t, r), serverURL(t, r))
		case "/a.xml":
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprint(w, `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a</loc></url></urlset>`)
		case "/b.xml":
			w.WriteHeader(599)
			fmt.Fprint(w, "still failing")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	withTestHTTPClient(t, server.Client(), func() {
		_, err := Discover(context.Background(), server.URL+"/index.xml")
		if err == nil {
			t.Fatal("Discover succeeded unexpectedly")
		}
		if got := err.Error(); got == "" || !containsAll(got, "failed to fully process sitemapindex", "/b.xml", "HTTP 599") {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestDiscoverFallsBackWhenScannerProfileIsForbidden(t *testing.T) {
	var mu sync.Mutex
	requests := map[string]int{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userAgent := r.Header.Get("User-Agent")

		mu.Lock()
		requests[userAgent]++
		mu.Unlock()

		switch userAgent {
		case sitemapFetchProfiles[0].userAgent:
			http.Error(w, "blocked by WAF", http.StatusForbidden)
		case sitemapFetchProfiles[1].userAgent:
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprint(w, `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/fallback</loc></url></urlset>`)
		default:
			t.Fatalf("unexpected user agent: %q", userAgent)
		}
	}))
	defer server.Close()

	withTestHTTPClient(t, server.Client(), func() {
		urls, err := Discover(context.Background(), server.URL)
		if err != nil {
			t.Fatalf("Discover returned error: %v", err)
		}

		expected := []string{"https://example.com/fallback"}
		if !slices.Equal(urls, expected) {
			t.Fatalf("unexpected URLs: got %v want %v", urls, expected)
		}
	})

	mu.Lock()
	defer mu.Unlock()

	if requests[sitemapFetchProfiles[0].userAgent] != 1 {
		t.Fatalf("expected one request with scanner profile, got %d", requests[sitemapFetchProfiles[0].userAgent])
	}
	if requests[sitemapFetchProfiles[1].userAgent] != 1 {
		t.Fatalf("expected one request with browser fallback profile, got %d", requests[sitemapFetchProfiles[1].userAgent])
	}
}

func TestDiscoverHonorsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := Discover(ctx, "https://example.com/sitemap.xml")
	if err == nil {
		t.Fatal("Discover succeeded unexpectedly")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", err)
	}
}

func withTestHTTPClient(t *testing.T, client *http.Client, fn func()) {
	t.Helper()

	original := httpClient
	testClient := *client
	testClient.Timeout = 5 * time.Second
	httpClient = &testClient
	t.Cleanup(func() {
		httpClient = original
	})

	fn()
}

func serverURL(t *testing.T, r *http.Request) string {
	t.Helper()
	return "http://" + r.Host
}

func containsAll(value string, substrings ...string) bool {
	for _, substring := range substrings {
		if !contains(value, substring) {
			return false
		}
	}
	return true
}

func contains(value, substring string) bool {
	return strings.Contains(value, substring)
}
