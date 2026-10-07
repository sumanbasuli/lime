#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ "${0##*/}" == git ]]; then
  if [[ "${1:-}" == archive && -n "${LIME_RELEASE_TEST_MOVE_HEAD_SHA:-}" ]]; then
    "${LIME_RELEASE_TEST_REAL_GIT}" -C "${LIME_RELEASE_TEST_WORK}" \
      update-ref HEAD "${LIME_RELEASE_TEST_MOVE_HEAD_SHA}"
  fi
  if [[ "${1:-}" == push && "${3:-}" == *:refs/tags/v2.0.0 ]]; then
    if [[ "${LIME_RELEASE_TEST_FAIL_CLAIM:-}" == true ]]; then
      exit 32
    fi
    if [[ -n "${LIME_RELEASE_TEST_RACE_SHA:-}" ]]; then
      "${LIME_RELEASE_TEST_REAL_GIT}" --git-dir="${LIME_RELEASE_TEST_REMOTE}" \
        update-ref refs/tags/v2.0.0 "${LIME_RELEASE_TEST_RACE_SHA}"
    fi
  fi
  exec "${LIME_RELEASE_TEST_REAL_GIT}" "$@"
fi

if [[ "${0##*/}" == make || "${0##*/}" == docker ]]; then
  if [[ "${0##*/}" == make && "${PUSH_IMAGES:-true}" == true ]]; then
    build_context="" build_version="" build_commit="" build_flags="" make_location="" previous_argument=""
    for argument in "$@"; do
      if [[ "${previous_argument}" == -C ]]; then make_location="${argument}"; fi
      case "${argument}" in
        DOCKER_BUILD_CONTEXT=*) build_context="${argument#DOCKER_BUILD_CONTEXT=}" ;;
        VERSION=*) build_version="${argument#VERSION=}" ;;
        GIT_COMMIT=*) build_commit="${argument#GIT_COMMIT=}" ;;
        DOCKER_BUILD_FLAGS=*) build_flags="${argument#DOCKER_BUILD_FLAGS=}" ;;
      esac
      previous_argument="${argument}"
    done
    [[ -n "${build_context}" && "${build_context}" != . && "${make_location}" == "${build_context}" ]] || exit 34
    [[ -f "${build_context}/shopkeeper/Dockerfile" && -f "${build_context}/lime/Dockerfile" ]] || exit 35
    [[ "$(< "${build_context}/VERSION")" == 2.0.0 && "${build_version}" == 2.0.0 && "${build_commit}" == "${LIME_RELEASE_TEST_EXPECT_HEAD:0:7}" && "${build_flags}" == --pull ]] || exit 36
    "${LIME_RELEASE_TEST_REAL_GIT}" -C "${LIME_RELEASE_TEST_WORK}" show "${LIME_RELEASE_TEST_EXPECT_HEAD}:shopkeeper/Dockerfile" | cmp - "${build_context}/shopkeeper/Dockerfile" >/dev/null || exit 38
    "${LIME_RELEASE_TEST_REAL_GIT}" -C "${LIME_RELEASE_TEST_WORK}" show "${LIME_RELEASE_TEST_EXPECT_HEAD}:lime/Dockerfile" | cmp - "${build_context}/lime/Dockerfile" >/dev/null || exit 39
    "${LIME_RELEASE_TEST_REAL_GIT}" -C "${LIME_RELEASE_TEST_WORK}" show "${LIME_RELEASE_TEST_EXPECT_HEAD}:Makefile" | cmp - "${build_context}/Makefile" >/dev/null || exit 40
    [[ ! -e "${build_context}/lime/.env.production" && ! -e "${build_context}/lime/public/private.log" && ! -e "${build_context}/shopkeeper/go.work" ]] || exit 37
    printf '%s\n' "${build_context}" >> "${LIME_RELEASE_TEST_CONTEXTS}"
  elif [[ "${0##*/}" == make ]]; then
    for argument in "$@"; do
      [[ "${argument}" != -C ]] || exit 41
    done
    [[ "${DOCKER_BUILD_FLAGS:-}" == '--target dev' ]] || exit 42
  fi
  if [[ "${0##*/}" == make && "${LIME_RELEASE_TEST_REQUIRE_CLAIM:-}" == true ]]; then
    claimed_sha="$("${LIME_RELEASE_TEST_REAL_GIT}" --git-dir="${LIME_RELEASE_TEST_REMOTE}" rev-list -n 1 refs/tags/v2.0.0)"
    claimed_type="$("${LIME_RELEASE_TEST_REAL_GIT}" --git-dir="${LIME_RELEASE_TEST_REMOTE}" cat-file -t refs/tags/v2.0.0)"
    [[ "${claimed_sha}" == "${LIME_RELEASE_TEST_EXPECT_HEAD}" && "${claimed_type}" == tag ]] || exit 33
  fi
  printf '%s\n' "${0##*/} $*" >> "${LIME_RELEASE_TEST_CALLS}"
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL_GIT="$(command -v git)"
REAL_MAKE="$(command -v make)"
test_dir="$(mktemp -d)"
trap 'rm -r -- "${test_dir}"' EXIT

