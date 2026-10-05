# Backup And Restore

LIME recovery needs PostgreSQL **and** the saved screenshot files. A SQL dump alone preserves scan findings/settings but cannot recreate image evidence. Keep backups outside `dist/`: `make clean` removes that directory and the normal Compose data volumes.

This guide was checked against the repository's scripts, schema, and storage paths. The backup/restore commands below are operator procedures, not commands executed against user data during documentation verification. Rehearse recovery in a separate environment before an incident.

## Recovery Set

Keep these together, with the capture time and running application version/tag:

| Item | Source | Why it matters |
|------|--------|----------------|
| PostgreSQL dump/provider snapshot | Database used by **both** services | Scans, URLs, findings, audit evidence, link jobs/destinations/source references, settings, schema version, caches |
| Screenshot tree | Docker/Fly `/app/screenshots`; native `SHOPKEEPER_SCREENSHOT_DIR` | Full-page, spotlight, and preview PNG evidence under each scan ID |
| Protected configuration | Compose/env overrides, systemd env files, or provider secret inventory | Database/backend/UI targets, runtime ports, physical storage paths |
| Application/catalog version | Release tag/image identifiers and `data/` JSON catalogs | Reproduce the schema, engine, scoring, and read-time guidance |

Database backups contain site URLs, HTML snippets, settings, and the MCP key hash/hint. Screenshot and env backups can be sensitive too. Restrict access, encrypt/off-host copy according to your policy, and record retention. The raw MCP key is not recoverable from its hash; retain client credentials separately or generate a new key after recovery.

## Quiesce For A Matched Snapshot

1. Schedule maintenance and prevent new scans, link checks, triage, and settings writes.
2. Let active accessibility scans complete, or request **Pause** and wait until each is `paused` rather than merely `pause_requested`. Let independent/companion link checks settle or use **Cancel check**; accessibility Pause does not pause a link job that has already started.
3. Stop the UI and Shopkeeper, leaving PostgreSQL running. This prevents database/filesystem changes while taking the matched set. Do not remove containers/volumes.
4. Dump PostgreSQL, copy screenshots/config/catalogs, and inspect all command outcomes.
5. Start the same services/version again and verify health/pages/evidence; resume paused scans only when ready.

Stopping an unpaused active backend causes that scan's partial data/screenshots to be reset on its next startup. Pausing first preserves completed evidence. `pg_dump` itself takes a consistent database snapshot while the database is live, but that snapshot does not synchronize filesystem writes; the maintenance window supplies the cross-store boundary. [PostgreSQL dump guidance](https://www.postgresql.org/docs/17/backup-dump.html) explains the database snapshot and restore behavior.

## Bundled Local Docker Example

Run in **Bash**, from the source deployment's directory. Confirm `docker compose ps` selects the intended stack first. For another project/file, include its `-p`, `-f`, and `--env-file` choices consistently in every command. `make stop-all` uses `down`, so use `stop` here to retain the container needed for screenshot copying.

Choose a private backup directory outside the checkout before running:

```bash
set -euo pipefail
umask 077
LIME_BACKUP_DIR=/absolute/path/to/private/lime-backups
mkdir -p "$LIME_BACKUP_DIR"
LIME_BACKUP_SET="$(mktemp -d "$LIME_BACKUP_DIR/lime-XXXXXXXX")"

# Only after scans are completed/paused and new writes are blocked:
docker compose stop ui shopkeeper
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip -9 > "$LIME_BACKUP_SET/database.sql.gz"
docker compose cp shopkeeper:/app/screenshots "$LIME_BACKUP_SET/screenshots"
cp .env "$LIME_BACKUP_SET/deployment.env"
cp docker-compose.yml "$LIME_BACKUP_SET/docker-compose.yml"
cp VERSION "$LIME_BACKUP_SET/VERSION"
cp -R data "$LIME_BACKUP_SET/catalog-data"
gzip -t "$LIME_BACKUP_SET/database.sql.gz"

docker compose start shopkeeper ui
```

