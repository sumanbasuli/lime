package linkchecker

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"github.com/sumanbasuli/lime/shopkeeper/internal/rootdns"
)

func TestNormalizePreservesQueryAndEscapedPaths(t *testing.T) {
	tests := map[string]string{
		"HTTP://EXAMPLE.COM:80":                          "http://example.com/",
		"https://Example.COM.:443/a%2Fb?q=1&q=2#section": "https://example.com/a%2Fb?q=1&q=2",
		"http://[::1]:8080":                              "http://[::1]:8080/",
	}
	for raw, want := range tests {
		got, err := Normalize(raw)
		if err != nil || got != want {
			t.Fatalf("Normalize(%q)=%q,%v want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{"/relative", "ftp://example.com/", "http://user:secret@example.com", "http:///missing", "http://example.com:999999/", "http://example.com/%zz"} {
		if _, err := Normalize(raw); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
}

func TestInvalidRelativeRedirectErrorDoesNotSaveQueryToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/bad-redirect" {
			w.Header().Set("Location", "/invalid%ZZ?token=QUERY_TOKEN_CANARY")
			w.WriteHeader(http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = fmt.Fprint(w, `<a href="/bad-redirect">Bad redirect</a>`)
	}))
	defer server.Close()
	job, results, err := New().Run(context.Background(), models.LinkCheck{URL: server.URL, CheckType: "single", MaxPages: 1, Status: "running"}, nil)
	if err != nil || job.PagesChecked != 1 {
		t.Fatalf("job=%+v err=%v", job, err)
	}
	result := resultMap(results)["/bad-redirect"]
	if result.Status != "error" || result.ErrorKind == nil || *result.ErrorKind != "network" || result.Error == nil ||
		*result.Error != errInvalidRedirectURL.Error() || strings.Contains(*result.Error, "QUERY_TOKEN_CANARY") {
		t.Fatalf("saved redirect result = %+v", result)
	}
	public := models.PublicLinkResult(result)
	if public.Error == nil || *public.Error != errInvalidRedirectURL.Error() || strings.Contains(*public.Error, "QUERY_TOKEN_CANARY") {
		t.Fatalf("public redirect error = %v", public.Error)
	}
}

func TestPublicIPExcludesSpecialAndPrivateNetworks(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.2.1", "198.18.0.1", "240.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2001:db8::1", "2001::a00:1", "2002:0a00:0001::1", "2001:2::1", "3fff::1"} {
		if publicIP(net.ParseIP(ip)) {
			t.Errorf("allowed non-public %s", ip)
		}
	}
	for _, ip := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"} {
		if !publicIP(net.ParseIP(ip)) {
			t.Errorf("blocked public %s", ip)
		}
	}
}

func TestExtractResolvesBaseAndRetainsDuplicateReferences(t *testing.T) {
	root, _ := url.Parse("https://example.com/")
	items, truncated, err := extract(context.Background(), []byte(`<html><head><base href="/assets/"></head><body>
	<a href="../page?q=one#first">Same</a><a href="../page?q=one#second">Same</a>
	<a href="mailto:user@example.com">Email</a><a href="#local">Local</a><a href="javascript:void(0)">Script</a>
	<img src="photo.png" srcset="small.png 1x, large.png 2x"><video poster="poster.jpg" src="movie.mp4"></video>
	<form action="/submit"></form><a href="//external.example/document.pdf">PDF</a></body></html>`), "https://example.com/start", root)
	if err != nil {
		t.Fatal(err)
	}
	if truncated {
		t.Fatal("ordinary base references were truncated")
	}
	if len(items) != 8 {
		t.Fatalf("extracted %d refs: %#v", len(items), items)
	}
	if items[0].target != "https://example.com/page?q=one" || items[1].target != items[0].target || !items[0].crawl {
		t.Fatal("base/query/fragment normalization failed")
	}
	if items[2].target != "https://example.com/assets/photo.png" || items[2].crawl {
		t.Fatal("asset resolution/crawl isolation failed")
	}
	if items[7].crawl {
		t.Fatal("external document was scheduled for crawl")
	}
}

func TestExtractSkipsOnlyConnectionHintLinkRelations(t *testing.T) {
	root, _ := url.Parse("https://example.test/")
	for _, tc := range []struct {
		name, element, rel string
		want               int
	}{
		{"preconnect", "link", "preconnect", 0},
		{"dns hint", "link", "dns-prefetch", 0},
		{"case and ASCII whitespace", "link", "\t PrEcOnNeCt\r\nDNS-PREFETCH\f", 0},
		{"duplicate hints", "link", "preconnect preconnect", 0},
		{"empty relation", "link", "", 1},
		{"stylesheet with hint", "link", "preconnect stylesheet", 1},
		{"preload with hint", "link", "dns-prefetch preload", 1},
		{"canonical with hint", "link", "canonical preconnect", 1},
		{"unknown relation with hint", "link", "preconnect custom", 1},
		{"non-ASCII whitespace is not a separator", "link", "preconnect\u00a0dns-prefetch", 1},
		{"anchor retains href", "a", "preconnect", 1},
		{"area retains href", "area", "dns-prefetch", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := fmt.Sprintf(`<%s rel="%s" href="/target">`, tc.element, tc.rel)
			items, truncated, err := extract(context.Background(), []byte(body), root.String(), root)
			if err != nil || truncated || len(items) != tc.want {
				t.Fatalf("items=%+v truncated=%v err=%v", items, truncated, err)
			}
			if len(items) > 0 && items[0].target != "https://example.test/target" {
				t.Fatalf("functional destination changed: %+v", items[0])
			}
		})
	}
}

