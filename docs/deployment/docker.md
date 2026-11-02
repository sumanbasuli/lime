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

The source stack binds PostgreSQL to `127.0.0.1:5432` by default while publishing Shopkeeper on 8080 and the UI on 3000. The release stack also publishes the backend and UI on host interfaces by default; these binds remain unchanged for existing remote deployments. The docs-demo database binds to localhost. The dashboard and ordinary API routes have no built-in login, and the MCP key protects only MCP. Before allowing remote access, restrict the published UI and API ports with a firewall or authenticated reverse proxy, serve the UI over TLS, and remove or restrict the direct Shopkeeper mapping if it is not needed. If remote PostgreSQL access is necessary, set `LIME_DB_BIND_HOST` explicitly, keep the unique password created for new installs, and allow only trusted client addresses. An older stack using the former default password needs a deliberate database-role rotation, not just an `.env` edit.

Link CSV downloads may use up to 512 MiB of temporary storage inside the Shopkeeper container while the export is prepared and delivered. Keep its temporary directory on suitable disk-backed storage rather than a small tmpfs; a full or failing temporary volume returns an export error before the CSV response starts. Only one such export runs per Shopkeeper process at a time.

Scans make network requests from Shopkeeper. Limit who can submit private targets, and use network rules to keep Shopkeeper away from sensitive management and metadata services. When a private target uses the standard HTTP or HTTPS port, its page can also request the same host on the other standard port, even if that port belongs to a separate service.

Browser write requests to the ordinary API must come from the dashboard's origin. The existing trusted `http://localhost:<port>` development exception for direct Shopkeeper calls remains, as do non-browser clients without an `Origin` header; other cross-origin browser writes are rejected. A public reverse proxy must preserve the browser's `Origin` and `Host` headers and set `X-Forwarded-Proto` to the public request scheme, as in the [Debian nginx example](../../deploy/debian/nginx.conf.example), so same-origin dashboard writes are recognized. This browser protection does not replace the access control above.

Both services also reject an unrecognized HTTP `Host` with status 421. `LIME_ALLOWED_HOSTS` is a comma-separated list of exact DNS names, without schemes, paths, or wildcards; a port may be present but does not restrict matching to that port. Names are matched case-insensitively. `localhost` and literal IPv4/IPv6 addresses are accepted implicitly, even when omitted from the list. An invalid list fails closed for both services, including their health checks. Source, release, and docs-demo Compose pass `LIME_ALLOWED_HOSTS` to **both** services and default it to `ui,shopkeeper` for internal requests. Before serving `lime.example.com`, set `LIME_ALLOWED_HOSTS=ui,shopkeeper,lime.example.com` in the deployment `.env`, then recreate both services. Include any distinct public API DNS name if clients reach Shopkeeper directly. The reverse proxy must preserve the original `Host` on both hops. Keep the ingress hostname check, firewall/authentication, and direct Shopkeeper network boundary: this application list does not authenticate callers, and the implicit IP allowance means it does not restrict direct IP access.

Protect `.env`, use unique credentials for nonlocal deployments, and ensure both services reach the same PostgreSQL database. A production database URL's TLS requirements depend on its provider; the local `sslmode=disable` example is not a recommendation for a remote database.

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

For a new checkout, start Docker, then run `make init-env` before starting LIME. It checks for an existing LIME container and Compose `pgdata` volumes, creates a private `.env` with a unique password only for a fresh stack, and refuses to overwrite an existing `.env`. If the host has another project's unrelated `pgdata` volume, first confirm which project and volume your checkout will use; then set `LIME_INIT_ENV_ALLOW_OTHER_PGDATA=true` for this one initialization. It never ignores a volume named for this checkout's `COMPOSE_PROJECT_NAME` (or directory-derived default). Initialization accepts the ordinary `docker compose` or `docker-compose` command only: put any `-p`/`--project-name` selection in `COMPOSE_PROJECT_NAME` and use the same Docker context for initialization and startup. Keep the new `.env` with the database volume across updates: changing the Compose password does not change an already-initialized PostgreSQL role. Source Compose now refuses a missing or blank password. If you have an older volume but no `.env`, restore its existing credential in a private `.env` instead of running the initializer; do not remove the volume or generate a new password for it. `make start-all` builds the services, starts the database, and Shopkeeper applies migrations on startup. `make start-dev` instead applies the UI hot-reload override. The individual `start-db`, `start-shopkeeper`, `start-ui`, and `migrate-all` targets are available when working on one service.

