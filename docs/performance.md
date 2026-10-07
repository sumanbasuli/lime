# Performance And Caching Strategy

LIME caches score and issue summaries in PostgreSQL to speed up dashboard and report reads. This guide explains which caches are active, how they stay current, and how to measure changes in performance.

## Priorities

The main areas to measure are:

- dashboard recent scans and score summaries
- scan detail score and coverage summaries
- issue page first render
- issue chunk and detail endpoints
- PDF, CSV, and LLM report input loading

Measure scan throughput separately from the time it takes to load and export saved results.

## Cache Model

PostgreSQL stores the derived summaries used by dashboard and report reads.

Derived data:

- per-scan score and coverage summaries
- per-scan issue-card summaries for failed and needs-review checks
- score cache rows written by the existing Next scorer, also read by direct Shopkeeper MCP when fresh

`scan_report_data_cache` is reserved for a future report cache. Reports currently query their data and generate files on demand, so `reportDataCacheTtlSeconds` does not affect report responses.

Low-churn data also has process/request-local caching:

- ACT catalog
- axe rule metadata
- server-wide settings

Settings are cached for five seconds per UI process. Saving through the settings route invalidates that process's copy; another UI process can observe the change after its local TTL. Catalog loaders use React's `cache`; do not assume an operator-edited JSON file will refresh every running process immediately. Restart/redeploy after replacing catalogs.

LIME does not require Redis. Profile the PostgreSQL queries and indexes before adding another caching service.

## Invalidation

Score and issue summary reads compare the saved scan timestamp and cache age against the current scan and configured TTL. Backend lifecycle/progress updates touch the scan timestamp; triage also explicitly deletes the score and issue caches. Derived data must remain consistent when:

- a scan completes
- a failed-page retry finishes
- false-positive state changes
- report-shaping settings change
- a scan is deleted

Scan deletion cascades to derived cache rows. Report-shaping settings are read by the relevant report routes/loaders; there is no cached report file to invalidate.

Occurrence detail queries are live and paginated (default 25 per request); the issue feed requests 12 groups by default. Current summary loading still assembles the scan's group summaries and slices that list for a page, and a cache hit loads the cached group rows. It avoids loading every node occurrence but is not a fully SQL-paginated group-list implementation. Keep this distinction when diagnosing very large scans.

## Concurrent Cache Replacement

The Next UI owns `scan_issue_summary_cache` replacement. A cache miss can be reached at the same time by server rendering, a post-triage refresh, and chunk requests. Replacing rows with uncoordinated `DELETE`/`INSERT` transactions can produce duplicate-key errors even when each request is individually transactional.

`loadCachedIssueSummaries` locks the parent `scans` row with `FOR UPDATE` before replacing cache rows. It verifies that the scan's current `updated_at` matches the snapshot used to compute the summaries, then performs `DELETE` and `INSERT` while holding that lock. This serializes writers across requests and UI processes, including when the cache has no rows to lock. If the scan was deleted or changed, the obsolete snapshot does not persist cache data.

Keep the scan-row lock and source-timestamp guard together when changing this path. Test concurrent cache misses after triage and confirm both stale snapshots and deleted scans cannot replace newer state. See [Verification And Handoff](verification.md) for the recorded regression evidence.

## Settings

Settings are persisted through the dashboard:

| Setting | Default | Current behavior |
|---------|---------|------------------|
| Summary cache TTL | 60 seconds | Score/issue cache age limit; accepted UI range 5–86400 seconds |
| Report-data cache TTL | 300 seconds | Reserved; no active report-data cache consumer |
| Report generation concurrency | 1 | Bounds PDF generation per Shopkeeper process and the dashboard's per-UI-process proxy; accepted range 1–10 |

The dashboard has a bounded waiting queue per UI process. Shopkeeper independently checks the current PDF setting and admits up to the configured number of Chromium PDF renders per backend process, including direct backend requests. A busy backend returns 503 with `Retry-After`; retry rather than launching unlimited parallel renders. These are process-local guards, not a database-wide semaphore. CSV/LLM generation does not use the PDF limiter.

Full PDF occurrence sampling defaults to 30 per group, scoped PDF to 2000, small CSV to 5, and LLM to 3. Limits are report samples, not scan-time limits and not deletion of saved evidence. Full CSV streams all occurrences in keyset-paged batches of 5000 rather than loading every occurrence into one array; it still performs work proportional to the full export and can be expensive for a large scan.

Juicer's five workers, 30-second page deadline, and 500ms politeness delay are code constants, not dashboard performance settings. Five workers applies per scan run, not a global server-wide cap across simultaneous scans. Increasing report concurrency or submitting many scans together can compete for Chromium CPU/memory.

## Link-Check Costs

The HTTP link runner is separate from Juicer and the PDF limiter. It runs at most two jobs per Shopkeeper process, with sequential source/target requests inside each job and bounded pages, targets, references, request count, body size, and deadlines. The dashboard report-concurrency setting does not tune this worker pool. An optional companion waits for its own accessibility parent to complete; it does not wait for every other job on the instance.

Link history/results are SQL-paginated. Result lists preview at most five sources per destination; the source endpoint pages the retained JSONB references independently. Snapshots replace bounded target rows transactionally under the job's running-state guard. CSV reads a consistent bounded target/source snapshot in one SQL query and buffers the export; it is not the accessibility full-CSV streaming path. Retained references and repeated checks still consume database/storage/network resources and belong in representative-load measurements.

See [Link Checker Architecture](architecture/link-checker.md) for limits, partial coverage, network rules, recovery, and schema. Each check runs once and stops at its configured limits; it does not monitor the site continuously.

## Verification

Before and after optimization work, measure:

- dashboard load time
- scan detail score summary load time
- issue page initial render time
- issue chunk response time
- issue detail response time
- full PDF generation time
- scoped issue PDF generation time

Use representative test data in a separate database, or an authorized read-only production sample. Record the number of scans, pages, groups, and occurrences, along with hardware, runtime versions, cache state, and concurrent work. `make verify-app` checks correctness; use a separate benchmark to measure large-site performance.

Set `LIME_PERF_LOG=true` on the UI process to log every instrumented hot-path timing as `[perf] <label> <milliseconds>`. With no flag, non-production builds log only slow operations above their route threshold (750ms by default); production stays quiet. `LIME_PERF_LOG=false` explicitly suppresses these timings. This is application timing, not PostgreSQL query tracing or browser navigation timing.

## Implementation References

- `lime/src/lib/scan-score-data.ts`: score cache reads/upserts and aggregate audit queries
- `lime/src/lib/scan-issues.ts`: summary cache replacement, group slicing, occurrence queries
- `lime/src/lib/report-settings.ts`: five-second settings cache and accepted ranges
- `lime/src/lib/report-generation-limiter.ts` and `app/api/scans/[id]/issues/report.pdf/route.ts`: PDF limiter scope
- `lime/src/lib/issues-report-data.ts`: live report input loading
- `lime/src/lib/performance-logging.ts`: timing/log thresholds
- `shopkeeper/migrations/000010…000012`: read-path indexes and cache schema
