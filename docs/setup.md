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
| `POSTGRES_USER` | `lime` | Bundled PostgreSQL bootstrap username |
| `POSTGRES_PASSWORD` | `lime_dev_password` | Bundled PostgreSQL bootstrap password |
| `POSTGRES_DB` | `lime_db` | Bundled PostgreSQL bootstrap database name |
| `DATABASE_URL` | `postgresql://lime:lime_dev_password@localhost:5432/lime_db?sslmode=disable` | Application-level database connection string used by Shopkeeper and the UI in native local development |
| `SHOPKEEPER_URL` | `http://localhost:8080` | Runtime proxy target used by the Next server in native local development |
| `LIME_API_PORT` | `8080` | Public host port for the Go backend API |
| `LIME_UI_PORT` | `3000` | Public host port for the NextJS UI |
| `ACT_RULES_PATH` | auto-resolved | Optional explicit path to `data/act-rules.json` for Shopkeeper and Next |

### File Locations

- **Root `.env`**: Native local-development runtime values plus published UI/API ports used by `docker-compose.yml` and Make targets.
- **Root `.env.example`**: Template — copy to `.env` for new setups.
- **`lime/.env.local`**: Optional NextJS-native override file if you run `npm run dev` manually inside `lime/` instead of using `make dev-ui`.
- **`deploy/release/.env.example`**: Template used by the release bundle for running published images against an external PostgreSQL database.

## Running the Stack

### Full Stack (Docker)

```bash
make start-all      # Build and start all services
make migrate-all    # Apply DB migrations without stopping services
make stop-all       # Stop all services
make clean          # Stop and remove all data volumes
```

### Production Build Outputs

```bash
make build          # build dist/shopkeeper, dist/ui, and the release bundle
make build-docker   # build versioned production Docker images locally
```

The repo-wide version source is `VERSION`, using plain semver such as `0.1.0`.
These builds create generic artifacts and generic Docker images. They do not bake in a deployment-specific API URL. Runtime deployments must provide `DATABASE_URL` and `SHOPKEEPER_URL`.

### Local Development (Hybrid)

For faster iteration, run only the database in Docker and the apps natively:

```bash
make start-db          # Start PostgreSQL in Docker
make migrate-all       # Apply DB migrations in a one-off Shopkeeper container
make dev-shopkeeper    # Go backend with Air hot reload (in a new terminal)
make dev-ui            # NextJS with hot reload (in a new terminal)
```

`make dev-ui` automatically points the Next proxy at `http://localhost:<LIME_API_PORT>`, so native UI development stays aligned with the local Go backend even though the Dockerized UI container talks to `http://shopkeeper:8080` internally.

Note: scans now recover automatically when Shopkeeper starts again, but `make dev-shopkeeper` still restarts the Go process frequently during code edits. For stable long-running scans, prefer `make start-shopkeeper` or `make start-all`.

ACT catalog note:
- Docker sets `ACT_RULES_PATH=/shared-data/act-rules.json` automatically for both services.
- Native local development usually does not need `ACT_RULES_PATH`; both apps fall back to `../data/act-rules.json`.

### Individual Services

```bash
make start-db          # PostgreSQL only
make migrate-all       # Apply DB migrations only
make start-shopkeeper  # Go backend (auto-starts DB)
make start-ui          # NextJS frontend
```

### Logs

```bash
make logs-db
make logs-shopkeeper
make logs-ui
```

## Release Workflow

- GitHub Release publishing is the trigger for Docker package publishing.
- The release tag must match `VERSION` after `v` normalization, for example:
  - `VERSION`: `0.1.0`
  - Git tag / GitHub Release: `v0.1.0`
- A published release pushes:
  - `ghcr.io/sumanbasuli/lime-shopkeeper:v0.1.0`
  - `ghcr.io/sumanbasuli/lime-ui:v0.1.0`
- Stable releases also update `latest`.
- The same workflow uploads a bundle asset like `lime-v0.1.0-release.tar.gz`.

## Release Bundle

The release bundle is built from:
- `docker-compose.release.yml`
- `deploy/release/.env.example`
- `deploy/release/README.md`
- `data/*.json`

Users can run the published stack from the extracted bundle with:

```bash
docker compose --env-file .env -f docker-compose.release.yml up -d
```

The release `.env` file is the source of truth for:
- published image tag
- `DATABASE_URL`
- `SHOPKEEPER_URL`
- public UI/API ports
- optional direct Shopkeeper exposure on `LIME_API_PORT`

The browser still talks to the UI origin only. The Next server proxies `/api/...` requests to `SHOPKEEPER_URL` at runtime, so release images stay generic and reverse-proxy friendly.

## Database Configuration

LIME uses `DATABASE_URL` as the application-level source of truth for database access in native development and in release deployments.

- In native local development, the root `.env.example` points `DATABASE_URL` at `localhost:5432`, which matches `make start-db`.
- In the local Docker stack, `docker-compose.yml` overrides `DATABASE_URL` and `SHOPKEEPER_URL` internally to use Docker service names (`db` and `shopkeeper`) so the containers can talk to each other reliably.
- In the release bundle, `DATABASE_URL` must point at an external PostgreSQL instance.
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` are only used to initialize the bundled PostgreSQL container in local development.
- The NextJS app reads PostgreSQL directly for server-rendered pages, so both the UI runtime and Shopkeeper must be able to reach the same database described by `DATABASE_URL`.

### External PostgreSQL for the Release Bundle

Set `DATABASE_URL` in the release `.env` file to the external connection string, then start the published stack:

```bash
docker compose --env-file .env -f docker-compose.release.yml up -d
```

## Service URLs

| Service | URL |
|---------|-----|
| NextJS UI | `http://localhost:<LIME_UI_PORT>` |
| Shopkeeper API | `http://localhost:<LIME_API_PORT>` |
| Health Check | `http://localhost:<LIME_API_PORT>/api/health` |
| Dashboard Stats | `http://localhost:<LIME_API_PORT>/api/stats` |

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
- Accessibility rule execution now follows a Lighthouse-aligned axe configuration instead of the broad default axe run. That means WCAG A/AA tag filtering, Lighthouse-style rule overrides, node references, failure summaries, and scroll reset behavior are applied before screenshots are captured.
- Screenshot capture now waits for a fuller page-settle point before capturing and saves both a highlighted visible-view image and a smaller inline preview cropped from that same focused screenshot.
- Screenshot capture now also resolves duplicate selectors to a best-effort exact DOM match and runs a bounded `focus + hover` preparation pass before deciding that a focused screenshot is unavailable.
- The spotlight now comes from a dedicated overlay layer rather than per-element inline styles, which keeps the highlight more consistent across issue types and prevents stale highlights from leaking into later captures.
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
├── deploy/              Release bundle templates
├── data/                Shared ACT catalog used by Shopkeeper and Next
├── lime/                NextJS frontend (App Router, shadcn/ui, Drizzle ORM)
├── shopkeeper/          Go backend (Chi, pgx, golang-migrate)
├── scripts/             Maintenance scripts such as ACT catalog refresh and release bundle generation
├── docker-compose.yml   Local development Docker stack
├── docker-compose.release.yml  Published-image Docker stack
├── Makefile             Developer commands
├── VERSION              Repo-wide release version
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
