# Docker & Deployment

Choose the Compose configuration for your deployment:

- `docker-compose.yml` for production-style local builds from source
- `docker-compose.dev.yml` as the local development override for UI hot reload
- `docker-compose.release.yml` for published runtime images

`docker-compose.docs.yml` is a fourth, isolated demonstration/verification stack, not the production deployment template. `make verify-app` selects its own project name and ports.

The Makefile auto-detects either the Docker Compose plugin (`docker compose`) or the legacy standalone binary (`docker-compose`). Set `DOCKER_COMPOSE=docker-compose` explicitly if your server has only the legacy command and auto-detection cannot see it.

The services divide responsibilities as follows:

- the UI reads PostgreSQL directly for server-rendered pages
- Shopkeeper handles scan actions and API writes
- the browser only talks to the UI origin
- the Next server proxies `/api/...` to Shopkeeper at runtime through `SHOPKEEPER_URL`

That keeps the Docker images generic. They do not need a build-time public API URL.

## Before Public Hosting

Use one Shopkeeper per database. Its active jobs, pause cancellation, and restart recovery are process-local; another backend can reset a job still running elsewhere. The screenshot volume is part of the durable application state and must be backed up with PostgreSQL.

The source stack publishes PostgreSQL on port 5432, Shopkeeper on 8080, and the UI on 3000. The release stack also publishes the backend and UI. Remove or restrict unnecessary port mappings, and put the UI behind a reverse proxy with TLS and access control. The dashboard and ordinary API routes have no built-in login; the MCP key protects only MCP.

Browser write requests to the ordinary API must come from the dashboard's origin. The existing trusted `http://localhost:<port>` development exception for direct Shopkeeper calls remains, as do non-browser clients without an `Origin` header; other cross-origin browser writes are rejected. A public reverse proxy must preserve the browser's `Origin` and `Host` headers and set `X-Forwarded-Proto` to the public request scheme, as in the [Debian nginx example](../../deploy/debian/nginx.conf.example), so same-origin dashboard writes are recognized. This browser protection does not replace the access control above.

Replace development credentials for nonlocal use, protect `.env`, and ensure both services reach the same PostgreSQL database. A production database URL's TLS requirements depend on its provider; the local `sslmode=disable` example is not a recommendation for a remote database.

## Local Docker Stack

The local stack builds from source and keeps the bundled Postgres workflow:

1. `db`
2. `shopkeeper`
3. `ui`

Use:

```bash
make start-all
make stop-all
```

For a new checkout, copy `.env.example` to `.env` first. `make start-all` builds the services, starts the database, and Shopkeeper applies migrations on startup. `make start-dev` instead applies the UI hot-reload override. The individual `start-db`, `start-shopkeeper`, `start-ui`, and `migrate-all` targets are available when working on one service.

The root `.env` controls:
- published UI and API host ports
- native local-development `DATABASE_URL`
- native local-development `SHOPKEEPER_URL`
- bundled Postgres bootstrap values

Local configuration:

- the Docker services override `DATABASE_URL` and `SHOPKEEPER_URL` internally to use Docker service names (`db` and `shopkeeper`)
- `make start-all` builds the production UI image and serves the built Next app
- `make start-dev` applies `docker-compose.dev.yml` and runs the UI with NextJS hot reload. In a checkout created by the one-line installer, it also keeps the generated `docker-compose.install.yml` override last, so database, API, and UI ports stay bound to localhost. Manual source checkouts retain their existing Compose behavior. If running Compose commands by hand in an installer checkout, include the generated override last as well.
- `make dev-ui` overrides `SHOPKEEPER_URL` to `http://localhost:<LIME_API_PORT>` for native Next development
- Shopkeeper's `REPORT_BASE_URL=http://ui:3000` lets Chromium render PDFs from the dashboard over the Docker network

Check `docker compose ps`, the startup logs, and `curl -fsS http://localhost:3000/api/health` (adjust a custom UI port). Then run a small scan and open a screenshot/PDF. Container liveness alone does not prove the whole flow works. `make stop-all` preserves volumes; `make clean` deletes database/screenshots volumes and `dist/`, including any backups there.

## Production Build Targets

The root [Makefile](../../Makefile) exposes:

- `make build` for production artifacts in `dist/`
- `make build-docker` for local production image builds tagged from [VERSION](../../VERSION)
- `make migrate-all` to run `./shopkeeper --migrate` in a one-off Shopkeeper container against the local Docker database

Local image names:
- `lime-shopkeeper:v<version>`
- `lime-ui:v<version>`

These builds are generic. Runtime deployments must supply:
- `DATABASE_URL`
- `SHOPKEEPER_URL`
- any published port mapping they want

## GitHub Release Publishing

Pushing a `VERSION` change to `main`, or manually dispatching it, triggers [release-docker.yml](../../.github/workflows/release-docker.yml). A code-only push does not publish images automatically.

The workflow:
- reads `VERSION` and uses `v<VERSION>` as the release tag
- requires a matching `CHANGELOG.md` section and uses it as the GitHub Release notes
- claims an absent remote release tag before building images, and refuses to publish if that tag points at another commit or the remote cannot be checked
- installs the repo toolchains and runs `make build` as the release preflight
- builds and pushes:
  - `ghcr.io/<repo-owner>/lime-shopkeeper:<release-tag>`
  - `ghcr.io/<repo-owner>/lime-ui:<release-tag>`
