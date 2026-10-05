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
│   ├── mcp/server.go               — Authenticated read-only JSON-RPC transport and tools
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
    └── 000001…000012_*.sql         — Versioned schema migrations (inspect the current checkout)

repo root
├── data/act-rules.json             — Shared checked-in ACT catalog used by Go + Next at read time
└── scripts/refresh-act-data.mjs    — Refreshes the ACT catalog from axe metadata + official ACT sources
```

### API Endpoints

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/health` | HealthCheck | Service health status |
| GET | `/api/version` | Version | Build version and commit metadata |
| GET | `/api/stats` | GetStats | Dashboard aggregates (total scans/issues/pages) |
| POST | `/api/scans` | CreateScan | Create scan + launch async pipeline |
| GET | `/api/scans` | ListScans | List all scans (desc by date) |
| POST | `/api/scans/{id}/pause` | PauseScan | Request a cooperative pause for an active scan |
| POST | `/api/scans/{id}/resume` | ResumeScan | Continue a paused scan from persisted state |
| POST | `/api/scans/{id}/rescan` | RescanScan | Create a fresh scan from a completed, paused, or failed scan |
| POST | `/api/scans/{id}/retry-failed` | RetryFailedPages | Requeue failed pages on a completed partial scan and continue the same scan |
| GET | `/api/scans/{id}` | GetScan | Single scan detail |
| DELETE | `/api/scans/{id}` | DeleteScan | Delete a completed, paused, or failed scan and related data |
| GET | `/api/scans/{id}/issues` | GetScanIssues | Issues with occurrences for a scan, enriched with ACT context and suggested fixes |
| POST | `/api/scans/{id}/issues/{issueId}/false-positive` | MarkIssueFalsePositive | Mark a scan issue as a false positive |
| DELETE | `/api/scans/{id}/issues/{issueId}/false-positive` | UnmarkIssueFalsePositive | Remove the false-positive mark from a scan issue |
| GET | `/api/screenshots/{scanId}/{filename}` | ServeScreenshot | Serve a saved screenshot |
| GET | `/api/scans/{id}/issues/report.pdf` | DownloadIssueReport | Render the dashboard report document using Chromium |

Shopkeeper owns the read-only `/mcp` transport, bearer-key authentication, 2025 protocol negotiation, tool schemas, and paginated repository reads. Clients should use the dashboard's canonical `/mcp` proxy: after an authenticated `get_scan` read, Next adds fresh scores using its existing scorer. Direct Shopkeeper calls return only a valid saved score cache, or null when it is cold or stale. Report metadata includes per-format availability and paths explicitly relative to the dashboard origin. Paginated issue-detail REST routes, settings, and CSV/LLM exports belong to Next and must use that origin. See [MCP Integration](../mcp.md) for enablement, client capabilities, and the read-only SDK smoke test. Stateless JSON POST results and GET 405 are intentional; no OAuth, scoped keys, or mutation tools are implemented.

MCP issue-detail lookup queries the selected group directly rather than searching a capped first-page list. Failed issue UUID keys are canonicalized to lowercase; needs-review keys remain rule IDs. Older incomplete audit rows may provide summary counts without stored node occurrences: detail then returns an empty list and `has_more: false`, preserving the count without inventing evidence. MCP detail adds dashboard-relative `screenshot_url` and `element_screenshot_url` while retaining raw storage paths for compatibility; absent/empty stored paths omit the corresponding URL field. It does not verify file existence during a detail read. These added fields do not change normal REST occurrence payloads. SDK v1 and v2 client checks use the legacy 2025 contract; client package generation does not imply modern 2026 server protocol support.

### Dependency Injection