mkdir -p "${test_dir}/work/scripts" "${test_dir}/work/shopkeeper" "${test_dir}/work/lime/public" "${test_dir}/bin" "${test_dir}/tmp"
cp "${ROOT_DIR}/scripts/publish-release-images.sh" "${test_dir}/work/scripts/"
cp "${ROOT_DIR}/Makefile" "${test_dir}/work/Makefile"
cp "${ROOT_DIR}/.gitignore" "${test_dir}/work/.gitignore"
cp "${ROOT_DIR}/.dockerignore" "${test_dir}/work/.dockerignore"
cp "${ROOT_DIR}/lime/.gitignore" "${test_dir}/work/lime/.gitignore"
cp "${ROOT_DIR}/shopkeeper/.gitignore" "${test_dir}/work/shopkeeper/.gitignore"
git init -q --bare "${test_dir}/origin.git"
git init -q "${test_dir}/work"
git -C "${test_dir}/work" config user.name 'LIME release test'
git -C "${test_dir}/work" config user.email 'release-test@example.invalid'
git -C "${test_dir}/work" remote add origin "${test_dir}/origin.git"
printf '2.0.0\n' > "${test_dir}/work/VERSION"
printf 'FROM scratch\n' > "${test_dir}/work/shopkeeper/Dockerfile"
printf 'FROM scratch\n' > "${test_dir}/work/lime/Dockerfile"
git -C "${test_dir}/work" add VERSION Makefile .gitignore .dockerignore scripts/publish-release-images.sh shopkeeper/.gitignore shopkeeper/Dockerfile lime/.gitignore lime/Dockerfile
git -C "${test_dir}/work" commit -qm 'first release candidate'
old_sha="$(git -C "${test_dir}/work" rev-parse HEAD)"
printf 'FROM scratch\n# current release candidate\n' > "${test_dir}/work/shopkeeper/Dockerfile"
git -C "${test_dir}/work" add shopkeeper/Dockerfile
git -C "${test_dir}/work" commit -qm 'new release candidate'
head_sha="$(git -C "${test_dir}/work" rev-parse HEAD)"
mkdir -p "${test_dir}/work/dist"
printf 'ignored build output\n' > "${test_dir}/work/dist/build-output"
printf 'private env value\n' > "${test_dir}/work/lime/.env.production"
printf 'private log value\n' > "${test_dir}/work/lime/public/private.log"
printf 'go 1.25\n' > "${test_dir}/work/shopkeeper/go.work"
for ignored_path in lime/.env.production lime/public/private.log shopkeeper/go.work; do
  git -C "${test_dir}/work" check-ignore -q "${ignored_path}"
done

