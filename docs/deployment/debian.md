# Debian Deployment Without Docker

This path compiles LIME from source and runs both services under systemd on Debian-family Linux. Use it when you cannot or do not want to run Docker on the host.

For macOS, use the Docker workflow instead:

```bash
make start-all      # production-style local Docker stack
make start-dev      # Docker stack with NextJS hot reload
```

## Prerequisites

Install on Debian or Ubuntu:

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
sudo apt-get install -y git make

# Optional but faster artifact syncing
sudo apt-get install -y rsync
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
make debian-install
```

Or run the steps explicitly:

```bash
make build
sudo ./scripts/debian-install.sh
```

The installer detects the host OS before writing anything. It exits on macOS or non-Debian-family Linux, requires systemd, checks for Node.js and Chromium, and installs the native deployment under:

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

## Configure

Edit the env files:

```bash
sudo $EDITOR /etc/lime/shopkeeper.env
sudo $EDITOR /etc/lime/ui.env
```

Minimum values to set:

- `DATABASE_URL` in both files
- `SHOPKEEPER_URL=http://127.0.0.1:8080` in `ui.env`
- `SHOPKEEPER_SCREENSHOT_DIR=/opt/lime/shopkeeper/screenshots` in `shopkeeper.env`
- `LIME_UPDATE_CHECK=true` in `ui.env` if you want sidebar update notices

## Start The Services

```bash
sudo systemctl start lime-shopkeeper lime-ui
sudo systemctl status lime-shopkeeper lime-ui
sudo journalctl -u lime-shopkeeper -f
```

## Reverse Proxy And TLS

Expose only the UI port publicly. Sample nginx config: [`deploy/debian/nginx.conf.example`](../../deploy/debian/nginx.conf.example). Pair it with `certbot --nginx`, Caddy, or your preferred TLS manager.

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
5. restarts Shopkeeper, waits briefly, then restarts the UI

Rollback is `sudo ./scripts/debian-update.sh <previous-tag>`.

## Layout On Disk

```text
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
/var/backups/lime/       # created by debian-update.sh
```
