# Performance And Caching Strategy

LIME uses PostgreSQL-backed score and issue summaries to reduce repeated aggregation without adding another required service. This page distinguishes the implemented caches from reserved infrastructure; it is not a performance benchmark or a guarantee for a particular scan size.

## Priorities

The first optimization pass targets read and report latency:

- dashboard recent scans and score summaries
- scan detail score and coverage summaries
- issue page first render
- issue chunk and detail endpoints
- PDF, CSV, and LLM report input loading

Scan throughput remains important, but it comes after the large-report read paths are bounded and measurable.

## Cache Model

PostgreSQL is the durable cache/read-model layer.

Derived data:

- per-scan score and coverage summaries
- per-scan issue-card summaries for failed and needs-review checks
- score cache rows written by the existing Next scorer, also read by direct Shopkeeper MCP when fresh

`scan_report_data_cache` has a migration and Drizzle table definition, but there is currently no report-loader/route using it. Report data is queried and files generated on demand. `reportDataCacheTtlSeconds` is stored/exposed for that reserved cache, not an effective report-response TTL today.

Low-churn data also has process/request-local caching:

- ACT catalog
- axe rule metadata
- server-wide settings

Settings are cached for five seconds per UI process. Saving through the settings route invalidates that process's copy; another UI process can observe the change after its local TTL. Catalog loaders use React's `cache`; do not assume an operator-edited JSON file will refresh every running process immediately. Restart/redeploy after replacing catalogs.

Redis is intentionally deferred until profiling proves a concrete need that PostgreSQL read models and indexes cannot satisfy.

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
| Report generation concurrency | 1 | Bounds PDF upstream generation per UI process; accepted range 1–10 |

The PDF limiter is not a database-wide semaphore. Multiple UI processes each have their own limit, and direct Shopkeeper PDF requests bypass the Next settings/limiter. CSV/LLM generation does not use this PDF limiter. Use dashboard report endpoints for the documented controls.

Full PDF occurrence sampling defaults to 30 per group, scoped PDF to 2000, small CSV to 5, and LLM to 3. Limits are report samples, not scan-time limits and not deletion of saved evidence. Full CSV streams all occurrences in keyset-paged batches of 5000 rather than loading every occurrence into one array; it still performs work proportional to the full export and can be expensive for a large scan.

Juicer's five workers, 30-second page deadline, and 500ms politeness delay are code constants, not dashboard performance settings. Five workers applies per scan run, not a global server-wide cap across simultaneous scans. Increasing report concurrency or submitting many scans together can compete for Chromium CPU/memory.

## Link-Check Costs

The HTTP link runner is separate from Juicer and the PDF limiter. It runs at most two jobs per Shopkeeper process, with sequential source/target requests inside each job and bounded pages, targets, references, request count, body size, and deadlines. The dashboard report-concurrency setting does not tune this worker pool. An optional companion waits for its own accessibility parent to complete; it does not wait for every other job on the instance.

Link history/results are SQL-paginated. Result lists preview at most five sources per destination; the source endpoint pages the retained JSONB references independently. Snapshots replace bounded target rows transactionally under the job's running-state guard. CSV reads a consistent bounded target/source snapshot in one SQL query and buffers the export; it is not the accessibility full-CSV streaming path. Retained references and repeated checks still consume database/storage/network resources and belong in representative-load measurements.

See [Link Checker Architecture](architecture/link-checker.md) for exact budgets, truncation semantics, network trust, recovery, and schema. Do not call a bounded one-shot job a recurring monitor or a complete arbitrary-size site crawl.

## Verification

Before and after optimization work, measure:

- dashboard load time
- scan detail score summary load time
- issue page initial render time
- issue chunk response time
- issue detail response time
- full PDF generation time
- scoped issue PDF generation time

Measure with a disposable representative scan/fixture or an authorized read-only production sample, and record scan/page/group/occurrence counts, hardware, runtime versions, warm/cold cache state, and concurrency. Do not generate destructive test data in the normal operator database. The deterministic `make verify-app` suite checks correctness; it is not a thousands-of-pages load test.

Set `LIME_PERF_LOG=true` on the UI process to log every instrumented hot-path timing as `[perf] <label> <milliseconds>`. With no flag, non-production builds log only slow operations above their route threshold (750ms by default); production stays quiet. `LIME_PERF_LOG=false` explicitly suppresses these timings. This is application timing, not PostgreSQL query tracing or browser navigation timing.

## Implementation References

- `lime/src/lib/scan-score-data.ts`: score cache reads/upserts and aggregate audit queries
- `lime/src/lib/scan-issues.ts`: summary cache replacement, group slicing, occurrence queries
- `lime/src/lib/report-settings.ts`: five-second settings cache and accepted ranges
- `lime/src/lib/report-generation-limiter.ts` and `app/api/scans/[id]/issues/report.pdf/route.ts`: PDF limiter scope
- `lime/src/lib/issues-report-data.ts`: live report input loading
- `lime/src/lib/performance-logging.ts`: timing/log thresholds
- `shopkeeper/migrations/000010…000012`: read-path indexes and cache schema