ln -s "${ROOT_DIR}/scripts/verify-release-image-tags.sh" "${test_dir}/bin/make"
ln -s "${ROOT_DIR}/scripts/verify-release-image-tags.sh" "${test_dir}/bin/docker"
ln -s "${ROOT_DIR}/scripts/verify-release-image-tags.sh" "${test_dir}/bin/git"

fail() {
  printf 'Release image tag verification failed: %s\n' "$1" >&2
  if [[ -s "${test_dir}/stderr" ]]; then
    sed -n '1,30p' "${test_dir}/stderr" >&2
  fi
  exit 1
}

build_commands="$(make -n DOCKER_COMPOSE='docker compose' \
  DOCKER_BUILD_CONTEXT='/virtual/release-context' \
  build-docker-shopkeeper build-docker-ui)"
printf '%s\n' "${build_commands}" | grep -Fq -- '--file "/virtual/release-context/shopkeeper/Dockerfile"' || fail 'Shopkeeper Makefile target ignored the build context'
printf '%s\n' "${build_commands}" | grep -Fq -- '--file "/virtual/release-context/lime/Dockerfile"' || fail 'UI Makefile target ignored the build context'
[[ "$(printf '%s\n' "${build_commands}" | grep -Ec '^[[:space:]]*"/virtual/release-context"$')" -eq 2 ]] || fail 'both Docker targets did not use the archive as their build context'
local_commands="$(make -n DOCKER_COMPOSE='docker compose' build-docker-shopkeeper build-docker-ui)"
printf '%s\n' "${local_commands}" | grep -Fq -- '--file "./shopkeeper/Dockerfile"' || fail 'local Shopkeeper build context changed'
printf '%s\n' "${local_commands}" | grep -Fq -- '--file "./lime/Dockerfile"' || fail 'local UI build context changed'

archive_context="${test_dir}/archived-make"
mkdir -p "${archive_context}"
git -C "${test_dir}/work" archive "${head_sha}" | tar -xf - -C "${archive_context}"
: > "${test_dir}/calls"
if ! env PATH="${test_dir}/bin:${PATH}" \
  LIME_RELEASE_TEST_CALLS="${test_dir}/calls" \
  LIME_RELEASE_TEST_REAL_GIT="${REAL_GIT}" \
  DOCKER_BUILD_FLAGS='--target dev' \
  "${REAL_MAKE}" -C "${archive_context}" \
    DOCKER_BUILD_CONTEXT="${archive_context}" VERSION=2.0.0 GIT_COMMIT="${head_sha:0:7}" DOCKER_BUILD_FLAGS=--pull \
    build-docker-shopkeeper build-docker-ui > "${test_dir}/make_stdout" 2> "${test_dir}/stderr"; then
  fail 'archived Makefile could not build both images with fake Docker'
fi
[[ "$(grep -c '^docker build --pull ' "${test_dir}/calls")" -eq 2 ]] || fail 'archived Makefile did not use pinned build flags'
[[ "$(grep -Fc -- "--build-arg LIME_VERSION=2.0.0 --build-arg LIME_COMMIT=${head_sha:0:7}" "${test_dir}/calls")" -eq 2 ]] || fail 'archived Makefile did not use pinned version and commit labels'
grep -Fq -- "--file ${archive_context}/shopkeeper/Dockerfile ${archive_context}" "${test_dir}/calls" || fail 'archived Shopkeeper recipe used the wrong context'
grep -Fq -- "--file ${archive_context}/lime/Dockerfile ${archive_context}" "${test_dir}/calls" || fail 'archived UI recipe used the wrong context'
rm -r -- "${archive_context}"

assert_contexts_cleaned() {
  local leftover context
  for leftover in "${test_dir}/tmp/"lime-release-context.*; do
    [[ ! -e "${leftover}" ]] || fail "temporary release context was not removed: ${leftover}"
  done
  while IFS= read -r context; do
    [[ ! -e "${context}" ]] || fail "published build context was not removed: ${context}"
  done < "${test_dir}/contexts"
}

