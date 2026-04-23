#!/usr/bin/env bash
# VPS native installer for LIME (Go backend + NextJS UI + systemd).
#
# Expects:
#   - you've already run `make build` in the repo root, so dist/shopkeeper
#     and dist/ui contain the compiled artifacts
#   - Go, Node, PostgreSQL, and Chromium are installed on the host
#   - the `lime` system user will own the install path
#
# Usage:
#   sudo ./scripts/vps-install.sh
#
# Idempotent: re-running updates binaries in-place and reloads systemd.

set -euo pipefail
export LC_ALL=C

if [[ $EUID -ne 0 ]]; then
  echo "This installer must run as root (use sudo)." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
INSTALL_ROOT="${LIME_INSTALL_ROOT:-/opt/lime}"
CONFIG_ROOT="${LIME_CONFIG_ROOT:-/etc/lime}"
SYSTEMD_DIR="${LIME_SYSTEMD_DIR:-/etc/systemd/system}"
LIME_USER="${LIME_USER:-lime}"
VERSION_FILE="${ROOT_DIR}/VERSION"

if [[ ! -d "${DIST_DIR}/shopkeeper" || ! -d "${DIST_DIR}/ui" ]]; then
  echo "dist/ is missing. Run 'make build' first." >&2
  exit 1
fi

echo "==> Ensuring ${LIME_USER} system user"
if ! id -u "${LIME_USER}" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "${LIME_USER}"
fi

echo "==> Ensuring directories"
install -d -o "${LIME_USER}" -g "${LIME_USER}" -m 0755 \
  "${INSTALL_ROOT}/shopkeeper" \
  "${INSTALL_ROOT}/shopkeeper/screenshots" \
  "${INSTALL_ROOT}/ui"
install -d -m 0750 "${CONFIG_ROOT}"
chgrp "${LIME_USER}" "${CONFIG_ROOT}"

echo "==> Installing Shopkeeper artifacts"
rsync -a --delete "${DIST_DIR}/shopkeeper/" "${INSTALL_ROOT}/shopkeeper/" \
  --exclude screenshots
install -d -o "${LIME_USER}" -g "${LIME_USER}" -m 0755 \
  "${INSTALL_ROOT}/shopkeeper/screenshots" \
  "${INSTALL_ROOT}/shopkeeper/data"
rsync -a "${ROOT_DIR}/data/" "${INSTALL_ROOT}/shopkeeper/data/"
chown -R "${LIME_USER}:${LIME_USER}" "${INSTALL_ROOT}/shopkeeper"

echo "==> Installing UI artifacts"
rsync -a --delete "${DIST_DIR}/ui/" "${INSTALL_ROOT}/ui/"
rsync -a "${ROOT_DIR}/data/" "${INSTALL_ROOT}/ui/data/"
chown -R "${LIME_USER}:${LIME_USER}" "${INSTALL_ROOT}/ui"

echo "==> Installing systemd units"
install -m 0644 "${ROOT_DIR}/deploy/vps/systemd/lime-shopkeeper.service" "${SYSTEMD_DIR}/lime-shopkeeper.service"
install -m 0644 "${ROOT_DIR}/deploy/vps/systemd/lime-ui.service" "${SYSTEMD_DIR}/lime-ui.service"

echo "==> Seeding env templates (first install only)"
if [[ ! -f "${CONFIG_ROOT}/shopkeeper.env" ]]; then
  install -o "${LIME_USER}" -g "${LIME_USER}" -m 0640 \
    "${ROOT_DIR}/deploy/vps/systemd/shopkeeper.env.example" \
    "${CONFIG_ROOT}/shopkeeper.env"
  echo "    wrote ${CONFIG_ROOT}/shopkeeper.env (edit DATABASE_URL before starting)"
fi
if [[ ! -f "${CONFIG_ROOT}/ui.env" ]]; then
  install -o "${LIME_USER}" -g "${LIME_USER}" -m 0640 \
    "${ROOT_DIR}/deploy/vps/systemd/ui.env.example" \
    "${CONFIG_ROOT}/ui.env"
  echo "    wrote ${CONFIG_ROOT}/ui.env (edit DATABASE_URL before starting)"
fi

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
echo "Reverse proxy example at deploy/vps/nginx.conf.example."
