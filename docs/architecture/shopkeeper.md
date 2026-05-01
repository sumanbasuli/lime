# Shopkeeper (Main Backend Orchestrator)

**Shopkeeper** is the central orchestrator of the accessibility scanner system. It is designed to be a standalone REST API built in **Go**.

## Responsibilities

1. **API Endpoints**: Expose endpoints for the UI (NextJS) to initiate new scans, check scan status, and retrieve results.
2. **Orchestration**: Coordinate the execution of its three internal modules:
    * **Profiler**: Taking a starting sitemap URL and fetching all target URLs.
    * **Juicer**: Distributing the URLs to the scanner workers while respecting concurrency limits.
    * **Sweetner**: Sending the raw Juicer results to be formatted and aggregated.
3. **Data Persistence**: Save the refined scan data to the database.

## Architecture

### Package Structure

```
shopkeeper/
├── cmd/shopkeeper/main.go          — Entrypoint: DB connect, migrations, chromedp allocator, server
├── internal/
│   ├── actrules/resolver.go        — Loads shared ACT catalog and enriches issues at read time
│   ├── config/config.go            — Env-based config (DATABASE_URL, SHOPKEEPER_PORT)
│   ├── database/database.go        — pgxpool connection + golang-migrate runner
│   ├── models/models.go            — Domain structs: Scan, URL, Issue, IssueOccurrence, Stats
│   ├── repository/repository.go    — All DB CRUD operations via pgx
│   ├── handler/handler.go          — HTTP handlers with ScanRunner interface
│   ├── router/router.go            — Chi router with CORS, middleware, all routes
│   ├── scanner/scanner.go          — Async scan pipeline orchestrator
│   ├── viewport/presets.go         — Scan viewport preset validation + stored dimensions
│   ├── profiler/profiler.go        — Sitemap XML parser
│   ├── juicer/                     — chromedp + axe-core scanner
│   │   ├── juicer.go               — Worker pool, page scanning
│   │   ├── types.go                — RawResult, Violation, Node
│   │   ├── axecore.go              — Embedded axe.min.js
│   │   └── axe.min.js              — axe-core 4.10.2
│   └── sweetner/sweetner.go        — Result deduplication + DB persistence
└── migrations/
    ├── 000001_init_schema.up.sql
    └── 000001_init_schema.down.sql

repo root
├── data/act-rules.json             — Shared checked-in ACT catalog used by Go + Next at read time
└── scripts/refresh-act-data.mjs    — Refreshes the ACT catalog from axe metadata + official ACT sources
```

