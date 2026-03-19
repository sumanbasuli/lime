# Profiler (Sitemap Scanner)

**Profiler** is the first module in the Shopkeeper scanning pipeline.

## Responsibility

To extract a complete list of individual page URLs from a given sitemap URL.

## Implementation

**File**: `shopkeeper/internal/profiler/profiler.go`

**Entry point**: `Discover(sitemapURL string) ([]string, error)`

### Features

* **Recursive Processing**: Handles both `<urlset>` (direct URLs) and `<sitemapindex>` (nested sitemaps). When a sitemapindex is found, each nested sitemap is fetched and parsed recursively.
* **Max Depth**: Recursion is limited to 10 levels to prevent infinite loops.
* **De-duplication**: Uses a `map[string]bool` to ensure URLs are unique before returning.
* **Validation**: Each URL is validated using `url.ParseRequestURI` — only `http://` and `https://` schemes are accepted.
* **Error Resilience**: If a nested sitemap fails to fetch, the error is logged but processing continues for the remaining sitemaps.
* **Size Limit**: Response bodies are limited to 50MB to prevent memory exhaustion.

### XML Structures

```go
type sitemapIndex struct {
    Sitemaps []sitemapEntry `xml:"sitemap"`
}

type urlSet struct {
    URLs []urlEntry `xml:"url"`
}
```

### HTTP Client

* Timeout: 30 seconds per request
* Standard Go `http.Client`

## Output

A distinct slice of validated, deduplicated URL strings ready to be consumed by the **Juicer** module.
