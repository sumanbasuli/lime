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
#   4. stops the UI and backend, reinstalls artifacts, then restarts in health-gated order
#
# DATABASE_URL and SHOPKEEPER_PORT are read as data from the service env file.

set -euo pipefail
export LC_ALL=C
umask 077

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

# shellcheck source=scripts/debian-env.sh
. "${ROOT_DIR}/scripts/debian-env.sh"
DATABASE_URL="$(read_debian_database_url "${ENV_FILE}")"
SHOPKEEPER_PORT="$(read_debian_shopkeeper_port "${ENV_FILE}")"

# shellcheck source=scripts/backup-safety.sh
. "${ROOT_DIR}/scripts/backup-safety.sh"
ensure_private_backup_dir "${BACKUP_DIR}"
BACKUP_DIR="${LIME_PRIVATE_BACKUP_DIR}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/lime-pre-${TAG}-${TIMESTAMP}.sql.gz"
if [[ -e "${BACKUP_FILE}" || -L "${BACKUP_FILE}" ]]; then
  echo "Backup already exists: ${BACKUP_FILE}; refusing to overwrite it." >&2
  exit 1
fi

echo "==> Backing up database to ${BACKUP_FILE}"
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg_dump not found; install postgresql-client before running updates." >&2
  exit 1
fi
dump_external_database "${DATABASE_URL}" "${BACKUP_FILE}"

echo "==> Fetching tag ${TAG}"
run_as_build_user git -C "${ROOT_DIR}" fetch --tags --prune
run_as_build_user git -C "${ROOT_DIR}" checkout "${TAG}"

echo "==> Rebuilding artifacts"
run_as_build_user make -C "${ROOT_DIR}" build

# Reject incompatible legacy paths before the maintenance cutover. The
# installer repeats these checks after both services stop.
# shellcheck source=scripts/debian-install-safety.sh
. "${ROOT_DIR}/scripts/debian-install-safety.sh"
debian_preflight_install_paths \
  "${LIME_INSTALL_ROOT:-/opt/lime}" \
  "${CONFIG_ROOT}" \
  "${LIME_SYSTEMD_DIR:-/etc/systemd/system}"

# shellcheck source=scripts/debian-cutover.sh
. "${ROOT_DIR}/scripts/debian-cutover.sh"
install_and_restart_debian_services "${ROOT_DIR}/scripts/debian-install.sh" "${SHOPKEEPER_PORT}"

echo
echo "Update to ${TAG} complete. Backup kept at ${BACKUP_FILE}."
