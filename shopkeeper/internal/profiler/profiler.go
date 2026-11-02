package profiler

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sumanbasuli/lime/shopkeeper/internal/rootdns"
	log "github.com/sumanbasuli/lime/shopkeeper/internal/safelog"
)

// sitemapEntry represents a <sitemap> element inside a sitemapindex.
type sitemapEntry struct {
	Loc string `xml:"loc"`
}

// urlEntry represents a <url> element inside a urlset.
type urlEntry struct {
	Loc string `xml:"loc"`
}

type sitemapDocument struct {
	index   bool
	entries []string
	count   int
}

const (
	fetchTimeout            = 30 * time.Second
	pinnedDialTimeout       = 5 * time.Second
	fetchRetryDelay         = 400 * time.Millisecond
	maxFetchRetries         = 3
	xmlAcceptHeader         = "application/xml,text/xml;q=0.9,*/*;q=0.8"
	pageAcceptHeader        = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
	resolveURLTimeout       = 10 * time.Second
	resolveURLWorkerCount   = 12
	maxDiscoveryDuration    = 30 * time.Minute
	maxDiscoveryRequests    = 20_000
	maxSitemapDocumentBytes = 50 << 20
	maxSitemapBytes         = 128 << 20
	maxDiscoveredURLs       = 10_000
)

var httpClient = newHTTPClient()

var errDifferentAuthority = errors.New("URL has different authority from root sitemap")
var errDiscoveryBudget = errors.New("sitemap discovery work budget exceeded")
var errMixedRootDNS = errors.New("sitemap host resolved to mixed public and non-public addresses")
var errInvalidSitemap = errors.New("invalid sitemap XML")

type discovery struct {
	allowedAuthority string
	rootHost         string
	client           *http.Client
	lookupIPAddr     func(context.Context, string) ([]net.IPAddr, error)
	dialContext      func(context.Context, string, string) (net.Conn, error)
	dialTimeout      time.Duration
	addressMu        sync.Mutex
	pinnedAddresses  []net.IPAddr
	visitedSitemaps  map[string]bool
	requests         atomic.Int64
	sitemapBytes     int64
	requestLimit     int64
	byteLimit        int64
	pageLimit        int
	observeRootDNS   rootdns.Observer
	privateDialGuard rootdns.PrivateDialGuard
	requestHook      func(context.Context) error
	chargeHook       func(context.Context, int64) error
}

type requestProfile struct {
	name      string
	userAgent string
}

type discoveredURL struct {
	index  int
	rawURL string
}

type urlEligibilityOutcome struct {
	index      int
	finalURL   string
	eligible   bool
	redirected bool
	external   bool
	unresolved bool
}

type urlEligibilitySummary struct {
	redirected int
	external   int
	unresolved int
}

var sitemapFetchProfiles = []requestProfile{
	{
		name:      "scanner",
		userAgent: "LIME Accessibility Scanner/1.0",
	},
	{
		name:      "browser-fallback",
		userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
	},
}

func newHTTPClient() *http.Client {
	return &http.Client{
		Timeout: fetchTimeout,
	}
}