run_publisher() {
  local tag="$1"
  shift
  : > "${test_dir}/calls"
  : > "${test_dir}/contexts"
  env \
    PATH="${test_dir}/bin:${PATH}" \
    TMPDIR="${test_dir}/tmp" \
    LIME_RELEASE_TEST_CALLS="${test_dir}/calls" \
    LIME_RELEASE_TEST_CONTEXTS="${test_dir}/contexts" \
    LIME_RELEASE_TEST_REAL_GIT="${REAL_GIT}" \
    LIME_RELEASE_TEST_REMOTE="${test_dir}/origin.git" \
    LIME_RELEASE_TEST_WORK="${test_dir}/work" \
    LIME_RELEASE_TEST_EXPECT_HEAD="${head_sha}" \
    LIME_IMAGE_REGISTRY='example.invalid/lime' \
    DOCKER_BUILD_FLAGS='--target dev' \
    PUSH_IMAGES=true \
    "$@" \
    bash "${test_dir}/work/scripts/publish-release-images.sh" "${tag}" \
    > "${test_dir}/stdout" 2> "${test_dir}/stderr"
}

expect_rejected_before_build() {
  local description="$1"
  local tag="$2"
  shift 2
  if run_publisher "${tag}" "$@"; then
    fail "${description}: publisher accepted unsafe remote tag state"
  fi
  [[ ! -s "${test_dir}/calls" ]] || fail "${description}: Docker or make ran before rejection"
  assert_contexts_cleaned
}

expect_published() {
  local description="$1"
  local tag="$2"
  shift 2
  if ! run_publisher "${tag}" "$@"; then
    fail "${description}: publisher rejected a valid release"
  fi
  [[ "$(grep -c '^make ' "${test_dir}/calls")" -eq 2 ]] || fail "${description}: missing image builds"
  grep -Fqx 'docker push example.invalid/lime/lime-shopkeeper:v2.0.0' "${test_dir}/calls" || fail "${description}: Shopkeeper version tag not pushed"
  grep -Fqx 'docker push example.invalid/lime/lime-ui:v2.0.0' "${test_dir}/calls" || fail "${description}: UI version tag not pushed"
  [[ "$(wc -l < "${test_dir}/contexts")" -eq 2 ]] || fail "${description}: both image builds did not receive an archive context"
  assert_contexts_cleaned
}

# An existing annotated tag at the previous commit must block all image work.
printf '# local change\n' >> "${test_dir}/work/shopkeeper/Dockerfile"
expect_rejected_before_build 'dirty tracked Docker context' v2.0.0
if git --git-dir="${test_dir}/origin.git" show-ref --verify --quiet refs/tags/v2.0.0; then
  fail 'dirty tracked Docker context created a remote tag'
fi
git -C "${test_dir}/work" restore -- shopkeeper/Dockerfile
printf 'local change\n' > "${test_dir}/work/shopkeeper/untracked.txt"
expect_rejected_before_build 'untracked Docker context' v2.0.0
if git --git-dir="${test_dir}/origin.git" show-ref --verify --quiet refs/tags/v2.0.0; then
  fail 'untracked Docker context created a remote tag'
fi
rm -- "${test_dir}/work/shopkeeper/untracked.txt"

git -C "${test_dir}/work" tag -a v2.0.0 -m old "${old_sha}"
git -C "${test_dir}/work" push -q origin refs/tags/v2.0.0
expect_rejected_before_build 'divergent annotated tag' v2.0.0

