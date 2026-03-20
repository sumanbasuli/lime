# Development Roadmap & Build Steps

This document outlines the sequential steps to build the accessibility scanner system from scratch.

## Phase 1: Planning & Documentation
- [x] Create project documentation structure.
- [x] Document Shopkeeper, Profiler, Juicer, and Sweetner architectures.
- [x] Document NextJS UI and Database strategy.
- [x] Document Docker deployment details.

## Phase 2: Environment Setup
- [x] Initialize NextJS project in the `lime` folder (App Router, TypeScript, TailwindCSS, shadcn/ui, Drizzle ORM).
- [x] Initialize Go module for Shopkeeper in `shopkeeper/` directory (Chi router, pgx, golang-migrate).
- [x] Setup PostgreSQL database (docker-compose with health checks, initial migration with 4 tables).
- [x] Create initial `docker-compose.yml` and helper startup scripts (`Makefile`).

## Phase 3: Go Backend - Shopkeeper API (Core)
- [x] Domain models (`internal/models/models.go`) — Go structs for Scan, URL, Issue, IssueOccurrence, request/response types.
- [x] Repository layer (`internal/repository/repository.go`) — Full CRUD via pgx: create/get/list scans, bulk insert URLs, create issues/occurrences, aggregate stats.
- [x] Handler endpoints (`internal/handler/handler.go`) — POST /api/scans (create + async launch), GET /api/scans (list), GET /api/scans/{id} (detail), GET /api/scans/{id}/issues (issues with occurrences), GET /api/stats (dashboard aggregates).
- [x] Router update (`internal/router/router.go`) — Added /api/stats route, switched from raw pool to repository injection.
- [x] Scanner orchestrator (`internal/scanner/scanner.go`) — Async pipeline: pending → profiling → scanning → processing → completed/failed.

## Phase 4: Go Backend - Modules
- [x] **Profiler** (`internal/profiler/profiler.go`): Recursive sitemap XML parsing (`<sitemapindex>` and `<urlset>`), URL deduplication, validation, 10-level max depth.
- [x] **Juicer** (`internal/juicer/`): chromedp headless browser with axe-core 4.10.2 (embedded via `//go:embed`), 5-concurrent worker pool with semaphore, 500ms politeness delay, full-page screenshots, 30s page timeout.
- [x] **Sweetner** (`internal/sweetner/sweetner.go`): Groups violations by axe-core rule ID, maps impact→severity, creates one Issue per unique violation type with IssueOccurrence per URL+node.

## Phase 5: NextJS Frontend
- [x] API client (`src/lib/api.ts`) — Typed fetch wrapper for all Shopkeeper endpoints.
- [x] Dashboard (`src/app/page.tsx`) — Server Component with real DB data: stats cards (total scans/issues/pages), recent scans table, New Scan form.
- [x] New Scan form (`src/components/new-scan-form.tsx`) — Client Component: URL validation, POST /api/scans, redirect to scan detail.
- [x] Scans list (`src/app/scans/page.tsx`) — All scans with status badges and progress.
- [x] Scan detail (`src/app/scans/[id]/page.tsx`) — Progress bar, severity summary, issues table, live polling via ScanProgress client component.
- [x] Issues viewer (`src/app/scans/[id]/issues/page.tsx`) — Expandable collapsible rows showing violation details, affected URLs, HTML snippets.
- [x] Live progress polling (`src/components/scan-progress.tsx`) — Client Component polling every 3s with router.refresh().
- [x] Sidebar navigation updated with real routes.
- [x] Scan management actions — Rescan completed/failed scans and delete old terminal scans without touching active jobs.
- [x] Interrupted scan recovery — Non-terminal scans are automatically reset and resumed when Shopkeeper starts again.
- [x] ACT-enriched issue details — Shared local ACT catalog, W3C rule links, WCAG mappings, and deterministic suggested fixes on `/scans/[id]/issues` without changing the DB schema.
- [x] Sitemap discovery hardening — Retry transient nested sitemap fetch failures and avoid partial sitemap-index scans when full discovery is unavailable.
- [x] Screenshot capture hardening — Wait for pages to settle before capture, reject tiny/blank element crops, and fall back to broader page context in the issue viewer.
- [x] Viewport-controlled scans — Persist scan viewport presets, run Juicer with an explicit rendering size, and expose screen-size selection in the scan UI.
- [x] Scan settle/failure hardening — Continue rule execution when a late settle wait times out on an otherwise usable page, and fail scans when every page errors instead of reporting a false completion.

## Phase 6: Testing & Refinement
- [ ] End-to-end testing of the entire flow.
- [ ] Optimize Juicer's resource usage.
- [x] Polish UI — refined scan detail hierarchy, aligned heading/body/code font usage on scan pages, and fixed the issue expander so open/closed state is visually clear.
- [x] Issue triage groundwork — persisted false-positive mark/unmark controls on issue cards without changing scan aggregation behavior yet.
