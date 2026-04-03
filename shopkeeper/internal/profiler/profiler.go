package profiler

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
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
	fetchTimeout    = 30 * time.Second
	fetchRetryDelay = 400 * time.Millisecond
	maxFetchRetries = 3
	xmlAcceptHeader = "application/xml,text/xml;q=0.9,*/*;q=0.8"
)

var httpClient = newHTTPClient()

type requestProfile struct {
	name      string
	userAgent string
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

// Discover fetches a sitemap URL and recursively extracts all page URLs.
// It handles both <sitemapindex> (nested sitemaps) and <urlset> (direct URLs).
// Returns a deduplicated, validated slice of URL strings.
func Discover(ctx context.Context, sitemapURL string) ([]string, error) {
	seen := make(map[string]bool)
	var result []string

	if err := discoverRecursive(ctx, sitemapURL, seen, &result, 0); err != nil {
		return nil, err
	}

	log.Printf("Profiler: discovered %d unique URLs from %s", len(result), sitemapURL)
	return result, nil
}

const maxDepth = 10

func discoverRecursive(ctx context.Context, sitemapURL string, seen map[string]bool, result *[]string, depth int) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	if depth > maxDepth {
		return fmt.Errorf("exceeded maximum sitemap nesting depth (%d)", maxDepth)
	}

	body, err := fetchURL(ctx, sitemapURL)
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
			if err := discoverRecursive(ctx, loc, seen, result, depth+1); err != nil {
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
				seen[loc] = true
				*result = append(*result, loc)
			}
		}
		return nil
	}

	return fmt.Errorf("could not parse %s as either sitemapindex or urlset", sitemapURL)
}

func fetchURL(ctx context.Context, rawURL string) ([]byte, error) {
	var lastErr error

	for i, profile := range sitemapFetchProfiles {
		body, statusCode, err := fetchURLWithRetries(ctx, rawURL, profile)
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

func fetchURLWithRetries(ctx context.Context, rawURL string, profile requestProfile) ([]byte, int, error) {
	var lastErr error
	var lastStatusCode int

	for attempt := 1; attempt <= maxFetchRetries; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, 0, err
		}

		body, statusCode, shouldRetry, err := fetchURLOnce(ctx, rawURL, profile)
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

func fetchURLOnce(ctx context.Context, rawURL string, profile requestProfile) ([]byte, int, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, 0, false, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Accept", xmlAcceptHeader)
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("User-Agent", profile.userAgent)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, 0, true, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500,
			fmt.Errorf("HTTP %d for %s", resp.StatusCode, rawURL)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 50*1024*1024)) // 50MB limit
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
	return u.Scheme == "http" || u.Scheme == "https"
}