func newDiscovery(sitemapURL string) (*discovery, error) {
	parsedURL, err := url.ParseRequestURI(sitemapURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse sitemap URL %s: %w", sitemapURL, err)
	}
	if !isHTTPURL(parsedURL) {
		return nil, fmt.Errorf("sitemap URL %s must use HTTP or HTTPS", sitemapURL)
	}

	allowedAuthority := normalizedAuthority(parsedURL)
	if allowedAuthority == "" {
		return nil, fmt.Errorf("sitemap URL %s has no host", sitemapURL)
	}

	// Each discovery uses its own redirect policy while retaining the configured
	// transport and other settings (including the client supplied by tests).
	client := *httpClient
	d := &discovery{
		allowedAuthority: allowedAuthority,
		rootHost:         parsedURL.Hostname(),
		client:           &client,
		lookupIPAddr:     net.DefaultResolver.LookupIPAddr,
		dialContext:      (&net.Dialer{Timeout: fetchTimeout}).DialContext,
		dialTimeout:      pinnedDialTimeout,
		visitedSitemaps:  make(map[string]bool),
		requestLimit:     maxDiscoveryRequests,
		byteLimit:        maxSitemapBytes,
		pageLimit:        maxDiscoveredURLs,
	}
	// The production client uses an HTTP transport. Clone it per discovery so
	// every sitemap, redirect, retry, and page eligibility check shares one DNS
	// answer without changing other scans' connection pools. A custom test
	// RoundTripper has no network dial to constrain.
	base := client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	if transport, ok := base.(*http.Transport); ok {
		pinned := transport.Clone()
		// An environment proxy would resolve the hostname itself and bypass the
		// pinned dial. Profiler discovery therefore connects directly, as the
		// link checker does, even when HTTP_PROXY/HTTPS_PROXY is configured.
		pinned.Proxy = nil
		pinned.Dial = nil
		pinned.DialTLS = nil
		pinned.DialTLSContext = nil
		pinned.DialContext = d.dialPinnedAddress
		client.Transport = pinned
	}
	previousCheckRedirect := client.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if !isAllowedURL(req.URL, allowedAuthority) {
			return fmt.Errorf("%w: %s", errDifferentAuthority, req.URL)
		}
		if previousCheckRedirect != nil {
			if err := previousCheckRedirect(req, via); err != nil {
				return err
			}
		} else if len(via) >= 10 {
			return errors.New("stopped after 10 redirects")
		}
		return d.reserveRequest(req.Context())
	}

	return d, nil
}

