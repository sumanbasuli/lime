# Profiler (Sitemap Scanner)

**Profiler** is the first module in the Shopkeeper scanning pipeline.

## Responsibility

Profiler reads sitemaps, follows page redirects, and returns eligible pages on the same host. Juicer then scans those pages for accessibility issues. If a companion [link check](link-checker.md) is selected, it uses the saved page list after the accessibility scan completes.

## Implementation

**File**: `shopkeeper/internal/profiler/profiler.go`

**Entry points**: `Discover(ctx context.Context, sitemapURL string) ([]string, error)` remains available for direct use. The scanner calls `DiscoverCheckpointed` with a repository store, admission epoch, and root DNS policy hooks so discovery can resume from saved work and record the root classification before dialing.

### Features

* **Recursive Processing**: Handles both `<urlset>` (direct URLs) and `<sitemapindex>` (nested sitemaps). When a sitemapindex is found, each nested sitemap is fetched and parsed recursively.
* **Max Depth**: Recursion is limited to 10 levels to prevent infinite loops.
* **De-duplication**: Fetches each normalized sitemap URL once, including repeated and cyclic index entries. It also deduplicates discovered page URLs before eligibility checks and final redirect targets before returning.
* **Validation**: Each URL is validated using `url.ParseRequestURI` — only `http://` and `https://` schemes are accepted. Nested sitemaps and page URLs must have the entered sitemap's authority before Profiler requests them; redirects to another authority are not followed.
* **Fetch Retries**: Sitemap requests retry transient fetch failures before giving up.
* **Complete Discovery Requirement**: Shopkeeper does not continue into scanning with a partial sitemap index. If any nested sitemap still fails after retries, discovery returns an error and the scan fails instead of silently scanning an incomplete URL set.
* **Response Limit**: Reads up to 50 MiB per sitemap through `io.LimitReader`. The XML must parse successfully; there is no separate Content-Length validation.
* **Discovery Budget**: One scan's sitemap discovery may make at most 20,000 HTTP requests (including retries, page probes, and redirects), read 128 MiB of sitemap XML in total, and collect at most 10,000 distinct raw page candidates. The limits survive yield, pause, and restart. The 50 MiB per-sitemap limit and depth limit also remain. Reaching a limit returns an explicit error; no partial page list goes to Juicer. These limits apply only to sitemap profiling, not single-URL scans. The former cumulative 30-minute discovery stop no longer applies to checkpointed scans.

Checkpointed discovery uses its own ten-minute fairness slices before page scanning begins. At a slice boundary, Shopkeeper saves completed sitemap documents and page-probe outcomes, returns the scan to `pending`, and lets older queued scans use the slot. A network request already in flight may need to settle, and a completed XML document can take a bounded checkpoint tail, so an occupied slot can exceed ten minutes. Pausing or restarting retains committed discovery work; only unfinished fetches or probes may repeat. There is no cumulative elapsed-time stop after migration `000020`. Page scanning has separate ten-minute slices after the eligible URL list is complete.

Migration `000020` stores the sitemap frontier, candidate order and outcomes, cumulative budgets, active-time accounting, and an admission epoch. The scanner publishes the final deduplicated eligible URLs into `urls` with the `complete` phase in one transaction. Until that commit, `urls` remains empty and neither Juicer nor a companion link check sees a partial discovery list. Historical scans with saved `urls` but no discovery row remain readable and continue their existing page workflow.

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
* Resolves the entered host once per admitted discovery slice and dials one of the approved IP addresses directly for later same-authority requests in that slice. Mixed public/non-public DNS answers are rejected. The scanner commits that answer's public-only classification to the scan and any companion in PostgreSQL before Profiler dials; each private-root TCP dial also holds a policy lease until it finishes. A newly submitted private-only root remains supported; once the scan has seen a public answer, a later private answer is blocked in Profiler, Juicer, or its companion link check. The pinned IP set is specific to an admission, while the classification survives resume, retry, and rescan. The dedicated transport does not use ambient HTTP proxy settings.
* Starts with the LIME scanner user agent; a 403 switches once to a browser-profile user agent
* Receives the parent scan-run context so a pause can cancel in-flight discovery/resolution requests
* Page-probe workers and their queue also stop on cancellation, so pausing during profiling can settle the scan instead of leaving its producer waiting for a worker

## Output

A complete, deduplicated list of eligible URLs for **Juicer** to scan. The list is published atomically only after all nested sitemaps and candidate probes finish. Entries beyond the stated discovery caps are not audited; exceeding a cap fails discovery rather than publishing a truncated list.

## Verification And Failure Diagnosis

`shopkeeper/internal/profiler/profiler_test.go` and `checkpoint_test.go` cover sitemap parsing, retries/fallback, redirect eligibility, deduplication, aggregate limits, checkpoints, and cancellation while page probes are active. Repository integration tests cover durable state and atomic publication. When discovery fails, inspect Shopkeeper's `Profiler:` logs and scan error for the exact nested sitemap, budget, or filtering totals. A public browser successfully loading a URL does not prove the backend container can reach it; `localhost` in a scan target means the scanner's own runtime, not the user's browser machine.