func TestSingleDoesNotRequestConnectionHints(t *testing.T) {
	var mu sync.Mutex
	calls := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls[r.URL.Path]++
		mu.Unlock()
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, `<link rel="preconnect" href="/hint-connect"><link rel="dns-prefetch" href="/hint-dns"><link rel="stylesheet preconnect" href="/style.css"><link rel="preload" href="/script.js">`)
		case "/style.css", "/script.js":
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	job, items, err := New().Run(context.Background(), models.LinkCheck{URL: server.URL, CheckType: "single", MaxPages: 1, Status: "running"}, nil)
	if err != nil || job.Status != "completed" || job.Truncated {
		t.Fatalf("job=%+v err=%v", job, err)
	}
	results := resultMap(items)
	mu.Lock()
	defer mu.Unlock()
	for _, hint := range []string{"/hint-connect", "/hint-dns"} {
		if _, exists := results[hint]; exists || calls[hint] != 0 {
			t.Fatalf("connection hint was requested or published: %s calls=%d", hint, calls[hint])
		}
	}
	for _, resource := range []string{"/style.css", "/script.js"} {
		if results[resource].Status != "healthy" || calls[resource] == 0 {
			t.Fatalf("resource was not checked: %s result=%+v calls=%d", resource, results[resource], calls[resource])
		}
	}
}

func TestSrcsetDataURLsDoNotInventHTTPReferences(t *testing.T) {
	root, _ := url.Parse("https://example.test/")
	items, truncated, err := extract(context.Background(), []byte(`<img srcset="data:image/png;base64,AAA 1x, /real.png 2x"><img srcset="one.png, two.png 2x">`), root.String(), root)
	if err != nil {
		t.Fatal(err)
	}
	if truncated {
		t.Fatal("ordinary srcset references were truncated")
	}
	if len(items) != 3 || items[0].target != "https://example.test/real.png" || items[1].target != "https://example.test/one.png" || items[2].target != "https://example.test/two.png" {
		t.Fatalf("srcset=%+v", items)
	}
}

func TestExtractNestedObjectsBoundTextWorkAndRetainEarlierReferences(t *testing.T) {
	root, _ := url.Parse("https://example.test/")
	body := `<a href="/normal"><b>Normal label</b></a>` +
		strings.Repeat(`<object data="/same">`, 450) +
		strings.Repeat("x", 256<<10) +
		strings.Repeat(`</object>`, 450)
	if len(body) > MaxHTMLBytes {
		t.Fatal("fixture exceeds source body cap")
	}
	items, truncated, err := extract(context.Background(), []byte(body), root.String(), root)
	if err != nil {
		t.Fatal(err)
	}
	if !truncated || len(items) < 2 || len(items) >= 451 {
		t.Fatalf("nested text work was not bounded: refs=%d truncated=%v", len(items), truncated)
	}
	if items[0].target != "https://example.test/normal" || items[0].source.Text != "Normal label" {
		t.Fatalf("ordinary reference lost: %+v", items[0])
	}
	if len(items[1].source.Text) > 256 {
		t.Fatalf("source text exceeded preview cap: %d", len(items[1].source.Text))
	}
}

func TestExtractOversizedBaseSkipsDependentReferences(t *testing.T) {
	root, _ := url.Parse("https://example.test/")
	longPage := root.String() + strings.Repeat("p", maxURLBytes-len(root.String())-1) + "/"
	for _, tc := range []struct {
		name    string
		pageURL string
		base    string
	}{
		{"oversized attribute", root.String(), "https://other.example/" + strings.Repeat("x", maxURLBytes) + "/"},
		{"oversized resolved base", longPage, "child/"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := `<base href="` + tc.base + `">` +
				`<a href="/root-relative">Root relative</a>` +
				`<a href="child">Path relative</a>` +
				`<a href="//third.example/protocol-relative">Protocol relative</a>` +
				`<a href="https://example.test/absolute">Absolute</a>`
			items, truncated, err := extract(context.Background(), []byte(body), tc.pageURL, root)
			if err != nil {
				t.Fatal(err)
			}
			if !truncated || len(items) != 1 || items[0].target != "https://example.test/absolute" || items[0].source.Text != "Absolute" {
				t.Fatalf("oversized base was reinterpreted: refs=%+v truncated=%v", items, truncated)
			}
		})
	}
}

func TestExtractCountsOversizedResolvedURLsTowardWorkBudget(t *testing.T) {
	root, _ := url.Parse("https://example.test/")
	base := root.String() + strings.Repeat("p", maxURLBytes-len(root.String())-1) + "/"
	if len(base) != maxURLBytes {
		t.Fatal("fixture base must reach the URL limit")
	}
	body := `<base href="` + base + `">` +
		`<a href="https://example.test/early">Early</a>` +
		strings.Repeat(`<a href="x">Rejected</a>`, 5000) +
		`<a href="https://example.test/late">Late</a>`
	items, truncated, err := extract(context.Background(), []byte(body), root.String(), root)
	if err != nil {
		t.Fatal(err)
	}
	if !truncated || len(items) != 1 || items[0].target != "https://example.test/early" {
		t.Fatalf("oversized resolved URL work was not bounded: refs=%+v truncated=%v", items, truncated)
	}
}