// dialPinnedAddress never asks DNS to resolve the root again after its first
// successful answer. The URL authority, Host header, and HTTPS SNI remain the
// original hostname; only the TCP destination is replaced with a pinned IP.
func (d *discovery) dialPinnedAddress(ctx context.Context, network, address string) (net.Conn, error) {
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addresses, err := d.rootAddresses(ctx)
	if err != nil {
		return nil, err
	}
	// A private pinned answer may remain in use for several sitemap requests.
	// Hold a shared policy lease through each TCP dial so another stage cannot
	// commit a public observation between our policy check and connection.
	if ip, ok := netip.AddrFromSlice(addresses[0].IP); ok && !rootdns.PublicIP(ip) && d.privateDialGuard != nil {
		release, err := d.privateDialGuard(ctx)
		if err != nil {
			if release != nil {
				release()
			}
			return nil, fmt.Errorf("sitemap private-root dial policy: %w", err)
		}
		if release == nil {
			return nil, errors.New("sitemap private-root dial guard returned no release function")
		}
		defer release()
	}
	if len(addresses) == 1 {
		return d.dialContext(ctx, network, net.JoinHostPort(addresses[0].String(), port))
	}

	// Keep dual-stack fallback responsive without launching a dial goroutine for
	// every DNS record. Each approved address gets a bounded attempt, so two
	// blackholed first addresses cannot hold both workers until the fetch ends.
	dialCtx, cancel := context.WithCancel(ctx)
	var dialers sync.WaitGroup
	// The private-root policy lease outlives every attempted connection, even
	// when a different address wins the race and this method returns early.
	defer func() {
		cancel()
		dialers.Wait()
	}()
	attemptTimeout := pinnedDialAttemptBudget(ctx, len(addresses), d.dialTimeout)
	type dialResult struct {
		conn net.Conn
		err  error
	}
	jobs := make(chan net.IPAddr)
	results := make(chan dialResult)
	for range min(2, len(addresses)) {
		dialers.Add(1)
		go func() {
			defer dialers.Done()
			for candidate := range jobs {
				attemptCtx, attemptCancel := context.WithTimeout(dialCtx, attemptTimeout)
				conn, err := d.dialContext(attemptCtx, network, net.JoinHostPort(candidate.String(), port))
				attemptCancel()
				select {
				case results <- dialResult{conn: conn, err: err}:
				case <-dialCtx.Done():
					if conn != nil {
						conn.Close()
					}
					return
				}
			}
		}()
	}
	dialers.Add(1)
	go func() {
		defer dialers.Done()
		defer close(jobs)
		for _, candidate := range interleaveIPFamilies(addresses) {
			select {
			case jobs <- candidate:
			case <-dialCtx.Done():
				return
			}
		}
	}()
	var lastErr error
	for range addresses {
		select {
		case result := <-results:
			if result.conn != nil {
				return result.conn, nil
			}
			lastErr = result.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return nil, lastErr
}

func pinnedDialAttemptBudget(ctx context.Context, addressCount int, maximum time.Duration) time.Duration {
	if maximum <= 0 {
		maximum = pinnedDialTimeout
	}
	if deadline, ok := ctx.Deadline(); ok {
		// Two workers need this many rounds to try every pinned address. Keep
		// enough of a shorter caller deadline for later candidates to be tried.
		rounds := max(1, (addressCount+1)/2)
		if share := time.Until(deadline) / time.Duration(rounds); share < maximum {
			return share
		}
	}
	return maximum
}

func interleaveIPFamilies(addresses []net.IPAddr) []net.IPAddr {
	firstFamilyIPv4 := addresses[0].IP.To4() != nil
	primary, secondary := make([]net.IPAddr, 0, len(addresses)), make([]net.IPAddr, 0, len(addresses))
	for _, address := range addresses {
		if (address.IP.To4() != nil) == firstFamilyIPv4 {
			primary = append(primary, address)
		} else {
			secondary = append(secondary, address)
		}
	}
	ordered := make([]net.IPAddr, 0, len(addresses))
	for len(primary) > 0 || len(secondary) > 0 {
		if len(primary) > 0 {
			ordered, primary = append(ordered, primary[0]), primary[1:]
		}
		if len(secondary) > 0 {
			ordered, secondary = append(ordered, secondary[0]), secondary[1:]
		}
	}
	return ordered
}

func (d *discovery) rootAddresses(ctx context.Context) ([]net.IPAddr, error) {
	d.addressMu.Lock()
	defer d.addressMu.Unlock()
	if len(d.pinnedAddresses) > 0 {
		return d.pinnedAddresses, nil
	}
	var addresses []net.IPAddr
	if ip := net.ParseIP(d.rootHost); ip != nil {
		addresses = []net.IPAddr{{IP: ip}}
	} else {
		var err error
		addresses, err = d.lookupIPAddr(ctx, d.rootHost)
		if err != nil {
			return nil, fmt.Errorf("failed to resolve sitemap host %s: %w", d.rootHost, err)
		}
	}
	if len(addresses) == 0 {
		return nil, fmt.Errorf("sitemap host %s has no addresses", d.rootHost)
	}
	public, nonPublic := false, false
	for _, address := range addresses {
		ip, ok := netip.AddrFromSlice(address.IP)
		if !ok {
			return nil, fmt.Errorf("sitemap host %s resolved to invalid IP address", d.rootHost)
		}
		if rootdns.PublicIP(ip) {
			public = true
		} else {
			nonPublic = true
		}
	}
	if d.observeRootDNS != nil {
		if err := d.observeRootDNS(ctx, public, nonPublic); err != nil {
			return nil, fmt.Errorf("sitemap root DNS policy: %w", err)
		}
	}
	if public && nonPublic {
		return nil, fmt.Errorf("%w: %s", errMixedRootDNS, d.rootHost)
	}
	d.pinnedAddresses = append([]net.IPAddr(nil), addresses...)
	return d.pinnedAddresses, nil
}

func (d *discovery) reserveRequest(ctx context.Context) error {
	if d.requestHook != nil {
		return d.requestHook(ctx)
	}
	for {
		used := d.requests.Load()
		if used >= d.requestLimit {
			return fmt.Errorf("%w: at most %d HTTP requests", errDiscoveryBudget, d.requestLimit)
		}
		if d.requests.CompareAndSwap(used, used+1) {
			return nil
		}
	}
}

func isHTTPURL(u *url.URL) bool {
	return u != nil && (u.Scheme == "http" || u.Scheme == "https")
}

func isAllowedURL(u *url.URL, allowedAuthority string) bool {
	return isHTTPURL(u) && normalizedAuthority(u) == allowedAuthority
}

func (d *discovery) checkURL(rawURL string) error {
	parsedURL, err := url.ParseRequestURI(rawURL)
	if err != nil {
		return fmt.Errorf("invalid URL %s: %w", rawURL, err)
	}
	if !isAllowedURL(parsedURL, d.allowedAuthority) {
		return fmt.Errorf("%w: %s", errDifferentAuthority, rawURL)
	}
	return nil
}

// Discover fetches a sitemap URL and recursively extracts all page URLs.
// It handles both <sitemapindex> (nested sitemaps) and <urlset> (direct URLs).
// Returns a deduplicated, validated slice of URL strings.
func Discover(ctx context.Context, sitemapURL string) ([]string, error) {
	return DiscoverWithRootPolicy(ctx, sitemapURL, nil)
}

// DiscoverWithRootPolicy applies the durable scan policy to the same DNS
// answer that discovery pins, before its first network dial.
func DiscoverWithRootPolicy(ctx context.Context, sitemapURL string, observe rootdns.Observer, guards ...rootdns.PrivateDialGuard) ([]string, error) {
	d, err := newDiscovery(sitemapURL)
	if err != nil {
		return nil, log.Error(err)
	}
	d.observeRootDNS = observe
	if len(guards) > 0 {
		d.privateDialGuard = guards[0]
	}
	defer d.client.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(ctx, maxDiscoveryDuration)
	defer cancel()

	seen := make(map[string]bool)
	var result []string

	if err := d.discoverRecursive(ctx, sitemapURL, seen, &result, 0); err != nil {
		return nil, log.Error(err)
	}

	eligibleURLs, summary, err := d.filterEligibleURLs(ctx, result)
	if err != nil {
		return nil, log.Error(err)
	}

	log.Printf(
		"Profiler: discovered %d unique URLs from %s; kept %d same-host URLs (%d redirected, %d cross-host skipped, %d unresolved skipped)",
		len(result),
		sitemapURL,
		len(eligibleURLs),
		summary.redirected,
		summary.external,
		summary.unresolved,
	)
	return eligibleURLs, nil
}

const maxDepth = 10

func (d *discovery) discoverRecursive(ctx context.Context, sitemapURL string, seen map[string]bool, result *[]string, depth int) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	if err := d.checkURL(sitemapURL); err != nil {
		return err
	}
	key := canonicalizeURLString(sitemapURL)
	if d.visitedSitemaps[key] {
		return nil
	}
	if depth > maxDepth {
		return fmt.Errorf("exceeded maximum sitemap nesting depth (%d)", maxDepth)
	}
	d.visitedSitemaps[key] = true

	document, err := d.fetchSitemap(ctx, sitemapURL, seen)
	if err != nil {
		return err
	}

	if document.index {
		log.Printf("Profiler: found sitemapindex at %s with %d sitemaps", sitemapURL, document.count)
		var nestedErrs []error
		for _, loc := range document.entries {
			if err := d.discoverRecursive(ctx, loc, seen, result, depth+1); err != nil {
				if errors.Is(err, errDiscoveryBudget) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					return err
				}
				log.Printf("Profiler: warning: failed to process nested sitemap %s: %v", loc, err)
				nestedErrs = append(nestedErrs, fmt.Errorf("%s: %w", loc, err))
			}
		}
		if len(nestedErrs) > 0 {
			return fmt.Errorf("failed to fully process sitemapindex %s: %w", sitemapURL, errors.Join(nestedErrs...))
		}
		return nil
	}

	log.Printf("Profiler: found urlset at %s with %d URLs", sitemapURL, document.count)
	for _, loc := range document.entries {
		seen[loc] = true
		*result = append(*result, loc)
	}
	return nil
}

