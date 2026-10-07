# Shopkeeper (Main Backend Orchestrator)

**Shopkeeper** is LIME's Go backend. It serves the API, runs accessibility scans and link checks, and saves their results.

## Responsibilities

1. **API Endpoints**: Expose endpoints for the UI (NextJS) to initiate new scans, check scan status, and retrieve results.
2. **Orchestration**: Coordinate the execution of its three internal modules:
    * **Profiler**: Reads a sitemap and finds eligible page URLs.
    * **Juicer**: Runs accessibility checks in Chromium workers.
    * **Sweetner**: Groups and saves the results.
3. **Data Persistence**: Save the refined scan data to the database.
4. **Link Checking**: Own independent HTTP link jobs, persisted destinations/source references, lifecycle actions, CSV, and optional companions that start after accessibility completes. This runner is separate from the three-stage axe/screenshot pipeline; see [Link Checker Architecture](link-checker.md).

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
│   ├── mcp/server.go               — Authenticated JSON-RPC transport and workflow tools
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
    └── 000001…000014_*.sql         — Versioned schema migrations

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

The `/api/link-checks` routes create, list, inspect, cancel, recheck, export, and delete link checks, with paginated destinations and source references. `GET /api/scans/{id}/link-check` retrieves a scan's optional companion check. Selecting `include_link_check` when creating a scan starts that companion after accessibility completes, using the saved page URLs. Link results remain separate from accessibility issues and scoring. See [Link Checker Architecture](link-checker.md) and the [API Reference](https://lime.heysuman.com/api/).

Shopkeeper owns the `/mcp` transport, bearer-key authentication, 2025 protocol negotiation, validated tool schemas, and paginated repository reads. The original twelve saved-data tools remain compatible; capability/statistics reads and opt-in scan/link/triage tools extend the integration. Actions reuse existing application handlers so lifecycle eligibility, network boundaries, screenshot cleanup, companions, and cache invalidation are shared with REST. MCP link lists default to 20, cap at 100, and accept offsets up to 100,000; UUID validation and tool-error handling remain explicit.

Write permission is stored as default-false `mcp_allow_writes`, preserving the read-only boundary for existing keys. New-job actions require a UUID `request_id` and use a durable reservation/result ledger; retries replay the prior response, conflicting arguments reject reuse, and an interrupted uncertain reservation never automatically launches another job. Deletion requires `confirm: true`. Key/permission administration is not an MCP tool.

Clients should use the dashboard's canonical `/mcp` proxy: after an authenticated `get_scan` read, Next adds fresh scores using its existing scorer. Direct Shopkeeper calls return only a valid saved score cache, or null when it is cold or stale. Report metadata includes per-format availability and paths explicitly relative to the dashboard origin. Link-check metadata similarly returns dashboard-relative `/links/<id>` and `/api/link-checks/<id>/export.csv` paths; it neither downloads CSV nor changes accessibility exports. A valid scan with no/deleted companion returns null check/paths and its historical selection; a missing scan returns a tool error. Ordinary dashboard/download routes do not inherit MCP authentication.

Paginated issue-detail REST routes, settings, and accessibility CSV/LLM exports belong to Next and must use that origin. Canonical MCP adds bounded report/screenshot/link-CSV content and authenticated reporting/performance changes, for seventeen read tools or twenty-nine full-access tools. Dashboard-owned tools require that endpoint rather than direct Go. See [MCP Integration](../mcp.md) for exact tool envelopes, enablement, permissions, client capabilities, and SDK checks. Stateless JSON POST results and GET 405 are intentional; OAuth and scoped keys are not implemented. Site-derived URLs, captured text and error content are untrusted evidence, not instructions for connected clients.

MCP issue details query the selected group directly, including groups beyond the first page. Failed issue UUIDs are normalized to lowercase; needs-review groups use rule IDs. Older incomplete audits may have summary counts without saved occurrences; these return an empty occurrence list and `has_more: false` while retaining their summary count.

Details include dashboard-relative `screenshot_url` and `element_screenshot_url` fields alongside the original storage paths. Missing paths omit the corresponding URL field; detail reads do not check whether the file exists. These additions do not change REST occurrence responses. MCP uses the supported 2025 protocol versions described in [MCP Integration](../mcp.md), including when a client uses SDK v2.

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

- False-positive decisions are stored in PostgreSQL as `issues.is_false_positive`.
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

- Each scan stores `viewport_preset`, `viewport_width`, and `viewport_height` on the `scans` row. Shopkeeper resolves these at creation and uses them for every page in the scan.
- Rescans create a brand new `scans` row and re-run the pipeline with the original target URL, scan type, tag, and viewport.
- Rescans preserve `include_link_check`; selected rescans get a fresh companion. Deleting the parent cascades to companion jobs/results. A waiting companion remains queued while its parent is paused; an already running companion can be cancelled independently without cancelling accessibility work.
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

PDF rendering loads `/reports/scans/{id}/issues`, waits for the ready marker and assets, and prints through Chromium. It has a four-minute render deadline. Before any Chromium PDF work, Shopkeeper reads the current persisted PDF enablement and concurrency settings. Disabled exports return 403; requests over the per-Shopkeeper-process render limit return 503 with `Retry-After`, without waiting in an unbounded backend queue. The dashboard adds its own bounded per-UI-process waiting queue for normal downloads. This is admission control, not authentication: ordinary dashboard and backend routes still need an operator-managed access boundary. The health endpoint reports HTTP service liveness, not a full database/browser/report readiness check.

See [Docker deployment](../deployment/docker.md), [Backup And Restore](../deployment/backup-restore.md), and [Operational Troubleshooting](../deployment/troubleshooting.md) before changing live process or storage configuration.

## Verification

See [Verification](../verification.md) for test commands and coverage. Handler and scanner tests cover job state changes; the full application suite checks the browser, API, database results, screenshots, and exports together.