func TestExtractCandidateAndDOMBudgetsRetainEarlierReferences(t *testing.T) {
	root, _ := url.Parse("https://example.test/")
	for _, tc := range []struct {
		name string
		body string
	}{
		{"rejected candidates", `<a href="https://example.test/early">Early</a>` + strings.Repeat(`<a href="mailto:x">Bad</a>`, maxExtractCandidates+1) + `<a href="https://example.test/late">Late</a>`},
		{"DOM nodes", `<a href="/early">Early</a>` + strings.Repeat(`<div></div>`, maxExtractNodes+1) + `<a href="https://example.test/late">Late</a>`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if len(tc.body) > MaxHTMLBytes {
				t.Fatal("fixture exceeds source body cap")
			}
			items, truncated, err := extract(context.Background(), []byte(tc.body), root.String(), root)
			if err != nil {
				t.Fatal(err)
			}
			if !truncated || len(items) != 1 || items[0].target != "https://example.test/early" {
				t.Fatalf("work budget did not retain only the early reference: refs=%+v truncated=%v", items, truncated)
			}
		})
	}
}

type cancelAfterChecksContext struct {
	context.Context
	cancel    context.CancelFunc
	remaining int
}

func (c *cancelAfterChecksContext) Err() error {
	c.remaining--
	if c.remaining == 0 {
		c.cancel()
	}
	return c.Context.Err()
}

func TestExtractHonorsCancellationDuringTraversal(t *testing.T) {
	root, _ := url.Parse("https://example.test/")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	probe := &cancelAfterChecksContext{Context: ctx, cancel: cancel, remaining: 20}
	body := []byte(strings.Repeat(`<div></div>`, 1000))
	_, _, err := extract(probe, body, root.String(), root)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("extraction ignored cancellation: %v", err)
	}
}

func resultMap(items []models.LinkResult) map[string]models.LinkResult {
	out := map[string]models.LinkResult{}
	for _, item := range items {
		u, _ := url.Parse(item.TargetURL)
		out[u.RequestURI()] = item
	}
	return out
}

