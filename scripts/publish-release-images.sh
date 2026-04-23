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
RELEASE_TAG="${TAG_INPUT#v}"
RELEASE_TAG="v${RELEASE_TAG}"
FILE_VERSION="$(tr -d '[:space:]' < VERSION)"
EXPECTED_TAG="v${FILE_VERSION}"

if [[ "${RELEASE_TAG}" != "${EXPECTED_TAG}" ]]; then
  echo "VERSION (${FILE_VERSION}) does not match requested image tag (${RELEASE_TAG})" >&2
  exit 1
fi

LIME_IMAGE_REGISTRY="${LIME_IMAGE_REGISTRY:-ghcr.io/sumanbasuli}"
SHOPKEEPER_IMAGE="${RELEASE_SHOPKEEPER_IMAGE:-${LIME_IMAGE_REGISTRY}/lime-shopkeeper}"
UI_IMAGE="${RELEASE_UI_IMAGE:-${LIME_IMAGE_REGISTRY}/lime-ui}"
SHA_TAG="${LIME_SHA_TAG:-sha-$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)}"
PUBLISH_LATEST="${PUBLISH_LATEST:-true}"
PUSH_IMAGES="${PUSH_IMAGES:-true}"

push_with_aliases() {
  local image="$1"

  docker tag "${image}:${RELEASE_TAG}" "${image}:${SHA_TAG}"
  if [[ "${PUBLISH_LATEST}" == "true" ]]; then
    docker tag "${image}:${RELEASE_TAG}" "${image}:latest"
  fi

  if [[ "${PUSH_IMAGES}" != "true" ]]; then
    echo "Skipping docker push for ${image}:${RELEASE_TAG}"
    return
  fi

  docker push "${image}:${RELEASE_TAG}"
  docker push "${image}:${SHA_TAG}"

  if [[ "${PUBLISH_LATEST}" == "true" ]]; then
    docker push "${image}:latest"
  fi
}

make \
  SHOPKEEPER_IMAGE="${SHOPKEEPER_IMAGE}" \
  LIME_IMAGE_TAG="${RELEASE_TAG}" \
  build-docker-shopkeeper
push_with_aliases "${SHOPKEEPER_IMAGE}"

make \
  UI_IMAGE="${UI_IMAGE}" \
  LIME_IMAGE_TAG="${RELEASE_TAG}" \
  build-docker-ui
push_with_aliases "${UI_IMAGE}"