Also copy any deployment-specific override files and record the actual running images/commit; `VERSION` alone is not proof that a locally modified image matches a release. The dump uses the container's real bootstrap user/database, not hardcoded credentials. Keep stderr and inspect warnings. A failed command leaves a partial set that must not be labeled a successful backup; if the script exits before restart, recover service availability deliberately after inspecting the error.

`make backup-db` creates a SQL gzip under `dist/backups`, but its current pipeline can report success if `pg_dump` fails and gzip succeeds. Use the `pipefail` procedure above and a restore rehearsal instead of trusting only a filename or success message. `gzip -t` checks compression integrity, not completeness of the SQL data.

## External Database And Native/Fly Storage

Use the provider's completed snapshot/backup mechanism, or a compatible host `pg_dump`, with a role that can read all application objects. PostgreSQL's client cannot dump a newer-major server with an older-major `pg_dump`; select the matching client and inspect stderr. [The `pg_dump` reference](https://www.postgresql.org/docs/17/app-pgdump.html) covers version/privilege and format constraints.

For a host client with the intended connection already configured securely (for example through a PostgreSQL service file):

```bash
set -euo pipefail
umask 077
pg_dump --dbname='service=lime-backup' | gzip -9 > /absolute/private/backup/database.sql.gz
gzip -t /absolute/private/backup/database.sql.gz
```

Replace the service/path with your actual configured backup target; this example does not set up credentials or create the parent directory. Avoid pasting password-bearing connection strings into shared terminal output. A dump includes one database, not cluster-wide roles/tablespaces: preserve/recreate the required roles or provider grants separately.

For native systemd, stop `lime-ui` and `lime-shopkeeper` after pausing, then copy the configured screenshot root and `/etc/lime` to protected storage along with the DB backup. For Fly, preserve the screenshot volume using the provider's volume backup/export mechanism as well as a database backup. A DB snapshot does not back up the Fly screenshot disk or secrets. None of the bundled update helpers automates this complete recovery set.

## Restore Rehearsal: Separate Empty Database First

Restoring executes SQL and writes the destination. Confirm the exact destination is an isolated, empty rehearsal database created by your DBA/provider, with no normal application connected. Never aim this example at the current LIME database; it is not an in-place overwrite procedure.

The repository helpers create **plain SQL compressed with gzip**, so restore with `psql`, not `pg_restore`. Required object owners/roles must exist first. Use a trusted dump and stop on errors; the optional single transaction avoids retaining a half-applied restore when the dump supports it. [PostgreSQL's `psql` reference](https://www.postgresql.org/docs/17/app-psql.html) documents these flags.

```bash
set -euo pipefail
: "${LIME_RESTORE_DATABASE_URL:?set the URL of the separate empty rehearsal database}"
gzip -dc /absolute/private/backup/database.sql.gz \
  | psql -X --set=ON_ERROR_STOP=on --single-transaction "$LIME_RESTORE_DATABASE_URL"
```

Do not start the application's migration runner against an empty restore destination before loading the dump; the dump already contains schema objects and `schema_migrations`. Restore the matching screenshot tree into a **new** rehearsal volume/directory, preserving `{scanId}/{filename}` structure and writable ownership. Native physical paths can differ because the application stores stable `/app/screenshots/…` metadata and serves files through its configured physical root.

Start the matching application release with both services pointed at the rehearsal database and Shopkeeper at the rehearsal screenshot root. Check migration logs, scan/group/occurrence counts, settings, an existing screenshot, all enabled exports, and MCP if used. Remember: unpaused active rows in a restored snapshot are reset/rerun at startup, so pause before capture and use an isolated network if replaying scan targets is undesirable.

## Production Recovery Or Version Rollback

Prefer a tested fresh database/volume plus deliberate cutover over mixing old SQL with live newer tables. Record the cutover's expected data loss: scans/triage/settings after the backup time will not be in the restored set. Preserve the current state before replacing anything, and obtain the operator's approval for the exact target.

Switching to an older image is not schema rollback. Startup runs forward migrations only; down files existing in the repository do not make a downgrade automatic or safe. Use a version compatible with the restored schema and catalog, verify the isolated restoration, then redirect both UI and Shopkeeper together. Never run `make clean`, `down -v`, forced migration versions, or broad recursive deletion as a recovery shortcut.
