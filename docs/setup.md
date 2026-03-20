# Local Development Setup

This document describes how to set up the LIME accessibility scanner for local development.

## Prerequisites

- **Docker** and **Docker Compose** (for running PostgreSQL and full stack)
- **Go 1.25+** (for Shopkeeper backend development)
- **Node.js 23+** and **npm** (for NextJS frontend development)

## Environment Variables

All environment configuration is managed through `.env` files:

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_USER` | `lime` | PostgreSQL username |
| `POSTGRES_PASSWORD` | `lime_dev_password` | PostgreSQL password |
| `POSTGRES_DB` | `lime_db` | PostgreSQL database name |
| `DATABASE_URL` | `postgresql://lime:lime_dev_password@db:5432/lime_db?sslmode=disable` | Full connection string (Docker) |
| `SHOPKEEPER_PORT` | `8080` | Port for the Go backend API |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8080` | Shopkeeper API URL for the frontend |
| `ACT_RULES_PATH` | auto-resolved | Optional explicit path to `data/act-rules.json` for Shopkeeper and Next |

### File Locations

- **Root `.env`**: Used by `docker-compose.yml` for container configuration.
- **Root `.env.example`**: Template — copy to `.env` for new setups.
- **`lime/.env.local`**: Used by NextJS in local development. Uses `localhost` instead of `db` for the database host.

## Running the Stack

### Full Stack (Docker)

```bash
make start-all      # Build and start all services
make stop-all       # Stop all services
make clean          # Stop and remove all data volumes
```

### Local Development (Hybrid)

For faster iteration, run only the database in Docker and the apps natively:

```bash
make start-db          # Start PostgreSQL in Docker
make dev-shopkeeper    # Go backend with Air hot reload (in a new terminal)
make dev-ui            # NextJS with hot reload (in a new terminal)
```

Note: scans now recover automatically when Shopkeeper starts again, but `make dev-shopkeeper` still restarts the Go process frequently during code edits. For stable long-running scans, prefer `make start-shopkeeper` or `make start-all`.

ACT catalog note:
- Docker sets `ACT_RULES_PATH=/shared-data/act-rules.json` automatically for both services.
- Native local development usually does not need `ACT_RULES_PATH`; both apps fall back to `../data/act-rules.json`.

### Individual Services

```bash
make start-db          # PostgreSQL only
make start-shopkeeper  # Go backend (auto-starts DB)
make start-ui          # NextJS frontend
```

### Logs

```bash
make logs-db
make logs-shopkeeper
make logs-ui
```

## Service URLs

| Service | URL |
|---------|-----|
| NextJS UI | http://localhost:3000 |
| Shopkeeper API | http://localhost:8080 |
| Health Check | http://localhost:8080/api/health |
| Dashboard Stats | http://localhost:8080/api/stats |
| PostgreSQL | localhost:5432 |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Service health check |
| GET | `/api/stats` | Dashboard aggregates (total scans/issues/pages) |
| POST | `/api/scans` | Create a new scan (body: `{"sitemap_url": "...", "scan_type": "sitemap|single", "viewport_preset": "desktop|laptop|tablet|mobile", "tag": "optional"}`) |
| GET | `/api/scans` | List all scans |
| POST | `/api/scans/{id}/rescan` | Start a fresh scan using the same target URL/type/tag |
| GET | `/api/scans/{id}` | Get scan detail by ID |
| DELETE | `/api/scans/{id}` | Delete a completed/failed scan and its saved assets |
| GET | `/api/scans/{id}/issues` | Get issues with occurrences for a scan, including ACT rules and suggested fixes |
| POST | `/api/scans/{id}/issues/{issueId}/false-positive` | Mark an issue as a false positive |
| DELETE | `/api/scans/{id}/issues/{issueId}/false-positive` | Remove the false-positive mark from an issue |

## Runtime Behavior

- A scan continues running if the user changes pages or closes the scan detail view; only the frontend polling stops.
- A scan does not survive a dead Shopkeeper process in-memory, but non-terminal scans are now recovered automatically the next time Shopkeeper starts.
- Recovery resets partial URLs/issues/screenshots for that scan before rerunning it, so the final stored result is clean.
- Scans now run with an explicit viewport preset instead of Chromium's implicit default. The current presets are Desktop `1440x900`, Laptop `1280x800`, Tablet `768x1024`, and Mobile `390x844`.
- For long-running scans in local development, prefer Docker or `make start-shopkeeper` over `make dev-shopkeeper`, because hot reload restarts the Go process frequently.
- Sitemap discovery now retries transient nested sitemap fetch failures. If Shopkeeper still cannot fetch every sitemap listed in a sitemap index, the scan fails rather than scanning a partial subset of URLs.
- Screenshot capture now waits for a fuller page-settle point before capturing and prefers a highlighted focused context around the affected element instead of a detached tight crop.
- The issue details UI opens screenshots in a lightbox and no longer shows the generic page capture inline unless it is explicitly opened as a fallback view.
- If that extra settle wait times out on a page that is already loaded enough to scan, Shopkeeper still runs the rules and only logs the settle timeout as a warning.
- A scan is only marked `completed` when at least one page scanned successfully. If every page errors, the scan is marked `failed`.
- ACT issue guidance is loaded from the local checked-in catalog at read time. There is no runtime dependency on W3C services and no ACT snapshot stored in Postgres.
- The issue details page is the main ACT UI surface in this phase. Compact scan summaries remain unchanged.
- False-positive marking is persisted per issue row and is currently a triage flag only. It does not yet filter issues out of counts, summaries, or scan detail tables.

## ACT Catalog Maintenance

The shared ACT catalog lives at `data/act-rules.json`.

Refresh it with:

```bash
node scripts/refresh-act-data.mjs
```

What the refresh script does:
- reads axe-core `actIds` mappings from `shopkeeper/internal/juicer/axe.min.js`
- pulls official ACT metadata from `https://act-rules.github.io/testcases.json`
- resolves official W3C ACT rule URLs
- merges the checked-in deterministic remediation overlay and writes a new `data/act-rules.json`

