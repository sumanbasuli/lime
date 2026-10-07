#!/usr/bin/env bash
set -euo pipefail

if [[ "${0##*/}" == flyctl ]]; then
  printf '%s\0' "$@" >> "${LIME_FLY_TEST_DIR}/argv.bin"
  printf '%s\n' "$*" >> "${LIME_FLY_TEST_DIR}/calls"

  case "${1:-} ${2:-}" in
    'auth whoami') ;;
    'apps list')
      printf '{"Name":"%s"}\n{"Name":"%s"}\n' "${LIME_FLY_TEST_SHOP}" "${LIME_FLY_TEST_UI}"
      ;;
    'volumes list') printf '{"Name":"lime_screenshots"}\n' ;;
    'secrets list') printf '{"Name":"DATABASE_URL"}\n' ;;
    'secrets import')
      app=''
      args=("$@")
      for ((i = 0; i < ${#args[@]}; i++)); do
        if [[ "${args[i]}" == --app ]]; then app="${args[i+1]}"; fi
      done
      [[ -n "${app}" ]] || exit 2
      IFS= read -r secret || exit 3
      if IFS= read -r extra || [[ -n "${extra}" ]]; then exit 4; fi
      printf '%s\t%s\n' "${app}" "${secret}" >> "${LIME_FLY_TEST_DIR}/imports"
      ;;
    'secrets set'|'deploy --app') ;;
    *) printf 'unexpected flyctl call: %s\n' "$1 $2" >&2; exit 5 ;;
  esac
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="${ROOT_DIR}/scripts/verify-fly-deploy.sh"
test_dir="$(mktemp -d)"
trap 'rm -r -- "${test_dir}"' EXIT
ln -s "${SCRIPT_PATH}" "${test_dir}/flyctl"
export PATH="${test_dir}:${PATH}"
export LIME_FLY_TEST_DIR="${test_dir}"
export LIME_FLY_TEST_SHOP='lime-test-shop'
export LIME_FLY_TEST_UI='lime-test-ui'

fail() {
  printf 'Fly deploy verification failed: %s\n' "$1" >&2
  if [[ -s "${test_dir}/stderr" ]]; then
    sed -E 's#postgresql://[^[:space:]]+#<redacted database URL>#g' "${test_dir}/stderr" >&2
  fi
  if [[ "${LIME_FLY_TEST_DEBUG:-}" == 1 ]]; then
    sed -E 's#postgresql://[^[:space:]]+#<redacted database URL>#g' "${test_dir}/calls" >&2
  fi
  exit 1
}

clear_calls() {
  : > "${test_dir}/argv.bin"
  : > "${test_dir}/calls"
  : > "${test_dir}/imports"
}

run_deploy() {
  bash "${ROOT_DIR}/scripts/fly-deploy.sh" v2.0.0 \
    "${LIME_FLY_TEST_SHOP}" "${LIME_FLY_TEST_UI}" iad \
    > "${test_dir}/stdout" 2> "${test_dir}/stderr"
}

clear_calls
database_url='postgresql://lime:secret-fly-test-marker@db.example/lime?sslmode=require&application_name=lime'
DATABASE_URL="${database_url}" run_deploy || fail 'deploy with a supplied database URL failed'
if grep -aFq 'secret-fly-test-marker' "${test_dir}/argv.bin"; then
  fail 'database credentials appeared in flyctl arguments'
fi
if grep -Fq 'secret-fly-test-marker' "${test_dir}/stdout" "${test_dir}/stderr"; then
  fail 'database credentials appeared in script output'
fi
[[ "$(wc -l < "${test_dir}/imports")" -eq 2 ]] || fail 'database URL was not imported exactly twice'
grep -Fqx -- "${LIME_FLY_TEST_SHOP}"$'\t'"DATABASE_URL=${database_url}" "${test_dir}/imports" || fail 'Shopkeeper did not receive the exact database URL on stdin'
grep -Fqx -- "${LIME_FLY_TEST_UI}"$'\t'"DATABASE_URL=${database_url}" "${test_dir}/imports" || fail 'UI did not receive the exact database URL on stdin'
grep -Fq "secrets set --app ${LIME_FLY_TEST_UI} --stage SHOPKEEPER_URL=http://${LIME_FLY_TEST_SHOP}.internal:8080 LIME_UPDATE_CHECK=true" "${test_dir}/calls" || fail 'ordinary UI secrets changed'
grep -Fq "deploy --app ${LIME_FLY_TEST_SHOP}" "${test_dir}/calls" || fail 'Shopkeeper was not deployed'
grep -Fq "deploy --app ${LIME_FLY_TEST_UI}" "${test_dir}/calls" || fail 'UI was not deployed'

clear_calls
unset DATABASE_URL
LIME_UPDATE_CHECK=false run_deploy || fail 'deploy with existing Fly database secrets failed'
[[ ! -s "${test_dir}/imports" ]] || fail 'existing Fly database secrets were overwritten'
grep -Fq "secrets list --app ${LIME_FLY_TEST_SHOP} --json" "${test_dir}/calls" || fail 'Shopkeeper existing secret was not checked'
grep -Fq "secrets list --app ${LIME_FLY_TEST_UI} --json" "${test_dir}/calls" || fail 'UI existing secret was not checked'
grep -Fq "secrets set --app ${LIME_FLY_TEST_UI} --stage SHOPKEEPER_URL=http://${LIME_FLY_TEST_SHOP}.internal:8080 LIME_UPDATE_CHECK=false" "${test_dir}/calls" || fail 'ordinary UI secrets changed without a local database URL'

for unsafe_url in $'postgresql://db/lime\nANOTHER_SECRET=value' $'postgresql://db/lime\rANOTHER_SECRET=value'; do
  clear_calls
  if DATABASE_URL="${unsafe_url}" run_deploy; then
    fail 'a multiline database URL was accepted'
  fi
  [[ ! -s "${test_dir}/calls" ]] || fail 'a multiline database URL triggered Fly calls'
  [[ ! -s "${test_dir}/imports" ]] || fail 'a multiline database URL reached Fly secret import'
  if grep -Fq 'ANOTHER_SECRET' "${test_dir}/stdout" "${test_dir}/stderr"; then
    fail 'a multiline database URL appeared in script output'
  fi
done

printf 'Fly deploy verification passed.\n'
