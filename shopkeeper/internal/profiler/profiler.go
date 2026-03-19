package profiler

import (
	"encoding/xml"
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

var httpClient = &http.Client{
	Timeout: 30 * time.Second,
}

// Discover fetches a sitemap URL and recursively extracts all page URLs.
// It handles both <sitemapindex> (nested sitemaps) and <urlset> (direct URLs).
// Returns a deduplicated, validated slice of URL strings.
func Discover(sitemapURL string) ([]string, error) {
	seen := make(map[string]bool)
	var result []string

	if err := discoverRecursive(sitemapURL, seen, &result, 0); err != nil {
		return nil, err
	}

	log.Printf("Profiler: discovered %d unique URLs from %s", len(result), sitemapURL)
	return result, nil
}

const maxDepth = 10

func discoverRecursive(sitemapURL string, seen map[string]bool, result *[]string, depth int) error {
	if depth > maxDepth {
		return fmt.Errorf("exceeded maximum sitemap nesting depth (%d)", maxDepth)
	}

	body, err := fetchURL(sitemapURL)
	if err != nil {
		return fmt.Errorf("failed to fetch sitemap %s: %w", sitemapURL, err)
	}

	// Try parsing as sitemapindex first
	var index sitemapIndex
	if err := xml.Unmarshal(body, &index); err == nil && len(index.Sitemaps) > 0 {
		log.Printf("Profiler: found sitemapindex at %s with %d sitemaps", sitemapURL, len(index.Sitemaps))
		for _, entry := range index.Sitemaps {
			loc := strings.TrimSpace(entry.Loc)
			if loc == "" {
				continue
			}
			if err := discoverRecursive(loc, seen, result, depth+1); err != nil {
				log.Printf("Profiler: warning: failed to process nested sitemap %s: %v", loc, err)
				// Continue processing other sitemaps rather than failing entirely
			}
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

func fetchURL(rawURL string) ([]byte, error) {
	resp, err := httpClient.Get(rawURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d for %s", resp.StatusCode, rawURL)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 50*1024*1024)) // 50MB limit
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	return body, nil
}

func isValidURL(rawURL string) bool {
	u, err := url.ParseRequestURI(rawURL)
	if err != nil {
		return false
	}
	return u.Scheme == "http" || u.Scheme == "https"
}
