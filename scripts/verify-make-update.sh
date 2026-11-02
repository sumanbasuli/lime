#!/usr/bin/env bash
# Exercise the source Compose update recipe without contacting Docker or Git.
set -euo pipefail

case "${0##*/}" in
  docker)
    [[ "${1:-}" == compose ]] || exit 1
    shift
    [[ "${1:-}" != version ]] || exit 0
    printf 'compose %s\n' "$*" >> "${MOCK_LOG:?}"
    case "${1:-}:${2:-}:${3:-}" in
      exec:-T:db) printf 'fixture backup\n' ;;
      exec:-T:shopkeeper) [[ "${MOCK_FAIL:-}" != shop-health ]] ;;
      exec:-T:ui) [[ "${MOCK_FAIL:-}" != ui-health ]] ;;
      build:*) [[ "${MOCK_FAIL:-}" != build ]] ;;
      stop:*) [[ "${MOCK_FAIL:-}" != stop ]] ;;
      run:*)
        if [[ "$*" == *--verify-startup ]]; then
          [[ "${MOCK_FAIL:-}" != preflight ]]
        else
          [[ "${MOCK_FAIL:-}" != migration ]]
        fi
        ;;
      up:*) exit 0 ;;
      *) echo "Unexpected Compose command: $*" >&2; exit 1 ;;
    esac
    exit
    ;;
  git)
    case "${1:-}" in
      rev-parse)
        if [[ "$(<VERSION)" == 2.0.0 ]]; then printf 'newsha\n'; else printf 'oldsha\n'; fi
        ;;
      fetch) printf 'git %s\n' "$*" >> "${MOCK_LOG:?}" ;;
      checkout)
        printf 'git %s\n' "$*" >> "${MOCK_LOG:?}"
        printf '2.0.0\n' > VERSION
        ;;
      *) echo "Unexpected Git command: $*" >&2; exit 1 ;;
    esac
    exit
    ;;
  sleep) exit 0 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
self="${repo_root}/scripts/verify-make-update.sh"
test_root="$(mktemp -d)"
trap 'rm -r -- "${test_root}"' EXIT

run_case() {
  local name="$1" failure="$2" expected_status="$3" case_dir
  case_dir="${test_root}/${name}"
  mkdir -p "${case_dir}/bin" "${case_dir}/scripts"
  cp "${repo_root}/Makefile" "${case_dir}/Makefile"
  cp "${repo_root}/scripts/backup-safety.sh" "${case_dir}/scripts/backup-safety.sh"
  printf '1.0.0\n' > "${case_dir}/VERSION"
  ln -s "${self}" "${case_dir}/bin/docker"
  ln -s "${self}" "${case_dir}/bin/git"
  ln -s "${self}" "${case_dir}/bin/sleep"
  : > "${case_dir}/commands"
  local status=0
  (
    cd "${case_dir}"
    PATH="${case_dir}/bin:${PATH}" MOCK_LOG="${case_dir}/commands" MOCK_FAIL="${failure}" \
      make -s update TAG=v2.0.0 > "${case_dir}/output" 2>&1
  ) || status=$?
  if [[ "${expected_status}" == success && "${status}" -ne 0 ]] ||
     [[ "${expected_status}" == failure && "${status}" -eq 0 ]]; then
    echo "${name}: unexpected make status ${status}" >&2
    sed -n '1,120p' "${case_dir}/output" >&2
    exit 1
  fi
  printf '%s\n' "${case_dir}"
}

success_dir="$(run_case success '' success)"
events=()
event_count=0
while IFS= read -r event; do
  events[event_count]="${event}"
  event_count=$((event_count + 1))
done < "${success_dir}/commands"
[[ "${events[0]}" == 'compose exec -T db pg_dump -U lime lime_db' ]]
[[ "${events[1]}" == 'git fetch --tags --prune' ]]
[[ "${events[2]}" == 'git checkout v2.0.0' ]]
[[ "${events[3]}" == compose\ build\ --pull*LIME_VERSION=2.0.0*LIME_COMMIT=newsha*shopkeeper\ ui ]]
[[ "${events[4]}" == 'compose stop ui shopkeeper' ]]
[[ "${events[5]}" == 'compose run --rm --no-deps shopkeeper ./shopkeeper --verify-startup' ]]
[[ "${events[6]}" == 'compose run --rm --no-deps shopkeeper ./shopkeeper --migrate' ]]
[[ "${events[7]}" == 'compose up -d --no-deps --force-recreate shopkeeper' ]]
[[ "${events[8]}" == 'compose exec -T shopkeeper setpriv --reuid=10001 --regid=10001 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs -- wget --timeout=2 --tries=1 -qO- http://127.0.0.1:8080/api/health' ]]
[[ "${events[9]}" == 'compose up -d --no-deps --force-recreate ui' ]]
[[ "${events[10]}" == compose\ exec\ -T\ ui\ node\ -e* ]]
[[ "${event_count}" -eq 11 ]]
[[ "$(<"${success_dir}/output")" == *'Update to v2.0.0 complete.'* ]]

build_dir="$(run_case build-failure build failure)"
[[ "$(<"${build_dir}/commands")" != *'compose stop'* ]]

migration_dir="$(run_case migration-failure migration failure)"
[[ "$(<"${migration_dir}/commands")" != *'compose up'* ]]

preflight_dir="$(run_case preflight-failure preflight failure)"
[[ "$(<"${preflight_dir}/commands")" != *'--migrate'* ]]
[[ "$(<"${preflight_dir}/commands")" != *'compose up'* ]]

shop_dir="$(run_case shop-health-failure shop-health failure)"
[[ "$(<"${shop_dir}/commands")" != *'compose up -d --no-deps --force-recreate ui'* ]]
[[ "$(<"${shop_dir}/output")" == *'Shopkeeper did not become healthy'* ]]

ui_dir="$(run_case ui-health-failure ui-health failure)"
[[ "$(<"${ui_dir}/output")" == *'UI did not respond successfully'* ]]
[[ "$(<"${ui_dir}/output")" != *'Update to v2.0.0 complete.'* ]]

echo 'Make update mock verification passed.'
