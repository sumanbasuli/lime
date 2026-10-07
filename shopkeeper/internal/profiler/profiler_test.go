package profiler

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDiscoverKeepsAuthenticatedSitemapFetchButRedactsDiagnostics(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/protected.xml":
			username, password, ok := r.BasicAuth()
			if !ok || username != "alice" || password != "s@cret" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			fmt.Fprintf(w, `<urlset><url><loc>%s/page</loc></url></urlset>`, serverURL(t, r))
		case "/page":
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)

	withTestHTTPClient(t, server.Client(), func() {
		target := strings.Replace(server.URL, "://", "://alice:s%40cret@", 1) + "/protected.xml"
		urls, err := Discover(context.Background(), target)
		if err != nil {
			t.Fatalf("authenticated sitemap fetch failed: %v", err)
		}
		if !slices.Equal(urls, []string{server.URL + "/page"}) {
			t.Fatalf("unexpected discovered URLs: %v", urls)
		}

		badTarget := strings.Replace(server.URL, "://", "://eve:wrong@", 1) + "/protected.xml"
		_, err = Discover(context.Background(), badTarget)
		if err == nil || !strings.Contains(err.Error(), "HTTP 401") {
			t.Fatalf("expected HTTP 401 from wrong credentials, got %v", err)
		}
		if strings.Contains(err.Error(), "eve") || strings.Contains(err.Error(), "wrong") {
			t.Fatalf("credentials leaked in error: %v", err)
		}
	})

	if strings.Contains(output.String(), "alice") || strings.Contains(output.String(), "s%40cret") || strings.Contains(output.String(), "eve") {
		t.Fatalf("credentials leaked in profiler logs: %q", output.String())
	}
	if !strings.Contains(output.String(), server.URL+"/protected.xml") {
		t.Fatalf("redacted target missing from profiler logs: %q", output.String())
	}
}

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
			fmt.Fprintf(w, `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>%s/a</loc></url></urlset>`, serverURL(t, r))
		case "/b.xml":
			if count == 1 {
				w.WriteHeader(599)
				fmt.Fprint(w, "retry me")
				return
			}
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprintf(w, `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>%s/b</loc></url></urlset>`, serverURL(t, r))
		case "/c.xml":
			if count == 1 {
				w.WriteHeader(599)
				fmt.Fprint(w, "retry me")
				return
			}
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprintf(w, `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>%s/c</loc></url></urlset>`, serverURL(t, r))
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
			server.URL + "/a",
			server.URL + "/b",
			server.URL + "/c",
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
			fmt.Fprintf(w, `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>%s/a</loc></url></urlset>`, serverURL(t, r))
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
			fmt.Fprintf(w, `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>%s/fallback</loc></url></urlset>`, serverURL(t, r))
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

		expected := []string{server.URL + "/fallback"}
		if !slices.Equal(urls, expected) {
			t.Fatalf("unexpected URLs: got %v want %v", urls, expected)
		}
	})

	mu.Lock()
	defer mu.Unlock()

	if requests[sitemapFetchProfiles[0].userAgent] != 1 {
		t.Fatalf("expected one request with scanner profile, got %d", requests[sitemapFetchProfiles[0].userAgent])
	}
	if requests[sitemapFetchProfiles[1].userAgent] != 2 {
		t.Fatalf("expected two requests with browser fallback profile (sitemap fetch + URL eligibility check), got %d", requests[sitemapFetchProfiles[1].userAgent])
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

func TestDiscoverFetchesRepeatedAndCyclicSitemapsOnlyOnce(t *testing.T) {
	var indexRequests atomic.Int32
	var childRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/index.xml":
			indexRequests.Add(1)
			fmt.Fprintf(w, `<sitemapindex>
				<sitemap><loc>%s/index.xml</loc></sitemap>
				<sitemap><loc>%s/child.xml</loc></sitemap>
				<sitemap><loc>%s/child.xml</loc></sitemap>
			</sitemapindex>`, serverURL(t, r), serverURL(t, r), serverURL(t, r))
		case "/child.xml":
			childRequests.Add(1)
			fmt.Fprintf(w, `<urlset><url><loc>%s/page</loc></url></urlset>`, serverURL(t, r))
		case "/page":
			fmt.Fprint(w, "ok")
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
		if want := []string{server.URL + "/page"}; !slices.Equal(urls, want) {
			t.Fatalf("unexpected URLs: got %v want %v", urls, want)
		}
	})
	if got := indexRequests.Load(); got != 1 {
		t.Fatalf("index fetched %d times, want once", got)
	}
	if got := childRequests.Load(); got != 1 {
		t.Fatalf("repeated child fetched %d times, want once", got)
	}
}

