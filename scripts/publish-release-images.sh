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
BUILD_CONTEXT="${DOCKER_BUILD_CONTEXT:-.}"
RELEASE_BUILD_CONTEXT=""

cleanup_release_build_context() {
  local status=$?
  trap - EXIT
  if [[ -n "${RELEASE_BUILD_CONTEXT}" ]]; then
    if ! rm -r -- "${RELEASE_BUILD_CONTEXT}"; then
      echo "Could not remove temporary release build context: ${RELEASE_BUILD_CONTEXT}" >&2
      [[ "${status}" -ne 0 ]] || status=1
    fi
  fi
  exit "${status}"
}

# The GitHub Release step runs after image publishing. Claim a new remote tag
# before building so two release jobs cannot publish different commits under
# the same GHCR version aliases. Local no-push builds remain usable offline.
verify_remote_release_tag() {
  local tag_refs sha ref tag_object_sha="" tag_commit_sha=""
  if ! tag_refs="$(git ls-remote --tags origin "refs/tags/${RELEASE_TAG}" "refs/tags/${RELEASE_TAG}^{}")"; then
    echo "Could not check release tag ${RELEASE_TAG} on origin; refusing to publish images." >&2
    return 1
  fi

  while IFS=$'\t' read -r sha ref; do
    case "${ref}" in
      "refs/tags/${RELEASE_TAG}") tag_object_sha="${sha}" ;;
      "refs/tags/${RELEASE_TAG}^{}") tag_commit_sha="${sha}" ;;
    esac
  done <<< "${tag_refs}"

  if [[ -n "${tag_refs}" && -z "${tag_object_sha}" ]]; then
    echo "Could not verify release tag ${RELEASE_TAG} on origin; refusing to publish images." >&2
    return 1
  fi
  REMOTE_TAG_SHA="${tag_commit_sha:-${tag_object_sha}}"
  if [[ -n "${REMOTE_TAG_SHA}" && "${REMOTE_TAG_SHA}" != "${HEAD_SHA}" ]]; then
    echo "Release tag ${RELEASE_TAG} already exists at ${REMOTE_TAG_SHA}, not ${HEAD_SHA}; refusing to publish images." >&2
    return 1
  fi
}

if [[ "${PUSH_IMAGES}" == "true" ]]; then
  HEAD_SHA="$(git rev-parse --verify 'HEAD^{commit}')" || exit 1
  if ! WORKTREE_CHANGES="$(git status --porcelain --untracked-files=all)"; then
    echo "Could not check the release working tree; refusing to publish images." >&2
    exit 1
  fi
  if [[ -n "${WORKTREE_CHANGES}" ]]; then
    echo "Commit or remove local changes before publishing release images." >&2
    exit 1
  fi
  RELEASE_BUILD_CONTEXT="$(mktemp -d "${TMPDIR:-/tmp}/lime-release-context.XXXXXXXX")" || exit 1
  trap cleanup_release_build_context EXIT
  if ! git archive "${HEAD_SHA}" | tar -xf - -C "${RELEASE_BUILD_CONTEXT}"; then
    echo "Could not prepare the committed release build context." >&2
    exit 1
  fi
  if [[ ! -f "${RELEASE_BUILD_CONTEXT}/VERSION" ]]; then
    echo "Committed release build context has no VERSION file." >&2
    exit 1
  fi
  ARCHIVED_VERSION="$(tr -d '[:space:]' < "${RELEASE_BUILD_CONTEXT}/VERSION")"
  if [[ "v${ARCHIVED_VERSION}" != "${RELEASE_TAG}" ]]; then
    echo "Committed VERSION (${ARCHIVED_VERSION}) does not match requested image tag (${RELEASE_TAG})." >&2
    exit 1
  fi
  BUILD_CONTEXT="${RELEASE_BUILD_CONTEXT}"
  if [[ -z "${LIME_SHA_TAG:-}" ]]; then
    SHA_TAG="sha-${HEAD_SHA:0:12}"
  fi
  verify_remote_release_tag || exit 1
  if [[ -z "${REMOTE_TAG_SHA}" ]]; then
    TAGGER_IDENT="$(git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' var GIT_COMMITTER_IDENT)" || exit 1
    TAG_OBJECT_SHA="$(
      printf 'object %s\ntype commit\ntag %s\ntagger %s\n\nRelease %s\n' \
        "${HEAD_SHA}" "${RELEASE_TAG}" "${TAGGER_IDENT}" "${RELEASE_TAG}" | git mktag
    )" || exit 1
    # A non-force push is the claim. If another job won it, proceed only when
    # its new tag peels to this same commit.
    git push origin "${TAG_OBJECT_SHA}:refs/tags/${RELEASE_TAG}" || true
    verify_remote_release_tag || exit 1
    if [[ -z "${REMOTE_TAG_SHA}" ]]; then
      echo "Could not claim release tag ${RELEASE_TAG} on origin; refusing to publish images." >&2
      exit 1
    fi
  fi
fi

BUILD_MAKE_ARGS=(DOCKER_BUILD_CONTEXT="${BUILD_CONTEXT}")
if [[ "${PUSH_IMAGES}" == "true" ]]; then
  BUILD_MAKE_ARGS+=(VERSION="${ARCHIVED_VERSION}" GIT_COMMIT="${HEAD_SHA:0:7}" DOCKER_BUILD_FLAGS=--pull)
fi

run_image_build() {
  if [[ "${PUSH_IMAGES}" == "true" ]]; then
    make -C "${RELEASE_BUILD_CONTEXT}" "${BUILD_MAKE_ARGS[@]}" "$@"
  else
    make "${BUILD_MAKE_ARGS[@]}" "$@"
  fi
}

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

run_image_build \
  SHOPKEEPER_IMAGE="${SHOPKEEPER_IMAGE}" \
  LIME_IMAGE_TAG="${RELEASE_TAG}" \
  build-docker-shopkeeper
push_with_aliases "${SHOPKEEPER_IMAGE}"

run_image_build \
  UI_IMAGE="${UI_IMAGE}" \
  LIME_IMAGE_TAG="${RELEASE_TAG}" \
  build-docker-ui
push_with_aliases "${UI_IMAGE}"