func TestDeltaPublicationWritesOnlyChangedResultsAndRetriesFailedSink(t *testing.T) {
	const count = 200
	checker := New()
	r, err := checker.newRun(models.LinkCheck{URL: "https://example.test/", CheckType: "crawl", MaxPages: MaxPages, Status: "running"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer r.client.CloseIdleConnections()
	publications, written, largest := 0, 0, 0
	failNext := false
	r.deltaSink = func(_ models.LinkCheck, changed []models.LinkResult) error {
		if failNext {
			failNext = false
			return errors.New("temporary persistence failure")
		}
		publications++
		written += len(changed)
		if len(changed) > largest {
			largest = len(changed)
		}
		return nil
	}
	for i := 0; i < count; i++ {
		url := fmt.Sprintf("https://example.test/page-%03d", i)
		if r.add(url, models.LinkSource{PageURL: r.root.String(), Element: "a", Attribute: "href", Text: "Page"}) == nil {
			t.Fatal("ordinary result rejected")
		}
		if err := r.publish(); err != nil {
			t.Fatal(err)
		}
	}
	if publications != count || written != count || largest != 1 {
		t.Fatalf("progress rewrote accumulated results: publications=%d rows=%d largest=%d", publications, written, largest)
	}
	// A counter-only publication must not resubmit old results.
	if err := r.publish(); err != nil || written != count {
		t.Fatalf("counter-only publication rewrote results: rows=%d err=%v", written, err)
	}
	target := "https://example.test/page-000"
	result := r.add(target, models.LinkSource{PageURL: "https://example.test/other", Element: "a", Attribute: "href", Text: "Again"})
	if result == nil {
		t.Fatal("existing target rejected")
	}
	failNext = true
	if err := r.publish(); err == nil {
		t.Fatal("failed sink was accepted")
	}
	if err := r.publish(); err != nil || written != count+1 || result.OccurrenceCount != 2 {
		t.Fatalf("changed sources were not retried: rows=%d result=%+v err=%v", written, result, err)
	}
	response := &http.Response{StatusCode: http.StatusNotFound, Request: &http.Request{URL: r.root}}
	r.outcome(result, response, 0, nil)
	if err := r.publish(); err != nil || written != count+2 || result.Status != "broken" {
		t.Fatalf("changed outcome was not published: rows=%d result=%+v err=%v", written, result, err)
	}
}

func TestLegacyFullSnapshotSinkStillReceivesCompleteResults(t *testing.T) {
	checker := New()
	lengths := []int{}
	r, err := checker.newRun(models.LinkCheck{URL: "https://example.test/", Status: "running"}, func(_ models.LinkCheck, items []models.LinkResult) error {
		lengths = append(lengths, len(items))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer r.client.CloseIdleConnections()
	r.add("https://example.test/one", models.LinkSource{PageURL: r.root.String(), Element: "a", Attribute: "href"})
	if err := r.publish(); err != nil {
		t.Fatal(err)
	}
	r.add("https://example.test/two", models.LinkSource{PageURL: r.root.String(), Element: "a", Attribute: "href"})
	if err := r.publish(); err != nil {
		t.Fatal(err)
	}
	if len(lengths) != 2 || lengths[0] != 1 || lengths[1] != 2 {
		t.Fatalf("legacy sink lost full snapshots: %v", lengths)
	}
}

func TestCrawlDeltaPublicationsBoundRowsPassedToPersistence(t *testing.T) {
	const pages = 20
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		var index int
		if _, err := fmt.Sscanf(request.URL.Path, "/page-%d", &index); err != nil || index < 0 || index >= pages {
			http.NotFound(w, request)
			return
		}
		if index+1 < pages {
			fmt.Fprintf(w, `<a href="/page-%d">Next</a>`, index+1)
		}
	}))
	defer server.Close()
	writes, publications := 0, 0
	job, final, err := New().RunObservedDelta(context.Background(), models.LinkCheck{
		URL: server.URL + "/page-0", CheckType: "crawl", MaxPages: pages, Status: "running",
	}, func(_ models.LinkCheck, changed []models.LinkResult) error {
		publications++
		writes += len(changed)
		return nil
	}, nil)
	if err != nil || job.Status != "completed" || job.PagesChecked != pages || len(final) != pages {
		t.Fatalf("crawl result: job=%+v results=%d err=%v", job, len(final), err)
	}
	if publications < pages || writes > pages*3 {
		t.Fatalf("crawl sent accumulated rows instead of changed rows: publications=%d writes=%d", publications, writes)
	}
}

func TestSingleChecksStatusesRedirectsFallbackAndSources(t *testing.T) {
	var mu sync.Mutex
	calls := map[string][]string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls[r.URL.Path] = append(calls[r.URL.Path], r.Method)
		mu.Unlock()
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, `<a href="/ok#one">Good</a><a href="/ok#two">Duplicate</a><a href="/missing">Missing</a><a href="/redirect">Moved</a><a href="/fallback">Fallback</a><a href="/loop">Loop</a><a href="/denied">Private</a><a href="/rate">Rate</a><a href="/report.pdf">Document</a><img src="/image.png"><a href="/query?a=1">One</a><a href="/query?a=2">Two</a>`)
		case "/missing":
			http.NotFound(w, r)
		case "/redirect":
			http.Redirect(w, r, "/ok", 302)
		case "/loop":
			http.Redirect(w, r, "/loop", 301)
		case "/fallback":
			if r.Method == http.MethodHead {
				w.WriteHeader(405)
			} else {
				w.WriteHeader(201)
			}
		case "/denied":
			w.WriteHeader(403)
		case "/rate":
			w.WriteHeader(429)
		default:
			w.WriteHeader(200)
		}
	}))
	defer server.Close()
	job, items, err := New().Run(context.Background(), models.LinkCheck{URL: server.URL, CheckType: "single", MaxPages: 1, Status: "running"}, nil)
	if err != nil || job.Status != "completed" || job.PagesChecked != 1 || job.PagesFailed != 0 || job.Truncated {
		t.Fatalf("job=%+v err=%v", job, err)
	}
	results := resultMap(items)
	for target, want := range map[string]string{"/ok": "healthy", "/missing": "broken", "/redirect": "redirected", "/fallback": "healthy", "/loop": "error", "/denied": "error", "/rate": "error"} {
		if results[target].Status != want {
			t.Errorf("%s=%+v want %s", target, results[target], want)
		}
	}
	if results["/ok"].OccurrenceCount != 2 || len(results["/ok"].Sources) != 2 {
		t.Fatal("duplicates did not retain source references")
	}
	if results["/redirect"].RedirectCount != 1 || results["/redirect"].FinalURL == nil || *results["/redirect"].FinalURL != server.URL+"/ok" {
		t.Fatal("redirect metadata missing")
	}
	if results["/loop"].ErrorKind == nil || *results["/loop"].ErrorKind != "redirect_loop" {
		t.Fatal("redirect loop not classified")
	}
	if results["/report.pdf"].LinkType != "document" || results["/image.png"].LinkType != "media" {
		t.Fatal("target types incorrect")
	}
	if _, ok := results["/query?a=1"]; !ok {
		t.Fatal("first query lost")
	}
	if _, ok := results["/query?a=2"]; !ok {
		t.Fatal("distinct query deduplicated")
	}
	mu.Lock()
	defer mu.Unlock()
	if got := strings.Join(calls["/fallback"], ","); got != "HEAD,GET" {
		t.Errorf("fallback methods=%s", got)
	}
	if got := strings.Join(calls["/ok"], ","); strings.Contains(got, "GET") {
		t.Errorf("single mode crawled target: %s", got)
	}
}

func TestCrawlLimitsPagesAndDoesNotCrawlAssets(t *testing.T) {
	var mu sync.Mutex
	gets := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if r.Method == "GET" {
			gets[r.URL.Path]++
		}
		mu.Unlock()
		w.Header().Set("Content-Type", "text/html")
		switch r.URL.Path {
		case "/":
			fmt.Fprint(w, `<a href="/second">Next</a><img src="/image.png">`)
		case "/second":
			fmt.Fprint(w, `<a href="/third">Third</a>`)
		case "/third":
			fmt.Fprint(w, `<a href="/">Home</a>`)
		}
	}))
	defer server.Close()
	job, items, err := New().Run(context.Background(), models.LinkCheck{URL: server.URL, CheckType: "crawl", MaxPages: 2, Status: "running"}, nil)
	if err != nil || job.PagesChecked != 2 || !job.Truncated {
		t.Fatalf("crawl job=%+v err=%v", job, err)
	}
	if resultMap(items)["/third"].Status != "healthy" {
		t.Fatal("uncrawled discovered link wasn't checked")
	}
	mu.Lock()
	defer mu.Unlock()
	if gets["/image.png"] != 0 || gets["/third"] != 0 {
		t.Fatalf("asset/page cap ignored: %v", gets)
	}
}