func TestDiscoverStopsAtAggregateRequestBudget(t *testing.T) {
	var secondRequests atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/index.xml":
			return testResponse(r, `<sitemapindex>
				<sitemap><loc>https://example.invalid/first.xml</loc></sitemap>
				<sitemap><loc>https://example.invalid/second.xml</loc></sitemap>
			</sitemapindex>`), nil
		case "/first.xml":
			return testResponse(r, `<urlset><url><loc>https://example.invalid/page</loc></url></urlset>`), nil
		case "/second.xml":
			secondRequests.Add(1)
			return testResponse(r, `<urlset><url><loc>https://example.invalid/page-2</loc></url></urlset>`), nil
		default:
			return nil, fmt.Errorf("unexpected request for %s", r.URL.Path)
		}
	})}
	withTestHTTPClient(t, client, func() {
		d, err := newDiscovery("https://example.invalid/index.xml")
		if err != nil {
			t.Fatal(err)
		}
		d.requestLimit = 2
		seen := make(map[string]bool)
		var urls []string
		err = d.discoverRecursive(context.Background(), "https://example.invalid/index.xml", seen, &urls, 0)
		if !errors.Is(err, errDiscoveryBudget) {
			t.Fatalf("expected request budget error, got %v", err)
		}
	})
	if got := secondRequests.Load(); got != 0 {
		t.Fatalf("second child fetched %d times after request budget, want zero", got)
	}
}

func TestDiscoverStopsAtAggregateByteAndPageBudgets(t *testing.T) {
	const root = "https://example.invalid/index.xml"
	const twoPages = `<urlset><url><loc>https://example.invalid/one</loc></url><url><loc>https://example.invalid/two</loc></url></urlset>`
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return testResponse(r, twoPages), nil
	})}
	withTestHTTPClient(t, client, func() {
		for _, test := range []struct {
			name       string
			byteLimit  int64
			pageLimit  int
			wantBudget bool
		}{
			{name: "bytes exceeded", byteLimit: int64(len(twoPages) - 1), pageLimit: maxDiscoveredURLs, wantBudget: true},
			{name: "pages exceeded", byteLimit: maxSitemapBytes, pageLimit: 1, wantBudget: true},
			{name: "exact limits accepted", byteLimit: int64(len(twoPages)), pageLimit: 2},
		} {
			t.Run(test.name, func(t *testing.T) {
				d, err := newDiscovery(root)
				if err != nil {
					t.Fatal(err)
				}
				d.byteLimit = test.byteLimit
				d.pageLimit = test.pageLimit
				seen := make(map[string]bool)
				var urls []string
				err = d.discoverRecursive(context.Background(), root, seen, &urls, 0)
				if test.wantBudget {
					if !errors.Is(err, errDiscoveryBudget) {
						t.Fatalf("expected budget error, got %v", err)
					}
				} else if err != nil || len(urls) != 2 {
					t.Fatalf("expected both pages at exact limits, got URLs=%v error=%v", urls, err)
				}
			})
		}
	})
}

