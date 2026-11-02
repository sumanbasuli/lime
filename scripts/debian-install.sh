#!/usr/bin/env bash
# Debian native installer for LIME (Go backend + NextJS UI + systemd).
#
# Expects:
#   - Debian-family Linux with systemd
#   - you've already run `make build` in the repo root, so dist/shopkeeper
#     and dist/ui contain the compiled artifacts
#   - Go, Node, PostgreSQL client/server, and Chromium are installed on the host
#   - root owns Shopkeeper code; the `lime` user owns screenshots and UI data
#
# Usage:
#   sudo ./scripts/debian-install.sh
#
# Idempotent: re-running updates binaries in-place and reloads systemd.

set -euo pipefail
export LC_ALL=C

require_debian_family_linux() {
  local kernel
  kernel="$(uname -s 2>/dev/null || true)"
  if [[ "${kernel}" != "Linux" ]]; then
    echo "This installer only runs on Debian-family Linux. Detected ${kernel:-unknown}." >&2
    echo "On macOS, use 'make start-all' for Docker or 'make start-dev' for hot reload." >&2
    exit 1
  fi

  if [[ ! -r /etc/os-release ]]; then
    echo "Cannot read /etc/os-release; this installer requires Debian-family Linux." >&2
    exit 1
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${ID_LIKE:-}" in
    debian:*|ubuntu:*|*:debian*|*:ubuntu*)
      ;;
    *)
      echo "This installer supports Debian-family Linux only. Detected ${PRETTY_NAME:-${ID:-unknown}}." >&2
      echo "Use the Docker deployment on non-Debian Linux hosts." >&2
      exit 1
      ;;
  esac

  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl was not found. The native Debian install requires systemd." >&2
    exit 1
  fi
}

require_runtime_dependencies() {
  local missing=()

  for command_name in node install sed find cp chown chgrp useradd; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
      missing+=("${command_name}")
    fi
  done

  if ! command -v chromium >/dev/null 2>&1 &&
    ! command -v chromium-browser >/dev/null 2>&1 &&
    ! command -v google-chrome >/dev/null 2>&1 &&
    ! command -v google-chrome-stable >/dev/null 2>&1; then
    missing+=("chromium")
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Missing required Debian runtime commands: ${missing[*]}" >&2
    echo "Install Node.js and Chromium before running the native installer." >&2
    exit 1
  fi
}

require_debian_family_linux

if [[ $EUID -ne 0 ]]; then
  echo "This installer must run as root (use sudo)." >&2
  exit 1
fi

require_runtime_dependencies

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
INSTALL_ROOT="${LIME_INSTALL_ROOT:-/opt/lime}"
CONFIG_ROOT="${LIME_CONFIG_ROOT:-/etc/lime}"
SYSTEMD_DIR="${LIME_SYSTEMD_DIR:-/etc/systemd/system}"
LIME_USER="${LIME_USER:-lime}"
VERSION_FILE="${ROOT_DIR}/VERSION"
SYSTEMD_SOURCE_DIR="${ROOT_DIR}/deploy/debian/systemd"

if [[ ! -d "${DIST_DIR}/shopkeeper" || ! -d "${DIST_DIR}/ui" ]]; then
  echo "dist/ is missing. Run 'make build' first." >&2
  exit 1
fi

# shellcheck source=scripts/debian-install-safety.sh
. "${ROOT_DIR}/scripts/debian-install-safety.sh"

# Validate every destination before user creation, ownership changes, or copy.
# Existing captures are preserved only when screenshots is a real directory.
debian_preflight_install "${INSTALL_ROOT}" "${CONFIG_ROOT}" "${SYSTEMD_DIR}"
INSTALL_ROOT="${DEBIAN_INSTALL_ROOT_PATH}"
CONFIG_ROOT="${DEBIAN_CONFIG_ROOT_PATH}"
SYSTEMD_DIR="${DEBIAN_SYSTEMD_DIR_PATH}"

ensure_env_value() {
  local env_file="$1"
  local key="$2"
  local value="$3"

  if grep -q "^${key}=" "${env_file}"; then
    return
  fi

  printf '\n%s=%s\n' "${key}" "${value}" >> "${env_file}"
}

install_systemd_unit() {
  local source_file="$1"
  local target_file="$2"
  local temp_file
  temp_file="$(mktemp)"

  sed \
    -e "s|/opt/lime|${INSTALL_ROOT}|g" \
    -e "s|/etc/lime|${CONFIG_ROOT}|g" \
    "${source_file}" > "${temp_file}"
  install -m 0644 "${temp_file}" "${target_file}"
  rm -f "${temp_file}"
}

install_env_template() {
  local source_file="$1"
  local target_file="$2"
  local temp_file
  temp_file="$(mktemp)"

  sed \
    -e "s|/opt/lime|${INSTALL_ROOT}|g" \
    -e "s|/etc/lime|${CONFIG_ROOT}|g" \
    "${source_file}" > "${temp_file}"
  install -o root -g "${LIME_USER}" -m 0640 "${temp_file}" "${target_file}"
  rm -f "${temp_file}"
}

