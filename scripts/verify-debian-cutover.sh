#!/usr/bin/env bash
# Exercise service stop/reinstall/restart order without contacting systemd.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/debian-cutover.sh
. "${ROOT_DIR}/scripts/debian-cutover.sh"

test_dir="$(mktemp -d)"
trap 'rm -r -- "${test_dir}"' EXIT

fail() {
  echo "Debian cutover verification failed: $1" >&2
  exit 1
}

mock_active=true
mock_success_after=3
mock_install_failure=false
active_calls=0
node_calls=0
sleep_calls=0
call_log="${test_dir}/calls"

systemctl() {
  case "$*" in
    'stop lime-ui.service'|'stop lime-shopkeeper.service'|\
    'restart lime-shopkeeper.service'|'restart lime-ui.service')
      printf '%s\n' "$*" >> "${call_log}"
      ;;
    'is-active --quiet lime-shopkeeper.service')
      active_calls=$((active_calls + 1))
      printf '%s\n' "$*" >> "${call_log}"
      [[ "${mock_active}" == true ]]
      ;;
    *) fail "unexpected systemctl call" ;;
  esac
}

node() {
  [[ "${1:-}" == -e && "${3:-}" == 'http://127.0.0.1:18080/api/health' ]] ||
    fail "readiness did not probe the custom backend port"
  node_calls=$((node_calls + 1))
  printf 'health probe\n' >> "${call_log}"
  (( node_calls >= mock_success_after ))
}

sleep() {
  [[ "$*" == 2 ]] || fail "unexpected sleep interval"
  sleep_calls=$((sleep_calls + 1))
}

mock_installer() {
  printf 'install\n' >> "${call_log}"
  [[ "${mock_install_failure}" != true ]]
}

mock_success_after=1
install_and_restart_debian_services mock_installer 18080 > "${test_dir}/output" ||
  fail "healthy cutover failed"
expected_calls="$(printf '%s\n' \
  'stop lime-ui.service' \
  'stop lime-shopkeeper.service' \
  'install' \
  'restart lime-shopkeeper.service' \
  'is-active --quiet lime-shopkeeper.service' \
  'health probe' \
  'restart lime-ui.service')"
[[ "$(<"${call_log}")" == "${expected_calls}" ]] || fail "cutover command order was incorrect"

: > "${call_log}"
mock_install_failure=true
if install_and_restart_debian_services mock_installer 18080 > "${test_dir}/output"; then
  fail "failed reinstall was accepted"
fi
expected_calls="$(printf '%s\n' \
  'stop lime-ui.service' \
  'stop lime-shopkeeper.service' \
  'install')"
[[ "$(<"${call_log}")" == "${expected_calls}" ]] ||
  fail "services restarted after reinstall failure"
mock_install_failure=false

: > "${call_log}"
mock_success_after=3
active_calls=0
node_calls=0
sleep_calls=0
wait_for_debian_shopkeeper_health 18080 > "${test_dir}/output" || fail "healthy backend was rejected"
[[ "${active_calls}" -eq 3 && "${node_calls}" -eq 3 && "${sleep_calls}" -eq 2 ]] ||
  fail "healthy backend retry count was incorrect"
grep -q 'healthy after 3 attempts' "${test_dir}/output" || fail "health success was not reported"

mock_success_after=31
active_calls=0
node_calls=0
sleep_calls=0
: > "${call_log}"
if install_and_restart_debian_services mock_installer 18080 > "${test_dir}/output" 2> "${test_dir}/error"; then
  fail "unhealthy backend was accepted"
fi
[[ "${active_calls}" -eq 30 && "${node_calls}" -eq 30 && "${sleep_calls}" -eq 29 ]] ||
  fail "unhealthy backend timeout was incorrect"
grep -q 'UI was not restarted' "${test_dir}/error" || fail "health failure lacked recovery context"
if grep -q 'restart lime-ui.service' "${call_log}"; then
  fail "UI restarted after backend health failure"
fi

mock_active=false
active_calls=0
node_calls=0
sleep_calls=0
if wait_for_debian_shopkeeper_health 18080 > "${test_dir}/output" 2> "${test_dir}/error"; then
  fail "inactive backend was accepted"
fi
[[ "${active_calls}" -eq 30 && "${node_calls}" -eq 0 && "${sleep_calls}" -eq 29 ]] ||
  fail "inactive backend was probed or timed out incorrectly"

echo "Debian cutover verification passed."