- also tags both images as `latest` and `sha-<commit>`
- uses `scripts/publish-release-images.sh` for Docker publish logic
- adds OCI labels for source, version, and revision
- uses `scripts/publish-github-release.sh` to create or update the GitHub Release
- uploads a release bundle asset such as `lime-v2.0.0-release.tar.gz`

The workflow does not use a build-time `NEXT_PUBLIC_API_URL`.

For a manual image publish, `scripts/publish-release-images.sh` requires a clean checkout and checks `origin` before building. Tracked changes and non-ignored untracked files are rejected. Both pushed images use Dockerfiles and build recipes from a temporary archive of the commit being tagged, not the live checkout. Ignored local files are excluded from the Docker build context, and release builds use the standard `--pull` flag. The temporary archive is removed after publishing.

If the version tag is absent, the script creates an annotated tag at that commit and pushes it without force; a same-commit tag is accepted on a retry. An unreachable remote is not treated as an absent tag. If an image build or push fails after the tag claim, fix the failure and rerun from the same commit; the tag may exist without a completed GitHub Release. Set `PUSH_IMAGES=false` only when you want local image builds from your checkout without any registry push or remote-tag claim.

## Published Image Deployment

The release bundle contains:
- `docker-compose.release.yml`
- `.env.example`
- `README.md`
- `data/*.json`

After extracting the bundle, copy `.env.example` to `.env`, set the external `DATABASE_URL`, and review the selected image tag. Do not overwrite an existing operator `.env` during an update. The release stack includes no PostgreSQL server.

The current release Compose template omits `REPORT_BASE_URL`. Before enabling PDF use, add this under the existing `shopkeeper.environment` block in your deployment's Compose file:

```yaml
REPORT_BASE_URL: http://ui:3000
```

This is the backend-to-UI direction; `SHOPKEEPER_URL=http://shopkeeper:8080` in `.env` configures the opposite direction. Setting `REPORT_BASE_URL` only in `.env` is insufficient because the current template does not forward that variable. Alternatively use a Compose override, but consistently include it for startup, diagnostics, migration, update, and recovery; `scripts/docker-update.sh` accepts one `COMPOSE_FILE` and does not combine an additional override automatically.

From the extracted deployment directory:

```bash
docker compose --env-file .env -f docker-compose.release.yml config --quiet
docker compose --env-file .env -f docker-compose.release.yml up -d
```

Create/edit `.env` and apply the report configuration before these validation/start commands. `config --quiet` validates without printing resolved secrets. Test the backend connection through the UI and generate a real PDF after startup.

The release stack is external-Postgres only. It ships only:
- `shopkeeper`
- `ui`

Required template values are `LIME_IMAGE_TAG`, `DATABASE_URL`, and `SHOPKEEPER_URL`. `LIME_IMAGE_REGISTRY` defaults to `ghcr.io/sumanbasuli`; public API/UI ports default to 8080/3000. `LIME_UPDATE_CHECK` defaults to true and can be explicitly false for offline deployments. Images carry their version; there is no need to force `LIME_VERSION=0.0.0` at runtime.

The bundled data directory is mounted into `/shared-data` so ACT and axe metadata are available without a source checkout.

The bundle contains no `scripts/` or Makefile. `scripts/docker-update.sh`/`make update-release` require the repository checkout with the correct deployment/env file paths; do not run them against an unrelated default `.env`. See [Updating LIME](updates.md) for a manual bundle-only sequence and helper limitations.

## Runtime URL Model

The browser uses only same-origin UI paths:
- page routes like `/scans/...`
- API routes like `/api/scans/...`
- screenshot routes like `/api/screenshots/...`

The Next route handler proxies those `/api/...` requests to `SHOPKEEPER_URL` at runtime. That means:
- reverse proxies can publish the UI on any external host or port
- the images do not need rebuilding when deployment URLs change
- direct Shopkeeper exposure can be removed/restricted, but the shipped Compose file publishes `LIME_API_PORT` by default

## Debian Systemd Production

`make build` produces:
- `dist/shopkeeper/` with the compiled binary and migrations
- `dist/ui/` with the Next standalone output
- the release bundle archive

For native Debian-family systemd deployments, use:

```bash
make debian-install
```

The installer validates Debian-family Linux before writing to `/opt/lime`, `/etc/lime`, or `/etc/systemd/system`. See [Debian deployment](debian.md) for the full flow.

## Docker Hygiene

Service-level `.dockerignore` files exclude local-only files such as:
- `node_modules`
- `.next`
- local env files
- screenshots
- build caches
- editor artifacts

This keeps build contexts small and excludes local files from release images.

## Shopkeeper Container Note

Shopkeeper runs Chromium inside Docker. The Compose configuration sets `shm_size: 2gb` for browser shared memory.

The embedded axe library and image-baked catalogs work without outbound rule downloads; scan targets and the default-enabled GitHub release check still need their own network access. A scan target on `localhost` refers to the backend container itself, not the host/browser. Use a hostname reachable from that container for local fixtures.

## Recovery And Diagnostics

Keep stable Compose project names and volume identities when updating; a new project name can create an empty screenshot/database volume instead of reusing the old one. Changing PostgreSQL bootstrap variables does not recreate users/passwords in an already initialized data volume. Do not delete `pgdata` to resolve a credential mismatch.

See [Backup And Restore](backup-restore.md) for backing up the database and screenshots together, [Updating LIME](updates.md) for upgrades and migration requirements, and [Operational Troubleshooting](troubleshooting.md) for diagnostics.
