#!/usr/bin/env bash
# Exercise native installer path and ownership rules without root or systemd.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/debian-install-safety.sh
. "${ROOT_DIR}/scripts/debian-install-safety.sh"

test_dir="$(mktemp -d)"
test_dir="$(cd "${test_dir}" && pwd -P)"
trap 'rm -r -- "${test_dir}"' EXIT

fail() {
  echo "Debian installer verification failed: $1" >&2
  exit 1
}

install_log="${test_dir}/install-calls"
install() {
  printf '%s\n' "$*" >> "${install_log}"
  mkdir -p -- "${@: -1}"
}

active_service=""
systemctl_error=false
systemctl() {
  [[ "$1" == show && "$2" == --property=ActiveState && "$3" == --value ]] || fail "unexpected systemctl call"
  if [[ "${systemctl_error}" == true ]]; then
    return 1
  fi
  if [[ "$4" == "${active_service}" ]]; then
    printf 'active\n'
  else
    printf 'inactive\n'
  fi
}

fixture="${test_dir}/fixture"
outside="${test_dir}/outside"
mkdir -p "${fixture}/shopkeeper" "${outside}"
printf 'outside data\n' > "${outside}/sentinel"

ln -s "${outside}" "${fixture}/shopkeeper/screenshots"
if debian_install_directory lime lime 0700 "${fixture}/shopkeeper/screenshots" 2> "${test_dir}/error"; then
  fail "screenshots symlink was accepted"
fi
grep -q 'contains a symlink' "${test_dir}/error" || fail "symlink rejection lacked a diagnostic"
[[ ! -e "${install_log}" && "$(<"${outside}/sentinel")" == 'outside data' ]] ||
  fail "root directory operation reached a symlink target"

unlink "${fixture}/shopkeeper/screenshots"
ln -s "${test_dir}/missing" "${fixture}/shopkeeper/screenshots"
if debian_install_directory lime lime 0700 "${fixture}/shopkeeper/screenshots" 2> "${test_dir}/error"; then
  fail "dangling screenshots symlink was accepted"
fi
[[ ! -e "${install_log}" ]] || fail "install ran for a dangling symlink"
unlink "${fixture}/shopkeeper/screenshots"

ln -s "${outside}" "${fixture}/parent-link"
if debian_check_directory_path "${fixture}/parent-link/child" 2> "${test_dir}/error"; then
  fail "ancestor symlink was accepted"
fi
printf 'file\n' > "${fixture}/not-a-directory"
if debian_check_directory_path "${fixture}/not-a-directory/child" 2> "${test_dir}/error"; then
  fail "regular-file path component was accepted"
fi
if debian_check_directory_path '////' 2> "${test_dir}/error"; then
  fail "alternate spelling of filesystem root was accepted"
fi
debian_check_directory_path "${fixture}/missing/child" || fail "new directory path was rejected"
[[ ! -e "${fixture}/missing" ]] || fail "preflight created a directory"

debian_directory_owner_mode() {
  case "$1" in
    "${fixture}/service-owned") printf '999 755\n' ;;
    "${fixture}/other-owned") printf '1000 755\n' ;;
    "${fixture}/group-writable") printf '0 775\n' ;;
    *) printf '0 755\n' ;;
  esac
}
mkdir -p "${fixture}/service-owned" "${fixture}/other-owned" "${fixture}/group-writable"
if debian_require_trusted_directory_path "${fixture}/service-owned" 2> "${test_dir}/error"; then
  fail "service-owned install root was accepted"
fi
if debian_require_trusted_directory_path "${fixture}/other-owned" 2> "${test_dir}/error"; then
  fail "other non-root-owned install root was accepted"
fi
if debian_require_trusted_directory_path "${fixture}/group-writable" 2> "${test_dir}/error"; then
  fail "group-writable install root was accepted"
fi
debian_require_trusted_directory_path "${fixture}/shopkeeper" ||
  fail "root-controlled install root was rejected"
if debian_preflight_install "${fixture}" "${fixture}/group-writable" "${test_dir}/systemd" 2> "${test_dir}/error"; then
  fail "group-writable config root was accepted"
fi

ln -s "${outside}" "${fixture}/shopkeeper/screenshots"
if debian_preflight_install "${fixture}" "${test_dir}/config" "${test_dir}/systemd" 2> "${test_dir}/error"; then
  fail "installer preflight accepted screenshots symlink"
