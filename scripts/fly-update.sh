#!/usr/bin/env bash
# Rolling update of LIME on Fly.io using a newer GHCR image tag.
#
# Usage:
#   ./scripts/fly-update.sh <version-tag> [shopkeeper-app] [ui-app]
#
# Example:
#   ./scripts/fly-update.sh v1.0.2
#
# Behaviour:
#   - Deploys Shopkeeper first so DB migrations run before the UI restarts.
#   - Uses the rolling strategy defined in the fly.toml files.
#   - The UI is deployed second so users still see the old UI while
#     Shopkeeper migrates. On a single-machine app brief interruption
#     is unavoidable; scale machines to avoid that.

set -euo pipefail
export LC_ALL=C

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <version-tag> [shopkeeper-app] [ui-app]" >&2
  exit 1
fi

VERSION_TAG="$1"
SHOPKEEPER_APP="${2:-lime-shopkeeper}"
UI_APP="${3:-lime-ui}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHOPKEEPER_CFG="${ROOT_DIR}/deploy/fly/shopkeeper.fly.toml"
UI_CFG="${ROOT_DIR}/deploy/fly/ui.fly.toml"

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl not found. Install from https://fly.io/docs/flyctl/install/" >&2
  exit 1
fi

echo "==> Updating Shopkeeper (${SHOPKEEPER_APP}) to ${VERSION_TAG}"
flyctl deploy \
  --app "${SHOPKEEPER_APP}" \
  --config "${SHOPKEEPER_CFG}" \
  --image "ghcr.io/sumanbasuli/lime-shopkeeper:${VERSION_TAG}" \
  --strategy rolling

echo "==> Updating UI (${UI_APP}) to ${VERSION_TAG}"
flyctl deploy \
  --app "${UI_APP}" \
  --config "${UI_CFG}" \
  --image "ghcr.io/sumanbasuli/lime-ui:${VERSION_TAG}" \
  --strategy rolling

echo "Rolling update to ${VERSION_TAG} complete."
