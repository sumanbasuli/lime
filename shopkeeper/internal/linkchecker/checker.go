// Package linkchecker checks HTTP links without running accessibility audits or
// browser scripts. Limits bound every job; referenced external sites are never
// crawled, and only the explicitly entered origin may reach private networks.
package linkchecker

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/models"
	"golang.org/x/net/html"
)

const (
	DefaultMaxPages = 100
	MaxPages        = 500
	MaxLinks        = 2000
	MaxSources      = 10000
	MaxRequests     = 5000
	MaxRedirects    = 5
	MaxHTMLBytes    = 2 << 20
	RequestTimeout  = 10 * time.Second
	JobTimeout      = 10 * time.Minute
)

var errBlocked = errors.New("target is outside the entered origin and resolves to a non-public network")
var errBudget = errors.New("HTTP request limit reached")
var errRedirect = errors.New("redirect limit or loop reached")

type Resolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}

// Checker uses an injectable resolver/dialer for deterministic tests. Production
// always resolves, validates, and dials the same IP with no environment proxy.
type Checker struct {
	Resolver    Resolver
	DialContext func(context.Context, string, string) (net.Conn, error)
}

func New() *Checker {
	d := &net.Dialer{Timeout: RequestTimeout}
	return &Checker{Resolver: net.DefaultResolver, DialContext: d.DialContext}
}

func Normalize(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || len(raw) > 8192 {
		return "", errors.New("URL must be an absolute HTTP/HTTPS URL without credentials")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	port := u.Port()
	if port != "" {
		if _, err := net.LookupPort("tcp", port); err != nil {
			return "", errors.New("invalid URL port")
		}
	}
	if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
		port = ""
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	u.Host = host
	if port != "" {
		u.Host = net.JoinHostPort(strings.Trim(host, "[]"), port)
	}
	if u.Path == "" {
		u.Path = "/"
	}
	u.Fragment = ""
	u.RawFragment = ""
	return u.String(), nil
}

func sameOrigin(a, b *url.URL) bool { return a.Scheme == b.Scheme && strings.EqualFold(a.Host, b.Host) }

func publicIP(ip net.IP) bool {
	a, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	a = a.Unmap()
	if !a.IsGlobalUnicast() || a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() {
		return false
	}
	// Exclude translation/tunnelling ranges that can encode a private IPv4
	// destination; only native global IPv6 is considered an external target.
	if a.Is6() && !netip.MustParsePrefix("2000::/3").Contains(a) {
		return false
	}
	for _, cidr := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32", "2001::/23", "2002::/16", "3fff::/20"} {
		if netip.MustParsePrefix(cidr).Contains(a) {
			return false
		}
	}
	return true
}

type run struct {
	checker     *Checker
	job         models.LinkCheck
	root        *url.URL
	client      *http.Client
	requests    int
	results     map[string]*models.LinkResult
	order       []string
	sourceCount int
	sink        func(models.LinkCheck, []models.LinkResult) error
}

func (c *Checker) newRun(job models.LinkCheck, sink func(models.LinkCheck, []models.LinkResult) error) (*run, error) {
	normalized, err := Normalize(job.URL)
	if err != nil {
		return nil, err
	}
	root, _ := url.Parse(normalized)
	r := &run{checker: c, job: job, root: root, results: map[string]*models.LinkResult{}, sink: sink}
	t := &http.Transport{Proxy: nil, MaxIdleConns: 8, MaxIdleConnsPerHost: 2, IdleConnTimeout: 30 * time.Second, TLSHandshakeTimeout: RequestTimeout, ResponseHeaderTimeout: RequestTimeout}
	t.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := c.Resolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		if len(ips) == 0 {
			return nil, errors.New("hostname has no addresses")
		}
		// The request URL is checked before every hop. Dialing validates again and
		// pins the chosen IP, so a rebinding lookup cannot switch to a private IP.
		trusted, _ := ctx.Value(originKey{}).(bool)
		if !trusted {
			for _, ip := range ips {
				if !publicIP(ip.IP) {
					return nil, errBlocked
				}
			}
		}
		var last error
		for _, ip := range ips {
			conn, err := c.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
			if err == nil {
				return conn, nil
			}
			last = err
		}
		return nil, last
	}
	r.client = &http.Client{Transport: t, Timeout: RequestTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return r, nil
}