This is a maintenance/build-time step only. The running app does not call external ACT services.

## Operations

Useful commands while diagnosing scan behavior:

```bash
make logs-shopkeeper      # backend logs
make logs-ui              # frontend logs
docker compose ps         # container state
docker compose logs -f shopkeeper
```

## Frontend Pages

| Route | Description |
|-------|-------------|
| `/` | Dashboard: stats, recent scans, new scan form |
| `/scans` | All scans list |
| `/scans/new` | New scan form |
| `/scans/[id]` | Scan detail with live progress |
| `/scans/[id]/issues` | Expandable issues viewer |

## Project Structure

```
lime/                    (project root)
├── docs/                Documentation
├── data/                Shared ACT catalog used by Shopkeeper and Next
├── lime/                NextJS frontend (App Router, shadcn/ui, Drizzle ORM)
├── shopkeeper/          Go backend (Chi, pgx, golang-migrate)
├── scripts/             Maintenance scripts such as ACT catalog refresh
├── docker-compose.yml   Multi-container orchestration
├── Makefile             Developer commands
└── .env                 Environment variables
```

## Tech Stack

### Frontend (`/lime`)
- **Framework**: NextJS with App Router
- **UI Components**: shadcn/ui (built on Radix UI + TailwindCSS)
- **Database ORM**: Drizzle ORM (read-only access to shared PostgreSQL)
- **Styling**: TailwindCSS v4

### Backend (`/shopkeeper`)
- **Language**: Go
- **Router**: Chi v5
- **Database Driver**: pgx v5 with pgxpool connection pooling
- **Migrations**: golang-migrate v4
- **Hot Reload**: Air

### Infrastructure
- **Database**: PostgreSQL 17 (Alpine)
- **Containers**: Docker Compose
- **Headless Browser**: Chromium (installed in Shopkeeper container for Juicer module)

## Database Migrations

Migrations are managed by the Go backend using `golang-migrate`. They run automatically when Shopkeeper starts. Migration files live in `shopkeeper/migrations/`.

The Drizzle schema in `lime/src/db/schema.ts` must be kept in sync with the SQL migrations manually. All schema changes should originate in the Go migrations (since Shopkeeper owns writes), then be reflected in the Drizzle schema.
