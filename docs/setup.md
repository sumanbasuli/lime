# Local Development Setup

This document describes how to set up the LIME accessibility scanner for local development.

## Prerequisites

- **Docker** and **Docker Compose** (for running PostgreSQL and full stack)
- **Go 1.25.1+** (the minimum in `shopkeeper/go.mod`, for backend development)
- **Node.js 23+** and **npm** (for NextJS frontend development)

Docker-only application startup does not require Go or Node on the host. Native development needs the language runtimes and installed packages: run `npm --prefix lime ci` for the dashboard and `npm --prefix docs-site ci` for the marketing/docs app. Browser verification also needs Playwright Chromium: `cd docs-site && npx playwright install chromium`.

Native Shopkeeper also needs a working Chrome/Chromium installation and a writable screenshot directory. Docker supplies Chromium. For new native installs, choose a currently supported Node release satisfying the 23+ requirement, rather than installing the old Node 23 release line; see [Node's release status](https://nodejs.org/en/about/previous-releases). The repository Dockerfile and release workflow currently pin Node 23; changing that pin is a separate tested runtime upgrade.

## First Startup

From the repository root:

```bash
cp .env.example .env   # only for a new checkout; do not overwrite an existing .env
make start-all
docker compose ps
curl -fsS http://localhost:3000/api/health
```

Open `http://localhost:3000/` for the dashboard. The health request goes through the UI to Shopkeeper; it does not verify PostgreSQL reads, Chromium, screenshots, or exports. Run one single-page scan and inspect its issues/screenshots before relying on a new deployment. [Verification And Handoff](verification.md) describes the complete isolated suite.

The defaults are for local development, not public hosting: PostgreSQL, API, and UI ports are published on the host, and the database uses a development password. Review [Docker deployment](deployment/docker.md) before exposing the instance. Run one Shopkeeper per database; scan recovery is not coordinated across multiple backend processes.

## Environment Variables

The Makefile loads and exports the root `.env`; Compose reads it for interpolation. A manually launched Go process does not load this file itself. Next loads its own `.env.local` when launched from `lime/`. Keep credentials out of Git and use the deployment's environment/secret mechanism outside local development.

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_USER` | `lime` | Bundled PostgreSQL bootstrap username |
| `POSTGRES_PASSWORD` | `lime_dev_password` | Bundled PostgreSQL bootstrap password |
| `POSTGRES_DB` | `lime_db` | Bundled PostgreSQL bootstrap database name |
| `DATABASE_URL` | `postgresql://lime:lime_dev_password@localhost:5432/lime_db?sslmode=disable` | Application-level database connection string used by Shopkeeper and the UI in native local development |
| `SHOPKEEPER_URL` | `http://localhost:8080` | Runtime proxy target used by the Next server in native local development |
| `LIME_API_PORT` | `8080` | Public host port for the Go backend API |
| `SHOPKEEPER_PORT` | `8080` | Port listened on by a native Shopkeeper process; Compose fixes its internal port to 8080 |
| `LIME_UI_PORT` | `3000` | Public host port for the NextJS UI |
| `LIME_DB_PORT` | `5432` | Public host port for the bundled PostgreSQL container |
| `LIME_DOCS_PORT` | `3001` | Local marketing website and documentation port |
| `LIME_UPDATE_CHECK` | `true` | Default-enabled best-effort GitHub release check; set `false` to opt out. The per-browser Update notice preference only controls card visibility |
| `LIME_GITHUB_REPO` | `sumanbasuli/lime` | Repository used by the optional release check |
| `LIME_VERSION` | packaged dashboard version | Nonblank runtime/release-build version overrides remain authoritative for release comparison; when unset or blank, the UI uses its package version |
| `ACT_RULES_PATH` | auto-resolved | Optional explicit path to `data/act-rules.json` for Shopkeeper and Next |
| `REPORT_BASE_URL` | `http://localhost:3000` | Shopkeeper-to-dashboard URL for Chromium PDF rendering; local Compose supplies `http://ui:3000` |
| `SHOPKEEPER_SCREENSHOT_DIR` | `/app/screenshots` | Physical writable screenshot root; set a local directory for native development |

Changing `LIME_DB_PORT` requires updating the native `DATABASE_URL` port as well. Changing native API/UI ports also requires `SHOPKEEPER_PORT`, `SHOPKEEPER_URL`, and `REPORT_BASE_URL` to agree. Host port mappings do not change container-internal ports.

### File Locations

- **Root `.env`**: Native local-development runtime values plus published UI/API ports used by `docker-compose.yml` and Make targets.
- **Root `.env.example`**: Template — copy to `.env` for new setups.
- **`lime/.env.local`**: Optional NextJS-native override file if you run `npm run dev` manually inside `lime/` instead of using `make dev-ui`.
- **`deploy/release/.env.example`**: Template used by the release bundle for running published images against an external PostgreSQL database.

Make targets auto-detect the Docker Compose plugin (`docker compose`) and fall back to the legacy standalone binary (`docker-compose`). If your server needs an explicit command, run targets with `DOCKER_COMPOSE=docker-compose`.

## Running the Stack

### Full Stack (Docker)

```bash
make start-all      # Build and start production-style services
make start-dev      # Build and start services with UI hot reload
make migrate-all    # Apply DB migrations without stopping services
make stop-all       # Stop all services
```

`make stop-all` removes this Compose stack's containers/network but preserves its database and screenshot volumes; it does not stop unrelated Docker containers. `make clean` is destructive: it removes the stack's volumes and all of `dist/`, including backups stored there. Do not use it for routine shutdown or before copying backups off-host.

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
SHOPKEEPER_SCREENSHOT_DIR="$PWD/.artifacts/native-screenshots" make dev-shopkeeper
make dev-ui            # NextJS with hot reload (in a new terminal)
```

Use separate terminals for the two development processes. The Air executable must be on `PATH` after `go install`; `go env GOPATH` identifies its usual `bin` directory. With the default ports, Shopkeeper renders PDFs through the native UI at `http://localhost:3000`. For a custom native UI port, explicitly set `REPORT_BASE_URL` on the backend.

`make dev-ui` automatically points the Next proxy at `http://localhost:<LIME_API_PORT>`, so native UI development stays aligned with the local Go backend even though the Dockerized UI container talks to `http://shopkeeper:8080` internally.

Note: scans now recover automatically when Shopkeeper starts again, but `make dev-shopkeeper` still restarts the Go process frequently during code edits. For stable long-running scans, prefer `make start-shopkeeper`, `make start-dev`, or production-style `make start-all`.

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

### Marketing Website And Docs

```bash
npm --prefix docs-site ci
make docs-dev          # website and docs with hot reload on localhost:3001
make docs-run          # build and serve the production static export
make docs-verify       # build, validate links/assets, and verify browser interactions
```

Open `http://localhost:3001/` for the complete website and `http://localhost:3001/docs/` for documentation. This app is separate from the product dashboard on port 3000 and does not need the database to serve its built pages. See [Docs Site](docs-site.md) for screenshot refresh and publishing.

### Verify Existing Features

Run `make verify-app` to exercise the product against deterministic local pages in an isolated production Docker stack. It uses its own database and screenshot volumes, so the checks can create, triage, retry, export, and delete test scans without changing the normal local instance. See [Verification And Handoff](verification.md) for coverage, prerequisites, artifacts, and the current evidence. Use focused checks while iterating; run the complete suite before handing off a cross-stack change.

## Release Workflow

- Pushes to `main` that change `VERSION`, or a manual `workflow_dispatch`, trigger `.github/workflows/release-docker.yml`; ordinary code-only pushes do not publish a release.
- The workflow reads `VERSION` and creates the `v<VERSION>` release tag, for example:
  - `VERSION`: `0.1.0`
  - Git tag / GitHub Release: `v0.1.0`
- `CHANGELOG.md` must include a matching `## [0.1.0]` or `## v0.1.0` section; that section becomes the release notes.
- The workflow installs dependencies, runs `make build`, publishes images via `scripts/publish-release-images.sh`, and publishes the GitHub Release via `scripts/publish-github-release.sh`.
- A release pushes:
  - `ghcr.io/sumanbasuli/lime-shopkeeper:v0.1.0`
  - `ghcr.io/sumanbasuli/lime-ui:v0.1.0`
- The workflow also publishes `latest` and `sha-<commit>` image tags.
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

First copy the bundle's `.env.example` to `.env` and replace its database URL. The bundle does not contain the repository update scripts. The release Compose file also currently omits `REPORT_BASE_URL`; configure an override pointing Shopkeeper at `http://ui:3000` before using PDF exports. See [Docker deployment](deployment/docker.md#published-image-deployment) for the override and update instructions.

The release `.env` file is the source of truth for:
- image registry
- published image tag
- `DATABASE_URL`
- `SHOPKEEPER_URL`
- public UI/API ports
- Shopkeeper exposure on `LIME_API_PORT` (published by default; remove or restrict that mapping for private backend access)

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
| POST | `/api/scans/{id}/pause` | Request a cooperative pause for an active scan |
| POST | `/api/scans/{id}/resume` | Continue pending pages in a paused scan using the same scan ID |
| POST | `/api/scans/{id}/retry-failed` | Requeue failed pages on a completed partial scan and continue the same scan |
| GET | `/api/scans/{id}` | Get scan detail by ID |
| DELETE | `/api/scans/{id}` | Delete a completed, paused, or failed scan and its saved assets |
| GET | `/api/scans/{id}/issues` | Get issues with occurrences for a scan, including ACT rules and suggested fixes |
| POST | `/api/scans/{id}/issues/{issueId}/false-positive` | Mark an issue as a false positive |
| DELETE | `/api/scans/{id}/issues/{issueId}/false-positive` | Remove the false-positive mark from an issue |

These routes are served by Shopkeeper and are also reachable through the dashboard's same-origin proxy. Paginated issue reads, application settings, and CSV/LLM exports are owned by Next and must use the dashboard origin. The [public API reference](https://lime.heysuman.com/api/) lists both surfaces. Shopkeeper also serves `/api/version`, `/api/screenshots/{scanId}/{filename}`, and the read-only MCP tools. Use the dashboard's canonical `/mcp` endpoint (local port 3000): it proxies authentication/tool requests to Shopkeeper, adds fresh scores using the existing UI scorer, and provides the correct origin for report paths. The static docs website on port 3001 is not an MCP endpoint. Direct Shopkeeper `/mcp` remains available but returns null for cold/stale score caches. See [MCP Integration](mcp.md) for client-specific bearer-key setup, reachable HTTPS remote access, and the read-only SDK smoke test.

Next also owns `GET /_lime/update-check`, which checks releases by default and returns HTTP 200 with `enabled: false` when explicitly disabled. Set `LIME_UPDATE_CHECK=false` on the UI service to opt out; the isolated docs/verification Compose stack keeps this value explicitly false. See [Updating LIME](deployment/updates.md) for the server opt-out, immediate browser preference, and release-specific dismissal behavior.

## Runtime Behavior

- A scan continues running if the user changes pages or closes the scan detail view; only the frontend polling stops.
- **Pause** requests a cooperative stop. Pages already in flight may finish before the scan becomes `paused`; **Resume** continues pending pages with the same scan ID and saved results. Paused scans remain paused across backend restarts.
- Active background work is lost when Shopkeeper exits, but scans left in `pending`, `profiling`, `scanning`, or `processing` are recovered on its next startup.
- Interrupted active scans without a saved pause request restart from a clean run: Shopkeeper resets their URL/issue data and progress, removes their screenshot directory, and reruns the same scan ID with its saved target and viewport. A saved pause request is finalized as paused instead; already paused scans remain paused. This restart recovery differs from explicit **Resume**, which keeps completed-page evidence and continues pending pages.
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
- Completed partial scans can now retry only their failed pages in place. That reopens the same scan ID, keeps completed pages intact, and updates the existing report instead of creating a second scan.
- ACT issue guidance is loaded from the local checked-in catalog at read time. There is no runtime dependency on W3C services and no ACT snapshot stored in Postgres.
- The issue details page is the main ACT UI surface in this phase. Compact scan summaries remain unchanged.
- False-positive marking is persisted per scan issue. The issue remains visible as excluded evidence, while dashboard open-issue counts and active scoring exclude it. Marking or unmarking invalidates derived score and issue-summary caches. New scans inherit the latest terminal decision for matching target URL, scan type, and viewport; changing one scan does not retroactively change another scan's saved state.

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
| `/` | Overview: workspace metrics, active scan progress, recent scans, new-scan entry point |
| `/scans` | All scans list with tag filters and search |
| `/scans/new` | New scan form |
| `/scans/[id]` | Scan detail with live progress |
| `/scans/[id]/issues` | Expandable issues viewer |
| `/settings` | Persisted reporting, performance, and MCP controls |
| `/links` | Link checker design preview; no backend checks or saved results |
| `/reports/scans/[id]/issues` | Printable report document used by PDF generation |

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
- **UI Components**: shadcn/ui-style components using Base UI primitives and TailwindCSS
- **Database ORM**: Drizzle ORM (scan reads plus UI-owned settings and derived read caches)
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

The Drizzle schema in `lime/src/db/schema.ts` must be kept in sync with the SQL migrations manually. All schema changes should originate in the Go migrations (Shopkeeper owns migration execution), then be reflected in the Drizzle schema. This includes UI-owned settings and derived cache tables as well as scan results.
