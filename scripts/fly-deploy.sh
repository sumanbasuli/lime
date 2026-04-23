#!/usr/bin/env bash
# Fly.io first-time deployment helper for LIME.
#
# Creates two Fly apps (Shopkeeper + UI), provisions a 10GB volume
# for screenshots, wires secrets, and deploys the published GHCR
# images. Requires `flyctl` to be installed and authenticated.
#
# Usage:
#   ./scripts/fly-deploy.sh <version-tag> [shopkeeper-app-name] [ui-app-name] [region]
#
# Example:
#   ./scripts/fly-deploy.sh v0.1.0
#   ./scripts/fly-deploy.sh v0.1.0 my-lime-shop my-lime-ui fra

set -euo pipefail
export LC_ALL=C

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <version-tag> [shopkeeper-app] [ui-app] [region]" >&2
  exit 1
fi

VERSION_TAG="$1"
SHOPKEEPER_APP="${2:-lime-shopkeeper}"
UI_APP="${3:-lime-ui}"
REGION="${4:-iad}"
VOLUME_NAME="lime_screenshots"
VOLUME_SIZE_GB="${LIME_VOLUME_SIZE_GB:-10}"

SHOPKEEPER_IMAGE="ghcr.io/sumanbasuli/lime-shopkeeper:${VERSION_TAG}"
UI_IMAGE="ghcr.io/sumanbasuli/lime-ui:${VERSION_TAG}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHOPKEEPER_CFG="${ROOT_DIR}/deploy/fly/shopkeeper.fly.toml"
UI_CFG="${ROOT_DIR}/deploy/fly/ui.fly.toml"

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl not found. Install from https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi

if ! flyctl auth whoami >/dev/null 2>&1; then
  echo "flyctl is not authenticated. Run: flyctl auth login" >&2
  exit 1
fi

echo "==> Fly deploy plan"
echo "    Shopkeeper app: ${SHOPKEEPER_APP} (${SHOPKEEPER_IMAGE})"
echo "    UI app:         ${UI_APP} (${UI_IMAGE})"
echo "    Region:         ${REGION}"
echo "    Screenshot vol: ${VOLUME_NAME} (${VOLUME_SIZE_GB} GB)"
if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "    Database:       DATABASE_URL from environment"
else
  echo "    Database:       existing DATABASE_URL Fly secrets"
fi
echo

create_app_if_missing() {
  local app="$1"
  if flyctl apps list --json 2>/dev/null | grep -q "\"Name\":\"${app}\""; then
    echo "    app ${app} already exists, skipping create"
  else
    flyctl apps create "${app}" --org "${FLY_ORG:-personal}"
  fi
}

echo "==> Creating apps"
create_app_if_missing "${SHOPKEEPER_APP}"
create_app_if_missing "${UI_APP}"

secret_exists() {
  local app="$1"
  local secret="$2"
  flyctl secrets list --app "${app}" --json 2>/dev/null | grep -q "\"Name\":\"${secret}\""
}

if [[ -z "${DATABASE_URL:-}" ]]; then
  if secret_exists "${SHOPKEEPER_APP}" "DATABASE_URL" && secret_exists "${UI_APP}" "DATABASE_URL"; then
    echo "==> DATABASE_URL is already present as a Fly secret on both apps"
  else
    cat >&2 <<EOF
Missing DATABASE_URL.

Set an external PostgreSQL URL before running:
  export DATABASE_URL='postgresql://...'

Or create/attach Fly Managed Postgres to both apps first:
  flyctl mpg create --name lime-db --region ${REGION}
  flyctl mpg list
  flyctl mpg attach <cluster-id> -a ${SHOPKEEPER_APP}
  flyctl mpg attach <cluster-id> -a ${UI_APP}

EOF
    exit 1
  fi
fi

echo "==> Ensuring screenshots volume on ${SHOPKEEPER_APP}"
if flyctl volumes list -a "${SHOPKEEPER_APP}" --json 2>/dev/null | grep -q "\"Name\":\"${VOLUME_NAME}\""; then
  echo "    volume ${VOLUME_NAME} already present, skipping"
else
  flyctl volumes create "${VOLUME_NAME}" \
    --app "${SHOPKEEPER_APP}" \
    --region "${REGION}" \
    --size "${VOLUME_SIZE_GB}" \
    --yes
fi

if [[ -n "${DATABASE_URL:-}" ]]; then
  echo "==> Setting database secret on ${SHOPKEEPER_APP}"
  flyctl secrets set \
    --app "${SHOPKEEPER_APP}" \
    --stage \
    "DATABASE_URL=${DATABASE_URL}"
else
  echo "==> Keeping existing database secret on ${SHOPKEEPER_APP}"
fi

echo "==> Setting secrets on ${UI_APP}"
ui_secrets=(
  "SHOPKEEPER_URL=http://${SHOPKEEPER_APP}.internal:8080"
  "LIME_UPDATE_CHECK=${LIME_UPDATE_CHECK:-true}"
)
if [[ -n "${DATABASE_URL:-}" ]]; then
  ui_secrets+=("DATABASE_URL=${DATABASE_URL}")
fi
flyctl secrets set \
  --app "${UI_APP}" \
  --stage \
  "${ui_secrets[@]}"

echo "==> Deploying Shopkeeper"
flyctl deploy \
  --app "${SHOPKEEPER_APP}" \
  --config "${SHOPKEEPER_CFG}" \
  --image "${SHOPKEEPER_IMAGE}" \
  --primary-region "${REGION}"

echo "==> Deploying UI"
flyctl deploy \
  --app "${UI_APP}" \
  --config "${UI_CFG}" \
  --image "${UI_IMAGE}" \
  --primary-region "${REGION}"

echo
echo "Done. Open the UI with:"
echo "    flyctl open -a ${UI_APP}"
