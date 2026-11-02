# Updating LIME

The sidebar notice links to release notes; you install updates using the method for your deployment. Before updating:

1. record the running version, Compose project/volume names or native paths, and deployment configuration
2. let scans finish, or request **Pause** and wait for `paused`; prevent new writes during the maintenance window
3. back up PostgreSQL, screenshots, and protected configuration, then verify the recovery set
4. pull/rebuild the selected release, stop the old UI and Shopkeeper, then apply its migrations
5. start Shopkeeper, verify startup, then start the UI and check the full scan/report flow

On backend startup, an interrupted scan keeps completed discovery checkpoints and finished page evidence; unfinished requests and pages resume under the same scan ID. A scan still queued as `pending` keeps its saved progress and starts when a worker is free. A paused scan remains paused and can resume later. Run one Shopkeeper per database; rolling/replicated infrastructure does not supply distributed scan ownership.

For the first update that includes root-DNS policy migration `000016`, MCP request-ID admission migration `000018`, Link Checker source-storage migration `000019`, or discovery checkpoint migration `000020`, use a maintenance cutover: stop accepting new scans, link checks, and MCP writes; let or pause active work; stop every old Shopkeeper process; then apply the migrations and start the new Shopkeeper. Check that an external database runs the supported PostgreSQL 17 version first. Migration `000016` conservatively marks older hostname jobs public-only; jobs created by an old process after that migration get the same safe default. An old process cannot enforce the new network policy, count new MCP request IDs, or read the source rows introduced by `000019`. After `000020`, an old process can reset a profiling scan or treat partial URL results as complete; no old Shopkeeper may run against that migrated database. Do not use an overlapping rolling backend update for the first `000020` release. The UI can be restarted after the new backend is healthy.

For the host-validation and memory-limit update, review configuration **before** restarting either service. In source/release Compose, carry forward the updated Compose file and set `LIME_ALLOWED_HOSTS` in `.env` to `ui,shopkeeper` plus every public dashboard/API DNS name used in a request `Host`; the same value reaches both services. The defaults are `ui,shopkeeper`, and `localhost` and literal IP hosts remain implicit. The updated Compose files give Shopkeeper a `2g` memory limit with no extra swap; set `LIME_SHOPKEEPER_MEMORY_LIMIT` if the host and workload need a different ceiling. On Debian, set `LIME_ALLOWED_HOSTS` in each service's `/etc/lime/*.env` and retain or create a Shopkeeper systemd drop-in if overriding the new `MemoryMax=2G`, `MemorySwapMax=0` defaults. A missing public name returns 421; a low memory ceiling can terminate in-flight work. Verify the effective hostnames and limits, health, dashboard, scan, and report path before reopening write traffic. Existing published UI/API port bindings and their external access controls remain in force.

If your checkout still contains an older update helper, do not run that old helper for this first cutover: it can apply migrations while the old Shopkeeper remains active. Obtain the trusted new release checkout. Docker and Debian use its stopped-service update path. A bundle-only Docker installation can follow the stop/migrate/start sequence with the same Compose project and preserved volumes. An old checkout cannot acquire this safety change merely by passing a new image tag.

## One-time Chromium sandbox upgrade

This release requires Chromium's sandbox and runs Shopkeeper as a non-root user. Plan a maintenance window for the first upgrade, even if you already completed the database security cutover. Keep a matching database, screenshot, and configuration backup, and stop all old backends before the new container prepares the screenshot volume.

For Docker, obtain the complete updated checkout or release bundle, including its Compose file and `deploy/docker/` directory. Use the existing project name, database, screenshot volume, `.env`, and any reviewed overrides. The seccomp policy file must be available on the machine running the Docker client. Then follow the stopped-service sequence below. An old image-only updater cannot install this host-side file: replace the deployment configuration before pulling and starting the new image. Do not remove volumes or disable the sandbox to recover from a missing policy.

On first start, the image entrypoint transfers supported legacy screenshot ownership to UID/GID `10001` without changing capture bytes, names, or modes. A large volume can take time; allow startup to finish and inspect its logs. The initializer rejects links, special files, nested mounts, and unexpected owners. If it stops, keep the old backend stopped, inspect the named entry against your backup, and resolve that specific storage issue. Do not apply a recursive permission change to the deployment. A restored root-owned backup is checked again on startup.

The backend probes Chromium and reads the ACT catalog before normal migrations or HTTP startup. Missing sandbox support or unreadable catalogs cause a clear startup failure. The updated Docker helpers stop the old services, run `./shopkeeper --verify-startup`, and only then apply migrations. A failed preflight leaves the services stopped without applying migrations. A migration-only command does not launch Chromium; it still uses the container's ownership preparation and non-root account. After startup, open a saved screenshot, finish a small scan with a highlighted capture, generate an enabled PDF and CSV export, and check MCP before reopening write traffic.

Native Debian installs use the updated `lime-shopkeeper.service` and installer from the same checkout. They provide private browser runtime storage and readable installed catalogs for the `lime` account; keep Chromium's native sandbox available under that account.

## Runtime security updates