func TestDiscoverCountsBytesAcrossNestedSitemaps(t *testing.T) {
	const root = "https://example.invalid/index.xml"
	const index = `<sitemapindex><sitemap><loc>https://example.invalid/first.xml</loc></sitemap><sitemap><loc>https://example.invalid/second.xml</loc></sitemap></sitemapindex>`
	const first = `<urlset><url><loc>https://example.invalid/one</loc></url></urlset>`
	const second = `<urlset><url><loc>https://example.invalid/two</loc></url></urlset>`
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/index.xml":
			return testResponse(r, index), nil
		case "/first.xml":
			return testResponse(r, first), nil
		case "/second.xml":
			return testResponse(r, second), nil
		default:
			return nil, fmt.Errorf("unexpected request for %s", r.URL.Path)
		}
	})}
	withTestHTTPClient(t, client, func() {
		for _, test := range []struct {
			name       string
			byteLimit  int64
			wantBudget bool
		}{
			{name: "one byte over", byteLimit: int64(len(index) + len(first) + len(second) - 1), wantBudget: true},
			{name: "exact total accepted", byteLimit: int64(len(index) + len(first) + len(second))},
		} {
			t.Run(test.name, func(t *testing.T) {
				d, err := newDiscovery(root)
				if err != nil {
					t.Fatal(err)
				}
				d.byteLimit = test.byteLimit
				seen := make(map[string]bool)
				var urls []string
				err = d.discoverRecursive(context.Background(), root, seen, &urls, 0)
				if test.wantBudget {
					if !errors.Is(err, errDiscoveryBudget) {
						t.Fatalf("expected cumulative byte budget error, got %v", err)
					}
				} else if err != nil || len(urls) != 2 || d.sitemapBytes != test.byteLimit {
					t.Fatalf("expected two pages and exact byte usage, got URLs=%v bytes=%d error=%v", urls, d.sitemapBytes, err)
				}
			})
		}
	})
}

func TestDiscoverChargesPartialReadBytesBeforeRetry(t *testing.T) {
	const root = "https://example.invalid/index.xml"
	const partial = "abcdef"
	var attempts atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		attempts.Add(1)
		response := testResponse(r, "")
		response.Body = io.NopCloser(&partialErrorReader{data: partial})
		return response, nil
	})}
	withTestHTTPClient(t, client, func() {
		d, err := newDiscovery(root)
		if err != nil {
			t.Fatal(err)
		}
		d.byteLimit = 2*int64(len(partial)) - 1
		_, err = d.fetchURL(context.Background(), root)
		if !errors.Is(err, errDiscoveryBudget) {
			t.Fatalf("expected cumulative byte budget error after partial reads, got %v", err)
		}
		if d.sitemapBytes != int64(2*len(partial)) {
			t.Fatalf("charged %d bytes, want both partial reads charged", d.sitemapBytes)
		}
	})
	if got := attempts.Load(); got != 2 {
		t.Fatalf("made %d attempts, want two before the byte budget stops retries", got)
	}
}

func TestDiscoverRetryAfterPartialReadPreservesSuccessfulResult(t *testing.T) {
	const root = "https://example.invalid/index.xml"
	const partial = "oops"
	const sitemap = `<urlset><url><loc>https://example.invalid/page</loc></url></urlset>`
	var attempts atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if attempts.Add(1) == 1 {
			response := testResponse(r, "")
			response.Body = io.NopCloser(&partialErrorReader{data: partial})
			return response, nil
		}
		return testResponse(r, sitemap), nil
	})}
	withTestHTTPClient(t, client, func() {
		d, err := newDiscovery(root)
		if err != nil {
			t.Fatal(err)
		}
		d.byteLimit = int64(len(partial) + len(sitemap))
		body, err := d.fetchURL(context.Background(), root)
		if err != nil || string(body) != sitemap || d.sitemapBytes != d.byteLimit {
			t.Fatalf("retry result=%q bytes=%d error=%v, want complete sitemap and exact charged bytes", body, d.sitemapBytes, err)
		}
	})
	if got := attempts.Load(); got != 2 {
		t.Fatalf("made %d attempts, want a partial failure followed by one success", got)
	}
}

func TestDiscoverStopsWhenPageRedirectExceedsRequestBudget(t *testing.T) {
	const root = "https://example.invalid/index.xml"
	var finalRequests atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/index.xml":
			return testResponse(r, `<urlset><url><loc>https://example.invalid/redirect</loc></url></urlset>`), nil
		case "/redirect":
			response := testResponse(r, "")
			response.StatusCode = http.StatusFound
			response.Header.Set("Location", "/final")
			return response, nil
		case "/final":
			finalRequests.Add(1)
			return testResponse(r, "ok"), nil
		default:
			return nil, fmt.Errorf("unexpected request for %s", r.URL.Path)
		}
	})}
	withTestHTTPClient(t, client, func() {
		d, err := newDiscovery(root)
		if err != nil {
			t.Fatal(err)
		}
		d.requestLimit = 2 // sitemap + page probe; redirect would be the third request
		seen := make(map[string]bool)
		var urls []string
		if err := d.discoverRecursive(context.Background(), root, seen, &urls, 0); err != nil {
			t.Fatal(err)
		}
		filtered, _, err := d.filterEligibleURLs(context.Background(), urls)
		if !errors.Is(err, errDiscoveryBudget) || filtered != nil {
			t.Fatalf("expected fatal request budget error without partial pages, got pages=%v error=%v", filtered, err)
		}
	})
	if got := finalRequests.Load(); got != 0 {
		t.Fatalf("redirect target fetched %d times after request budget, want zero", got)
	}
}

