# Updating LIME

Every deploy target has a matching update script. The operational sequence is:

1. back up the database
2. pull or rebuild the new version
3. apply migrations
4. rolling restart of the services

The Fly script does not create a database backup automatically; take one with your database provider before deploying. Backup behavior for each target is listed below.

## Update channels

| Target | Command | Backup location |
|--------|---------|-----------------|
| Fly.io | `./scripts/fly-update.sh <tag>` | none automatic; use `flyctl mpg backup create <cluster-id>` or your provider's tooling before running |
| Docker (release bundle) | `./scripts/docker-update.sh <tag>` or `make update-release TAG=<tag>` | `dist/backups/lime-pre-<tag>-<timestamp>.sql.gz` |
| Docker (from source) | `make update TAG=<tag>` | same as above |
| Debian systemd | `sudo ./scripts/debian-update.sh <tag>` or `make debian-update TAG=<tag>` | `/var/backups/lime/lime-pre-<tag>-<timestamp>.sql.gz` |

## Update notice in the sidebar

The notice has two controls:

1. Outbound best-effort release checks are enabled by default when `LIME_UPDATE_CHECK` is unset; normal/source and release Compose also default it to `true`. Set `LIME_UPDATE_CHECK=false` on the UI service to opt out, then restart/recreate the UI process with that environment. Existing explicit false values remain disabled. `LIME_GITHUB_REPO` selects the repository, defaulting to `sumanbasuli/lime`.
2. Each browser can show or hide the sidebar card using **Settings > Update notice**. This browser preference defaults to on and takes effect immediately, without **Save settings**. It does not change server-wide settings or disable the operator's outbound check.

The Next-owned `GET /_lime/update-check` endpoint returns `{ "enabled": false }` when the server check is disabled. When enabled, it checks `api.github.com` with a five-second timeout and compares the latest release against the UI version. Nonblank `LIME_VERSION` runtime/release-build overrides remain authoritative; when unset or blank, the route uses the packaged dashboard version rather than a development placeholder. Drafts, prereleases, and best-effort failures produce no update card. The card links to release notes; it never installs an update.

The isolated `docker-compose.docs.yml` stack explicitly disables release checks for deterministic/offline documentation and verification. Turning off only the browser card does not prevent the server from contacting GitHub; use the environment opt-out for that.

The display preference is stored as `lime.updateNotice.enabled` in browser local storage. Dismissing a card stores its exact release tag as `lime.updateNotice.dismissed`, so the same release stays hidden after reload while a different newer release can appear. These choices belong to that browser and origin, not PostgreSQL or an account.

The route source is `lime/src/app/%5Flime/update-check/route.ts`. The escaped folder preserves the public `/_lime/update-check` URL without making it a Next private folder. Do not rename it to `_lime`: that removes the endpoint from routing and causes a 404. See [Verification And Handoff](../verification.md) for the deterministic notice checks and the limits of live GitHub coverage.

## Manual release notifications

Prefer no outbound release calls? Set `LIME_UPDATE_CHECK=false` and watch the GitHub repository for releases:

1. open `https://github.com/sumanbasuli/lime`
2. click **Watch > Custom > Releases**

GitHub will email you when a new tag is published.

## Rolling update safety

The scripts share the same contract:

- Shopkeeper is updated first so migrations run before the UI talks to the new schema.
- The UI is updated second.
- Health checks gate the transition on Docker and Fly.

Even with rolling restarts, a single-machine deployment will flicker for a few seconds while Shopkeeper restarts. For true zero downtime, run at least two machines per app (Fly scale, Docker Compose replicas, or two Debian hosts behind a load balancer).

## Migrations

Migrations are forward-only and run automatically when Shopkeeper starts (`database.RunMigrations`). Always keep the backup produced by the update script until you have confirmed the new version works.
