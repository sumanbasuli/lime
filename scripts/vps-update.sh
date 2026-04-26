#!/usr/bin/env bash
# Pull a new LIME release tag, rebuild, and restart services on a VPS.
#
# Usage:
#   sudo ./scripts/vps-update.sh <git-tag>
#
# Example:
#   sudo ./scripts/vps-update.sh v1.0.2
#
# The script:
#   1. backs up the Postgres database
#   2. checks out the given tag
#   3. runs `make build`
#   4. reinstalls artifacts + restarts systemd units
#
# DATABASE_URL is read from /etc/lime/shopkeeper.env for the backup step.

set -euo pipefail
export LC_ALL=C

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <git-tag>" >&2
  exit 1
fi

TAG="$1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${LIME_BACKUP_DIR:-/var/backups/lime}"
ENV_FILE="${LIME_ENV_FILE:-/etc/lime/shopkeeper.env}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Expected env file at ${ENV_FILE}. Is LIME installed?" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
. "${ENV_FILE}"
set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set in ${ENV_FILE}; cannot back up before update." >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/lime-pre-${TAG}-${TIMESTAMP}.sql.gz"

echo "==> Backing up database to ${BACKUP_FILE}"
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg_dump not found; install postgresql-client before running updates." >&2
  exit 1
fi
pg_dump "${DATABASE_URL}" | gzip -9 > "${BACKUP_FILE}"

echo "==> Fetching tag ${TAG}"
cd "${ROOT_DIR}"
git fetch --tags --prune
git checkout "${TAG}"

echo "==> Rebuilding artifacts"
sudo -u "${SUDO_USER:-$(logname)}" make build

echo "==> Reinstalling"
"${ROOT_DIR}/scripts/vps-install.sh"

echo "==> Restarting services"
systemctl restart lime-shopkeeper.service
# Small wait lets Shopkeeper apply migrations before UI reconnects.
sleep 3
systemctl restart lime-ui.service

echo
echo "Update to ${TAG} complete. Backup kept at ${BACKUP_FILE}."