type originKey struct{}

func (r *run) request(ctx context.Context, raw, method string) (*http.Response, int, error) {
	current := raw
	seen := map[string]bool{}
	redirects := 0
	for {
		if r.requests >= MaxRequests {
			return nil, redirects, errBudget
		}
		normalized, err := Normalize(current)
		if err != nil {
			return nil, redirects, err
		}
		u, _ := url.Parse(normalized)
		if seen[normalized] {
			return nil, redirects, errRedirect
		}
		seen[normalized] = true
		trusted := sameOrigin(r.root, u)
		// Even a reused connection may only be used for a validated URL origin.
		if !trusted {
			ips, err := r.checker.Resolver.LookupIPAddr(ctx, u.Hostname())
			if err != nil {
				return nil, redirects, err
			}
			if len(ips) == 0 {
				return nil, redirects, errors.New("hostname has no addresses")
			}
			for _, ip := range ips {
				if !publicIP(ip.IP) {
					return nil, redirects, errBlocked
				}
			}
		}
		req, err := http.NewRequestWithContext(context.WithValue(ctx, originKey{}, trusted), method, normalized, nil)
		if err != nil {
			return nil, redirects, err
		}
		req.Header.Set("User-Agent", "LIME-LinkChecker/1.0")
		req.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
		r.requests++
		response, err := r.client.Do(req)
		if err != nil {
			return nil, redirects, err
		}
		if response.StatusCode < 300 || response.StatusCode > 399 || response.StatusCode == 304 {
			return response, redirects, nil
		}
		location := response.Header.Get("Location")
		response.Body.Close()
		if location == "" {
			return nil, redirects, errors.New("redirect response has no Location")
		}
		if redirects >= MaxRedirects {
			return nil, redirects, errRedirect
		}
		next, err := u.Parse(location)
		if err != nil {
			return nil, redirects, err
		}
		current = next.String()
		redirects++
	}
}

func uuid() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func pointer[T any](v T) *T { return &v }

func classify(u, root *url.URL, element string) string {
	switch strings.ToLower(path.Ext(u.Path)) {
	case ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".csv", ".txt", ".zip":
		return "document"
	case ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico", ".mp4", ".mp3", ".wav", ".woff", ".woff2", ".css", ".js":
		return "media"
	}
	if element != "a" && element != "area" && element != "page" {
		return "media"
	}
	if sameOrigin(u, root) {
		return "internal"
	}
	return "external"
}

func (r *run) add(raw string, source models.LinkSource) *models.LinkResult {
	normalized, err := Normalize(raw)
	if err != nil {
		return nil
	}
	result := r.results[normalized]
	if result == nil {
		if len(r.results) >= MaxLinks {
			r.job.Truncated = true
			return nil
		}
		u, _ := url.Parse(normalized)
		result = &models.LinkResult{ID: uuid(), TargetURL: normalized, Status: "unchecked", LinkType: classify(u, r.root, source.Element), Sources: []models.LinkSource{}}
		r.results[normalized] = result
		r.order = append(r.order, normalized)
	}
	if r.sourceCount >= MaxSources {
		r.job.Truncated = true
		return result
	}
	result.Sources = append(result.Sources, source)
	result.OccurrenceCount++
	r.sourceCount++
	return result
}

