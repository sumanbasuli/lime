#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LIME_DOCS_DB_PORT="${LIME_VERIFY_DB_PORT:-16432}"
export LIME_DOCS_API_PORT="${LIME_VERIFY_API_PORT:-19080}"
export LIME_DOCS_UI_PORT="${LIME_VERIFY_UI_PORT:-14000}"
export LIME_VERIFY_FIXTURE_PORT="${LIME_VERIFY_FIXTURE_PORT:-19090}"
STACK_STARTED=false

for command_name in docker node npm curl; do
  command -v "${command_name}" >/dev/null || { echo "${command_name} is required." >&2; exit 1; }
done
for port in "${LIME_DOCS_DB_PORT}" "${LIME_DOCS_API_PORT}" "${LIME_DOCS_UI_PORT}" "${LIME_VERIFY_FIXTURE_PORT}"; do
  if ! [[ "${port}" =~ ^[0-9]+$ ]] || [ "${port}" -lt 1 ] || [ "${port}" -gt 65535 ]; then
    echo "Verification ports must be integers between 1 and 65535." >&2
    exit 1
  fi
done

compose() {
  docker compose -p lime-verification -f "${ROOT_DIR}/docker-compose.docs.yml" "$@"
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [ "${STACK_STARTED}" = true ]; then
    if [ "${exit_code}" -ne 0 ]; then
      mkdir -p "${ROOT_DIR}/.artifacts/verification"
      compose logs --no-color > "${ROOT_DIR}/.artifacts/verification/docker.log" 2>&1 || true
    fi
    compose down --volumes >/dev/null 2>&1 || true
  fi
  exit "${exit_code}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -d "${ROOT_DIR}/docs-site/node_modules/playwright" ]; then
  npm --prefix "${ROOT_DIR}/docs-site" ci
fi
if ! (cd "${ROOT_DIR}/docs-site" && node --input-type=module -e 'import { chromium } from "playwright"; import { existsSync } from "node:fs"; if (!existsSync(chromium.executablePath())) process.exit(1);'); then
  (cd "${ROOT_DIR}/docs-site" && npx playwright install chromium)
fi

echo "Starting isolated production verification stack (lime-verification)..."
STACK_STARTED=true
compose up -d --build --wait --wait-timeout 180
for attempt in {1..60}; do
  if curl -fsS "http://127.0.0.1:${LIME_DOCS_UI_PORT}/" >/dev/null; then
    break
  fi
  if [ "${attempt}" -eq 60 ]; then
    echo "Verification UI did not start." >&2
    exit 1
  fi
  sleep 1
done

node "${ROOT_DIR}/docs-site/scripts/verify-app.mjs" \
  --base-url "http://127.0.0.1:${LIME_DOCS_UI_PORT}" \
  --api-url "http://127.0.0.1:${LIME_DOCS_API_PORT}"
