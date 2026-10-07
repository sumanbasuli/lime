package profiler

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// sitemapIndex represents a <sitemapindex> XML element.
type sitemapIndex struct {
	XMLName  xml.Name       `xml:"sitemapindex"`
	Sitemaps []sitemapEntry `xml:"sitemap"`
}

// sitemapEntry represents a <sitemap> element inside a sitemapindex.
type sitemapEntry struct {
	Loc string `xml:"loc"`
}

// urlSet represents a <urlset> XML element.
type urlSet struct {
	XMLName xml.Name   `xml:"urlset"`
	URLs    []urlEntry `xml:"url"`
}

// urlEntry represents a <url> element inside a urlset.
type urlEntry struct {
	Loc string `xml:"loc"`
}

const (
	fetchTimeout          = 30 * time.Second
	fetchRetryDelay       = 400 * time.Millisecond
	maxFetchRetries       = 3
	xmlAcceptHeader       = "application/xml,text/xml;q=0.9,*/*;q=0.8"
	pageAcceptHeader      = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
	resolveURLTimeout     = 10 * time.Second
	resolveURLWorkerCount = 12
	maxDiscoveryDuration  = 30 * time.Minute
	maxDiscoveryRequests  = 20_000
	maxSitemapBytes       = 128 << 20
	maxDiscoveredURLs     = 10_000
)

var httpClient = newHTTPClient()

var errDifferentAuthority = errors.New("URL has different authority from root sitemap")
var errDiscoveryBudget = errors.New("sitemap discovery work budget exceeded")

type discovery struct {
	allowedAuthority string
	client           *http.Client
	visitedSitemaps  map[string]bool
	requests         atomic.Int64
	sitemapBytes     int64
	requestLimit     int64
	byteLimit        int64
	pageLimit        int
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
		client:           &client,
		visitedSitemaps:  make(map[string]bool),
		requestLimit:     maxDiscoveryRequests,
		byteLimit:        maxSitemapBytes,
		pageLimit:        maxDiscoveredURLs,
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
		return d.reserveRequest()
	}

	return d, nil
}

func (d *discovery) reserveRequest() error {
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
	d, err := newDiscovery(sitemapURL)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, maxDiscoveryDuration)
	defer cancel()

	seen := make(map[string]bool)
	var result []string

	if err := d.discoverRecursive(ctx, sitemapURL, seen, &result, 0); err != nil {
		return nil, err
	}

	eligibleURLs, summary, err := d.filterEligibleURLs(ctx, result)
	if err != nil {
		return nil, err
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

	body, err := d.fetchURL(ctx, sitemapURL)
	if err != nil {
		return fmt.Errorf("failed to fetch sitemap %s: %w", sitemapURL, err)
	}

	// Try parsing as sitemapindex first
	var index sitemapIndex
	if err := xml.Unmarshal(body, &index); err == nil && len(index.Sitemaps) > 0 {
		log.Printf("Profiler: found sitemapindex at %s with %d sitemaps", sitemapURL, len(index.Sitemaps))
		var nestedErrs []error
		for _, entry := range index.Sitemaps {
			loc := strings.TrimSpace(entry.Loc)
			if loc == "" {
				continue
			}
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

	// Try parsing as urlset
	var urls urlSet
	if err := xml.Unmarshal(body, &urls); err == nil && len(urls.URLs) > 0 {
		log.Printf("Profiler: found urlset at %s with %d URLs", sitemapURL, len(urls.URLs))
		for _, entry := range urls.URLs {
			loc := strings.TrimSpace(entry.Loc)
			if loc == "" {
				continue
			}
			if !isValidURL(loc) {
				log.Printf("Profiler: skipping invalid URL: %s", loc)
				continue
			}
			if !seen[loc] {
				if len(seen) >= d.pageLimit {
					return fmt.Errorf("%w: at most %d distinct page URLs", errDiscoveryBudget, d.pageLimit)
				}
				seen[loc] = true
				*result = append(*result, loc)
			}
		}
		return nil
	}

	return fmt.Errorf("could not parse %s as either sitemapindex or urlset", sitemapURL)
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
	if d.sitemapBytes >= d.byteLimit {
		return nil, 0, false, fmt.Errorf("%w: at most %d sitemap bytes", errDiscoveryBudget, d.byteLimit)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, 0, false, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Accept", xmlAcceptHeader)
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("User-Agent", profile.userAgent)

	if err := d.reserveRequest(); err != nil {
		return nil, 0, false, err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, 0, !errors.Is(err, errDifferentAuthority) && !errors.Is(err, errDiscoveryBudget), err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500,
			fmt.Errorf("HTTP %d for %s", resp.StatusCode, rawURL)
	}

	remaining := d.byteLimit - d.sitemapBytes
	readLimit := min(int64(50*1024*1024), remaining+1)
	body, err := io.ReadAll(io.LimitReader(resp.Body, readLimit)) // 50 MiB per sitemap
	// ReadAll can return both bytes and an error. Charge those bytes before a
	// retry, otherwise repeated partial responses bypass the aggregate limit.
	d.sitemapBytes += int64(len(body))
	if int64(len(body)) > remaining {
		return nil, resp.StatusCode, false, fmt.Errorf("%w: at most %d sitemap bytes", errDiscoveryBudget, d.byteLimit)
	}
	if err != nil {
		return nil, resp.StatusCode, true, fmt.Errorf("failed to read response body: %w", err)
	}

	return body, resp.StatusCode, false, nil
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
		if errors.Is(err, errDiscoveryBudget) {
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

	if err := d.reserveRequest(); err != nil {
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