func (r *run) outcome(result *models.LinkResult, response *http.Response, redirects int, err error) {
	result.RedirectCount = redirects
	if err != nil {
		result.Status = "error"
		kind := "network"
		if errors.Is(err, errBlocked) {
			result.Status = "blocked"
			kind = "blocked"
		}
		if errors.Is(err, errRedirect) {
			kind = "redirect_loop"
		}
		if errors.Is(err, context.DeadlineExceeded) {
			kind = "timeout"
		}
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			kind = "timeout"
		}
		if errors.Is(err, errBudget) {
			result.Status = "unchecked"
			r.job.Truncated = true
		}
		result.Error = pointer(err.Error())
		result.ErrorKind = pointer(kind)
		return
	}
	result.StatusCode = pointer(response.StatusCode)
	result.FinalURL = pointer(response.Request.URL.String())
	result.Error = nil
	result.ErrorKind = nil
	switch {
	case response.StatusCode == 401 || response.StatusCode == 403 || response.StatusCode == 429:
		result.Status = "error"
		result.Error = pointer("HTTP access denied or rate limited; availability is inconclusive")
	case response.StatusCode >= 400:
		result.Status = "broken"
	case redirects > 0 && response.StatusCode >= 200 && response.StatusCode < 300:
		result.Status = "redirected"
	case response.StatusCode >= 200 && response.StatusCode < 300:
		result.Status = "healthy"
	default:
		result.Status = "error"
		result.Error = pointer("Unexpected HTTP status")
	}
}

func (r *run) snapshot() []models.LinkResult {
	r.job.Summary = models.LinkSummary{}
	r.job.TotalLinks = len(r.results)
	r.job.LinksChecked = 0
	items := make([]models.LinkResult, 0, len(r.order))
	for _, target := range r.order {
		v := r.results[target]
		items = append(items, *v)
		switch v.Status {
		case "healthy":
			r.job.Summary.Healthy++
		case "redirected":
			r.job.Summary.Redirected++
		case "broken":
			r.job.Summary.Broken++
		case "error":
			r.job.Summary.Error++
		case "blocked":
			r.job.Summary.Blocked++
		case "unchecked":
			r.job.Summary.Unchecked++
		}
		if v.ErrorKind != nil && *v.ErrorKind == "timeout" {
			r.job.Summary.Timeout++
		}
		if v.Status != "unchecked" {
			r.job.LinksChecked++
		}
	}
	return items
}

func (r *run) publish() error {
	items := r.snapshot()
	if r.sink != nil {
		return r.sink(r.job, items)
	}
	return nil
}

type discovered struct {
	target string
	source models.LinkSource
	crawl  bool
}

