#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <version>" >&2
  exit 1
fi

VERSION="$1"
RELEASE_TAG="v${VERSION}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
BUNDLE_DIR="${DIST_DIR}/release/lime-${RELEASE_TAG}"
ARCHIVE_PATH="${DIST_DIR}/lime-${RELEASE_TAG}-release.tar.gz"

rm -rf "${BUNDLE_DIR}"
mkdir -p "${BUNDLE_DIR}"
mkdir -p "${DIST_DIR}/release"

cp "${ROOT_DIR}/docker-compose.release.yml" "${BUNDLE_DIR}/docker-compose.release.yml"
cp "${ROOT_DIR}/deploy/release/README.md" "${BUNDLE_DIR}/README.md"
mkdir -p "${BUNDLE_DIR}/data"
cp "${ROOT_DIR}/data/"*.json "${BUNDLE_DIR}/data/"

sed "s/^LIME_IMAGE_TAG=.*/LIME_IMAGE_TAG=${RELEASE_TAG}/" \
  "${ROOT_DIR}/deploy/release/.env.example" > "${BUNDLE_DIR}/.env.example"

tar -C "${DIST_DIR}/release" -czf "${ARCHIVE_PATH}" "lime-${RELEASE_TAG}"

echo "Release bundle ready at ${ARCHIVE_PATH}"
