# Database Architecture

The system requires reliable data persistence to store scan configurations, progress states, and the final refined results.

## Database Engine

* **Engine**: PostgreSQL 17 (Alpine image via Docker).
* **Single Instance**: Both the Go backend and NextJS frontend connect to the same PostgreSQL database (`lime_db`).

## NextJS UI Database Access

* **ORM**: Drizzle ORM.
* **Access**: Read-only. Schema defined in `lime/src/db/schema.ts`.
* **Responsibility**: Display scan results, dashboard data, and issue details.

## Go Backend (Shopkeeper) Database Strategy

* **Driver**: `pgx` v5 with `pgxpool` connection pooling.
* **Migrations**: `golang-migrate` v4. Migration files in `shopkeeper/migrations/`.
* **Access**: Full read/write. Shopkeeper owns all writes for scan progress and results.

## Schema

All primary keys are UUIDs (`gen_random_uuid()`). Foreign keys use `ON DELETE CASCADE`.

### Custom Enums

| Enum | Values |
|------|--------|
| `scan_status` | `pending`, `profiling`, `scanning`, `processing`, `completed`, `failed` |
| `url_status` | `pending`, `scanning`, `completed`, `failed` |
| `severity` | `critical`, `serious`, `moderate`, `minor` |

### Tables

#### `scans`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key, auto-generated |
| `sitemap_url` | TEXT | NOT NULL |
| `status` | `scan_status` | Default: `pending` |
| `total_urls` | INTEGER | Default: 0 |
| `scanned_urls` | INTEGER | Default: 0 |
| `created_at` | TIMESTAMP | Default: NOW() |
| `updated_at` | TIMESTAMP | Default: NOW() |

#### `urls`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `scan_id` | UUID | FK -> scans(id), CASCADE |
| `url` | TEXT | NOT NULL |
| `status` | `url_status` | Default: `pending` |
| `created_at` | TIMESTAMP | Default: NOW() |

#### `issues`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `scan_id` | UUID | FK -> scans(id), CASCADE |
| `violation_type` | TEXT | NOT NULL |
| `description` | TEXT | NOT NULL |
| `severity` | `severity` | NOT NULL |
| `created_at` | TIMESTAMP | Default: NOW() |

#### `issue_occurrences`
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `issue_id` | UUID | FK -> issues(id), CASCADE |
| `url_id` | UUID | FK -> urls(id), CASCADE |
| `html_snippet` | TEXT | Nullable |
| `screenshot_path` | TEXT | Nullable |
| `created_at` | TIMESTAMP | Default: NOW() |

### Indexes

* `idx_urls_scan_id` on `urls(scan_id)`
* `idx_issues_scan_id` on `issues(scan_id)`
* `idx_issues_severity` on `issues(severity)`
* `idx_issue_occurrences_issue_id` on `issue_occurrences(issue_id)`
* `idx_issue_occurrences_url_id` on `issue_occurrences(url_id)`

## Schema Sync Strategy

All schema changes originate in the Go SQL migrations (`shopkeeper/migrations/`). The Drizzle schema in `lime/src/db/schema.ts` must be updated to match. Drizzle Kit's `pull` command can introspect the database to verify alignment.

## Notes

Both systems (Go and NextJS) interact with the PostgreSQL database. Shopkeeper owns all writes regarding scan progress and results. NextJS should only read these tables.
