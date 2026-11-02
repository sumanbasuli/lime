# Database Architecture

PostgreSQL stores LIME's scans, progress, findings, audit outcomes, link checks, settings, and cached summaries. Screenshot files are stored separately on a filesystem volume.

## Engine And Access Model

- **Engine**: PostgreSQL 17.
- **Backend access**: Shopkeeper uses `pgxpool` and owns scan lifecycle writes, scan results, screenshots metadata, migrations, and cleanup.
- **UI access**: the NextJS app uses Drizzle ORM for server-rendered reads and UI-owned settings routes.
- **Migrations**: SQL migrations in `shopkeeper/migrations/` are authoritative. Drizzle definitions in `lime/src/db/schema.ts` cover the tables the UI reads directly; backend-only Link Checker storage is owned by Shopkeeper.

Both services must connect to the same database. Shopkeeper's pool uses a maximum of 10 connections and minimum of 2; the UI creates a separate `pg.Pool`. Account for both services and maintenance clients in the database's connection budget. There is no distributed scan queue or backend ownership lease: run only one Shopkeeper against a database.

## Relationships And Ownership

```text
scans ── urls ── url_audits / url_audit_occurrences
  │         └── issue_occurrences ── issues
  ├── issues
  ├── scan_discoveries ── scan_discovery_sitemaps / scan_discovery_candidates
  ├── link_checks ── link_check_results ── link_check_sources
  └── scan_score_summary_cache / scan_issue_summary_cache / scan_report_data_cache
standalone link_checks (scan_id = null) ── link_check_results ── link_check_sources
app_settings (one server-wide row, key = 'global')
mcp_action_requests (durable request UUID reservations and replay responses)
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

The complete, scan-ready discovered list or the provided single-page URL. Checkpointed sitemap discovery does not write partial candidate lists here.

Key fields:

- scan ID
- URL
- URL status: `pending`, `scanning`, `completed`, or `failed`
- created timestamp

### `scan_discoveries`, `scan_discovery_sitemaps`, and `scan_discovery_candidates`

Migration `000020_add_discovery_checkpoints` adds backend-owned state for long sitemap discovery. `scan_discoveries` records the `fetch`, `probe`, or `complete` phase, admission epoch, cumulative HTTP request and XML-byte counters, candidate ordinal, and active-time accounting. `scan_discovery_sitemaps` stores the ordered nested-sitemap frontier and task outcomes. `scan_discovery_candidates` stores distinct raw page candidates in discovery order and their eligible, external, or unresolved probe outcomes. These rows cascade when the parent scan is deleted.

Each profiling admission has an approximately ten-minute fairness slice. Committed tasks, outcomes, and counters survive pending requeues, pause, and restart; unfinished requests may repeat and still consume cumulative budgets. A bounded XML checkpoint or network drain can extend the occupied slot. The former cumulative 30-minute discovery stop does not apply after `000020`. The 20,000-request, 128 MiB aggregate XML, 50 MiB per-document, 10,000-candidate, and depth limits remain. Reaching one fails discovery without making partial results scan-ready.

After all required sitemaps and probes finish, one transaction inserts the deduplicated eligible URLs into `urls`, updates `scans.total_urls`, and changes the discovery phase to `complete`. Until then, `urls` remains empty and a companion link check cannot use partial candidates. Historical scans that already have `urls` but no discovery row remain valid and continue the existing page workflow.

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
- `link_check_results` stores a deduplicated target URL per check, response category/code/final URL/redirect count, link type, occurrence count, source-storage version, historical JSONB source references, and optional error/error-kind.

Migration `000019_add_link_source_rows` adds `link_check_sources`, keyed by `(result_id, ordinal)`. New results append each source occurrence once as a JSONB object in its own row, preserving order and duplicates without rewriting a growing parent array. Historical results keep their original arrays and remain readable. A later publication converts only the affected legacy result inside the same transaction; a count mismatch is rejected. Deleting or replacing a result cascades to its source rows. The migration's down file restores complete ordered arrays before dropping the table and refuses a count mismatch, but a production downgrade still requires a deliberate stopped-service recovery plan.

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
- MCP enablement, default-false write permission, and hashed key metadata

The raw MCP key is never stored; only its hash and display hint are persisted.

Defaults and input normalization are defined in `lime/src/lib/report-settings-config.ts` and `report-settings.ts`. MCP defaults to disabled and `mcp_allow_writes` defaults false, preserving read-only access for existing keys after upgrade; PDF/CSV/LLM exports default to enabled. Browser-only update-card preferences are stored in local storage, not this table. The raw MCP key cannot be recovered from a database backup; clients need a retained key or a newly generated one.

### `mcp_action_requests`

Migration `000014_add_mcp_actions` adds default-false `app_settings.mcp_allow_writes` and the backend-owned durable new-job request ledger. `request_id` is a UUID primary key; the row stores the tool name, normalized argument hash, reserved timestamp, nullable response JSONB, and completion timestamp. The response and completion timestamp are either both absent or both present.

Reservations occur before create/rescan/recheck execution. Identical completed retries replay saved data; a reused ID with another tool or argument hash rejects the call. An unfinished reservation may represent an in-flight action or a crash after creation, so it never automatically reruns. There is deliberately no expiry: removing an old reservation can allow the same ID to execute again. Preserve this table in backups and do not clear it as routine cleanup. Operators must inspect actual saved scans/checks before intentionally issuing another request UUID. See [MCP Integration](mcp.md#confirmations-and-durable-retries).

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
- Update matching Drizzle models when a changed table is read directly by the UI. Use Shopkeeper migrations for the full schema; do not use a UI-only schema push to replace backend-owned tables.
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

These queries inspect the database without changing it. Migration `000013_add_link_checks` adds link checks, and `000014_add_mcp_actions` adds MCP write permissions and request tracking. Check the migration files for the release you are running. Existing scans keep `include_link_check` set to false; the migration does not create companion checks for past scans.

## Backup Boundary

A usable recovery set contains the database, the screenshot root, protected runtime configuration, and the matching application/catalog version. Database-only backups preserve findings and settings but cannot recreate image evidence. See [Backup And Restore](deployment/backup-restore.md) for a maintenance-window procedure and a restore rehearsal into a separate empty database.
