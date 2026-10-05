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
	"testing"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
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
	items, err := extract([]byte(`<html><head><base href="/assets/"></head><body>
	<a href="../page?q=one#first">Same</a><a href="../page?q=one#second">Same</a>
	<a href="mailto:user@example.com">Email</a><a href="#local">Local</a><a href="javascript:void(0)">Script</a>
	<img src="photo.png" srcset="small.png 1x, large.png 2x"><video poster="poster.jpg" src="movie.mp4"></video>
	<form action="/submit"></form><a href="//external.example/document.pdf">PDF</a></body></html>`), "https://example.com/start", root)
	if err != nil {
		t.Fatal(err)
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

func TestSrcsetDataURLsDoNotInventHTTPReferences(t *testing.T) {
	root, _ := url.Parse("https://example.test/")
	items, err := extract([]byte(`<img srcset="data:image/png;base64,AAA 1x, /real.png 2x"><img srcset="one.png, two.png 2x">`), root.String(), root)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 || items[0].target != "https://example.test/real.png" || items[1].target != "https://example.test/one.png" || items[2].target != "https://example.test/two.png" {
		t.Fatalf("srcset=%+v", items)
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