func TestFailedSourceIsNotSuccessfulEmptyJob(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) }))
	defer server.Close()
	job, items, err := New().Run(context.Background(), models.LinkCheck{URL: server.URL, CheckType: "single", MaxPages: 1, Status: "running"}, nil)
	if err != nil || job.Status != "failed" || job.PagesFailed != 1 || job.Error == nil || !job.Truncated || len(items) != 1 || items[0].Status != "broken" {
		t.Fatalf("failed source=%+v / %+v / %v", job, items, err)
	}
}

func TestTimeoutAndCancellationInterruptRequests(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Second):
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, "<html></html>")
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	job, items, err := New().Run(ctx, models.LinkCheck{URL: server.URL, CheckType: "single", MaxPages: 1, Status: "running"}, nil)
	if err != nil || job.Status != "failed" || job.Summary.Timeout != 1 || items[0].ErrorKind == nil || *items[0].ErrorKind != "timeout" {
		t.Fatalf("timeout=%+v / %+v / %v", job, items, err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	time.AfterFunc(30*time.Millisecond, cancel)
	_, _, err = New().Run(ctx, models.LinkCheck{URL: server.URL, CheckType: "single", MaxPages: 1, Status: "running"}, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel did not stop work: %v", err)
	}
}

type resolverFunc func(context.Context, string) ([]net.IPAddr, error)

func (f resolverFunc) LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error) {
	return f(ctx, host)
}

func TestExternalPrivateOriginAndUnsafeRedirectAreBlocked(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprintf(w, `<a href="http://localhost:%s/private">Other origin</a><a href="/unsafe">Unsafe redirect</a>`, strings.Split(server.Listener.Addr().String(), ":")[1])
			return
		}
		if r.URL.Path == "/unsafe" {
			http.Redirect(w, r, "http://169.254.169.254/latest/meta-data", 302)
			return
		}
		t.Error("private external request reached fixture")
	}))
	defer server.Close()
	job, items, err := New().Run(context.Background(), models.LinkCheck{URL: server.URL, CheckType: "single", MaxPages: 1, Status: "running"}, nil)
	if err != nil || job.Summary.Blocked != 2 {
		t.Fatalf("networkpolicy=%+v / %+v / %v", job, items, err)
	}
}

func TestExternalDNSRebindingAndMixedAnswersNeverDial(t *testing.T) {
	for _, mixed := range []bool{false, true} {
		t.Run(fmt.Sprint(mixed), func(t *testing.T) {
			calls := 0
			dialed := false
			c := New()
			c.Resolver = resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
				calls++
				ips := []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}
				if mixed || calls > 1 {
					ips = append(ips, net.IPAddr{IP: net.ParseIP("127.0.0.1")})
				}
				return ips, nil
			})
			c.DialContext = func(context.Context, string, string) (net.Conn, error) {
				dialed = true
				return nil, errors.New("should not dial")
			}
			r, err := c.newRun(models.LinkCheck{URL: "http://root.example/"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer r.client.CloseIdleConnections()
			_, _, err = r.request(context.Background(), "http://external.example/", "HEAD")
			if !errors.Is(err, errBlocked) || dialed {
				t.Fatalf("rebind/mixed allowed: %v dialed=%v calls=%d", err, dialed, calls)
			}
		})
	}
}

func TestPublicRootDNSRebindingNeverDialsPrivate(t *testing.T) {
	for _, mode := range []string{"extracted link", "same-origin redirect"} {
		t.Run(mode, func(t *testing.T) {
			var phase atomic.Int32
			var privateDialed atomic.Bool
			public := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/" {
					t.Errorf("unexpected public request %s", r.URL.Path)
					return
				}
				w.Header().Set("Connection", "close") // Force a new DNS lookup for /next.
				phase.Store(1)
				if mode == "same-origin redirect" {
					http.Redirect(w, r, "/next", http.StatusFound)
					return
				}
				w.Header().Set("Content-Type", "text/html")
				fmt.Fprint(w, `<a href="/next">Next</a>`)
			}))
			defer public.Close()

			c := New()
			c.Resolver = resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
				if phase.Load() == 0 {
					return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
				}
				return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
			})
			c.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
				if address == "127.0.0.1:80" {
					privateDialed.Store(true)
					return nil, errors.New("private address was dialed")
				}
				if address != "8.8.8.8:80" {
					return nil, fmt.Errorf("unexpected address %s", address)
				}
				return (&net.Dialer{}).DialContext(ctx, network, public.Listener.Addr().String())
			}

			if mode == "same-origin redirect" {
				r, err := c.newRun(models.LinkCheck{URL: "http://root.example/"}, nil)
				if err != nil {
					t.Fatal(err)
				}
				defer r.client.Transport.(*http.Transport).CloseIdleConnections()
				_, redirects, err := r.request(context.Background(), "http://root.example/", http.MethodGet)
				if !errors.Is(err, errBlocked) || redirects != 1 || privateDialed.Load() {
					t.Fatalf("redirect rebind: err=%v redirects=%d privateDialed=%v", err, redirects, privateDialed.Load())
				}
				return
			}

			job, items, err := c.Run(context.Background(), models.LinkCheck{URL: "http://root.example/", CheckType: "single", MaxPages: 1, Status: "running"}, nil)
			if err != nil || job.Status != "completed" || job.Summary.Blocked != 1 || privateDialed.Load() {
				t.Fatalf("extracted-link rebind: job=%+v items=%+v err=%v privateDialed=%v", job, items, err, privateDialed.Load())
			}
			for _, item := range items {
				if item.TargetURL == "http://root.example/next" && item.Status == "blocked" {
					return
				}
			}
			t.Fatalf("rebinding target was not blocked: %+v", items)
		})
	}
}

