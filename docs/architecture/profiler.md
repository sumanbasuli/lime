# Profiler (Sitemap Scanner)

**Profiler** is the first module in the Shopkeeper scanning pipeline.

## Responsibility

Profiler reads sitemaps, follows page redirects, and returns eligible pages on the same host. Juicer then scans those pages for accessibility issues. If a companion [link check](link-checker.md) is selected, it uses the saved page list after the accessibility scan completes.

## Implementation

**File**: `shopkeeper/internal/profiler/profiler.go`

**Entry point**: `Discover(ctx context.Context, sitemapURL string) ([]string, error)`

### Features

* **Recursive Processing**: Handles both `<urlset>` (direct URLs) and `<sitemapindex>` (nested sitemaps). When a sitemapindex is found, each nested sitemap is fetched and parsed recursively.
* **Max Depth**: Recursion is limited to 10 levels to prevent infinite loops.
* **De-duplication**: Uses a `map[string]bool` to ensure URLs are unique before returning.
* **Validation**: Each URL is validated using `url.ParseRequestURI` — only `http://` and `https://` schemes are accepted.
* **Fetch Retries**: Sitemap requests retry transient fetch failures before giving up.
* **Complete Discovery Requirement**: Shopkeeper does not continue into scanning with a partial sitemap index. If any nested sitemap still fails after retries, discovery returns an error and the scan fails instead of silently scanning an incomplete URL set.
* **Response Limit**: Reads up to 50 MiB per sitemap through `io.LimitReader`. The XML must parse successfully; there is no separate Content-Length validation.

### Page Eligibility After XML Discovery

Profiler makes a browser-profile HTTP **GET**, not HEAD, for each distinct discovered page to follow redirects. It uses up to 12 resolution workers and a 10-second context deadline per candidate. It does not run JavaScript during this step or read the page into Chromium.

- The final page authority must match the original sitemap authority. Hostnames are case-normalized; default HTTP/HTTPS ports are normalized away, while nondefault ports remain significant.
- Cross-host redirects and unresolved requests are skipped. Successful redirected URLs are canonicalized, fragments removed, and deduplicated again; the retained order follows XML discovery order.
- HTTP error status alone does not exclude a candidate if a final response URL is available. A network/redirect-resolution failure does.
- Logs report unique discovered, retained, redirected, cross-host, and unresolved counts. `total_urls` reflects the retained set, not every `<loc>` in the XML.

This is separate from the complete nested-sitemap requirement: one failed nested sitemap fails discovery, whereas an individual unresolved page candidate is filtered out. A single-URL scan bypasses Profiler and goes directly to Juicer.

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
* Up to 3 attempts for transient sitemap failures (network/read errors, HTTP 429, and 5xx), with 400ms/800ms backoff
* Uses a dedicated `http.Client` configuration for sitemap requests
* Starts with the LIME scanner user agent; a 403 switches once to a browser-profile user agent
* Receives the parent scan-run context so a pause can cancel in-flight discovery/resolution requests

## Output

A deduplicated list of eligible URLs for **Juicer** to scan.

## Verification And Failure Diagnosis

`shopkeeper/internal/profiler/profiler_test.go` covers sitemap parsing, retries/fallback, redirect eligibility, deduplication, and cancellation. When discovery fails, inspect Shopkeeper's `Profiler:` logs for the exact nested sitemap or filtering totals. A public browser successfully loading a URL does not prove the backend container can reach it; `localhost` in a scan target means the scanner's own runtime, not the user's browser machine.
