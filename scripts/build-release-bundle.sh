#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <version>" >&2
  exit 1
fi

VERSION="$1"
bash "$(dirname "${BASH_SOURCE[0]}")/validate-release-version.sh" "${VERSION}"
RELEASE_TAG="v${VERSION}"
IMAGE_REGISTRY="${LIME_IMAGE_REGISTRY:-ghcr.io/sumanbasuli}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
BUNDLE_DIR="${DIST_DIR}/release/lime-${RELEASE_TAG}"
ARCHIVE_PATH="${DIST_DIR}/lime-${RELEASE_TAG}-release.tar.gz"

if [[ -L "${DIST_DIR}" || -L "${DIST_DIR}/release" || -L "${ARCHIVE_PATH}" || -d "${ARCHIVE_PATH}" ]]; then
  echo "Release output paths must use real directories and an ordinary archive file under dist/." >&2
  exit 1
fi

rm -rf -- "${BUNDLE_DIR}"
mkdir -p "${BUNDLE_DIR}"
mkdir -p "${DIST_DIR}/release"

cp "${ROOT_DIR}/docker-compose.release.yml" "${BUNDLE_DIR}/docker-compose.release.yml"
cp "${ROOT_DIR}/deploy/release/README.md" "${BUNDLE_DIR}/README.md"
mkdir -p "${BUNDLE_DIR}/data"
cp "${ROOT_DIR}/data/"*.json "${BUNDLE_DIR}/data/"
chmod 0755 "${BUNDLE_DIR}/data"
chmod 0644 "${BUNDLE_DIR}/data/"*.json
mkdir -p "${BUNDLE_DIR}/deploy/docker"
cp "${ROOT_DIR}/deploy/docker/chromium-seccomp.json" \
  "${ROOT_DIR}/deploy/docker/LICENSE.moby" \
  "${ROOT_DIR}/deploy/docker/README.md" "${BUNDLE_DIR}/deploy/docker/"
chmod 0755 "${BUNDLE_DIR}/deploy" "${BUNDLE_DIR}/deploy/docker"
chmod 0644 "${BUNDLE_DIR}/deploy/docker/"*

sed \
  -e "s|^LIME_IMAGE_REGISTRY=.*|LIME_IMAGE_REGISTRY=${IMAGE_REGISTRY}|" \
  -e "s|^LIME_IMAGE_TAG=.*|LIME_IMAGE_TAG=${RELEASE_TAG}|" \
  "${ROOT_DIR}/deploy/release/.env.example" > "${BUNDLE_DIR}/.env.example"

ARCHIVE_LINKS=0
if [[ -f "${ARCHIVE_PATH}" ]]; then
  if [[ "$(uname -s)" == Darwin ]]; then
    ARCHIVE_LINKS="$(stat -f '%l' "${ARCHIVE_PATH}")"
    ARCHIVE_MODE="$(stat -f '%Lp' "${ARCHIVE_PATH}")"
  else
    ARCHIVE_LINKS="$(stat -c '%h' "${ARCHIVE_PATH}")"
    ARCHIVE_MODE="$(stat -c '%a' "${ARCHIVE_PATH}")"
  fi
fi
if [[ "${ARCHIVE_LINKS}" == 1 ]]; then
  # Keep an ordinary existing artifact's owner, group, ACLs, and permissions.
  tar -C "${DIST_DIR}/release" -czf "${ARCHIVE_PATH}" "lime-${RELEASE_TAG}"
else
  TEMP_ARCHIVE="$(mktemp "${DIST_DIR}/.lime-${RELEASE_TAG}-archive.XXXXXXXX")"
  trap 'rm -f -- "${TEMP_ARCHIVE}"' EXIT
  tar -C "${DIST_DIR}/release" -czf "${TEMP_ARCHIVE}" "lime-${RELEASE_TAG}"
  if [[ "${ARCHIVE_LINKS}" == 0 ]]; then
    chmod =rw "${TEMP_ARCHIVE}"
  else
    chmod "${ARCHIVE_MODE}" "${TEMP_ARCHIVE}"
  fi
  mv -f -- "${TEMP_ARCHIVE}" "${ARCHIVE_PATH}"
  trap - EXIT
fi

echo "Release bundle ready at ${ARCHIVE_PATH}"