// fetchSitemap parses each fetch attempt directly from the response body. A
// failed attempt cannot contribute URLs to a successful retry.
func (d *discovery) fetchSitemap(ctx context.Context, rawURL string, seen map[string]bool) (sitemapDocument, error) {
	if err := d.checkURL(rawURL); err != nil {
		return sitemapDocument{}, fmt.Errorf("failed to fetch sitemap %s: %w", rawURL, err)
	}

	var lastErr error
	for i, profile := range sitemapFetchProfiles {
		var lastStatusCode int
		for attempt := 1; attempt <= maxFetchRetries; attempt++ {
			if err := ctx.Err(); err != nil {
				return sitemapDocument{}, fmt.Errorf("failed to fetch sitemap %s: %w", rawURL, err)
			}
			var document sitemapDocument
			statusCode, shouldRetry, err := d.fetchURLOnceConsume(ctx, rawURL, profile, func(body io.Reader) error {
				var parseErr error
				document, parseErr = decodeSitemap(body, seen, d.visitedSitemaps, d.pageLimit, int(d.requestLimit))
				return parseErr
			})
			if err == nil {
				if i > 0 {
					log.Printf("Profiler: fetched %s using %s profile after upstream blocked the default scanner profile", rawURL, profile.name)
				}
				return document, nil
			}
			lastErr = err
			lastStatusCode = statusCode
			if !shouldRetry || attempt == maxFetchRetries {
				break
			}
			time.Sleep(time.Duration(attempt) * fetchRetryDelay)
		}
		if lastStatusCode == http.StatusForbidden && i < len(sitemapFetchProfiles)-1 {
			log.Printf("Profiler: %s returned 403 for %s profile, retrying with %s", rawURL, profile.name, sitemapFetchProfiles[i+1].name)
			continue
		}
		break
	}
	if errors.Is(lastErr, errInvalidSitemap) {
		return sitemapDocument{}, fmt.Errorf("could not parse %s as either sitemapindex or urlset: %w", rawURL, lastErr)
	}
	return sitemapDocument{}, fmt.Errorf("failed to fetch sitemap %s: %w", rawURL, lastErr)
}

