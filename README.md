# LIME - Accessibility Scanner

LIME is an accessibility scanning system that uses axe-core to evaluate websites for accessibility issues. It processes sitemaps, scans individual pages with a headless browser, and presents grouped results through a web UI.

## Architecture

- **Shopkeeper** (`/shopkeeper`): Go backend REST API that orchestrates scanning (Chi router, pgx)
- **UI** (`/lime`): NextJS frontend dashboard (shadcn/ui, Drizzle ORM)
- **Database**: PostgreSQL (shared between both services)

See the [docs](./docs/index.md) folder for detailed architecture and design documentation.

## Prerequisites

- Docker and Docker Compose
- Go 1.25+ (for local development)
- Node.js 23+ (for local development)

## Quick Start

### Start everything

```bash
make start-all
```

Copy [/.env.example](/Users/txsadhu/Documents/Campuspress/lime/.env.example) to `.env` before first run. For local Docker, the root `.env` controls the published UI/API ports and the native-development runtime values. The Docker services themselves use Compose service names internally, so the images stay generic.

### Access the application

- **UI**: http://localhost:3000
- **API**: http://localhost:8080
- **API Health**: http://localhost:8080/api/health

### Stop everything

```bash
make stop-all
```

## Local Development (without Docker)

Start only the database:

```bash
make start-db
```

Then in separate terminals:

```bash
make dev-shopkeeper    # Go backend with hot reload (Air)
make dev-ui            # NextJS with hot reload
```

## Available Commands

| Command | Description |
|---------|-------------|
| `make start-db` | Start PostgreSQL only |
| `make start-shopkeeper` | Start Go backend (starts DB if needed) |
| `make start-ui` | Start NextJS frontend |
| `make start-all` | Start entire stack |
| `make stop-all` | Stop all services |
| `make logs-db` | Tail database logs |
| `make logs-shopkeeper` | Tail backend logs |
| `make logs-ui` | Tail frontend logs |
| `make dev-ui` | Run NextJS locally with hot reload |
| `make dev-shopkeeper` | Run Go backend locally with Air hot reload |
| `make build` | Build production artifacts and create the release bundle |
| `make build-docker` | Build versioned production Docker images locally |
| `make clean` | Stop all services and remove volumes |

## Production Builds

The repo-wide version source is [VERSION](/Users/txsadhu/Documents/Campuspress/lime/VERSION).

```bash
make build
make build-docker
```

`make build` creates:
- `dist/shopkeeper/` with the compiled backend and migrations
- `dist/ui/` with the Next standalone production output
- `dist/lime-v<version>-release.tar.gz` with the release-ready Docker bundle

`make build-docker` creates:
- `lime-shopkeeper:v<version>`
- `lime-ui:v<version>`

These production images are generic. They do not bake in deployment-specific API URLs. At runtime, operators provide:
- `DATABASE_URL` for both the UI and Shopkeeper
- `SHOPKEEPER_URL` for the UI server-side proxy target
- published ports through Compose or their own process manager

## GitHub Releases and Packages

Publishing a GitHub Release with a tag like `v0.1.0` now:
- validates that `VERSION` matches the release tag
- publishes `ghcr.io/sumanbasuli/lime-shopkeeper:v0.1.0`
- publishes `ghcr.io/sumanbasuli/lime-ui:v0.1.0`
- updates `latest` only for stable releases
- uploads a bundle asset named like `lime-v0.1.0-release.tar.gz`

The release bundle is external-Postgres by default. Users edit the bundle `.env` file with:
- `LIME_IMAGE_TAG`
- `DATABASE_URL`
- `SHOPKEEPER_URL`
- `LIME_API_PORT`
- `LIME_UI_PORT`

Browser traffic stays on the UI origin. The Next app proxies `/api/...` requests to `SHOPKEEPER_URL` at runtime, so the same images work on localhost, on custom ports, or behind a reverse proxy without rebuilds.