### API Endpoints

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/health` | HealthCheck | Service health status |
| GET | `/api/stats` | GetStats | Dashboard aggregates (total scans/issues/pages) |
| POST | `/api/scans` | CreateScan | Create scan + launch async pipeline |
| GET | `/api/scans` | ListScans | List all scans (desc by date) |
| POST | `/api/scans/{id}/rescan` | RescanScan | Create a fresh scan from a completed/failed scan |
| POST | `/api/scans/{id}/retry-failed` | RetryFailedPages | Requeue failed pages on a completed partial scan and continue the same scan |
| GET | `/api/scans/{id}` | GetScan | Single scan detail |
| DELETE | `/api/scans/{id}` | DeleteScan | Delete a completed/failed scan and related data |
| GET | `/api/scans/{id}/issues` | GetScanIssues | Issues with occurrences for a scan, enriched with ACT context and suggested fixes |
| POST | `/api/scans/{id}/issues/{issueId}/false-positive` | MarkIssueFalsePositive | Mark a scan issue as a false positive |
| DELETE | `/api/scans/{id}/issues/{issueId}/false-positive` | UnmarkIssueFalsePositive | Remove the false-positive mark from a scan issue |

### Dependency Injection

The handler uses an interface `ScanRunner` to avoid circular dependencies:
```go
type ScanRunner interface {
    RunScan(scan models.Scan)
}
```
The `scanner.Scanner` implements this interface. The handler launches scans asynchronously via `go h.scanner.RunScan(...)`, passing the persisted scan config so rescans and restart recovery keep the same viewport.

## Workflow

1. UI sends a POST request containing a `sitemap_url` to Shopkeeper.
2. Shopkeeper validates the URL, resolves the requested viewport preset, and creates a `Scan` record with status `pending`.
3. Shopkeeper launches an async goroutine that runs the scan pipeline.
4. Pipeline updates status to `profiling`, calls Profiler to discover URLs.
5. Profiler must finish full sitemap discovery before scanning starts. If any nested sitemap still fails after retries, the scan fails instead of continuing with a partial URL set.
6. Discovered URLs are bulk-inserted into the DB; status moves to `scanning`.
7. Juicer scans pages with 5-concurrent workers using the scan's persisted viewport dimensions; progress updates in real-time. Its accessibility execution is now aligned more closely with Lighthouse’s accessibility gatherer, using WCAG A/AA tags, curated rule overrides, node references, failure summaries, and scroll reset behavior before screenshot work begins. If a late page-settle wait times out after the document is already usable, Juicer still continues into rule execution instead of dropping that page immediately.
8. Status moves to `processing`; Sweetner deduplicates and stores issues from successfully scanned pages.
9. Status is set to `completed` when at least one page scanned successfully. If every page errors, or a pipeline step fails, status is set to `failed`.
10. If a completed scan still has failed URL rows, `POST /api/scans/{id}/retry-failed` can reset only those failed rows to `pending`, reset `scanned_urls` to the completed-page count, and relaunch the same scan ID through the normal resume path.

The async execution is backend-owned. Browser navigation only affects UI polling, not the actual scan job.

## ACT Enrichment Model

- Sweetner remains the canonical writer for issue records. It stores the accessibility `violation_type` and base issue metadata only.
- ACT metadata is added at read time, not persisted in PostgreSQL. This keeps the DB schema unchanged while allowing the ACT catalog to evolve independently.
- `GET /api/scans/{id}/issues` loads the DB issues first, then resolves `violation_type -> act_rule_ids[] -> act_rules[]` through `internal/actrules/resolver.go`.
- Suggested fixes are deterministic and local. They come from the checked-in ACT catalog and curated rule-level guidance, not from runtime AI generation and not from live W3C requests.
- If no ACT mapping exists for an axe rule, the API still returns the original issue shape with `act_rules: []` and `suggested_fixes: []`.

## Issue Triage State

- Issues now persist a local triage flag in PostgreSQL through `issues.is_false_positive`.
- The false-positive flag is intentionally lightweight in this phase. It does not remove issues from scan results, change dashboard counts, or alter ACT enrichment.
- Shopkeeper exposes explicit mark and unmark routes so the Next UI can update issue state without writing to the database directly.
- The flag is scan-specific because issue rows are scan-specific; marking an issue in one scan does not affect future rescans.

### Catalog Source of Truth

- The checked-in catalog lives at `data/act-rules.json`.
- The generator script `scripts/refresh-act-data.mjs` combines:
  - axe-core 4.10.2 `actIds` mappings from the embedded `juicer/axe.min.js`
  - official ACT metadata from `https://act-rules.github.io/testcases.json`
  - official W3C ACT rule URLs under `https://www.w3.org/WAI/standards-guidelines/act/rules/`
  - curated deterministic remediation guidance maintained in-repo
- Runtime services read the catalog from `ACT_RULES_PATH` when set. Docker mounts it at `/shared-data/act-rules.json`.

## Scan Lifecycle Management

- Each scan now stores `viewport_preset`, `viewport_width`, and `viewport_height` on the `scans` row. Shopkeeper resolves these at create time and reuses them for every page in the scan.
- Rescans create a brand new `scans` row and re-run the pipeline with the original target URL, scan type, tag, and viewport.
- Failed-page retries keep the same `scans` row. They are limited to completed partial scans with at least one completed page and at least one failed page.
- Deletes are limited to terminal scans (`completed` or `failed`) so an active background job is never orphaned.
- Database cleanup relies on `ON DELETE CASCADE`, and Shopkeeper removes the scan's screenshot directory after a successful delete. Docker/Fly use `/app/screenshots/{scanId}`; native installs can override the physical root with `SHOPKEEPER_SCREENSHOT_DIR`.
- On startup, Shopkeeper re-queues any scan left in `pending`, `profiling`, `scanning`, or `processing`. Partial URLs/issues/screenshots are cleared first so the recovered run starts cleanly with the same scan ID and viewport.

### Recovery Model

- Recovery is process-start based, not queue based. If the Shopkeeper process exits while a scan is running, the scan resumes the next time Shopkeeper starts.
- Recovery keeps the same scan ID so the existing UI route and DB record remain valid.
- Recovery intentionally discards partial per-scan artifacts before rerunning so the final data set is consistent.
