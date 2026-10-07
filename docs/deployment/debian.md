# Debian Deployment Without Docker

This path compiles LIME from source and runs both services under systemd on Debian-family Linux. Use it when you cannot or do not want to run Docker on the host.

For macOS, use the Docker workflow instead:

```bash
make start-all      # production-style local Docker stack
make start-dev      # Docker stack with NextJS hot reload
```

## Prerequisites

Use Debian-family Linux with systemd, a supported CPU architecture, and these dependencies:

- Go 1.25.1+ for builds, as required by `shopkeeper/go.mod`
- Node 23+ and npm for builds/runtime; choose a currently supported line such as Node 24 for a new native install ([official Node downloads](https://nodejs.org/en/download), [release status](https://nodejs.org/en/about/previous-releases))
- PostgreSQL 17 or a reachable managed database, plus a compatible `pg_dump` client for updates/backups
- Chrome/Chromium on the service's system `PATH`
- Git, Make, standard install utilities, and optionally rsync

Follow the [Go installation instructions](https://go.dev/doc/install) for your CPU architecture. Use the PostgreSQL [Debian](https://www.postgresql.org/download/linux/debian/) or [Ubuntu](https://www.postgresql.org/download/linux/ubuntu/) instructions if your distribution does not provide version 17. LIME's native installer expects Go, Node, Chromium, and PostgreSQL to be installed already.

After configuring the appropriate package repositories, a typical Debian package step is:

```bash
sudo apt-get install -y git make rsync chromium fonts-liberation postgresql-client-17
# Only when hosting PostgreSQL locally:
sudo apt-get install -y postgresql-17
```

Package availability differs across Debian and Ubuntu releases. Confirm that Chromium can run as the systemd service user; a desktop or Snap installation may need additional configuration.

```bash
go version
node --version
npm --version
pg_dump --version
command -v chromium
```

Create the database if you are hosting it locally:

```bash
sudo -u postgres createuser --pwprompt lime
sudo -u postgres createdb --owner lime lime_db
```

## Install

From a checkout:

```bash
git clone https://github.com/sumanbasuli/lime.git
cd lime
npm --prefix lime ci
make debian-install
```

Or run the steps explicitly:

```bash
make build
sudo ./scripts/debian-install.sh
```

The installer detects the host OS before writing anything. It exits on macOS or non-Debian-family Linux, requires systemd, checks for the Node command and Chromium, and installs the native deployment under:

- `/opt/lime/shopkeeper`
- `/opt/lime/shopkeeper/screenshots`
- `/opt/lime/ui`
- `/etc/lime/shopkeeper.env`
- `/etc/lime/ui.env`
- `/etc/systemd/system/lime-shopkeeper.service`
- `/etc/systemd/system/lime-ui.service`

You can override the install paths:

```bash
sudo LIME_INSTALL_ROOT=/srv/lime \
  LIME_CONFIG_ROOT=/etc/lime \
  LIME_SYSTEMD_DIR=/etc/systemd/system \
  ./scripts/debian-install.sh
```

The generated systemd units are rewritten to match the configured install and config roots.

This is an in-place install: artifact directories are replaced (screenshots are preserved), and service units are overwritten. Existing env file contents are preserved, while regular env files are changed to `root:lime` ownership and mode `0640`. The installer also ensures the screenshot-root setting exists and refreshes `LIME_VERSION`. It enables services but does not start them or run a readiness check. Back up before rerunning it on a live deployment.

The default screenshot directory is owned by `lime` and restricted to that account (`0700`) on first install and every reinstall. New per-scan directories and images use `0700` and `0600`. Reinstalling protects older captures beneath the default directory without deleting or renaming them, although it does not change each older file's mode. If `SHOPKEEPER_SCREENSHOT_DIR` points elsewhere, secure that directory and its existing contents separately; the installer does not alter a custom path. Shopkeeper serves screenshots through the same API paths after this change, so keep access to the ordinary API restricted as described below.

## Configure

Edit the env files:

```bash
sudoedit /etc/lime/shopkeeper.env
sudoedit /etc/lime/ui.env
```

Minimum values to set:

- `DATABASE_URL` in both files
- `SHOPKEEPER_URL=http://127.0.0.1:8080` in `ui.env`
- `SHOPKEEPER_SCREENSHOT_DIR=/opt/lime/shopkeeper/screenshots` in `shopkeeper.env`
- `REPORT_BASE_URL=http://127.0.0.1:3000` in `shopkeeper.env` when using the standard colocated UI (this is the backend default; set it explicitly if the UI host/port changes)

The env templates contain a `REPLACE_ME` database password; replace it before startup. Both processes need the same database, and the DB role needs to apply the checked-in schema migrations. Use the provider's required TLS mode for a remote database. The systemd `WorkingDirectory` keeps Shopkeeper's `migrations/` path valid.

Shopkeeper detects Chrome using known system commands in `cmd/shopkeeper/main.go`. Put a supported browser binary on the service's `PATH` and look for `Found Chrome/Chromium` in the startup log. The commented `CHROMIUM_PATH` example in the template is not supported as an override.

GitHub release checks are enabled when the UI flag is unset. To disable those outbound calls, add `LIME_UPDATE_CHECK=false` to `ui.env` before starting/restarting the UI. Existing false values stay disabled; sidebar display also respects the browser preference described in [Updating LIME](updates.md).

## Start The Services

```bash
sudo systemctl start lime-shopkeeper lime-ui
sudo systemctl status lime-shopkeeper lime-ui
sudo journalctl -u lime-shopkeeper -f
```

Wait for successful migration/startup logs, then check `curl -fsS http://127.0.0.1:3000/api/health` and load a database-backed page. Complete a single-page scan, open its focused screenshot, and download a PDF. The health route alone is liveness, not proof of browser/export readiness. Keep only one Shopkeeper connected to the database.

## Reverse Proxy And TLS

Expose only the UI port publicly. Sample nginx config: [`deploy/debian/nginx.conf.example`](../../deploy/debian/nginx.conf.example). Pair it with `certbot --nginx`, Caddy, or your preferred TLS manager.

Shopkeeper listens on all interfaces by default, even for this native install; restrict direct 8080 access at the network/firewall layer. The dashboard and ordinary API have no built-in account login. Configure the public access boundary you need, and ensure Shopkeeper can still render reports through its internal UI URL. The sample nginx file is a starting point, not a complete authentication or long-PDF timeout configuration.

## Update

```bash
sudo ./scripts/debian-update.sh v2.0.0
```

Or through Make:

```bash
make debian-update TAG=v2.0.0
```

When upgrading from a release whose Debian updater still sourced `shopkeeper.env`, first switch your checkout to the trusted new tag with `git fetch --tags` and `git checkout <new-tag>`, then run the updater from that checkout. The older updater reads the env file before it fetches the new code, so running it first would not apply this protection to that initial update.

The updater:

1. reads `DATABASE_URL` as data from `/etc/lime/shopkeeper.env` without executing the file as a shell script
2. dumps Postgres to `/var/backups/lime/lime-pre-<tag>-<timestamp>.sql.gz`
3. checks out the tag and runs `make build`
4. reinstalls binaries via `scripts/debian-install.sh`
5. restarts Shopkeeper, waits three seconds, then restarts the UI (a delay, not a migration/readiness gate)

Keep `DATABASE_URL` on one line in the env file, with no shell escapes. A plain value or a value enclosed in single or double quotes is supported; URL-encode special characters in the connection string. The updater treats the value as data, not shell code. If an env file is a symlink, the installer leaves its target ownership unchanged and warns you to secure that target separately.

The updater checks out the selected tag and runs `make build`, but does not install that release's npm dependencies. Review changes to the lockfile and required toolchains, install the matching dependencies, and keep the checkout clean before updating. Back up configuration and screenshots separately; the automatic dump covers only PostgreSQL.

Returning to a previous tag does not downgrade the schema. A previous binary may not work after forward migrations; use the schema-compatible recovery plan in [Backup And Restore](backup-restore.md), rather than assuming a second updater invocation is a rollback.

## Layout On Disk

```text
/opt/lime/
  shopkeeper/            # compiled Go binary + migrations + data catalog
    screenshots/         # writable by the lime user
  ui/                    # Next standalone server + data catalog
/etc/lime/
  shopkeeper.env         # 0640 root:lime (installer's default)
  ui.env                 # 0640 root:lime (installer's default)
/etc/systemd/system/
  lime-shopkeeper.service
  lime-ui.service
/var/backups/lime/       # created by debian-update.sh
```

Protect backups and configuration according to your host policy; the update script does not provide off-host storage, retention, encryption, or a restore test. See [Operational Troubleshooting](troubleshooting.md) for logs, storage permissions, and migration failures.
