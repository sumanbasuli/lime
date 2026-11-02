#!/usr/bin/env bash
# Exercise the release update order with a mocked Compose CLI and disposable files.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -r -- "${test_dir}"' EXIT
export LIME_DOCKER_TEST_DIR="${test_dir}"
export LIME_BACKUP_DIR="${test_dir}/backups"
export ENV_FILE="${test_dir}/release.env"
export COMPOSE_FILE="${test_dir}/docker-compose.yml"
printf 'LIME_IMAGE_TAG=v1.9.0\nPOSTGRES_USER=lime\nPOSTGRES_DB=lime_db\n' > "${ENV_FILE}"
printf 'services: {}\n' > "${COMPOSE_FILE}"

docker() {
  [[ "${1:-}" == compose ]] || { printf 'unexpected Docker call\n' >&2; return 2; }
  shift
  if [[ "${1:-}" == version ]]; then
    return 0
  fi
  [[ "${1:-}" == --env-file && "${3:-}" == -f ]] || {
    printf 'unexpected Compose options\n' >&2
    return 2
  }
  shift 4
  printf '%s\n' "$*" >> "${LIME_DOCKER_TEST_DIR}/calls"
  case "$*" in
    'ps --services') printf 'db\n' ;;
    'exec -T db pg_dump -U lime lime_db') printf 'fixture database dump\n' ;;
    'exec -T shopkeeper setpriv --reuid=10001 --regid=10001 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs -- wget -qO- http://127.0.0.1:8080/api/health') ;;
    'run --rm --no-deps shopkeeper ./shopkeeper --verify-startup')
      if [[ "${LIME_DOCKER_TEST_FAIL_PREFLIGHT:-0}" == 1 ]]; then return 46; fi
      ;;
    'run --rm --no-deps shopkeeper ./shopkeeper --migrate')
      if [[ "${LIME_DOCKER_TEST_FAIL_MIGRATION:-0}" == 1 ]]; then return 47; fi
      ;;
    'pull shopkeeper ui'|'stop ui shopkeeper'|'up -d --no-deps shopkeeper'|'up -d --no-deps ui') ;;
    *) printf 'unexpected Compose call: %s\n' "$*" >&2; return 2 ;;
  esac
}
export -f docker

bash "${ROOT_DIR}/scripts/docker-update.sh" v2.0.0 > "${test_dir}/stdout" 2> "${test_dir}/stderr" || {
  printf 'release update fixture failed\n' >&2
  sed -n '1,100p' "${test_dir}/stderr" >&2
  exit 1
}
expected_calls="$(printf '%s\n' \
  'ps --services' \
  'exec -T db pg_dump -U lime lime_db' \
  'pull shopkeeper ui' \
  'stop ui shopkeeper' \
  'run --rm --no-deps shopkeeper ./shopkeeper --verify-startup' \
  'run --rm --no-deps shopkeeper ./shopkeeper --migrate' \
  'up -d --no-deps shopkeeper' \
  'exec -T shopkeeper setpriv --reuid=10001 --regid=10001 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs -- wget -qO- http://127.0.0.1:8080/api/health' \
  'up -d --no-deps ui')"
[[ "$(<"${test_dir}/calls")" == "${expected_calls}" ]] || {
  printf 'release update used an unsafe Compose order\n' >&2
  sed -n '1,100p' "${test_dir}/calls" >&2
  exit 1
}
[[ "$(<"${ENV_FILE}")" == *'LIME_IMAGE_TAG=v2.0.0'* ]]
[[ -s "${test_dir}/backups/lime-pre-v2.0.0-"*'.sql.gz' ]]
grep -Fq 'Recovery requires a schema-compatible release' "${test_dir}/stdout"
if grep -Fq 'Rollback with:' "${test_dir}/stdout"; then
  printf 'update advertised an unsafe tag-only rollback\n' >&2
  exit 1
fi

: > "${test_dir}/calls"
if LIME_DOCKER_TEST_FAIL_MIGRATION=1 bash "${ROOT_DIR}/scripts/docker-update.sh" v2.0.1 > "${test_dir}/stdout" 2> "${test_dir}/stderr"; then
  printf 'migration failure did not stop the update\n' >&2
  exit 1
fi
expected_failure_calls="$(printf '%s\n' \
  'ps --services' \
  'exec -T db pg_dump -U lime lime_db' \
  'pull shopkeeper ui' \
  'stop ui shopkeeper' \
  'run --rm --no-deps shopkeeper ./shopkeeper --verify-startup' \
  'run --rm --no-deps shopkeeper ./shopkeeper --migrate')"
[[ "$(<"${test_dir}/calls")" == "${expected_failure_calls}" ]] || {
  printf 'migration failure restarted the app or skipped the stop\n' >&2
  sed -n '1,100p' "${test_dir}/calls" >&2
  exit 1
}
: > "${test_dir}/calls"
if LIME_DOCKER_TEST_FAIL_PREFLIGHT=1 bash "${ROOT_DIR}/scripts/docker-update.sh" v2.0.2 > "${test_dir}/stdout" 2> "${test_dir}/stderr"; then
  printf 'browser preflight failure did not stop the update\n' >&2
  exit 1
fi
if grep -Eq -- '--migrate|up -d' "${test_dir}/calls"; then
  printf 'browser preflight failure applied migrations or restarted services\n' >&2
  exit 1
fi
printf 'Docker update cutover verification passed.\n'
