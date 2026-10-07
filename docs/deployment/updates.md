# Updating LIME

The sidebar notice links to release notes; you install updates using the method for your deployment. Before updating:

1. record the running version, Compose project/volume names or native paths, and deployment configuration
2. let scans finish, or request **Pause** and wait for `paused`; prevent new writes during the maintenance window
3. back up PostgreSQL, screenshots, and protected configuration, then verify the recovery set
4. pull/rebuild the selected release and apply its migrations
5. start Shopkeeper, verify startup, then start the UI and check the full scan/report flow

An unpaused active scan is reset and rerun on backend startup, losing partial evidence. A paused scan remains paused and can resume later. Run one Shopkeeper per database; rolling/replicated infrastructure does not supply distributed scan ownership.

## Update channels

| Target | Command | Backup location |
|--------|---------|-----------------|
| Fly.io | `./scripts/fly-update.sh <tag>` | none automatic; use the database provider's backup mechanism |
| Docker (published images, repository helper) | `./scripts/docker-update.sh <tag>` or `make update-release TAG=<tag>` | `dist/backups/lime-pre-<tag>-<timestamp>.sql.gz` by default if bundled DB or host `pg_dump` is available; set `LIME_BACKUP_DIR` to keep it outside the checkout. Otherwise prompts to continue without a backup. |
| Docker (from source) | clean checkout + `make start-all`, described below | take a manual recovery set first |
| Debian systemd | `sudo ./scripts/debian-update.sh <tag>` or `make debian-update TAG=<tag>` | `/var/backups/lime/lime-pre-<tag>-<timestamp>.sql.gz` |

The Docker and Debian helpers back up PostgreSQL only. They create dumps with restrictive permissions and reject a backup directory with a different owner, group/other write bits, or detected ACLs. Keep parent directories protected too, and use a private destination if an existing shared path fails the check. Back up screenshots and configuration separately, and arrange retention, encryption, and off-host storage. The Fly helper creates no backup. See [Backup And Restore](backup-restore.md); for Fly Managed Postgres, use the [backup command reference](https://fly.io/docs/flyctl/mpg-backup-create/) and confirm that the backup has completed.

## Published Images

`scripts/docker-update.sh` is available in a repository checkout, not in the extracted release archive. It resolves its default `.env`, Compose file, and backups relative to the repository root. To operate another deployment, explicitly select its env/Compose paths and keep the same Compose project identity; confirm the selected containers/volumes before running. Its `COMPOSE_FILE` accepts one file, not a list of overrides.

Set `LIME_BACKUP_DIR` in the shell or the selected env file to put the automatic dump outside `dist/`; an explicit shell value takes precedence. The path must be writable by the updater account and protected from writes by other local users.

The helper sources the env file as shell code, changes `LIME_IMAGE_TAG`, pulls images, runs a migration-only container, recreates Shopkeeper, polls its liveness endpoint, then recreates UI. Use only a trusted, shell-compatible env file. It does not validate UI readiness or undo the changed tag/schema if an intermediate step fails. Preserve the previous tag/config and inspect the failing step before retrying. Its interactive no-backup branch uses Bash 4+ syntax; do not rely on that branch with macOS's older system Bash.

For a bundle-only deployment, use a maintenance window in the extracted directory. First take a recovery set, edit `.env` to the intended published `LIME_IMAGE_TAG`, and ensure the deployment's Shopkeeper `REPORT_BASE_URL` is configured as described in [Docker deployment](docker.md#published-image-deployment). Then:

```bash
docker compose --env-file .env -f docker-compose.release.yml config --quiet
docker compose --env-file .env -f docker-compose.release.yml stop ui shopkeeper
docker compose --env-file .env -f docker-compose.release.yml pull shopkeeper ui
docker compose --env-file .env -f docker-compose.release.yml run --rm --no-deps shopkeeper ./shopkeeper --migrate
docker compose --env-file .env -f docker-compose.release.yml up -d --no-deps shopkeeper
docker compose --env-file .env -f docker-compose.release.yml logs --tail=100 shopkeeper
# After confirming migrations/startup and backend health:
docker compose --env-file .env -f docker-compose.release.yml up -d --no-deps ui
```

Include your project name and override files consistently in every command. Do not use `down -v`; it destroys screenshot volumes. After updating, check the dashboard's health route, load saved scans, open an existing screenshot, and try each enabled export format.

## Source Docker Checkout

The existing `make update TAG=…` target is not recommended as unattended update automation: it builds `lime-shopkeeper:v…`/`lime-ui:v…`, while source Compose has `build:` entries without those image names, and the target then starts services without rebuilding the Compose-selected images. The `backup-db` step now stops on a dump failure, but a successful database dump alone is not a complete recovery set. Do not treat the update message as proof that the intended images are running or screenshots are backed up.

Instead, record a clean checkout (`git status --short`), pause/finish scans, take the recovery set, stop the application services without removing volumes, switch to the intended existing release tag, and rebuild with `make start-all`. Review tag-specific configuration changes before startup. Shopkeeper applies migrations on boot. Keep local/uncommitted work safe; do not reset or overwrite it as part of an update.

Native Debian rebuilds similarly require the selected release's npm dependencies and compatible toolchains; the updater runs `make build`, not `npm ci`. See [Debian deployment](debian.md).

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

The helpers invoke Shopkeeper before UI, but their readiness guarantees differ: Docker polls `/api/health` after migration/recreation; Fly relies on its configured deploy health checks; Debian waits three seconds and does not gate UI restart on a successful migration/readiness check. None of these is a complete browser/database/screenshot/export test.

Expect an interruption for the single backend. Do not run two Shopkeepers against one database to attempt zero downtime: recovery assumes the other process is gone, and filesystem evidence/cancellation state are not distributed. UI replicas do not change this backend constraint. PDF downloads have both a per-UI-process waiting limit and a per-Shopkeeper-process Chromium render limit.

## Migrations

Migrations are forward-only and run automatically when Shopkeeper starts (`database.RunMigrations`). Always keep the backup produced by the update script until you have confirmed the new version works.

The binary's `--migrate` mode applies migrations and exits without starting scans or HTTP. The migration directory is relative to its working directory. If migration fails, stop and preserve the logs/version state; do not force the schema version or blindly execute down files.

Selecting a previous image/tag is not a database rollback. Confirm schema compatibility first; otherwise restore a matched pre-update database/screenshot/config set into an isolated environment, verify it with the matching application version, and plan a deliberate cutover. Post-backup scans and settings changes will not exist in that restored set.