func (d *discovery) fetchURL(ctx context.Context, rawURL string) ([]byte, error) {
	if err := d.checkURL(rawURL); err != nil {
		return nil, err
	}

	var lastErr error

	for i, profile := range sitemapFetchProfiles {
		body, statusCode, err := d.fetchURLWithRetries(ctx, rawURL, profile)
		if err == nil {
			if i > 0 {
				log.Printf("Profiler: fetched %s using %s profile after upstream blocked the default scanner profile", rawURL, profile.name)
			}
			return body, nil
		}

		lastErr = err
		if statusCode == http.StatusForbidden && i < len(sitemapFetchProfiles)-1 {
			log.Printf("Profiler: %s returned 403 for %s profile, retrying with %s", rawURL, profile.name, sitemapFetchProfiles[i+1].name)
			continue
		}

		break
	}

	return nil, lastErr
}

func (d *discovery) fetchURLWithRetries(ctx context.Context, rawURL string, profile requestProfile) ([]byte, int, error) {
	var lastErr error
	var lastStatusCode int

	for attempt := 1; attempt <= maxFetchRetries; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, 0, err
		}

		body, statusCode, shouldRetry, err := d.fetchURLOnce(ctx, rawURL, profile)
		if err == nil {
			return body, statusCode, nil
		}

		lastErr = err
		lastStatusCode = statusCode
		if !shouldRetry || attempt == maxFetchRetries {
			break
		}

		time.Sleep(time.Duration(attempt) * fetchRetryDelay)
	}

	return nil, lastStatusCode, lastErr
}

func (d *discovery) fetchURLOnce(ctx context.Context, rawURL string, profile requestProfile) ([]byte, int, bool, error) {
	var body []byte
	statusCode, shouldRetry, err := d.fetchURLOnceConsume(ctx, rawURL, profile, func(reader io.Reader) error {
		var readErr error
		body, readErr = io.ReadAll(reader)
		return readErr
	})
	if err != nil {
		return nil, statusCode, shouldRetry, err
	}
	return body, statusCode, false, nil
}

