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
* **De-duplication**: Fetches each normalized sitemap URL once, including repeated and cyclic index entries. It also deduplicates discovered page URLs before eligibility checks and final redirect targets before returning.
* **Validation**: Each URL is validated using `url.ParseRequestURI` — only `http://` and `https://` schemes are accepted. Nested sitemaps and page URLs must have the entered sitemap's authority before Profiler requests them; redirects to another authority are not followed.
* **Fetch Retries**: Sitemap requests retry transient fetch failures before giving up.
* **Complete Discovery Requirement**: Shopkeeper does not continue into scanning with a partial sitemap index. If any nested sitemap still fails after retries, discovery returns an error and the scan fails instead of silently scanning an incomplete URL set.
* **Response Limit**: Reads up to 50 MiB per sitemap through `io.LimitReader`. The XML must parse successfully; there is no separate Content-Length validation.
* **Discovery Budget**: One discovery may make at most 20,000 HTTP requests (including retries, page probes, and redirects), read 128 MiB of sitemap XML in total, collect 10,000 distinct page URLs, and run for 30 minutes. Reaching a limit returns an explicit error; it never passes a partial page list to Juicer. These limits apply only to sitemap profiling, not single-URL scans.

### Page Eligibility After XML Discovery

Profiler makes a browser-profile HTTP **GET**, not HEAD, for each distinct discovered page on the entered sitemap's authority to follow allowed redirects. It uses up to 12 resolution workers and a 10-second context deadline per candidate. It does not run JavaScript during this step or read the page into Chromium.

- The final page authority must match the original sitemap authority. Hostnames are case-normalized; default HTTP/HTTPS ports are normalized away, while nondefault ports remain significant.
- Off-authority page URLs are skipped without a request. Redirects to another authority are refused before following them; unresolved requests are skipped. Successful same-authority redirects are canonicalized, fragments removed, and deduplicated again; the retained order follows XML discovery order.
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
* Uses a dedicated `http.Client` configuration for sitemap requests, with a per-discovery redirect guard
* Starts with the LIME scanner user agent; a 403 switches once to a browser-profile user agent
* Receives the parent scan-run context so a pause can cancel in-flight discovery/resolution requests
* Page-probe workers and their queue also stop on cancellation, so pausing during profiling can settle the scan instead of leaving its producer waiting for a worker

## Output

A deduplicated list of eligible URLs for **Juicer** to scan.

## Verification And Failure Diagnosis

`shopkeeper/internal/profiler/profiler_test.go` covers sitemap parsing, retries/fallback, redirect eligibility, deduplication, aggregate limits, and cancellation while page probes are active. When discovery fails, inspect Shopkeeper's `Profiler:` logs and scan error for the exact nested sitemap, budget, or filtering totals. A public browser successfully loading a URL does not prove the backend container can reach it; `localhost` in a scan target means the scanner's own runtime, not the user's browser machine.