func TestDiscoverCancellationUnblocksPageQueue(t *testing.T) {
	const root = "https://example.invalid/index.xml"
	allProbesStarted := make(chan struct{})
	var pageCalls atomic.Int32
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/index.xml" {
			var body strings.Builder
			body.WriteString("<urlset>")
			for i := 0; i <= resolveURLWorkerCount; i++ {
				fmt.Fprintf(&body, "<url><loc>https://example.invalid/page-%d</loc></url>", i)
			}
			body.WriteString("</urlset>")
			return testResponse(r, body.String()), nil
		}
		if !strings.HasPrefix(r.URL.Path, "/page-") {
			return nil, fmt.Errorf("unexpected request for %s", r.URL.Path)
		}
		if pageCalls.Add(1) == resolveURLWorkerCount {
			close(allProbesStarted)
		}
		<-r.Context().Done()
		return nil, r.Context().Err()
	})}
	withTestHTTPClient(t, client, func() {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan error, 1)
		go func() {
			_, err := Discover(ctx, root)
			done <- err
		}()

		select {
		case <-allProbesStarted:
		case <-time.After(3 * time.Second):
			t.Fatal("page probes did not all start")
		}
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("expected cancellation, got %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("Discover remained blocked after cancellation")
		}
	})
}

func TestDiscoverFiltersCrossHostRedirectsAndCanonicalizesEligibleRedirects(t *testing.T) {
	var externalRequests atomic.Int32
	external := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		externalRequests.Add(1)
		switch r.URL.Path {
		case "/outside":
			fmt.Fprint(w, "external")
		default:
			http.NotFound(w, r)
		}
	}))
	defer external.Close()

	mainServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sitemap.xml":
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprintf(
				w,
				`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
					<url><loc>%s/keep</loc></url>
					<url><loc>%s/redirect-internal</loc></url>
					<url><loc>%s/final</loc></url>
					<url><loc>%s/redirect-external</loc></url>
				</urlset>`,
				serverURL(t, r),
				serverURL(t, r),
				serverURL(t, r),
				serverURL(t, r),
			)
		case "/redirect-internal":
			http.Redirect(w, r, serverURL(t, r)+"/final", http.StatusMovedPermanently)
		case "/redirect-external":
			http.Redirect(w, r, external.URL+"/outside", http.StatusFound)
		case "/keep", "/final":
			fmt.Fprint(w, "ok")
		default:
			http.NotFound(w, r)
		}
	}))
	defer mainServer.Close()

	withTestHTTPClient(t, mainServer.Client(), func() {
		urls, err := Discover(context.Background(), mainServer.URL+"/sitemap.xml")
		if err != nil {
			t.Fatalf("Discover returned error: %v", err)
		}

		expected := []string{
			mainServer.URL + "/keep",
			mainServer.URL + "/final",
		}
		if !slices.Equal(urls, expected) {
			t.Fatalf("unexpected URLs: got %v want %v", urls, expected)
		}
	})
	if got := externalRequests.Load(); got != 0 {
		t.Fatalf("external redirect target received %d requests, want zero", got)
	}
}