func (d *discovery) fetchURLOnceConsume(ctx context.Context, rawURL string, profile requestProfile, consume func(io.Reader) error) (int, bool, error) {
	if d.sitemapBytes > d.byteLimit {
		return 0, false, fmt.Errorf("%w: at most %d sitemap bytes", errDiscoveryBudget, d.byteLimit)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return 0, false, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Accept", xmlAcceptHeader)
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("User-Agent", profile.userAgent)

	if err := d.reserveRequest(ctx); err != nil {
		return 0, false, err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return 0, !errors.Is(err, errDifferentAuthority) && !errors.Is(err, errDiscoveryBudget) && !errors.Is(err, errMixedRootDNS) && !isPersistenceError(err), err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500,
			fmt.Errorf("HTTP %d for %s", resp.StatusCode, rawURL)
	}

	reader := &sitemapBudgetReader{source: resp.Body, discovery: d, ctx: ctx}
	if err := consume(reader); err != nil {
		if reader.readErr != nil {
			return resp.StatusCode, !errors.Is(reader.readErr, context.Canceled) && !errors.Is(reader.readErr, context.DeadlineExceeded) && !errors.Is(reader.readErr, errDiscoveryBudget) && !isPersistenceError(reader.readErr),
				fmt.Errorf("failed to read response body: %w", reader.readErr)
		}
		return resp.StatusCode, false, err
	}
	return resp.StatusCode, false, nil
}

// The extra read at each limit distinguishes a document ending exactly at the
// limit from a larger response. The charged byte is retained across retries.
type sitemapBudgetReader struct {
	source    io.Reader
	discovery *discovery
	read      int64
	readErr   error
	ctx       context.Context
}

func (r *sitemapBudgetReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	remainingDocument := int64(maxSitemapDocumentBytes) - r.read
	remainingAggregate := r.discovery.byteLimit - r.discovery.sitemapBytes
	remaining := min(remainingDocument, remainingAggregate)
	if remaining < 0 {
		return 0, r.limitError(remainingDocument, remainingAggregate)
	}
	n, err := r.source.Read(p[:min(len(p), int(remaining+1))])
	r.read += int64(n)
	if n > 0 && r.discovery.chargeHook != nil {
		if chargeErr := r.discovery.chargeHook(r.ctx, int64(n)); chargeErr != nil {
			r.readErr = chargeErr
			return 0, chargeErr
		}
	}
	r.discovery.sitemapBytes += int64(n)
	if int64(n) > remaining {
		return 0, r.limitError(remainingDocument, remainingAggregate)
	}
	if err != nil && !errors.Is(err, io.EOF) {
		r.readErr = err
	}
	return n, err
}

func (r *sitemapBudgetReader) limitError(remainingDocument, remainingAggregate int64) error {
	if remainingDocument <= remainingAggregate {
		return fmt.Errorf("%w: at most %d bytes per sitemap", errDiscoveryBudget, maxSitemapDocumentBytes)
	}
	return fmt.Errorf("%w: at most %d sitemap bytes", errDiscoveryBudget, r.discovery.byteLimit)
}

// decodeSitemap keeps only entries that can still affect discovery. In
// particular, a urlset stops at the first distinct URL past the page budget
// rather than materializing the rest of the XML document.
func decodeSitemap(body io.Reader, seen, visitedSitemaps map[string]bool, pageLimit, indexLimit int) (sitemapDocument, error) {
	decoder := xml.NewDecoder(body)
	var root xml.StartElement
	for {
		token, err := decoder.Token()
		if err != nil {
			return sitemapDocument{}, invalidSitemap(err)
		}
		if start, ok := token.(xml.StartElement); ok {
			root = start
			break
		}
		if data, ok := token.(xml.CharData); ok && !isXMLWhitespace(data) {
			return sitemapDocument{}, invalidSitemap(errors.New("text before root element"))
		}
	}
	if root.Name.Local != "urlset" && root.Name.Local != "sitemapindex" {
		return sitemapDocument{}, invalidSitemap(fmt.Errorf("unexpected root element %s", root.Name.Local))
	}

	document := sitemapDocument{index: root.Name.Local == "sitemapindex"}
	localSeen := make(map[string]bool)
	for {
		token, err := decoder.Token()
		if err != nil {
			return sitemapDocument{}, invalidSitemap(err)
		}
		switch element := token.(type) {
		case xml.StartElement:
			if document.index && element.Name.Local == "sitemap" {
				var entry sitemapEntry
				if err := decoder.DecodeElement(&entry, &element); err != nil {
					return sitemapDocument{}, invalidSitemap(err)
				}
				document.count++
				loc := strings.TrimSpace(entry.Loc)
				if loc == "" {
					continue
				}
				key := canonicalizeURLString(loc)
				if visitedSitemaps[key] || localSeen[key] {
					continue
				}
				if len(localSeen) >= indexLimit {
					return sitemapDocument{}, fmt.Errorf("%w: at most %d distinct sitemap URLs", errDiscoveryBudget, indexLimit)
				}
				localSeen[key] = true
				document.entries = append(document.entries, loc)
			} else if !document.index && element.Name.Local == "url" {
				var entry urlEntry
				if err := decoder.DecodeElement(&entry, &element); err != nil {
					return sitemapDocument{}, invalidSitemap(err)
				}
				document.count++
				loc := strings.TrimSpace(entry.Loc)
				if loc == "" {
					continue
				}
				if !isValidURL(loc) {
					log.Printf("Profiler: skipping invalid URL: %s", loc)
					continue
				}
				if seen[loc] || localSeen[loc] {
					continue
				}
				if len(seen)+len(localSeen) >= pageLimit {
					return sitemapDocument{}, fmt.Errorf("%w: at most %d distinct page URLs", errDiscoveryBudget, pageLimit)
				}
				localSeen[loc] = true
				document.entries = append(document.entries, loc)
			} else if err := decoder.Skip(); err != nil {
				return sitemapDocument{}, invalidSitemap(err)
			}
		case xml.EndElement:
			if element.Name == root.Name {
				if document.count == 0 {
					return sitemapDocument{}, invalidSitemap(errors.New("no sitemap entries"))
				}
				for {
					token, err := decoder.Token()
					if errors.Is(err, io.EOF) {
						return document, nil
					}
					if err != nil {
						return sitemapDocument{}, invalidSitemap(err)
					}
					if data, ok := token.(xml.CharData); ok && isXMLWhitespace(data) {
						continue
					}
					if _, ok := token.(xml.Comment); ok {
						continue
					}
					if _, ok := token.(xml.ProcInst); ok {
						continue
					}
					return sitemapDocument{}, invalidSitemap(errors.New("content after root element"))
				}
			}
		}
	}
}

func invalidSitemap(err error) error {
	if errors.Is(err, errDiscoveryBudget) {
		return err
	}
	return fmt.Errorf("%w: %w", errInvalidSitemap, err)
}

func isXMLWhitespace(data xml.CharData) bool {
	for _, character := range data {
		switch character {
		case ' ', '\t', '\n', '\r':
		default:
			return false
		}
	}
	return true
}

func isValidURL(rawURL string) bool {
	u, err := url.ParseRequestURI(rawURL)
	if err != nil {
		return false
	}
	return isHTTPURL(u)
}

func (d *discovery) filterEligibleURLs(
	ctx context.Context,
	discovered []string,
) ([]string, urlEligibilitySummary, error) {
	var summary urlEligibilitySummary

	if len(discovered) == 0 {
		return []string{}, summary, nil
	}

	workerCount := resolveURLWorkerCount
	if len(discovered) < workerCount {
		workerCount = len(discovered)
	}

	workerCtx, cancelWorkers := context.WithCancel(ctx)
	defer cancelWorkers()
	jobs := make(chan discoveredURL)
	results := make(chan urlEligibilityOutcome, len(discovered))

	var wg sync.WaitGroup
	var workerErr error
	var firstError sync.Once
	for workerIndex := 0; workerIndex < workerCount; workerIndex++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for candidate := range jobs {
				outcome, err := d.evaluateURLEligibility(workerCtx, candidate)
				if err != nil {
					firstError.Do(func() {
						workerErr = err
						cancelWorkers()
					})
					return
				}
				results <- outcome
			}
		}()
	}

	for index, rawURL := range discovered {
		select {
		case <-workerCtx.Done():
			close(jobs)
			wg.Wait()
			if err := ctx.Err(); err != nil {
				return nil, summary, err
			}
			return nil, summary, workerErr
		case jobs <- discoveredURL{index: index, rawURL: rawURL}:
		}
	}

	close(jobs)
	go func() {
		wg.Wait()
		close(results)
	}()

	outcomes := make([]urlEligibilityOutcome, len(discovered))
	for outcome := range results {
		outcomes[outcome.index] = outcome
	}

	if err := ctx.Err(); err != nil {
		return nil, summary, err
	}
	if workerErr != nil {
		return nil, summary, workerErr
	}

	seenFinalURLs := make(map[string]bool, len(outcomes))
	filtered := make([]string, 0, len(outcomes))
	for _, outcome := range outcomes {
		switch {
		case outcome.eligible:
			if outcome.redirected {
				summary.redirected++
			}
			if !seenFinalURLs[outcome.finalURL] {
				seenFinalURLs[outcome.finalURL] = true
				filtered = append(filtered, outcome.finalURL)
			}
		case outcome.external:
			summary.external++
		default:
			summary.unresolved++
		}
	}

	return filtered, summary, nil
}

