# Database Architecture

LIME uses PostgreSQL as the shared durable store for scan configuration, progress, findings, audit outcomes, link checks/results, settings, and derived score/issue summaries. Screenshot pixels live on a separate filesystem volume, not in PostgreSQL.

## Engine And Access Model

- **Engine**: PostgreSQL 17.
- **Backend access**: Shopkeeper uses `pgxpool` and owns scan lifecycle writes, scan results, screenshots metadata, migrations, and cleanup.
- **UI access**: the NextJS app uses Drizzle ORM for server-rendered reads and UI-owned settings routes.
- **Migrations**: SQL migrations live in `shopkeeper/migrations/`; matching Drizzle table definitions live in `lime/src/db/schema.ts`.

Both services must connect to the same database. Shopkeeper's pool uses a maximum of 10 connections and minimum of 2; the UI creates a separate `pg.Pool`. Account for both services and maintenance clients in the database's connection budget. There is no distributed scan queue or backend ownership lease: run only one Shopkeeper against a database.

## Relationships And Ownership

```text
scans ── urls ── url_audits / url_audit_occurrences
  │         └── issue_occurrences ── issues
  ├── issues
  ├── link_checks ── link_check_results
  └── scan_score_summary_cache / scan_issue_summary_cache / scan_report_data_cache
standalone link_checks (scan_id = null) ── link_check_results
app_settings (one server-wide row, key = 'global')
```

Scan, URL, and issue foreign keys use `ON DELETE CASCADE`. Shopkeeper's delete handler additionally removes the scan screenshot directory. Deleting a row manually does not perform that filesystem cleanup. Use the application lifecycle routes rather than editing scan/result rows during normal operation.

## Core Tables

### `scans`

Top-level scan records.

Key fields:

- target URL, scan type, tag, viewport preset, and stored viewport dimensions
- status and pause-request state
- `include_link_check`: optional companion selection, default `false`
- total and scanned URL counters
- created and updated timestamps

Statuses are `pending`, `profiling`, `scanning`, `processing`, `paused`, `completed`, and `failed`. `scanned_urls` counts processed page attempts, including real failures; it is not the number of successfully audited pages. Use URL status counts/coverage for that distinction. A completed scan can still have failed pages and partial coverage.

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

### `link_checks` And `link_check_results`

Migration `000013_add_link_checks` adds the default-false `scans.include_link_check` selection and two backend-owned tables:

- `link_checks` stores the root URL, mode (`single`, `crawl`, or companion `scan`), nullable unique parent `scan_id`, configured page cap, lifecycle status, progress counters, truncation/error, JSONB summary and internal seed URLs, and timestamps.
- `link_check_results` stores a deduplicated target URL per check, response category/code/final URL/redirect count, link type, occurrence count, JSONB source references, and optional error/error-kind.

Statuses are `queued`, `running`, `completed`, `failed`, and `cancelled`. Result categories are `healthy`, `redirected`, `broken`, `error`, `blocked`, and `unchecked`; summary `timeout` is a subset of errors, not another result category. Source-preview reads are bounded independently of full source-reference paging.

The unique nullable `scan_id` allows at most one companion per scan while permitting independent standalone jobs. Deleting a scan cascades to its companion and target rows; deleting a standalone check cascades to its target rows. This does not share or mutate accessibility issue/audit/cache tables. Checks are HTTP-only and have no screenshot tree of their own.

Recent-job and active-status indexes support history and startup recovery; `(link_check_id, status, target_url)` supports paginated target filtering, and `(link_check_id, target_url)` prevents duplicate destinations. See [Link Checker Architecture](architecture/link-checker.md) for lifecycle, bounded extraction, and network rules.

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

Defaults and input normalization are defined in `lime/src/lib/report-settings-config.ts` and `report-settings.ts`. MCP defaults to disabled; PDF/CSV/LLM exports default to enabled. Browser-only update-card preferences are stored in local storage, not this table. The raw MCP key cannot be recovered from a database backup; clients need a retained key or a newly generated one.

### `scan_score_summary_cache`

Per-scan score, coverage, and audit-count read model used to avoid repeated full audit aggregation on dashboard and report reads.

The Next scorer writes this cache. Direct Shopkeeper MCP reads accept only a matching scan timestamp/status within the configured TTL, and return null for a cold/stale cache. The canonical dashboard `/mcp` endpoint uses the existing Next scorer to supply fresh summaries.

### `scan_issue_summary_cache`

Per-scan failed and needs-review issue-card read model used by the issues page. Occurrence details remain live and paginated.

Next serializes replacement by locking the parent scan row and checking its timestamp before persisting. Triage updates clear score/issue caches and touch the scan timestamp. See [Performance And Caching](performance.md).

### `scan_report_data_cache`

Reserved report-metadata cache schema keyed by scan, scope, format, and settings fingerprint. The migration and Drizzle definition exist, but current report routes/loaders do not read or populate this table. The corresponding report-data TTL setting is persisted but is not yet an active report cache. PDF, CSV, and LLM files are generated on demand.

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

## Migration Operations

Shopkeeper runs `database.RunMigrations` before connecting its runtime pool or starting HTTP. It uses `file://migrations`, relative to the process working directory. Run native commands from `shopkeeper/`, or use the packaged binary with its bundled `migrations/` directory and correct working directory. Docker and systemd set this up already.

`make migrate-all` targets the bundled local Compose database and can build a one-off Shopkeeper image. It is not a generic command for an external production database. For published images, use the release Compose command documented in [Updating LIME](deployment/updates.md).

The migration runner maintains `schema_migrations`. Down files exist, but application startup only runs `Up`; a previous binary/image does not downgrade the database. If a migration fails or leaves a dirty version, capture the error and inspect the version read-only before any repair. Do not force a version or rerun down migrations without understanding the partially applied SQL and having a tested backup.

```sql
SELECT version, dirty FROM schema_migrations;
SELECT status, count(*) FROM scans GROUP BY status ORDER BY status;
SELECT status, count(*) FROM urls GROUP BY status ORDER BY status;
```

These are diagnostic reads, not recovery operations. Unreleased source includes `000013_add_link_checks` after `000012_add_report_data_cache`; inspect the checked-out release's files rather than assuming a fixed version forever. The new selection defaults to false for existing scan rows; adding the checker does not enable companions retroactively.

## Backup Boundary

A usable recovery set contains the database, the screenshot root, protected runtime configuration, and the matching application/catalog version. Database-only backups preserve findings and settings but cannot recreate image evidence. See [Backup And Restore](deployment/backup-restore.md) for a maintenance-window procedure and a restore rehearsal into a separate empty database.