func TestPrivateRootLinksAndRedirectsStillWork(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Connection", "close")
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, `<a href="/jump">Jump</a>`)
		case "/jump":
			http.Redirect(w, r, "/done", http.StatusFound)
		case "/done":
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()
	job, items, err := New().Run(context.Background(), models.LinkCheck{URL: server.URL, CheckType: "single", MaxPages: 1, Status: "running"}, nil)
	if err != nil || job.Status != "completed" || job.Summary.Redirected != 1 || job.Summary.Blocked != 0 {
		t.Fatalf("private root failed: job=%+v items=%+v err=%v", job, items, err)
	}
	for _, item := range items {
		if item.TargetURL == server.URL+"/jump" && item.Status == "redirected" {
			return
		}
	}
	t.Fatalf("private redirect was not checked: %+v", items)
}

func TestRootInitialMixedAnswersBlockedBeforeDial(t *testing.T) {
	c := New()
	c.Resolver = resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}, {IP: net.ParseIP("127.0.0.1")}}, nil
	})
	var dialed atomic.Bool
	c.DialContext = func(context.Context, string, string) (net.Conn, error) {
		dialed.Store(true)
		return nil, errors.New("mixed address was dialed")
	}
	r, err := c.newRun(models.LinkCheck{URL: "http://root.example/"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer r.client.Transport.(*http.Transport).CloseIdleConnections()
	_, _, err = r.request(context.Background(), "http://root.example/", http.MethodHead)
	if !errors.Is(err, errBlocked) || dialed.Load() {
		t.Fatalf("mixed root answer allowed: err=%v dialed=%v", err, dialed.Load())
	}
}

func TestRootDNSObserverRunsBeforeDialAndFailsClosed(t *testing.T) {
	observerErr := errors.New("observation unavailable")
	dialErr := errors.New("fixture dial stopped")
	cases := []struct {
		name       string
		ips        []string
		rootPublic bool
		observeErr error
		wantEvents string
		wantErr    error
	}{
		{"public", []string{"8.8.8.8"}, false, nil, "observe,dial", dialErr},
		{"observer error", []string{"8.8.8.8"}, false, observerErr, "observe", observerErr},
		{"public parent after claim", []string{"127.0.0.1"}, false, rootdns.ErrBlocked, "observe", errBlocked},
		{"mixed", []string{"8.8.8.8", "127.0.0.1"}, false, nil, "observe", errBlocked},
		{"recovered public root", []string{"127.0.0.1"}, true, nil, "observe", errBlocked},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var events []string
			c := New()
			c.Resolver = resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
				ips := make([]net.IPAddr, 0, len(tc.ips))
				for _, raw := range tc.ips {
					ips = append(ips, net.IPAddr{IP: net.ParseIP(raw)})
				}
				return ips, nil
			})
			c.DialContext = func(context.Context, string, string) (net.Conn, error) {
				events = append(events, "dial")
				return nil, dialErr
			}
			observed := [2]bool{}
			observer := func(_ context.Context, public, nonPublic bool) error {
				events = append(events, "observe")
				observed = [2]bool{public, nonPublic}
				return tc.observeErr
			}
			r, err := c.newRun(models.LinkCheck{URL: "http://root.example/", RootPublic: tc.rootPublic}, nil, observer)
			if err != nil {
				t.Fatal(err)
			}
			defer r.client.CloseIdleConnections()
			_, _, err = r.request(context.Background(), "http://root.example/", http.MethodHead)
			if !errors.Is(err, tc.wantErr) || strings.Join(events, ",") != tc.wantEvents {
				t.Fatalf("err=%v events=%v", err, events)
			}
			if observed != [2]bool{containsIP(tc.ips, "8.8.8.8"), containsIP(tc.ips, "127.0.0.1")} {
				t.Fatalf("observed wrong DNS classes: %v", observed)
			}
		})
	}
}

func TestPrivateRootDialGuardBlocksAfterObservation(t *testing.T) {
	var events []string
	c := New()
	c.Resolver = resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
	})
	c.DialContext = func(context.Context, string, string) (net.Conn, error) {
		events = append(events, "dial")
		return nil, errors.New("private root was dialed")
	}
	job, results, err := c.RunObserved(
		context.Background(),
		models.LinkCheck{URL: "http://root.example/", CheckType: "single", MaxPages: 1, Status: "running"},
		nil,
		func(_ context.Context, public, nonPublic bool) error {
			if public || !nonPublic {
				t.Errorf("wrong root DNS classes: public=%v nonPublic=%v", public, nonPublic)
			}
			events = append(events, "observe")
			return nil
		},
		func(context.Context) (func(), error) {
			// A parent scan can commit a public observation after this job's
			// private answer was recorded but before its TCP dial begins.
			events = append(events, "guard")
			return nil, rootdns.ErrBlocked
		},
	)
	if err != nil || job.Status != "failed" || job.Summary.Blocked != 1 || len(results) != 1 || results[0].Status != "blocked" {
		t.Fatalf("late public observation not blocked: job=%+v results=%+v err=%v", job, results, err)
	}
	if got := strings.Join(events, ","); got != "observe,guard" {
		t.Fatalf("private dial sequence=%s", got)
	}
}