The handler uses an interface `ScanRunner` to avoid circular dependencies:
```go
type ScanRunner interface {
    RunScan(scan models.Scan)
    RequestPause(scanID string)
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
7. Juicer scans pages with up to 5 workers per scan using the persisted viewport dimensions; progress counts processed attempts, including genuine failures. Its accessibility execution is aligned more closely with Lighthouse’s accessibility gatherer, using WCAG A/AA tags, curated rule overrides, node references, failure summaries, and scroll reset behavior before screenshot work begins. If a late page-settle wait times out after the document is already usable, Juicer still continues into rule execution instead of dropping that page immediately.
8. Status moves to `processing`; Sweetner deduplicates and stores issues from successfully scanned pages.
9. Status is set to `completed` when at least one page scanned successfully. If every page errors, or a pipeline step fails, status is set to `failed`.
10. If a completed scan still has failed URL rows, `POST /api/scans/{id}/retry-failed` can reset only those failed rows to `pending`, reset `scanned_urls` to the completed-page count, and relaunch the same scan ID through the normal resume path.

The async execution is backend-owned. Browser navigation only affects UI polling, not the actual scan job.

### Progress Ordering

Juicer audits pages concurrently, but its synchronized per-run progress callback serializes updates and skips any older count arriving after a newer one. This keeps `scanned_urls` monotonic within a run: a slower callback for page 7 must not overwrite the saved count after page 8 finishes. Resumes and failed-page retries add the persisted processed-page count to the new callback count. The verification suite checks final coverage against the stored scan counter; callback ordering also has a deterministic backend regression check.

## ACT Enrichment Model

- Sweetner remains the canonical writer for issue records. It stores the accessibility `violation_type` and base issue metadata only.
- ACT metadata is added at read time, not persisted in PostgreSQL. This keeps the DB schema unchanged while allowing the ACT catalog to evolve independently.
- `GET /api/scans/{id}/issues` loads the DB issues first, then resolves `violation_type -> act_rule_ids[] -> act_rules[]` through `internal/actrules/resolver.go`.
- Suggested fixes are deterministic and local. They come from the checked-in ACT catalog and curated rule-level guidance, not from runtime AI generation and not from live W3C requests.
- If no ACT mapping exists for an axe rule, the API still returns the original issue shape with `act_rules: []` and `suggested_fixes: []`.

## Issue Triage State

- Issues now persist a local triage flag in PostgreSQL through `issues.is_false_positive`.
- Marked issues remain stored and visible as excluded evidence. The Next dashboard removes them from open-issue counts and active scoring, and places excluded issue groups after active failures and needs-review checks. ACT enrichment still describes the original rule.
- Marking or unmarking clears persisted score and issue-summary caches so the next read reflects the decision.
- Shopkeeper exposes explicit mark and unmark routes so the Next UI can update issue state without writing to the database directly.
- Each issue row stores its own scan-specific flag. When Sweetner creates issues for a new scan, it inherits the latest terminal scan's mark or unmark decision for the same target URL, scan type, and viewport preset/dimensions. This applies to matching new scans as well as explicit rescans. Changing a source scan later does not retroactively change an already-created child scan's saved issue state.

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
- Active scans can be paused cooperatively. In-flight pages may settle first; partial successful results are stored before the status becomes `paused`.
- Resume changes a paused scan back to pending and continues persisted URL state. It preserves the scan ID, viewport, successful pages, and existing findings.
- Deletes and backend rescans are limited to terminal scans (`completed`, `paused`, or `failed`) so an active background job is never orphaned.
- Database cleanup relies on `ON DELETE CASCADE`, and Shopkeeper removes the scan's screenshot directory after a successful delete. Docker/Fly use `/app/screenshots/{scanId}`; native installs can override the physical root with `SHOPKEEPER_SCREENSHOT_DIR`.
- On startup, Shopkeeper re-queues interrupted active scans in `pending`, `profiling`, `scanning`, or `processing`. Partial URLs/issues/screenshots are cleared first so the recovered run starts cleanly with the same scan ID and viewport. A persisted pause request is finalized as paused instead of being restarted; already paused scans stay paused.

### Recovery Model

- Recovery is process-start based, not queue based. If the Shopkeeper process exits while a scan is running, the scan resumes the next time Shopkeeper starts.
- Recovery keeps the same scan ID so the existing UI route and DB record remain valid.
- Recovery intentionally discards partial per-scan artifacts before rerunning so the final data set is consistent.

Run only one Shopkeeper against a database. The cancel map and scan execution are process-local, and startup recovery assumes the previous process is gone; there is no distributed lease distinguishing another backend's active scan. Starting a second backend can reset work still running in the first. A shared database/volume alone does not make backend replication safe.

## Runtime And Report Configuration

`cmd/shopkeeper/main.go` applies migrations before HTTP startup and supports `--migrate` to apply them and exit without scan recovery or a server. Migrations are loaded relative to the current working directory. Runtime DB access uses a pgx pool capped at 10 connections.

`internal/config/config.go` reads `DATABASE_URL`, `SHOPKEEPER_PORT` (default 8080), and `REPORT_BASE_URL` (default `http://localhost:3000`). `REPORT_BASE_URL` must be reachable from Shopkeeper's Chromium: source Compose supplies `http://ui:3000`; split-host/container deployments need an explicit internal UI URL. The UI also needs the reverse `SHOPKEEPER_URL` for browser API proxying. These are opposite directions and neither is a browser build-time public URL.

PDF rendering loads `/reports/scans/{id}/issues`, waits for the ready marker and assets, and prints through Chromium. It has a four-minute render deadline. Direct backend report requests do not apply Next's export toggle or per-UI-process limiter; use dashboard report URLs for operator-facing controls. The health endpoint reports HTTP service liveness, not a full database/browser/report readiness check.

See [Docker deployment](../deployment/docker.md), [Backup And Restore](../deployment/backup-restore.md), and [Operational Troubleshooting](../deployment/troubleshooting.md) before changing live process or storage configuration.

## Verification

Use [Verification And Handoff](../verification.md) for isolated end-to-end checks and the current evidence. Handler/scanner unit tests cover lifecycle invariants; the production-stack verifier exercises the browser, same-origin API, persisted database results, screenshots, and exports together.
