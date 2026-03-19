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
* **Fetch Retries**: Sitemap requests retry transient fetch failures before giving up.
* **Complete Discovery Requirement**: Shopkeeper does not continue into scanning with a partial sitemap index. If any nested sitemap still fails after retries, discovery returns an error and the scan fails instead of silently scanning an incomplete URL set.
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
* Retries transient sitemap fetch failures up to 3 times with short backoff
* Uses a dedicated `http.Client` configuration for sitemap requests

## Output

A distinct slice of validated, deduplicated URL strings ready to be consumed by the **Juicer** module.