func (d *discovery) evaluateURLEligibility(
	ctx context.Context,
	candidate discoveredURL,
) (urlEligibilityOutcome, error) {
	outcome := urlEligibilityOutcome{index: candidate.index}
	if err := d.checkURL(candidate.rawURL); err != nil {
		if errors.Is(err, errDifferentAuthority) {
			outcome.external = true
		} else {
			outcome.unresolved = true
		}
		return outcome, nil
	}

	resolveCtx, cancel := context.WithTimeout(ctx, resolveURLTimeout)
	defer cancel()

	finalURL, err := d.resolveFinalURL(resolveCtx, candidate.rawURL)
	if err != nil {
		if ctx.Err() != nil {
			return outcome, ctx.Err()
		}
		if errors.Is(err, errDiscoveryBudget) || isPersistenceError(err) {
			return outcome, err
		}
		if errors.Is(err, errDifferentAuthority) {
			outcome.external = true
		} else {
			outcome.unresolved = true
		}
		return outcome, nil
	}

	outcome.finalURL = canonicalizeURL(finalURL)
	outcome.redirected = outcome.finalURL != canonicalizeURLString(candidate.rawURL)
	if normalizedAuthority(finalURL) != d.allowedAuthority {
		outcome.external = true
		return outcome, nil
	}

	outcome.eligible = true
	return outcome, nil
}

