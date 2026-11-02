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

The dashboard has a bounded waiting queue per UI process. Shopkeeper independently checks the current PDF setting and admits up to the configured number of PDF requests per backend process, including direct backend requests. Both sides hold their permits until their response write/stream completes or is cancelled, so slow clients can temporarily make new PDFs return 503 with `Retry-After`. Generated PDFs over 64 MiB are rejected before Shopkeeper sends headers; the dashboard also stops an oversized upstream stream. These are process-local guards, not a database-wide semaphore. CSV/LLM generation does not use the PDF limiter.

Canonical MCP artifact reads have a separate two-response limit per dashboard process. A slot is held from artifact preparation through the encoded JSON-RPC response's delivery. Excess reads return a retryable tool error before preparing an artifact. On the supported Node server, the 30-second delivery deadline destroys a stalled response and its socket; admission waits for actual socket closure or successful response completion. Copied 64 KiB chunks avoid retaining the complete serialized artifact in one blocked socket write. The existing 4 MiB raw-file cap still applies; base64 or JSON encoding can make the response larger.

MCP CSV/LLM preparation uses its own read-only snapshot and connection rather than the ordinary pool. Each selected query is measured before raw rows reach Node; the cumulative budget is 16,384 rows and a conservative 32 MiB logical-text/row estimate. PostgreSQL statement timeouts shrink with the 30-second preparation budget, and connection startup is limited to five seconds. A disconnected statement keeps its admission slot until its SQL timeout when completion is uncertain. Both sampled and full CSV, and LLM output, stream into the exact 4 MiB file check so repeated fields cannot build an oversized complete string first. These are estimated preparation limits, not an RSS cap. Ordinary CSV/LLM downloads and other score reads retain their existing costs.

The direct HTML/PDF report path now measures each database projection before fetching its rows into the UI process, in one read-only repeatable-read snapshot. A report is refused once the cumulative estimate exceeds 4,096 rows or 8 MiB of weighted text and row overhead. PostgreSQL statements have a 30-second timeout. The HTML route shows a size message; Shopkeeper returns PDF HTTP 413 with a same-scope, dashboard-relative Full CSV path instead of a partial file. The existing 64 MiB generated-PDF limit also returns 413. Full CSV keeps its separate complete, streamed export and normal format permission checks. This bounds selected report data entering Node, not PostgreSQL aggregate work, Chromium render memory, or total process RSS.

Full PDF occurrence sampling defaults to 30 per group, scoped PDF to 2000, small CSV to 5, and LLM to 3. Limits are report samples, not scan-time limits and not deletion of saved evidence. Full CSV streams all occurrences in keyset-paged batches of 5000 rather than loading every occurrence into one array; it still performs work proportional to the full export and can be expensive for a large scan.

Juicer's five workers, 30-second page deadline, and 500ms politeness delay are code constants, not dashboard performance settings. The scanner admits at most two active scan pipelines per Shopkeeper process; further `pending` scans stay in the database queue. A long scan schedules pages for ten minutes, checkpoints each finished page, then moves behind older pending work if pages remain. The occupied slot can last longer while up to five in-flight pages and their serialized, individually bounded database checkpoints drain; this is a fairness improvement, not a strict ten-minute end-to-end deadline. Sitemap profiling has its own roughly ten-minute admission slices before page scanning begins. Completed sitemap documents, probe outcomes, and cumulative budgets are checkpointed before requeueing; a network drain or bounded XML checkpoint tail can extend a slot. There is no cumulative 30-minute discovery stop after migration `000020`, but the request, XML, candidate, depth, and per-document ceilings still apply. The complete eligible list is published atomically before page workers or a companion link check can use it. Five page workers still apply within each active scan, so PDFs and scans can compete for Chromium CPU/memory. The raw axe-result budget carries across automatic slices in one process but resets after a process restart, as it did for a manually resumed run. Run one Shopkeeper per database; this queue is not a distributed worker lease.

The page-local browser proxy also limits transferred payload to 256 MiB per page and 1 GiB across active pages in one Shopkeeper process. A page that exceeds either limit fails instead of saving partial audit evidence; the process allowance is reused when a page closes. These are network-transfer ceilings, not Chromium memory limits or a cumulative daily/whole-scan bandwidth quota.

## Link-Check Costs

The HTTP link runner is separate from Juicer and the PDF limiter. It runs at most two jobs per Shopkeeper process, with sequential source/target requests inside each job and bounded pages, targets, references, request count, body size, and deadlines. The dashboard report-concurrency setting does not tune this worker pool. An optional companion waits for its own accessibility parent to complete; it does not wait for every other job on the instance.

Link history/results are SQL-paginated. Result lists preview at most five sources per destination; the source endpoint pages retained references independently. New checks append ordered source rows instead of rewriting a growing JSONB array whenever another page repeats a destination. Historical JSONB results remain readable. Progress counters, changed target metadata, and new source rows commit together under the job's running-state guard. CSV reads one consistent SQL snapshot and spools complete rows to a bounded temporary file before delivery. Retained references and repeated checks still consume database/storage/network resources and belong in representative-load measurements.

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