# A missing remote tag is a first publication, even if a local tag exists.
git --git-dir="${test_dir}/origin.git" update-ref -d refs/tags/v2.0.0
expect_published 'absent remote tag' 2.0.0 LIME_RELEASE_TEST_REQUIRE_CLAIM=true LIME_RELEASE_TEST_MOVE_HEAD_SHA="${old_sha}"
git -C "${test_dir}/work" update-ref HEAD "${head_sha}"
[[ "$(git --git-dir="${test_dir}/origin.git" rev-list -n 1 refs/tags/v2.0.0)" == "${head_sha}" ]] || fail 'first publication did not claim HEAD'
[[ "$(git --git-dir="${test_dir}/origin.git" cat-file -t refs/tags/v2.0.0)" == tag ]] || fail 'first publication did not create an annotated tag'
git --git-dir="${test_dir}/origin.git" cat-file -p refs/tags/v2.0.0 | grep -Fqx "object ${head_sha}" || fail 'claimed tag object does not target HEAD'
git --git-dir="${test_dir}/origin.git" cat-file -p refs/tags/v2.0.0 | grep -Fqx 'tag v2.0.0' || fail 'claimed tag object has the wrong name'
[[ "$(git -C "${test_dir}/work" rev-list -n 1 refs/tags/v2.0.0)" == "${old_sha}" ]] || fail 'claim rewrote a pre-existing local tag'
git -C "${test_dir}/work" fetch -q --force --tags origin 'refs/tags/v2.0.0:refs/tags/v2.0.0'
[[ "$(git -C "${test_dir}/work" rev-list -n 1 refs/tags/v2.0.0)" == "${head_sha}" ]] || fail 'GitHub Release tag fetch did not accept the claim'

# Re-running at the same commit works for both annotated and lightweight tags.
git -C "${test_dir}/work" tag -fa v2.0.0 -m current HEAD >/dev/null
git -C "${test_dir}/work" push -q --force origin refs/tags/v2.0.0
expect_published 'same-commit annotated tag' v2.0.0
git -C "${test_dir}/work" tag -f v2.0.0 HEAD >/dev/null
git -C "${test_dir}/work" push -q --force origin refs/tags/v2.0.0
expect_published 'same-commit lightweight tag' v2.0.0

git -C "${test_dir}/work" tag -f v2.0.0 "${old_sha}" >/dev/null
git -C "${test_dir}/work" push -q --force origin refs/tags/v2.0.0
expect_rejected_before_build 'divergent lightweight tag' v2.0.0

# Two jobs can both see no tag. A non-force claim must reject a different
# commit that wins between lookup and push, but permit the same commit.
git --git-dir="${test_dir}/origin.git" update-ref -d refs/tags/v2.0.0
expect_rejected_before_build 'divergent concurrent claim' v2.0.0 LIME_RELEASE_TEST_RACE_SHA="${old_sha}"
git --git-dir="${test_dir}/origin.git" update-ref -d refs/tags/v2.0.0
expect_published 'same-commit concurrent claim' v2.0.0 LIME_RELEASE_TEST_RACE_SHA="${head_sha}"
git --git-dir="${test_dir}/origin.git" update-ref -d refs/tags/v2.0.0
expect_rejected_before_build 'failed tag claim' v2.0.0 LIME_RELEASE_TEST_FAIL_CLAIM=true

# Lookup errors are not equivalent to an absent tag. Local no-push builds remain offline.
git -C "${test_dir}/work" remote set-url origin "${test_dir}/missing.git"
expect_rejected_before_build 'unavailable remote' v2.0.0
if ! run_publisher v2.0.0 PUSH_IMAGES=false; then
  fail 'offline no-push build was rejected'
fi
[[ "$(grep -c '^make ' "${test_dir}/calls")" -eq 2 ]] || fail 'offline no-push build did not run'
if grep -q '^docker push ' "${test_dir}/calls"; then
  fail 'offline no-push build pushed an image'
fi

printf '# local change\n' >> "${test_dir}/work/shopkeeper/Dockerfile"
if ! run_publisher v2.0.0 PUSH_IMAGES=false; then
  fail 'offline no-push build rejected local source changes'
fi
[[ "$(grep -c '^make ' "${test_dir}/calls")" -eq 2 ]] || fail 'offline dirty no-push build did not run'

printf 'Release image tag verification passed.\n'