func TestDiscoverRejectsCrossAuthorityRootSitemapRedirect(t *testing.T) {
	var redirectedRequests atomic.Int32
	redirectedHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirectedRequests.Add(1)
		switch r.URL.Path {
		case "/sitemap.xml":
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprintf(
				w,
				`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>%s/page</loc></url></urlset>`,
				serverURL(t, r),
			)
		case "/page":
			fmt.Fprint(w, "ok")
		default:
			http.NotFound(w, r)
		}
	}))
	defer redirectedHost.Close()

	enteredHost := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/sitemap.xml" {
			http.Redirect(w, r, redirectedHost.URL+"/sitemap.xml", http.StatusMovedPermanently)
			return
		}
		http.NotFound(w, r)
	}))
	defer enteredHost.Close()

	withTestHTTPClient(t, enteredHost.Client(), func() {
		_, err := Discover(context.Background(), enteredHost.URL+"/sitemap.xml")
		if err == nil || !strings.Contains(err.Error(), "different authority") {
			t.Fatalf("expected cross-authority redirect error, got %v", err)
		}
	})
	if got := redirectedRequests.Load(); got != 0 {
		t.Fatalf("redirected sitemap host received %d requests, want zero", got)
	}
}

func TestDiscoverRejectsCrossAuthorityNestedSitemapLocBeforeFetch(t *testing.T) {
	var externalRequests atomic.Int32
	external := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		externalRequests.Add(1)
		fmt.Fprint(w, `<urlset><url><loc>http://example.test/page</loc></url></urlset>`)
	}))
	defer external.Close()

	mainServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `<sitemapindex><sitemap><loc>%s/nested.xml</loc></sitemap></sitemapindex>`, external.URL)
	}))
	defer mainServer.Close()

	withTestHTTPClient(t, mainServer.Client(), func() {
		_, err := Discover(context.Background(), mainServer.URL+"/index.xml")
		if err == nil || !strings.Contains(err.Error(), "different authority") {
			t.Fatalf("expected cross-authority nested sitemap error, got %v", err)
		}
	})
	if got := externalRequests.Load(); got != 0 {
		t.Fatalf("external nested sitemap received %d requests, want zero", got)
	}
}

func TestDiscoverRejectsCrossAuthorityNestedSitemapRedirect(t *testing.T) {
	var externalRequests atomic.Int32
	external := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		externalRequests.Add(1)
		fmt.Fprint(w, `<urlset><url><loc>http://example.test/page</loc></url></urlset>`)
	}))
	defer external.Close()

	mainServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/index.xml":
			fmt.Fprintf(w, `<sitemapindex><sitemap><loc>%s/nested.xml</loc></sitemap></sitemapindex>`, serverURL(t, r))
		case "/nested.xml":
			http.Redirect(w, r, external.URL+"/nested.xml", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	defer mainServer.Close()

	withTestHTTPClient(t, mainServer.Client(), func() {
		_, err := Discover(context.Background(), mainServer.URL+"/index.xml")
		if err == nil || !strings.Contains(err.Error(), "different authority") {
			t.Fatalf("expected cross-authority nested redirect error, got %v", err)
		}
	})
	if got := externalRequests.Load(); got != 0 {
		t.Fatalf("external nested redirect target received %d requests, want zero", got)
	}
}

func TestDiscoverSkipsCrossAuthorityPageLocBeforeFetch(t *testing.T) {
	var externalRequests atomic.Int32
	external := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		externalRequests.Add(1)
		fmt.Fprint(w, "external")
	}))
	defer external.Close()

	mainServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sitemap.xml":
			fmt.Fprintf(w, `<urlset><url><loc>%s/page</loc></url><url><loc>%s/keep</loc></url></urlset>`, external.URL, serverURL(t, r))
		case "/keep":
			fmt.Fprint(w, "ok")
		default:
			http.NotFound(w, r)
		}
	}))
	defer mainServer.Close()

	withTestHTTPClient(t, mainServer.Client(), func() {
		urls, err := Discover(context.Background(), mainServer.URL+"/sitemap.xml")
		if err != nil {
			t.Fatalf("Discover returned error: %v", err)
		}
		if want := []string{mainServer.URL + "/keep"}; !slices.Equal(urls, want) {
			t.Fatalf("unexpected URLs: got %v want %v", urls, want)
		}
	})
	if got := externalRequests.Load(); got != 0 {
		t.Fatalf("external page loc received %d requests, want zero", got)
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

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func testResponse(r *http.Request, body string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    r,
		Header:     make(http.Header),
	}
}

type partialErrorReader struct {
	data string
}

func (r *partialErrorReader) Read(p []byte) (int, error) {
	n := copy(p, r.data)
	return n, io.ErrUnexpectedEOF
}