func TestPrivateRootDialGuardCoversFallbackAndEndsBeforeHTTP(t *testing.T) {
	var eventsMu sync.Mutex
	var events []string
	record := func(event string) {
		eventsMu.Lock()
		events = append(events, event)
		eventsMu.Unlock()
	}
	var guarded atomic.Bool
	var served atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if guarded.Load() {
			t.Error("private dial guard was held during HTTP I/O")
		}
		record("http")
		served.Store(true)
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, "<html></html>")
	}))
	defer server.Close()
	c := New()
	c.Resolver = resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}, {IP: net.ParseIP("127.0.0.2")}}, nil
	})
	c.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if !guarded.Load() {
			t.Error("private dial ran without guard")
		}
		switch address {
		case "127.0.0.1:80":
			record("dial1")
			return nil, errors.New("first address unavailable")
		case "127.0.0.2:80":
			record("dial2")
			return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		default:
			return nil, fmt.Errorf("unexpected address %s", address)
		}
	}
	job, _, err := c.RunObserved(
		context.Background(),
		models.LinkCheck{URL: "http://root.example/", CheckType: "single", MaxPages: 1, Status: "running"},
		nil,
		func(context.Context, bool, bool) error { record("observe"); return nil },
		func(context.Context) (func(), error) {
			record("guard")
			guarded.Store(true)
			return func() {
				guarded.Store(false)
				record("release")
			}, nil
		},
	)
	if err != nil || job.Status != "completed" || !served.Load() || guarded.Load() {
		t.Fatalf("private dial guard lifecycle: job=%+v err=%v served=%v guarded=%v", job, err, served.Load(), guarded.Load())
	}
	eventsMu.Lock()
	got := strings.Join(events, ",")
	eventsMu.Unlock()
	if got != "observe,guard,dial1,dial2,release,http" {
		t.Fatalf("private dial sequence=%s", got)
	}
}

func TestPublicRootDoesNotAcquirePrivateDialGuard(t *testing.T) {
	var events []string
	c := New()
	c.Resolver = resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
	})
	c.DialContext = func(context.Context, string, string) (net.Conn, error) {
		events = append(events, "dial")
		return nil, errors.New("fixture dial stopped")
	}
	_, _, err := c.RunObserved(
		context.Background(),
		models.LinkCheck{URL: "http://root.example/", CheckType: "single", MaxPages: 1, Status: "running"},
		nil,
		func(context.Context, bool, bool) error { events = append(events, "observe"); return nil },
		func(context.Context) (func(), error) {
			events = append(events, "guard")
			return nil, errors.New("unexpected private dial guard")
		},
	)
	if err != nil || strings.Join(events, ",") != "observe,dial" {
		t.Fatalf("public root sequence=%v err=%v", events, err)
	}
}

func containsIP(ips []string, want string) bool {
	for _, ip := range ips {
		if ip == want {
			return true
		}
	}
	return false
}

func TestRootCannotReturnToPrivateAfterPublicAnswer(t *testing.T) {
	public := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Connection", "close")
		w.WriteHeader(http.StatusOK)
	}))
	defer public.Close()
	var phase atomic.Int32
	var firstPrivateDialed, laterPrivateDialed atomic.Bool
	c := New()
	c.Resolver = resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		address := "127.0.0.1"
		switch phase.Load() {
		case 1:
			address = "8.8.8.8"
		case 2:
			address = "169.254.169.254"
		}
		return []net.IPAddr{{IP: net.ParseIP(address)}}, nil
	})
	c.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		switch address {
		case "127.0.0.1:80":
			firstPrivateDialed.Store(true)
			return nil, errors.New("initial private connection unavailable")
		case "8.8.8.8:80":
			return (&net.Dialer{}).DialContext(ctx, network, public.Listener.Addr().String())
		case "169.254.169.254:80":
			laterPrivateDialed.Store(true)
			return nil, errors.New("later private address was dialed")
		default:
			return nil, fmt.Errorf("unexpected address %s", address)
		}
	}
	r, err := c.newRun(models.LinkCheck{URL: "http://root.example/"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer r.client.Transport.(*http.Transport).CloseIdleConnections()
	_, _, err = r.request(context.Background(), "http://root.example/first", http.MethodGet)
	if err == nil || errors.Is(err, errBlocked) || !firstPrivateDialed.Load() {
		t.Fatalf("initial private root attempt: err=%v dialed=%v", err, firstPrivateDialed.Load())
	}
	phase.Store(1)
	response, _, err := r.request(context.Background(), "http://root.example/second", http.MethodGet)
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("public root attempt: response=%v err=%v", response, err)
	}
	response.Body.Close()
	phase.Store(2)
	_, _, err = r.request(context.Background(), "http://root.example/third", http.MethodHead)
	if !errors.Is(err, errBlocked) || laterPrivateDialed.Load() {
		t.Fatalf("private return allowed: err=%v dialed=%v", err, laterPrivateDialed.Load())
	}
}