func (d *discovery) resolveFinalURL(ctx context.Context, rawURL string) (*url.URL, error) {
	if err := d.checkURL(rawURL); err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Accept", pageAcceptHeader)
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("User-Agent", sitemapFetchProfiles[1].userAgent)

	if err := d.reserveRequest(ctx); err != nil {
		return nil, err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.Request == nil || resp.Request.URL == nil {
		return nil, fmt.Errorf("missing final request URL for %s", rawURL)
	}

	return resp.Request.URL, nil
}

func normalizedAuthority(u *url.URL) string {
	if u == nil {
		return ""
	}

	host := strings.ToLower(u.Hostname())
	if host == "" {
		return ""
	}

	port := u.Port()
	if port == "" || port == defaultPortForScheme(u.Scheme) {
		return host
	}

	return net.JoinHostPort(host, port)
}

func defaultPortForScheme(scheme string) string {
	switch strings.ToLower(scheme) {
	case "http":
		return "80"
	case "https":
		return "443"
	default:
		return ""
	}
}

func canonicalizeURLString(rawURL string) string {
	parsedURL, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}

	return canonicalizeURL(parsedURL)
}

func canonicalizeURL(u *url.URL) string {
	if u == nil {
		return ""
	}

	normalized := *u
	normalized.Scheme = strings.ToLower(normalized.Scheme)
	normalized.Host = normalizedAuthority(u)
	normalized.Fragment = ""
	if normalized.Path == "" {
		normalized.Path = "/"
	}

	return normalized.String()
}
