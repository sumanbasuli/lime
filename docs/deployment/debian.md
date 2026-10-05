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

Install Go using [its platform-specific instructions](https://go.dev/doc/install); do not extract a pinned amd64 archive onto an unknown architecture or over an existing Go tree. Install PostgreSQL using the [Debian](https://www.postgresql.org/download/linux/debian/) or [Ubuntu](https://www.postgresql.org/download/linux/ubuntu/) instructions if the distribution repository does not provide version 17. The installer does not install language runtimes, Chromium, or PostgreSQL for you.

After configuring the appropriate package repositories, a typical Debian package step is:

```bash
sudo apt-get install -y git make rsync chromium fonts-liberation postgresql-client-17
# Only when hosting PostgreSQL locally:
sudo apt-get install -y postgresql-17
```

Package availability and Chromium packaging differ across Debian/Ubuntu releases; verify a real browser binary works for the systemd service user, rather than assuming an interactive desktop/snap installation is sufficient. These installation examples were reviewed, not executed against a fresh Debian host in the local Docker verification.

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

This is an in-place install: artifact directories are replaced (screenshots are preserved), and service units are overwritten. Existing env files are preserved, except the installer ensures the screenshot-root setting exists and refreshes `LIME_VERSION`. It enables services but does not start them or run a readiness check. Back up before rerunning it on a live deployment.

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

Chrome is auto-detected from known system commands in `cmd/shopkeeper/main.go`; its current allocator does not read the template's commented `CHROMIUM_PATH` as a custom binary override. Put a supported binary on the service `PATH` and inspect the `Found Chrome/Chromium` log. Do not assume setting that commented variable fixes detection.

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
sudo ./scripts/debian-update.sh v1.0.4
```

Or through Make:

```bash
make debian-update TAG=v1.0.4
```

The updater:

1. reads `DATABASE_URL` from `/etc/lime/shopkeeper.env`
2. dumps Postgres to `/var/backups/lime/lime-pre-<tag>-<timestamp>.sql.gz`
3. checks out the tag and runs `make build`
4. reinstalls binaries via `scripts/debian-install.sh`
5. restarts Shopkeeper, waits three seconds, then restarts the UI (a delay, not a migration/readiness gate)

The updater changes the checkout to the tag and runs `make build`; it does not install npm dependencies for that tag. Review lockfile/toolchain changes and install the target dependencies before treating it as unattended automation. Keep the checkout clean and back up config/screenshots too; its automatic dump covers only PostgreSQL.

Returning to a previous tag does not downgrade the schema. A previous binary may not work after forward migrations; use the schema-compatible recovery plan in [Backup And Restore](backup-restore.md), rather than assuming a second updater invocation is a rollback.

## Layout On Disk

```text
/opt/lime/
  shopkeeper/            # compiled Go binary + migrations + data catalog
    screenshots/         # writable by the lime user
  ui/                    # Next standalone server + data catalog
/etc/lime/
  shopkeeper.env         # 0640 lime:lime (installer's default)
  ui.env                 # 0640 lime:lime (installer's default)
/etc/systemd/system/
  lime-shopkeeper.service
  lime-ui.service
/var/backups/lime/       # created by debian-update.sh
```

Protect backups and configuration according to your host policy; the update script does not provide off-host storage, retention, encryption, or a restore test. See [Operational Troubleshooting](troubleshooting.md) for logs, storage permissions, and migration failures.
