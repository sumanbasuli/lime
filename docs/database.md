# Database Architecture

LIME uses PostgreSQL as the shared durable store for scan configuration, scan progress, issue data, audit outcomes, report settings, and future read-model caches.

## Engine And Access Model

- **Engine**: PostgreSQL 17.
- **Backend access**: Shopkeeper uses `pgxpool` and owns scan lifecycle writes, scan results, screenshots metadata, migrations, and cleanup.
- **UI access**: the NextJS app uses Drizzle ORM for server-rendered reads and UI-owned settings routes.
- **Migrations**: SQL migrations live in `shopkeeper/migrations/`; matching Drizzle table definitions live in `lime/src/db/schema.ts`.

## Core Tables

### `scans`

Top-level scan records.

Key fields:

- target URL, scan type, tag, viewport preset, and stored viewport dimensions
- status and pause-request state
- total and scanned URL counters
- created and updated timestamps

### `urls`

Discovered or provided URLs for a scan.

Key fields:

- scan ID
- URL
- URL status: `pending`, `scanning`, `completed`, or `failed`
- created timestamp

### `issues`

Deduplicated failed axe issue groups for a scan.

Key fields:

- scan ID
- axe rule ID in `violation_type`
- title/description, help URL, severity, and false-positive flag
- created timestamp

### `issue_occurrences`

Failed issue occurrences.

Key fields:

- issue ID
- URL ID
- CSS selector
- HTML snippet
- page and element screenshot paths
- created timestamp

### `url_audits`

Per-page audit outcomes for axe/Lighthouse-aligned rules.

Key fields:

- URL ID
- rule ID
- outcome: `passed`, `failed`, `not_applicable`, or `incomplete`
- created timestamp

### `url_audit_occurrences`

Occurrence rows for audit outcomes that need review or additional context.

Key fields:

- URL ID
- rule ID
- outcome
- CSS selector
- HTML snippet
- page and element screenshot paths
- created timestamp

### `app_settings`

Server-wide settings.

Current fields include:

- full PDF occurrence limit
- single-issue PDF occurrence limit
- small CSV occurrence limit
- LLM occurrence limit
- PDF, CSV, and LLM export enablement flags
- summary cache TTL
- report-data cache TTL
- report generation concurrency cap
- MCP enablement and hashed key metadata

The raw MCP key is never stored; only its hash and display hint are persisted.

### `scan_score_summary_cache`

Per-scan score, coverage, and audit-count read model used to avoid repeated full audit aggregation on dashboard and report reads.

### `scan_issue_summary_cache`

Per-scan failed and needs-review issue-card read model used by the issues page. Occurrence details remain live and paginated.

### `scan_report_data_cache`

Bounded report metadata cache keyed by scan, scope, format, and settings fingerprint. The cache stores metadata only; generated report files are still produced on demand.

## Index Strategy

The base schema includes indexes for direct foreign-key lookups. Later migrations add composite indexes for large-scan read paths.

Current read-path indexes include:

- recent scans: `scans(created_at DESC)`
- scans by tag: `scans(tag, created_at DESC)`
- URL coverage: `urls(scan_id, status)`
- URL ordering within a scan: `urls(scan_id, url)`
- score summaries and false-positive filtering: `issues(scan_id, is_false_positive)`
- scoped issue lookups: `issues(scan_id, violation_type)`
- issue occurrence paging: `issue_occurrences(issue_id, url_id, created_at)`
- audit aggregation: `url_audits(url_id, outcome, rule_id)`
- needs-review occurrence paging: `url_audit_occurrences(url_id, outcome, rule_id, created_at)`

## Schema Sync Rules

- Add schema changes through Shopkeeper SQL migrations first.
- Add matching Drizzle schema changes in the UI.
- Keep migrations forward-only in release history.
- Do not let NextJS become the writer for scan lifecycle or scan result tables.
- Document materialized read models or cache tables when they are added.