func TestPublicRootMayChangeBetweenPublicAddresses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Connection", "close")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	var phase atomic.Int32
	c := New()
	c.Resolver = resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		if phase.Load() == 0 {
			return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
		}
		return []net.IPAddr{{IP: net.ParseIP("1.1.1.1")}}, nil
	})
	c.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "8.8.8.8:80" && address != "1.1.1.1:80" {
			return nil, fmt.Errorf("unexpected address %s", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	r, err := c.newRun(models.LinkCheck{URL: "http://root.example/"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer r.client.Transport.(*http.Transport).CloseIdleConnections()
	for _, target := range []string{"http://root.example/", "http://root.example/next"} {
		response, _, err := r.request(context.Background(), target, http.MethodHead)
		if err != nil || response.StatusCode != http.StatusOK {
			t.Fatalf("public rotation failed: response=%v err=%v", response, err)
		}
		response.Body.Close()
		phase.Store(1)
	}
}

func TestExternalPublicTargetIsCheckedWithoutCrawling(t *testing.T) {
	var root *httptest.Server
	var externalGets int
	external := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			externalGets++
		}
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<a href="http://169.254.169.254/">Never extract</a>`)
	}))
	defer external.Close()
	root = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<a href="http://external.example/page">External</a>`)
	}))
	defer root.Close()
	c := New()
	originalDial := c.DialContext
	c.Resolver = resolverFunc(func(ctx context.Context, host string) ([]net.IPAddr, error) {
		if host == "external.example" {
			return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
		}
		return net.DefaultResolver.LookupIPAddr(ctx, host)
	})
	c.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address == "8.8.8.8:80" {
			address = external.Listener.Addr().String()
		}
		return originalDial(ctx, network, address)
	}
	job, items, err := c.Run(context.Background(), models.LinkCheck{URL: root.URL, CheckType: "crawl", MaxPages: 5, Status: "running"}, nil)
	if err != nil || job.PagesChecked != 1 || len(items) != 2 || externalGets != 0 {
		t.Fatalf("external crawled: %+v %+v err=%v GETs=%d", job, items, err, externalGets)
	}
}

func TestTargetSourceAndRequestBudgets(t *testing.T) {
	r, err := New().newRun(models.LinkCheck{URL: "https://example.com/"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < MaxLinks+1; i++ {
		r.add(fmt.Sprintf("https://example.com/%d", i), models.LinkSource{PageURL: "https://example.com/", Element: "a"})
	}
	if len(r.results) != MaxLinks || !r.job.Truncated {
		t.Fatal("target cap not applied")
	}
	r.job.Truncated = false
	for i := r.sourceCount; i < MaxSources+1; i++ {
		r.add("https://example.com/0", models.LinkSource{Element: "a"})
	}
	if r.sourceCount != MaxSources || !r.job.Truncated {
		t.Fatal("reference cap not applied")
	}
	r.requests = MaxRequests
	_, _, err = r.request(context.Background(), "https://example.com/", "HEAD")
	if !errors.Is(err, errBudget) {
		t.Fatalf("request cap=%v", err)
	}
}

func TestIntegratedSeedInventoryUsesCapAndNoExtraCrawl(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<a href="/extra">Extra</a>`)
	}))
	defer server.Close()
	job, items, err := New().Run(context.Background(), models.LinkCheck{URL: server.URL, CheckType: "scan", SeedURLs: []string{server.URL + "/a", server.URL + "/b", server.URL + "/c"}, MaxPages: 2, Status: "running"}, nil)
	if err != nil || job.PagesChecked != 2 || !job.Truncated || len(items) != 3 {
		t.Fatalf("seed inventory/cap=%+v /%+v /%v", job, items, err)
	}
}

func TestHTMLBodyLimitIsVisible(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, "<html>"+strings.Repeat(" ", MaxHTMLBytes)+"</html>")
	}))
	defer server.Close()
	job, _, err := New().Run(context.Background(), models.LinkCheck{URL: server.URL, CheckType: "single", MaxPages: 1, Status: "running"}, nil)
	if err != nil || !job.Truncated || job.PagesChecked != 1 {
		t.Fatalf("body limit=%+v %v", job, err)
	}
}

func TestRedirectAliasesDoNotMultiplyFinalDocumentSources(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		switch r.URL.Path {
		case "/":
			fmt.Fprint(w, `<a href="/alias-a">A</a><a href="/alias-b">B</a><a href="/actual">Actual</a>`)
		case "/alias-a", "/alias-b":
			http.Redirect(w, r, "/actual", 302)
		case "/actual":
			fmt.Fprint(w, `<a href="/missing">One missing anchor</a><a href="/duplicate">Repeated</a><a href="/duplicate">Repeated</a>`)
		case "/missing":
			http.NotFound(w, r)
		default:
			fmt.Fprint(w, "<html></html>")
		}
	}))
	defer server.Close()
	_, items, err := New().Run(context.Background(), models.LinkCheck{URL: server.URL, CheckType: "crawl", MaxPages: 10, Status: "running"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	results := resultMap(items)
	// One synthetic source-page record accompanies the genuinely broken anchor
	// because crawl attempts the missing URL, but there is only one /actual ref.
	actualRefs := 0
	for _, source := range results["/missing"].Sources {
		if source.PageURL == server.URL+"/actual" {
			actualRefs++
		}
	}
	if actualRefs != 1 {
		t.Fatalf("aliases multiplied references: %+v", results["/missing"])
	}
	duplicateRefs := 0
	for _, source := range results["/duplicate"].Sources {
		if source.PageURL == server.URL+"/actual" {
			duplicateRefs++
		}
	}
	if duplicateRefs != 2 {
		t.Fatalf("real duplicate anchors lost: %+v", results["/duplicate"])
	}
	if results["/alias-a"].Status != "redirected" || results["/alias-b"].Status != "redirected" {
		t.Fatal("alias redirect results lost")
	}
}