The current source build uses Go 1.27.3, Node 24.22.1, and Next.js 16.4.1. Native deployments need the patched host runtimes too; LIME's updater does not install or upgrade Go, Node, Chromium, nginx, or an external database. Keep these components on supported security patches. See the [Go release history](https://go.dev/doc/devel/release), [Node security releases](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), and [nginx advisories](https://nginx.org/en/security_advisories.html). A vendor package may contain backported fixes without matching the upstream version number.

Source and docs-demo Compose now select PostgreSQL 17.11 rather than a floating 17.x tag. This does not upgrade a database that is already running: the application update helpers recreate only UI and Shopkeeper. Schedule database maintenance separately, take and verify backups, and review [PostgreSQL 17.11's release notes](https://www.postgresql.org/docs/17/release-17-11.html), including its post-update configuration and data-cleanup guidance. Use the existing deployment's exact project, override files, and preserved volume; do not remove volumes or switch PostgreSQL major versions as part of this patch update. Managed databases must be updated through their provider.

## Update channels

| Target | Command | Backup location |
|--------|---------|-----------------|
| Docker (published images, repository helper) | `./scripts/docker-update.sh <tag>` or `make update-release TAG=<tag>` | `dist/backups/lime-pre-<tag>-<timestamp>.sql.gz` by default if bundled DB or host `pg_dump` is available; set `LIME_BACKUP_DIR` to keep it outside the checkout. Otherwise prompts to continue without a backup. |
| Docker (from source) | clean checkout + `make update TAG=<tag>` or the manual cutover below | `dist/backups/lime-manual-<timestamp>.sql.gz` for bundled PostgreSQL; back up screenshots and configuration separately |
| Debian systemd | `sudo ./scripts/debian-update.sh <tag>` or `make debian-update TAG=<tag>` | `/var/backups/lime/lime-pre-<tag>-<timestamp>.sql.gz` |

The Docker and Debian helpers back up PostgreSQL only. They create dumps with restrictive permissions and reject a backup directory with a different owner, group/other write bits, or detected ACLs. Keep parent directories protected too, and use a private destination if an existing shared path fails the check. Back up screenshots and configuration separately, and arrange retention, encryption, and off-host storage. See [Backup And Restore](backup-restore.md).

For an external database, the Docker and Debian helpers pass a password-free PostgreSQL URI to `pg_dump` and supply its password through a short-lived file in the validated private backup directory. Standard URI userinfo and `?password=` forms are supported. LIME's migration runner also requires a URI, not libpq keyword/value connection syntax. The helper stops instead of exposing an ambiguous password or an `sslpassword` in command arguments; use a manual provider backup for those uncommon configurations. A failed dump stops the update rather than continuing with an incomplete backup.

## Published Images

`scripts/docker-update.sh` is available in a repository checkout, not in the extracted release archive. It resolves its default `.env`, Compose file, and backups relative to the repository root. To operate another deployment, explicitly select its env/Compose paths and keep the same Compose project identity; confirm the selected containers/volumes before running. Its `COMPOSE_FILE` accepts one file, not a list of overrides.

Set `LIME_BACKUP_DIR` in the shell or the selected env file to put the automatic dump outside `dist/`; an explicit shell value takes precedence. The path must be writable by the updater account and protected from writes by other local users.

The helper sources the env file as shell code, changes `LIME_IMAGE_TAG`, pulls images, stops the old UI and Shopkeeper, runs a migration-only container, recreates Shopkeeper, polls its liveness endpoint, then recreates UI. Use only a trusted, shell-compatible env file. Expect a maintenance interruption. If migration or startup fails, the old app stays stopped; the helper does not validate UI readiness or undo the changed tag/schema. Preserve the previous tag/config and inspect the failing step before retrying. The previous image tag is not a rollback for a forward-migrated database; recover with a schema-compatible release or a matched pre-update database/screenshot/configuration set. Its interactive no-backup branch uses Bash 4+ syntax; do not rely on that branch with macOS's older system Bash.

For a bundle-only deployment, use a maintenance window in the deployment directory with the updated Compose file and `deploy/docker/` assets. First take a recovery set, edit the preserved `.env` to the intended published `LIME_IMAGE_TAG`, and confirm the deployment's Shopkeeper `REPORT_BASE_URL` is configured as described in [Docker deployment](docker.md#published-image-deployment). Then:

```bash
docker compose --env-file .env -f docker-compose.release.yml config --quiet
docker compose --env-file .env -f docker-compose.release.yml stop ui shopkeeper
docker compose --env-file .env -f docker-compose.release.yml pull shopkeeper ui
docker compose --env-file .env -f docker-compose.release.yml run --rm --no-deps shopkeeper ./shopkeeper --verify-startup
docker compose --env-file .env -f docker-compose.release.yml run --rm --no-deps shopkeeper ./shopkeeper --migrate
docker compose --env-file .env -f docker-compose.release.yml up -d --no-deps shopkeeper
docker compose --env-file .env -f docker-compose.release.yml logs --tail=100 shopkeeper
# After confirming migrations/startup and backend health:
docker compose --env-file .env -f docker-compose.release.yml up -d --no-deps ui
```

Include your project name and override files consistently in every command. Do not use `down -v`; it destroys screenshot volumes. After updating, check the dashboard's health route, load saved scans, open an existing screenshot, and try each enabled export format.

## Source Docker Checkout

`make update TAG=…` backs up the bundled database, checks out the tag, rebuilds the images selected by source Compose, stops UI and Shopkeeper, runs migrations, and recreates them in that order. It waits for backend health and an HTTP response from the UI before reporting success. The sequence has a mocked failure-path test, but has not been rehearsed against a live Docker daemon here; use a maintenance window and check the scan, screenshot, and export flows afterward. The database dump alone is not a complete recovery set.

Before running it, record a clean checkout (`git status --short`), pause/finish scans, take a matching screenshot/configuration backup, and review tag-specific configuration changes. If the checkout contains the old `make update` recipe, do not use it for the first `000016`, `000018`, `000019`, or `000020` upgrade; obtain the new recipe or use the manual stop/migrate/start sequence. To update manually, stop only the application services without removing volumes, switch to the intended existing release tag, and rebuild with `make start-all`. Shopkeeper applies migrations on boot. Keep local/uncommitted work safe; do not reset or overwrite it as part of an update.

Native Debian rebuilds require compatible host toolchains. The selected release's `make build` now runs `npm ci` before the UI build, so stale frontend packages are not carried into the new artifacts. An installation/build failure occurs before the updater stops services. This requires registry access or a complete npm cache and replaces the checkout's `lime/node_modules`; avoid sharing that directory with an active development server during a production build. See [Debian deployment](debian.md).

## Update notice in the sidebar

The notice has two controls:

1. Outbound best-effort release checks are enabled by default when `LIME_UPDATE_CHECK` is unset; normal/source and release Compose also default it to `true`. Set `LIME_UPDATE_CHECK=false` on the UI service to opt out, then restart/recreate the UI process with that environment. Existing explicit false values remain disabled. `LIME_GITHUB_REPO` selects the repository, defaulting to `sumanbasuli/lime`.
2. Each browser can show or hide the sidebar card using **Settings > Update notice**. This browser preference defaults to on and takes effect immediately, without **Save settings**. It does not change server-wide settings or disable the operator's outbound check.

`GET /_lime/update-check` returns `{ "enabled": false }` when release checks are disabled. When enabled, it requests the latest release from `api.github.com` with a five-second timeout and compares it with the dashboard version. Set `LIME_VERSION` to override that version; otherwise the packaged version is used. Drafts, prereleases, and failed requests do not show a card. The card links to release notes and never installs an update.

The isolated `docker-compose.docs.yml` stack disables release checks. To stop GitHub requests in another deployment, set `LIME_UPDATE_CHECK=false`; hiding the browser card only changes its visibility.

The display preference is stored as `lime.updateNotice.enabled` in browser local storage. Dismissing a card stores its exact release tag as `lime.updateNotice.dismissed`, so the same release stays hidden after reload while a different newer release can appear. These choices belong to that browser and origin, not PostgreSQL or an account.

The route source is `lime/src/app/%5Flime/update-check/route.ts`. The escaped folder preserves the public `/_lime/update-check` URL without making it a Next private folder. Do not rename it to `_lime`: that removes the endpoint from routing and causes a 404. See [Verification And Handoff](../verification.md) for the deterministic notice checks and the limits of live GitHub coverage.

## Manual release notifications

Prefer no outbound release calls? Set `LIME_UPDATE_CHECK=false` and watch the GitHub repository for releases:

1. open `https://github.com/sumanbasuli/lime`
2. click **Watch > Custom > Releases**

GitHub will email you when a new tag is published.

## Restart Safety And Readiness

The helpers invoke Shopkeeper before UI, but their readiness guarantees differ: Docker polls `/api/health` after migration/recreation; Debian stops the old LIME services before reinstalling, then waits for a healthy local Shopkeeper response before restarting UI. None of these is a complete browser/database/screenshot/export test.

Expect an interruption for the single backend. Do not run two Shopkeepers against one database to attempt zero downtime: recovery assumes the other process is gone, and filesystem evidence/cancellation state are not distributed. UI replicas do not change this backend constraint. PDF downloads have both a per-UI-process waiting limit and a per-Shopkeeper-process request limit that remains occupied until the response is sent.

## Migrations

Migrations are forward-only and run automatically when Shopkeeper starts (`database.RunMigrations`). Always keep the backup produced by the update script until you have confirmed the new version works.

The binary's `--migrate` mode applies migrations and exits without starting scans or HTTP. Its separate `--verify-startup` mode checks the non-root browser sandbox and ACT catalog without contacting PostgreSQL, applying migrations, or starting HTTP. Run the latter under the intended service identity and container policy after old backends stop. The two modes cannot be combined. The migration directory is relative to its working directory. If migration fails, stop and preserve the logs/version state; do not force the schema version or blindly execute down files.

Selecting a previous image/tag is not a database rollback. Confirm schema compatibility first; otherwise restore a matched pre-update database/screenshot/config set into an isolated environment, verify it with the matching application version, and plan a deliberate cutover. Post-backup scans and settings changes will not exist in that restored set.
