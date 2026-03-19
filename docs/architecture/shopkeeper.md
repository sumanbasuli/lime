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
│   ├── config/config.go            — Env-based config (DATABASE_URL, SHOPKEEPER_PORT)
│   ├── database/database.go        — pgxpool connection + golang-migrate runner
│   ├── models/models.go            — Domain structs: Scan, URL, Issue, IssueOccurrence, Stats
│   ├── repository/repository.go    — All DB CRUD operations via pgx
│   ├── handler/handler.go          — HTTP handlers with ScanRunner interface
│   ├── router/router.go            — Chi router with CORS, middleware, all routes
│   ├── scanner/scanner.go          — Async scan pipeline orchestrator
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
```

### API Endpoints

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/health` | HealthCheck | Service health status |
| GET | `/api/stats` | GetStats | Dashboard aggregates (total scans/issues/pages) |
| POST | `/api/scans` | CreateScan | Create scan + launch async pipeline |
| GET | `/api/scans` | ListScans | List all scans (desc by date) |
| POST | `/api/scans/{id}/rescan` | RescanScan | Create a fresh scan from a completed/failed scan |
| GET | `/api/scans/{id}` | GetScan | Single scan detail |
| DELETE | `/api/scans/{id}` | DeleteScan | Delete a completed/failed scan and related data |
| GET | `/api/scans/{id}/issues` | GetScanIssues | Issues with occurrences for a scan |

### Dependency Injection

The handler uses an interface `ScanRunner` to avoid circular dependencies:
```go
type ScanRunner interface {
    RunScan(scanID, targetURL, scanType string)
}
```
The `scanner.Scanner` implements this interface. The handler launches scans asynchronously via `go h.scanner.RunScan(...)`.

## Workflow

1. UI sends a POST request containing a `sitemap_url` to Shopkeeper.
2. Shopkeeper validates the URL and creates a `Scan` record with status `pending`.
3. Shopkeeper launches an async goroutine that runs the scan pipeline.
4. Pipeline updates status to `profiling`, calls Profiler to discover URLs.
5. Discovered URLs are bulk-inserted into the DB; status moves to `scanning`.
6. Juicer scans pages with 5-concurrent workers; progress updates in real-time.
7. Status moves to `processing`; Sweetner deduplicates and stores issues.
8. Status is set to `completed`. On any error, status is set to `failed`.

The async execution is backend-owned. Browser navigation only affects UI polling, not the actual scan job.

## Scan Lifecycle Management

- Rescans create a brand new `scans` row and re-run the pipeline with the original target URL, scan type, and tag.
- Deletes are limited to terminal scans (`completed` or `failed`) so an active background job is never orphaned.
- Database cleanup relies on `ON DELETE CASCADE`, and Shopkeeper removes the scan's screenshot directory from `/app/screenshots/{scanId}` after a successful delete.
- On startup, Shopkeeper re-queues any scan left in `pending`, `profiling`, `scanning`, or `processing`. Partial URLs/issues/screenshots are cleared first so the recovered run starts cleanly with the same scan ID.

### Recovery Model

- Recovery is process-start based, not queue based. If the Shopkeeper process exits while a scan is running, the scan resumes the next time Shopkeeper starts.
- Recovery keeps the same scan ID so the existing UI route and DB record remain valid.
- Recovery intentionally discards partial per-scan artifacts before rerunning so the final data set is consistent.