For a legacy no-`.env` stack, first confirm the original Compose project and `pgdata` volume; preserve the original `-p`/`COMPOSE_PROJECT_NAME` on every subsequent command. Create a new mode-`0600` `.env` from `.env.example` only if the file is absent, and set `POSTGRES_PASSWORD` to the password already in that database (the old source fallback was `lime_dev_password` unless you overrode it). Set native `DATABASE_URL` to the same credential if you run Shopkeeper outside Compose. Then check Compose configuration and restart with the same project and volume. A changed `POSTGRES_PASSWORD` environment value does not rotate PostgreSQL's stored role password; perform a deliberate database credential rotation separately after you have a verified backup.

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
The `VERSION` file and any direct bundle version must use `major.minor.patch`, optionally followed by a prerelease suffix such as `-rc.1`. Keep `VERSION` on one line. Release builds reject other forms before replacing bundle output or claiming a tag. Native builds, bundle generation, and GitHub publishing reject a symlinked `dist`; bundle generation also rejects a symlinked `dist/release` or output archive, and the publisher rejects symlinked bundle and release-notes files. Use real build-output directories.

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

After extracting the bundle, run `umask 077; cp .env.example .env; chmod 600 .env` for a new install, set the external `DATABASE_URL`, and review the selected image tag. Do not overwrite an existing operator `.env` during an update. The release stack includes no PostgreSQL server.

The release Compose template sets Shopkeeper's `REPORT_BASE_URL` to `http://ui:3000`, so PDF rendering can reach the dashboard inside the Compose network. Set `REPORT_BASE_URL` in `.env` only if your internal UI address differs. `SHOPKEEPER_URL=http://shopkeeper:8080` configures the opposite, UI-to-backend direction. If you use a Compose override for either address, include it consistently for startup, diagnostics, migration, update, and recovery; `scripts/docker-update.sh` accepts one `COMPOSE_FILE` and does not combine an additional override automatically.

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

All three Compose stacks also set Shopkeeper `mem_limit` and `memswap_limit` to `2g` by default. The equal values allow no additional swap beyond the memory limit. Set `LIME_SHOPKEEPER_MEMORY_LIMIT` in `.env` to change both together after sizing the host and testing representative scans and exports; a larger limit increases the possible impact of a heavy page, while a smaller one can terminate Shopkeeper or Chromium during normal work. The 2 GB shared-memory allocation is separate from these limits. Keep the selected value and current Compose files when updating, and inspect `docker compose config` before recreating the service.

Shopkeeper and Chromium run as UID/GID `10001`, with no process capabilities and no-new-privileges. Chromium's sandbox is required. The current Compose files load `deploy/docker/chromium-seccomp.json` from your checkout or release bundle; keep that file with the Compose deployment. The policy is for Docker Engine on Linux amd64/arm64, including Docker Desktop's Linux VM. Other runtimes need their own validation; do not use an unconfined profile or add `SYS_ADMIN` to bypass a startup failure.

Existing installations need the [one-time sandbox upgrade](updates.md#one-time-chromium-sandbox-upgrade). Changing only an image tag in an old Compose file is insufficient. Shopkeeper checks that a sandboxed browser can start before applying migrations or opening its HTTP port, and exits with a diagnostic if it cannot.

The container entrypoint briefly starts as root to prepare the fixed `/app/screenshots` volume, then drops privileges before running Shopkeeper or a command such as `./shopkeeper --migrate`. On the first start, it transfers supported root-owned legacy captures to UID/GID `10001`, preserving their paths, bytes, and permission bits. It rejects symlinks, hard-linked files, nested mounts, special files, and unexpected owners instead of following or broadly changing them. Keep the image's default entrypoint and user; a custom read-only screenshot mount or user override cannot perform this upgrade.

Shared catalog mounts must be readable by both Shopkeeper (`10001`) and the UI (`1001`), with traversal access on the mounted directories. The release bundle provides readable copies of its public catalogs; the fresh one-line installer prepares its cloned public catalogs too. For a manual checkout or custom catalog, grant those users the narrow read/traverse access it needs; do not make `.env` files or screenshots public. An unreadable or malformed ACT catalog stops Shopkeeper startup.

Continue to restrict scan submission to trusted users, isolate the backend from sensitive internal services, and keep host Docker sockets and unrelated secrets out of the container.

The embedded axe library and image-baked catalogs work without outbound rule downloads; scan targets and the default-enabled GitHub release check still need their own network access. A scan target on `localhost` refers to the backend container itself, not the host/browser. Use a hostname reachable from that container for local fixtures.

## Recovery And Diagnostics

Keep stable Compose project names and volume identities when updating; a new project name can create an empty screenshot/database volume instead of reusing the old one. Changing PostgreSQL bootstrap variables does not recreate users/passwords in an already initialized data volume. Do not delete `pgdata` to resolve a credential mismatch.

See [Backup And Restore](backup-restore.md) for backing up the database and screenshots together, [Updating LIME](updates.md) for upgrades and migration requirements, and [Operational Troubleshooting](troubleshooting.md) for diagnostics.
