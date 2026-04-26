# Docker Deployment

This is the recommended Docker option. You run the published GHCR images via Docker Compose and point them at a PostgreSQL database you own.

## Prerequisites

- Docker Engine 24+ and the Compose plugin
- A PostgreSQL 17 database reachable from the host (external or run on the same box)
- Optional: a reverse proxy (nginx/Caddy/Traefik) with TLS in front of the UI port

## Quick start from the release bundle

1. Download the latest release bundle asset (`lime-vX.Y.Z-release.tar.gz`) from GitHub Releases.
2. Extract it:

   ```bash
   tar -xzf lime-v0.1.0-release.tar.gz
   cd lime-v0.1.0
   ```

3. Copy and edit the environment file:

   ```bash
   cp .env.example .env
   $EDITOR .env
   ```

   Set at least `LIME_IMAGE_REGISTRY`, `LIME_IMAGE_TAG`, `DATABASE_URL`, and `SHOPKEEPER_URL`.

4. Start the stack:

   ```bash
   docker compose --env-file .env -f docker-compose.release.yml up -d
   ```

## Starting from a git checkout

If you prefer building from source:

```bash
git clone https://github.com/sumanbasuli/lime.git
cd lime
cp .env.example .env
# the dev compose uses a bundled PostgreSQL container
make start-all
```

The dev `docker-compose.yml` bundles its own PostgreSQL. Only use it if you do not already have a database and accept the single-container failure domain.

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `LIME_IMAGE_REGISTRY` | yes (release) | GHCR namespace containing the published images, e.g. `ghcr.io/sumanbasuli` |
| `LIME_IMAGE_TAG` | yes (release) | GHCR image tag to pin, e.g. `v0.1.0` |
| `DATABASE_URL` | yes | PostgreSQL connection string used by both services |
| `SHOPKEEPER_URL` | yes | URL the UI proxies `/api/...` to (internal Docker URL or external) |
| `LIME_API_PORT` | no | Host port published for the Shopkeeper API (default `8080`) |
| `LIME_UI_PORT` | no | Host port published for the UI (default `3000`) |
| `LIME_UPDATE_CHECK` | no | `true` to show GitHub release notices in the sidebar |
| `LIME_GITHUB_REPO` | no | Override the repo checked for updates (default `sumanbasuli/lime`) |

## Updating to a newer version

Use the bundled helper. It backs up the database, pulls the new images, migrates, and rolls Shopkeeper then UI with a health-check wait in between.

```bash
./scripts/docker-update.sh v1.0.3
```

From a repository checkout you can also run:

```bash
make update-release TAG=v1.0.3
```

The script writes a gzipped dump to `dist/backups/`. Keep at least the most recent file until you confirm the new version works.

## Backups

Manual backup any time:

```bash
make backup-db          # dumps the bundled dev db service
./scripts/docker-update.sh <same-tag>  # runs a backup without changing versions (useful as a no-op checkpoint)
```

For an external database, use your provider's tooling or run `pg_dump "$DATABASE_URL"` directly.

## Reverse proxy

Expose only the UI port publicly. An example nginx config lives at [`deploy/vps/nginx.conf.example`](../../deploy/vps/nginx.conf.example).

## Operations

```bash
docker compose --env-file .env -f docker-compose.release.yml ps
docker compose --env-file .env -f docker-compose.release.yml logs -f shopkeeper
docker compose --env-file .env -f docker-compose.release.yml logs -f ui
```
