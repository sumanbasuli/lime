# Docker & Deployment

LIME now has two distinct Docker surfaces:
- `docker-compose.yml` for local development
- `docker-compose.release.yml` for published runtime images

The runtime model is intentionally split:
- the UI still reads PostgreSQL directly for server-rendered pages
- Shopkeeper still owns scan actions and API writes
- the browser only talks to the UI origin
- the Next server proxies `/api/...` to Shopkeeper at runtime through `SHOPKEEPER_URL`

That keeps the Docker images generic. They do not need a build-time public API URL.

## Local Docker Stack

The local stack builds from source and keeps the bundled Postgres workflow:

1. `db`
2. `shopkeeper`
3. `ui`

Use:

```bash
make start-db
make start-shopkeeper
make start-ui
make start-all
make stop-all
```

The root `.env` controls:
- published UI and API host ports
- native local-development `DATABASE_URL`
- native local-development `SHOPKEEPER_URL`
- bundled Postgres bootstrap values

Important local detail:
- the Docker services override `DATABASE_URL` and `SHOPKEEPER_URL` internally to use Docker service names (`db` and `shopkeeper`)
- `make dev-ui` overrides `SHOPKEEPER_URL` to `http://localhost:<LIME_API_PORT>` for native Next development

## Production Build Targets

The root [Makefile](/Users/txsadhu/Documents/Campuspress/lime/Makefile) exposes:

- `make build` for production artifacts in `dist/`
- `make build-docker` for local production image builds tagged from [VERSION](/Users/txsadhu/Documents/Campuspress/lime/VERSION)

Local image names:
- `lime-shopkeeper:v<version>`
- `lime-ui:v<version>`

These builds are generic. Runtime deployments must supply:
- `DATABASE_URL`
- `SHOPKEEPER_URL`
- any published port mapping they want

## GitHub Release Publishing

Publishing a GitHub Release triggers [release-docker.yml](/Users/txsadhu/Documents/Campuspress/lime/.github/workflows/release-docker.yml).

The workflow:
- validates that `VERSION` matches the GitHub Release tag after `v` normalization
- builds and pushes:
  - `ghcr.io/sumanbasuli/lime-shopkeeper:<release-tag>`
  - `ghcr.io/sumanbasuli/lime-ui:<release-tag>`
- publishes `latest` only for non-prerelease releases
- adds OCI labels for source, version, and revision
- uploads a release bundle asset like `lime-v0.1.0-release.tar.gz`

No build-time `NEXT_PUBLIC_API_URL` is used in this workflow anymore.

## Release Bundle

The release bundle contains:
- `docker-compose.release.yml`
- `.env.example`
- `README.md`
- `data/*.json`

After extracting the bundle:

```bash
cp .env.example .env
docker compose --env-file .env -f docker-compose.release.yml up -d
```

The release stack is external-Postgres only. It ships only:
- `shopkeeper`
- `ui`

Required runtime env values:
- `LIME_IMAGE_TAG`
- `DATABASE_URL`
- `SHOPKEEPER_URL`
- `LIME_API_PORT`
- `LIME_UI_PORT`

The bundled data directory is mounted into `/shared-data` so ACT and axe metadata are available without a source checkout.

## Runtime URL Model

The browser uses only same-origin UI paths:
- page routes like `/scans/...`
- API routes like `/api/scans/...`
- screenshot routes like `/api/screenshots/...`

The Next route handler proxies those `/api/...` requests to `SHOPKEEPER_URL` at runtime. That means:
- reverse proxies can publish the UI on any external host or port
- the images do not need rebuilding when deployment URLs change
- direct Shopkeeper exposure on `LIME_API_PORT` remains optional for debugging or separate service access

## Non-Docker Production

`make build` produces:
- `dist/shopkeeper/` with the compiled binary and migrations
- `dist/ui/` with the Next standalone output
- the release bundle archive

For non-Docker deployments, operators must still provide runtime env for:
- `DATABASE_URL`
- `SHOPKEEPER_URL`

Because the UI still reads PostgreSQL directly for server-rendered pages, both processes must be able to reach the same database.

## Docker Hygiene

Service-level `.dockerignore` files exclude local-only files such as:
- `node_modules`
- `.next`
- local env files
- screenshots
- build caches
- editor artifacts

This keeps build contexts small and prevents development noise from leaking into released images.

## Shopkeeper Container Note

Shopkeeper still runs Chromium inside Docker, so the container keeps `shm_size: 2gb` to avoid browser memory issues during scans.
