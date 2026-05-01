#!/usr/bin/env bash
# Pull a new LIME release tag, rebuild, and restart services on Debian-family Linux.
#
# Usage:
#   sudo ./scripts/debian-update.sh <git-tag>
#
# Example:
#   sudo ./scripts/debian-update.sh v1.0.3
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

require_debian_family_linux() {
  local kernel
  kernel="$(uname -s 2>/dev/null || true)"
  if [[ "${kernel}" != "Linux" ]]; then
    echo "This updater only runs on Debian-family Linux. Detected ${kernel:-unknown}." >&2
    echo "On macOS, use 'make update-release TAG=<version>' for Docker release deployments." >&2
    exit 1
  fi

  if [[ ! -r /etc/os-release ]]; then
    echo "Cannot read /etc/os-release; this updater requires Debian-family Linux." >&2
    exit 1
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${ID_LIKE:-}" in
    debian:*|ubuntu:*|*:debian*|*:ubuntu*)
      ;;
    *)
      echo "This updater supports Debian-family Linux only. Detected ${PRETTY_NAME:-${ID:-unknown}}." >&2
      echo "Use the Docker update path on non-Debian Linux hosts." >&2
      exit 1
      ;;
  esac

  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl was not found. The native Debian update requires systemd." >&2
    exit 1
  fi
}

require_debian_family_linux

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
CONFIG_ROOT="${LIME_CONFIG_ROOT:-/etc/lime}"
ENV_FILE="${LIME_ENV_FILE:-${CONFIG_ROOT}/shopkeeper.env}"
BUILD_USER="${SUDO_USER:-}"
if [[ -z "${BUILD_USER}" || "${BUILD_USER}" == "root" ]]; then
  BUILD_USER="$(stat -c '%U' "${ROOT_DIR}" 2>/dev/null || printf root)"
fi

run_as_build_user() {
  if [[ "${BUILD_USER}" == "root" ]]; then
    "$@"
  else
    sudo -u "${BUILD_USER}" "$@"
  fi
}

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
run_as_build_user git -C "${ROOT_DIR}" fetch --tags --prune
run_as_build_user git -C "${ROOT_DIR}" checkout "${TAG}"

echo "==> Rebuilding artifacts"
run_as_build_user make -C "${ROOT_DIR}" build

echo "==> Reinstalling"
"${ROOT_DIR}/scripts/debian-install.sh"

echo "==> Restarting services"
systemctl restart lime-shopkeeper.service
# Small wait lets Shopkeeper apply migrations before UI reconnects.
sleep 3
systemctl restart lime-ui.service

echo
echo "Update to ${TAG} complete. Backup kept at ${BACKUP_FILE}."