func textContent(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if b.Len() > 512 {
			return
		}
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
			b.WriteByte(' ')
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	value := strings.Join(strings.Fields(b.String()), " ")
	if len(value) > 256 {
		value = value[:256]
	}
	return value
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

// Srcset URLs may contain commas (especially data URLs). Read the URL token
// before descriptors, rather than splitting commas inside a URL into fake links.
func srcsetURLs(value string) []string {
	items := []string{}
	for len(value) > 0 && len(items) < MaxSources {
		value = strings.TrimLeft(value, " \t\r\n\f,")
		if value == "" {
			break
		}
		end := strings.IndexAny(value, " \t\r\n\f")
		if end < 0 {
			end = len(value)
		}
		raw := value[:end]
		value = value[end:]
		trailingComma := strings.HasSuffix(raw, ",")
		raw = strings.TrimRight(raw, ",")
		if raw != "" && !strings.HasPrefix(strings.ToLower(raw), "data:") {
			items = append(items, raw)
		}
		if trailingComma {
			continue
		}
		// Width/density descriptors end at the next candidate separator.
		if comma := strings.IndexByte(value, ','); comma >= 0 {
			value = value[comma+1:]
		} else {
			break
		}
	}
	return items
}

func extract(body []byte, pageURL string, root *url.URL) ([]discovered, error) {
	doc, err := html.Parse(strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	base, _ := url.Parse(pageURL)
	var findBase func(*html.Node)
	found := false
	findBase = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "base" && !found {
			if u, err := base.Parse(attr(n, "href")); err == nil && (u.Scheme == "http" || u.Scheme == "https") {
				base = u
				found = true
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			findBase(c)
		}
	}
	findBase(doc)
	items := []discovered{}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if len(items) >= MaxSources {
			return
		}
		if n.Type == html.ElementNode {
			attribute := ""
			switch n.Data {
			case "a", "area", "link":
				attribute = "href"
			case "img", "script", "iframe", "audio", "video", "source", "track", "embed", "input":
				attribute = "src"
			case "object":
				attribute = "data"
			}
			values := []struct{ key, value string }{}
			if attribute != "" {
				values = append(values, struct{ key, value string }{attribute, attr(n, attribute)})
			}
			if n.Data == "video" {
				values = append(values, struct{ key, value string }{"poster", attr(n, "poster")})
			}
			if n.Data == "img" || n.Data == "source" {
				for _, candidate := range srcsetURLs(attr(n, "srcset")) {
					values = append(values, struct{ key, value string }{"srcset", candidate})
				}
			}
			for _, v := range values {
				raw := strings.TrimSpace(v.value)
				if raw == "" || strings.HasPrefix(raw, "#") {
					continue
				}
				u, err := base.Parse(raw)
				if err != nil {
					continue
				}
				normalized, err := Normalize(u.String())
				if err != nil {
					continue
				}
				u, _ = url.Parse(normalized)
				crawl := (n.Data == "a" || n.Data == "area") && sameOrigin(u, root) && classify(u, root, n.Data) == "internal"
				items = append(items, discovered{normalized, models.LinkSource{PageURL: pageURL, Element: n.Data, Attribute: v.key, Text: textContent(n)}, crawl})
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return items, nil
}

// Run fetches source HTML, extracts references, and checks unique HTTP targets.
// A sink error terminates work; publication is durable before the next batch.
func (c *Checker) Run(ctx context.Context, job models.LinkCheck, sink func(models.LinkCheck, []models.LinkResult) error) (models.LinkCheck, []models.LinkResult, error) {
	r, err := c.newRun(job, sink)
	if err != nil {
		return job, nil, err
	}
	defer r.client.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(ctx, JobTimeout)
	defer cancel()
	seeds := []string{r.root.String()}
	if job.CheckType == "scan" {
		seeds = job.SeedURLs
	}
	if len(seeds) > job.MaxPages {
		seeds = seeds[:job.MaxPages]
		r.job.Truncated = true
	}
	queue := []string{}
	queued := map[string]bool{}
	for _, seed := range seeds {
		normalized, err := Normalize(seed)
		if err != nil {
			r.job.PagesFailed++
			r.job.Truncated = true
			continue
		}
		if !queued[normalized] {
			queue = append(queue, normalized)
			queued[normalized] = true
		}
	}
	seen := map[string]bool{}
	parsedFinal := map[string]bool{}
	for len(queue) > 0 && ctx.Err() == nil {
		if r.job.PagesChecked+r.job.PagesFailed >= job.MaxPages {
			r.job.Truncated = true
			break
		}
		target := queue[0]
		queue = queue[1:]
		if seen[target] {
			continue
		}
		seen[target] = true
		result := r.add(target, models.LinkSource{PageURL: target, Element: "page", Attribute: "url", Text: "Source page"})
		if result == nil {
			r.job.Truncated = true
			break
		}
		response, redirects, fetchErr := r.request(ctx, target, http.MethodGet)
		r.outcome(result, response, redirects, fetchErr)
		if fetchErr != nil {
			r.job.PagesFailed++
			r.job.Truncated = true
			if err := r.publish(); err != nil {
				return r.job, r.snapshot(), err
			}
			if errors.Is(fetchErr, errBudget) {
				break
			}
			continue
		}
		contentType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
		if response.StatusCode < 200 || response.StatusCode >= 400 {
			response.Body.Close()
			r.job.PagesFailed++
			r.job.Truncated = true
			if err := r.publish(); err != nil {
				return r.job, r.snapshot(), err
			}
			continue
		}
		if contentType != "text/html" && contentType != "application/xhtml+xml" {
			response.Body.Close()
			r.job.PagesFailed++
			r.job.Truncated = true
			result.Error = pointer("Source page is not HTML; outgoing links could not be inspected")
			if err := r.publish(); err != nil {
				return r.job, r.snapshot(), err
			}
			continue
		}
		body, bodyErr := io.ReadAll(io.LimitReader(response.Body, MaxHTMLBytes+1))
		response.Body.Close()
		if bodyErr != nil {
			r.job.PagesFailed++
			r.job.Truncated = true
			r.outcome(result, nil, redirects, bodyErr)
			if err := r.publish(); err != nil {
				return r.job, r.snapshot(), err
			}
			continue
		}
		if len(body) > MaxHTMLBytes {
			body = body[:MaxHTMLBytes]
			r.job.Truncated = true
		}
		r.job.PagesChecked++
		final := response.Request.URL
		// Never expand a cross-origin redirect into an external crawl.
		if sameOrigin(final, r.root) {
			finalKey, _ := Normalize(final.String())
			// Redirect aliases are separate checked targets, but the same final
			// document contributes its outgoing DOM references only once.
			if parsedFinal[finalKey] {
				if err := r.publish(); err != nil {
					return r.job, r.snapshot(), err
				}
				continue
			}
			parsedFinal[finalKey] = true
			items, parseErr := extract(body, final.String(), r.root)
			if parseErr != nil {
				r.job.PagesFailed++
				r.job.Truncated = true
			} else {
				if len(items) >= MaxSources {
					r.job.Truncated = true
				}
				for _, item := range items {
					r.add(item.target, item.source)
					if job.CheckType == "crawl" && item.crawl && !queued[item.target] {
						if len(queued) >= job.MaxPages {
							r.job.Truncated = true
						} else {
							queued[item.target] = true
							queue = append(queue, item.target)
						}
					}
				}
			}
		} else {
			r.job.Truncated = true
		}
		if err := r.publish(); err != nil {
			return r.job, r.snapshot(), err
		}
	}
	for i, target := range r.order {
		if ctx.Err() != nil {
			break
		}
		result := r.results[target]
		if result.Status != "unchecked" {
			continue
		}
		response, redirects, checkErr := r.request(ctx, target, http.MethodHead)
		if checkErr == nil && (response.StatusCode == 405 || response.StatusCode == 501) {
			response.Body.Close()
			response, redirects, checkErr = r.request(ctx, target, http.MethodGet)
		}
		r.outcome(result, response, redirects, checkErr)
		if response != nil {
			response.Body.Close()
		}
		if i%10 == 0 {
			if err := r.publish(); err != nil {
				return r.job, r.snapshot(), err
			}
		}
		if errors.Is(checkErr, errBudget) {
			r.job.Truncated = true
			break
		}
	}
	if ctx.Err() != nil {
		r.job.Truncated = true
		r.job.Error = pointer(ctx.Err().Error())
		r.job.Status = "failed"
	} else if r.job.PagesChecked == 0 {
		r.job.Status = "failed"
		r.job.Error = pointer("No source HTML pages could be inspected")
	} else {
		r.job.Status = "completed"
		if r.job.PagesFailed > 0 {
			r.job.Error = pointer("Some source pages could not be inspected; results are partial")
		}
	}
	items := r.snapshot()
	sort.Slice(items, func(i, j int) bool { return items[i].TargetURL < items[j].TargetURL })
	if ctx.Err() != nil && errors.Is(ctx.Err(), context.Canceled) {
		return r.job, items, ctx.Err()
	}
	if r.sink != nil {
		if err := r.sink(r.job, items); err != nil {
			return r.job, items, err
		}
	}
	return r.job, items, nil
}
