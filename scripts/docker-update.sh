#!/usr/bin/env bash
# Zero-ish-downtime update for a Docker Compose LIME deployment.
#
# Flow:
#   1. dump the local Postgres (if using the bundled db service)
#      to dist/backups/lime-pre-<tag>-<timestamp>.sql.gz
#   2. pull the new GHCR images defined by LIME_IMAGE_TAG
#   3. migrate via a one-shot Shopkeeper container so the schema
#      is ready before long-running containers are touched
#   4. recreate shopkeeper, wait for health, then recreate ui
#
# Usage (from repo root):
#   ./scripts/docker-update.sh v1.0.3
#
# Environment:
#   COMPOSE_FILE  - compose file to use (default docker-compose.release.yml)
#   ENV_FILE      - env file consumed by compose (default .env)

set -euo pipefail
export LC_ALL=C

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <version-tag>" >&2
  exit 1
fi

TAG="$1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.release.yml}"
ENV_FILE="${ENV_FILE:-.env}"
BACKUP_DIR="${ROOT_DIR}/dist/backups"

cd "${ROOT_DIR}"

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "Compose file not found: ${COMPOSE_FILE}" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Env file not found: ${ENV_FILE}" >&2
  exit 1
fi

compose() {
  docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

echo "==> Reading current image tag"
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a
OLD_TAG="${LIME_IMAGE_TAG:-unknown}"
echo "    current LIME_IMAGE_TAG=${OLD_TAG}"
echo "    target LIME_IMAGE_TAG=${TAG}"

echo "==> Backing up database"
mkdir -p "${BACKUP_DIR}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/lime-pre-${TAG}-${TIMESTAMP}.sql.gz"

if compose ps --services 2>/dev/null | grep -qx "db"; then
  echo "    dumping bundled db service"
  compose exec -T db pg_dump -U "${POSTGRES_USER:-lime}" "${POSTGRES_DB:-lime_db}" | gzip -9 > "${BACKUP_FILE}"
elif [[ -n "${DATABASE_URL:-}" ]] && command -v pg_dump >/dev/null 2>&1; then
  echo "    dumping external database via host pg_dump"
  pg_dump "${DATABASE_URL}" | gzip -9 > "${BACKUP_FILE}"
else
  echo "    no bundled db and pg_dump unavailable on host; skipping automatic backup"
  echo "    (take a manual backup of your DATABASE_URL target before continuing)"
  read -r -p "Continue without backup? [y/N] " answer
  if [[ "${answer,,}" != "y" && "${answer,,}" != "yes" ]]; then
    exit 1
  fi
  BACKUP_FILE=""
fi

echo "==> Updating .env with new tag"
if grep -q '^LIME_IMAGE_TAG=' "${ENV_FILE}"; then
  sed -i.bak "s/^LIME_IMAGE_TAG=.*/LIME_IMAGE_TAG=${TAG}/" "${ENV_FILE}"
  rm -f "${ENV_FILE}.bak"
else
  printf '\nLIME_IMAGE_TAG=%s\n' "${TAG}" >> "${ENV_FILE}"
fi
export LIME_IMAGE_TAG="${TAG}"

echo "==> Pulling new images"
compose pull shopkeeper ui

echo "==> Applying migrations with one-shot Shopkeeper"
compose run --rm --no-deps shopkeeper ./shopkeeper --migrate

echo "==> Recreating Shopkeeper"
compose up -d --no-deps shopkeeper

echo "==> Waiting for Shopkeeper health"
for attempt in $(seq 1 30); do
  if compose exec -T shopkeeper wget -qO- "http://127.0.0.1:${SHOPKEEPER_PORT:-8080}/api/health" >/dev/null 2>&1; then
    echo "    healthy after ${attempt} attempts"
    break
  fi
  sleep 2
  if [[ ${attempt} -eq 30 ]]; then
    echo "    Shopkeeper did not become healthy in time" >&2
    exit 1
  fi
done

echo "==> Recreating UI"
compose up -d --no-deps ui

echo
echo "Update to ${TAG} complete."
if [[ -n "${BACKUP_FILE}" ]]; then
  echo "Backup: ${BACKUP_FILE}"
fi
echo "Rollback with: ./scripts/docker-update.sh ${OLD_TAG}"