fi
[[ ! -e "${install_log}" ]] || fail "installer preflight performed a directory operation"
unlink "${fixture}/shopkeeper/screenshots"

for active_service in lime-shopkeeper.service lime-ui.service; do
  debian_preflight_install_paths "${fixture}" "${test_dir}/config" "${test_dir}/systemd" ||
    fail "path preflight failed while services were active"
  if debian_preflight_install "${fixture}" "${test_dir}/config" "${test_dir}/systemd" 2> "${test_dir}/error"; then
    fail "active ${active_service} was accepted"
  fi
  grep -q 'Stop ' "${test_dir}/error" || fail "active-service rejection lacked a diagnostic"
done
active_service=""
systemctl_error=true
if debian_preflight_install "${fixture}" "${test_dir}/config" "${test_dir}/systemd" 2> "${test_dir}/error"; then
  fail "unreachable systemd bus was accepted"
fi
grep -q 'Cannot verify' "${test_dir}/error" || fail "systemd transport error lacked a diagnostic"
systemctl_error=false
debian_preflight_install "${fixture}" "${test_dir}/config" "${test_dir}/systemd" ||
  fail "stopped services and real paths were rejected"
[[ "${DEBIAN_INSTALL_ROOT_PATH}" == "${fixture}" ]] || fail "preflight changed install root"

source_dir="${test_dir}/source"
target_dir="${test_dir}/target"
mkdir -p "${source_dir}" "${target_dir}/screenshots/scan-id"
printf 'new binary\n' > "${source_dir}/shopkeeper"
printf 'old binary\n' > "${target_dir}/old-shopkeeper"
printf 'saved capture\n' > "${target_dir}/screenshots/scan-id/page.png"
debian_copy_tree "${source_dir}" "${target_dir}" --exclude screenshots
[[ "$(<"${target_dir}/shopkeeper")" == 'new binary' && ! -e "${target_dir}/old-shopkeeper" ]] ||
  fail "code replacement did not complete"
[[ "$(<"${target_dir}/screenshots/scan-id/page.png")" == 'saved capture' ]] ||
  fail "existing screenshot was changed"

ln -s "${outside}" "${target_dir}/data"
if debian_copy_tree "${source_dir}" "${target_dir}/data" 2> "${test_dir}/error"; then
  fail "data symlink was accepted as a copy target"
fi
[[ "$(<"${outside}/sentinel")" == 'outside data' ]] || fail "copy changed outside data"
unlink "${target_dir}/data"

debian_install_directory root root 0755 "${target_dir}"
debian_install_directory lime lime 0700 "${target_dir}/screenshots"
grep -Fq -- "-d -o root -g root -m 0755 ${target_dir}" "${install_log}" ||
  fail "code parent was not installed as root-owned"
grep -Fq -- "-d -o lime -g lime -m 0700 ${target_dir}/screenshots" "${install_log}" ||
  fail "screenshot directory did not retain service ownership"

mock_bin="${test_dir}/mock-bin"
mkdir -p "${mock_bin}"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$@" >> "$DEBIAN_TEST_CHOWN_LOG"' > "${mock_bin}/chown"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$@" >> "$DEBIAN_TEST_CHMOD_LOG"' > "${mock_bin}/chmod"
chmod +x "${mock_bin}/chown" "${mock_bin}/chmod"
export DEBIAN_TEST_CHOWN_LOG="${test_dir}/chown-calls"
export DEBIAN_TEST_CHMOD_LOG="${test_dir}/chmod-calls"
PATH="${mock_bin}:${PATH}" debian_secure_shopkeeper_code "${target_dir}"
grep -Fq "${target_dir}/shopkeeper" "${DEBIAN_TEST_CHOWN_LOG}" ||
  fail "Shopkeeper code was not assigned to root"
grep -Fq 'root:root' "${DEBIAN_TEST_CHOWN_LOG}" || fail "code ownership was not root:root"
if grep -Fq "${target_dir}/screenshots" "${DEBIAN_TEST_CHOWN_LOG}" "${DEBIAN_TEST_CHMOD_LOG}"; then
  fail "saved screenshots were traversed during code ownership change"
fi
[[ "$(<"${target_dir}/screenshots/scan-id/page.png")" == 'saved capture' ]] ||
  fail "ownership pass changed a saved capture"

echo "Debian installer verification passed."
