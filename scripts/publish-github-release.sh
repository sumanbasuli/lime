#!/usr/bin/env bash

set -euo pipefail
export LC_ALL=C

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <version-tag>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

TAG_INPUT="$1"
VERSION="${TAG_INPUT#v}"
RELEASE_TAG="v${VERSION}"
FILE_VERSION="$(tr -d '[:space:]' < VERSION)"
EXPECTED_TAG="v${FILE_VERSION}"
NOTES_PATH="${RELEASE_NOTES_PATH:-${ROOT_DIR}/dist/release-notes.md}"
BUNDLE_PATH="${RELEASE_BUNDLE_PATH:-${ROOT_DIR}/dist/lime-${RELEASE_TAG}-release.tar.gz}"

if [[ "${RELEASE_TAG}" != "${EXPECTED_TAG}" ]]; then
  echo "VERSION (${FILE_VERSION}) does not match requested release tag (${RELEASE_TAG})" >&2
  exit 1
fi

if [[ ! -f "${BUNDLE_PATH}" ]]; then
  echo "Release bundle not found: ${BUNDLE_PATH}" >&2
  exit 1
fi

mkdir -p "$(dirname "${NOTES_PATH}")"
./scripts/extract-release-notes.sh "${VERSION}" > "${NOTES_PATH}"

HEAD_SHA="$(git rev-parse HEAD)"

if git ls-remote --exit-code --tags origin "refs/tags/${RELEASE_TAG}" >/dev/null 2>&1; then
  git fetch --force --tags origin "refs/tags/${RELEASE_TAG}:refs/tags/${RELEASE_TAG}"
  TAG_SHA="$(git rev-list -n 1 "${RELEASE_TAG}")"
  if [[ "${TAG_SHA}" != "${HEAD_SHA}" ]]; then
    echo "Release tag ${RELEASE_TAG} already exists at ${TAG_SHA}, not ${HEAD_SHA}." >&2
    echo "Bump VERSION and add matching CHANGELOG.md notes before merging to main." >&2
    exit 1
  fi
else
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git tag -a "${RELEASE_TAG}" -m "Release ${RELEASE_TAG}" "${HEAD_SHA}"
  git push origin "refs/tags/${RELEASE_TAG}"
fi

if gh release view "${RELEASE_TAG}" >/dev/null 2>&1; then
  gh release edit "${RELEASE_TAG}" \
    --title "LIME ${RELEASE_TAG}" \
    --notes-file "${NOTES_PATH}" \
    --latest
  gh release upload "${RELEASE_TAG}" "${BUNDLE_PATH}" --clobber
else
  gh release create "${RELEASE_TAG}" "${BUNDLE_PATH}" \
    --verify-tag \
    --title "LIME ${RELEASE_TAG}" \
    --notes-file "${NOTES_PATH}" \
    --latest
fi
