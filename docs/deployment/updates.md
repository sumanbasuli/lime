# Updating LIME

Every deploy target has a matching update script. They all follow the same shape:

1. back up the database
2. pull or rebuild the new version
3. apply migrations
4. rolling restart of the services

## Update channels

| Target | Command | Backup location |
|--------|---------|-----------------|
| Fly.io | `./scripts/fly-update.sh <tag>` | none automatic; use `flyctl mpg backup create <cluster-id>` or your provider's tooling before running |
| Docker (release bundle) | `./scripts/docker-update.sh <tag>` or `make update-release TAG=<tag>` | `dist/backups/lime-pre-<tag>-<timestamp>.sql.gz` |
| Docker (from source) | `make update TAG=<tag>` | same as above |
| VPS (systemd) | `sudo ./scripts/vps-update.sh <tag>` | `/var/backups/lime/lime-pre-<tag>-<timestamp>.sql.gz` |

## Update notice in the sidebar

Set `LIME_UPDATE_CHECK=true` on the UI service and the sidebar will fetch the latest release from GitHub (`LIME_GITHUB_REPO`, default `sumanbasuli/lime`). When a newer semver tag is detected the sidebar shows an "Update available" card with a link to the release notes. Dismissing the card hides it until the next release.

- The check is opt-in because it calls out to `api.github.com`.
- Pre-releases and drafts are ignored.
- The card only appears when the UI's baked `LIME_VERSION` is older than the latest release.

## Manual release notifications

Prefer not to enable outbound calls? Watch the GitHub repository for releases:

1. open `https://github.com/sumanbasuli/lime`
2. click **Watch > Custom > Releases**

GitHub will email you when a new tag is published.

## Rolling update safety

The scripts share the same contract:

- Shopkeeper is updated first so migrations run before the UI talks to the new schema.
- The UI is updated second.
- Health checks gate the transition on Docker and Fly.

Even with rolling restarts, a single-machine deployment will flicker for a few seconds while Shopkeeper restarts. For true zero downtime, run at least two machines per app (Fly scale, Docker Compose replicas, or two VPS hosts behind a load balancer).

## Migrations

Migrations are forward-only and run automatically when Shopkeeper starts (`database.RunMigrations`). Always keep the backup produced by the update script until you have confirmed the new version works.