secure_env_file() {
  local env_file="$1"
  if [[ -L "${env_file}" ]]; then
    echo "Warning: ${env_file} is a symlink; verify its target is root-owned and not service-writable." >&2
    return
  fi
  chown "root:${LIME_USER}" "${env_file}"
  chmod 0640 "${env_file}"
}

echo "==> Ensuring ${LIME_USER} system user"
if ! id -u "${LIME_USER}" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "${LIME_USER}"
fi

echo "==> Ensuring directories"
if [[ ! -d "${INSTALL_ROOT}" ]]; then
  debian_install_directory root root 0755 "${INSTALL_ROOT}"
fi
debian_install_directory root root 0755 "${INSTALL_ROOT}/shopkeeper"
debian_install_directory "${LIME_USER}" "${LIME_USER}" 0755 "${INSTALL_ROOT}/ui"
debian_install_directory "${LIME_USER}" "${LIME_USER}" 0700 \
  "${INSTALL_ROOT}/shopkeeper/screenshots"
debian_install_directory root "${LIME_USER}" 0750 "${CONFIG_ROOT}"

echo "==> Installing Shopkeeper artifacts"
debian_copy_tree "${DIST_DIR}/shopkeeper" "${INSTALL_ROOT}/shopkeeper" \
  --exclude screenshots
debian_install_directory root root 0755 "${INSTALL_ROOT}/shopkeeper"
debian_install_directory "${LIME_USER}" "${LIME_USER}" 0700 \
  "${INSTALL_ROOT}/shopkeeper/screenshots"
debian_install_directory root root 0755 \
  "${INSTALL_ROOT}/shopkeeper/data"
debian_copy_tree "${ROOT_DIR}/data" "${INSTALL_ROOT}/shopkeeper/data"
debian_secure_shopkeeper_code "${INSTALL_ROOT}/shopkeeper"

echo "==> Installing UI artifacts"
debian_copy_tree "${DIST_DIR}/ui" "${INSTALL_ROOT}/ui"
debian_install_directory "${LIME_USER}" "${LIME_USER}" 0755 "${INSTALL_ROOT}/ui/data"
debian_copy_tree "${ROOT_DIR}/data" "${INSTALL_ROOT}/ui/data"
chown -R "${LIME_USER}:${LIME_USER}" "${INSTALL_ROOT}/ui"

echo "==> Installing systemd units"
install_systemd_unit "${SYSTEMD_SOURCE_DIR}/lime-shopkeeper.service" "${SYSTEMD_DIR}/lime-shopkeeper.service"
install_systemd_unit "${SYSTEMD_SOURCE_DIR}/lime-ui.service" "${SYSTEMD_DIR}/lime-ui.service"

echo "==> Seeding env templates (first install only)"
if [[ ! -f "${CONFIG_ROOT}/shopkeeper.env" ]]; then
  install_env_template "${SYSTEMD_SOURCE_DIR}/shopkeeper.env.example" "${CONFIG_ROOT}/shopkeeper.env"
  echo "    wrote ${CONFIG_ROOT}/shopkeeper.env (edit DATABASE_URL before starting)"
fi
if [[ ! -f "${CONFIG_ROOT}/ui.env" ]]; then
  install_env_template "${SYSTEMD_SOURCE_DIR}/ui.env.example" "${CONFIG_ROOT}/ui.env"
  echo "    wrote ${CONFIG_ROOT}/ui.env (edit DATABASE_URL before starting)"
fi

# Existing installs used lime-owned files. Preserve their contents while
# removing service-account write access before any further root maintenance.
secure_env_file "${CONFIG_ROOT}/shopkeeper.env"
secure_env_file "${CONFIG_ROOT}/ui.env"

ensure_env_value \
  "${CONFIG_ROOT}/shopkeeper.env" \
  "SHOPKEEPER_SCREENSHOT_DIR" \
  "${INSTALL_ROOT}/shopkeeper/screenshots"

if [[ -f "${VERSION_FILE}" ]]; then
  VERSION_VALUE="$(tr -d '[:space:]' < "${VERSION_FILE}")"
  # Refresh LIME_VERSION in ui.env so the sidebar update notice sees the installed version.
  if grep -q '^LIME_VERSION=' "${CONFIG_ROOT}/ui.env"; then
    sed -i "s/^LIME_VERSION=.*/LIME_VERSION=${VERSION_VALUE}/" "${CONFIG_ROOT}/ui.env"
  else
    printf '\nLIME_VERSION=%s\n' "${VERSION_VALUE}" >> "${CONFIG_ROOT}/ui.env"
  fi
fi

echo "==> Reloading systemd"
systemctl daemon-reload
systemctl enable lime-shopkeeper.service lime-ui.service

echo
echo "Install complete. Edit ${CONFIG_ROOT}/shopkeeper.env and ${CONFIG_ROOT}/ui.env,"
echo "then start the services:"
echo "    systemctl start lime-shopkeeper lime-ui"
echo
echo "Reverse proxy example at deploy/debian/nginx.conf.example."
