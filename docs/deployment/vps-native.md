# VPS Deployment without Docker

This path compiles LIME from source and runs both services under systemd. Use it when you cannot or do not want to run Docker on the host.

## Prerequisites

Install on the host (Debian/Ubuntu examples; use the equivalents on your distro):

```bash
# Go 1.25+
curl -L https://go.dev/dl/go1.25.0.linux-amd64.tar.gz | sudo tar -C /usr/local -xz
echo 'export PATH=$PATH:/usr/local/go/bin' | sudo tee /etc/profile.d/golang.sh

# Node 23+
curl -fsSL https://deb.nodesource.com/setup_23.x | sudo bash -
sudo apt-get install -y nodejs

# PostgreSQL 17 (or reuse a managed database)
sudo apt-get install -y postgresql-17 postgresql-client-17

# Chromium (required by the scanner)
sudo apt-get install -y chromium fonts-liberation libnss3 libatk-bridge2.0-0 \
  libdrm2 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2 \
  libpangocairo-1.0-0 libgtk-3-0

# Build tools
sudo apt-get install -y git make rsync
```

Create the database if you're hosting it locally:

```bash
sudo -u postgres createuser --pwprompt lime
sudo -u postgres createdb --owner lime lime_db
```

## Install

```bash
git clone https://github.com/sumanbasuli/lime.git
cd lime
make build                     # compiles Go + builds Next standalone
sudo ./scripts/vps-install.sh  # lays out /opt/lime, installs systemd units
```

The installer:

- creates a `lime` system user
- installs binaries under `/opt/lime/{shopkeeper,ui}`
- copies the ACT data catalog alongside both services
- drops systemd units into `/etc/systemd/system/`
- seeds `/etc/lime/shopkeeper.env` and `/etc/lime/ui.env` from the templates (only on first install)
- writes the current `VERSION` into `ui.env` so the sidebar update notice knows the installed version

## Configure

Edit the env files:

```bash
sudo $EDITOR /etc/lime/shopkeeper.env
sudo $EDITOR /etc/lime/ui.env
```

Minimum values to set:

- `DATABASE_URL` in both files
- `SHOPKEEPER_URL=http://127.0.0.1:8080` in `ui.env` (matches the default `SHOPKEEPER_PORT`)
- `LIME_UPDATE_CHECK=true` in `ui.env` if you want sidebar update notices

## Start the services

```bash
sudo systemctl start lime-shopkeeper lime-ui
sudo systemctl status lime-shopkeeper lime-ui
sudo journalctl -u lime-shopkeeper -f
```

## Reverse proxy + TLS

Expose only the UI port publicly. Sample nginx config at [`deploy/vps/nginx.conf.example`](../../deploy/vps/nginx.conf.example). Pair with `certbot --nginx` for Let's Encrypt certificates.

## Updating to a newer version

```bash
sudo ./scripts/vps-update.sh v0.2.0
```

The script:

1. reads `DATABASE_URL` from `/etc/lime/shopkeeper.env`
2. dumps Postgres to `/var/backups/lime/lime-pre-<tag>-<timestamp>.sql.gz`
3. checks out the tag and runs `make build`
4. reinstalls binaries via `scripts/vps-install.sh`
5. restarts Shopkeeper (migrations run on boot), pauses briefly, then restarts the UI

Rollback is `sudo ./scripts/vps-update.sh <previous-tag>`.

## Layout on disk

```
/opt/lime/
  shopkeeper/            # compiled Go binary + migrations + data catalog
    screenshots/         # writable by the lime user
  ui/                    # Next standalone server + data catalog
/etc/lime/
  shopkeeper.env         # 0640 root:lime
  ui.env                 # 0640 root:lime
/etc/systemd/system/
  lime-shopkeeper.service
  lime-ui.service
/var/backups/lime/       # created by vps-update.sh
```
