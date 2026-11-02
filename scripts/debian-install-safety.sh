#!/usr/bin/env bash
# Directory and ownership checks shared by the native installer and its fixture.

debian_check_directory_path() {
  local path="$1"
  local remainder component current=""

  if [[ "${path}" != /* || "${path}" == / ]]; then
    echo "Expected a non-root absolute deployment directory: ${path}" >&2
    return 1
  fi

  remainder="${path#/}"
  while [[ -n "${remainder}" ]]; do
    component="${remainder%%/*}"
    if [[ "${component}" == "${remainder}" ]]; then
      remainder=""
    else
      remainder="${remainder#*/}"
    fi

    [[ -z "${component}" ]] && continue
    if [[ "${component}" == . || "${component}" == .. ]]; then
      echo "Deployment directory must not contain . or .. components: ${path}" >&2
      return 1
    fi

    current="${current}/${component}"
    if [[ -L "${current}" ]]; then
      echo "Deployment directory contains a symlink: ${current}" >&2
      return 1
    fi
    if [[ -e "${current}" && ! -d "${current}" ]]; then
      echo "Deployment path component is not a directory: ${current}" >&2
      return 1
    fi
  done

  if [[ -z "${current}" ]]; then
    echo "Expected a non-root absolute deployment directory: ${path}" >&2
    return 1
  fi
  DEBIAN_CHECKED_PATH="${current}"
  return 0
}

debian_directory_owner_mode() {
  stat -c '%u %a' -- "$1"
}

debian_require_trusted_directory_path() {
  local path="$1"
  local remainder component current="" owner_mode owner mode

  debian_check_directory_path "${path}" || return
  remainder="${DEBIAN_CHECKED_PATH#/}"
  while [[ -n "${remainder}" ]]; do
    component="${remainder%%/*}"
    if [[ "${component}" == "${remainder}" ]]; then
      remainder=""
    else
      remainder="${remainder#*/}"
    fi
    current="${current}/${component}"
    [[ -d "${current}" ]] || continue

    owner_mode="$(debian_directory_owner_mode "${current}")" || return
    read -r owner mode <<< "${owner_mode}"
    if [[ "${owner}" != 0 || ! "${mode}" =~ ^[0-7]{3,4}$ ]] ||
       (( (8#${mode} & 0022) != 0 )); then
      echo "Deployment path has a non-root-owned or group/world-writable component: ${current}" >&2
      return 1
    fi
  done
  return 0
}

debian_require_services_stopped() {
  local service state
  for service in lime-shopkeeper.service lime-ui.service; do
    if ! state="$(systemctl show --property=ActiveState --value "${service}")"; then
      echo "Cannot verify whether ${service} is stopped; check the systemd connection before installing." >&2
      return 1
    fi
    case "${state}" in
      inactive|failed) ;;
      *)
        echo "Stop ${service} before running the native installer; the updater stops both services for you." >&2
        return 1
        ;;
    esac
  done
  return 0
}

debian_preflight_install_paths() {
  local install_root="$1" config_root="$2" systemd_dir="$3"
  local directory

  debian_check_directory_path "${install_root}" || return
  install_root="${DEBIAN_CHECKED_PATH}"
  debian_require_trusted_directory_path "${install_root}" || return
  debian_check_directory_path "${config_root}" || return
  config_root="${DEBIAN_CHECKED_PATH}"
  debian_require_trusted_directory_path "${config_root}" || return
  debian_check_directory_path "${systemd_dir}" || return
  systemd_dir="${DEBIAN_CHECKED_PATH}"
  debian_require_trusted_directory_path "${systemd_dir}" || return

  for directory in \
    "${install_root}/shopkeeper" \
    "${install_root}/shopkeeper/screenshots" \
    "${install_root}/shopkeeper/data" \
    "${install_root}/ui" \
    "${install_root}/ui/data"; do
    debian_check_directory_path "${directory}" || return
  done
  DEBIAN_INSTALL_ROOT_PATH="${install_root}"
  DEBIAN_CONFIG_ROOT_PATH="${config_root}"
  DEBIAN_SYSTEMD_DIR_PATH="${systemd_dir}"
}

debian_preflight_install() {
  debian_preflight_install_paths "$1" "$2" "$3" || return
  debian_require_services_stopped
}

debian_install_directory() {
  local owner="$1" group="$2" mode="$3" path="$4"
  debian_check_directory_path "${path}" || return
  install -d -o "${owner}" -g "${group}" -m "${mode}" "${path}"
}

debian_copy_tree() {
  local source_dir="$1"
  local target_dir="$2"
  shift 2
  local preserve_screenshots=false

  debian_check_directory_path "${target_dir}" || return
  if [[ " $* " == *" --exclude screenshots "* ]]; then
    preserve_screenshots=true
  fi

  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$@" "${source_dir}/" "${target_dir}/"
    return
  fi

  if [[ "${preserve_screenshots}" == "true" ]]; then
    find "${target_dir}" -mindepth 1 -maxdepth 1 ! -name screenshots -exec rm -rf {} +
  else
    find "${target_dir}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  fi
  cp -a "${source_dir}/." "${target_dir}/"
}

debian_secure_shopkeeper_code() {
  local shopkeeper_dir="$1"
  local screenshot_dir="${shopkeeper_dir}/screenshots"

  debian_check_directory_path "${shopkeeper_dir}" || return
  debian_check_directory_path "${screenshot_dir}" || return
  # Captures may contain arbitrary service-created entries. Do not traverse or
  # change any of them while transferring only application code to root.
  find -P "${shopkeeper_dir}" -path "${screenshot_dir}" -prune -o \
    ! -type l -exec chmod go-w -- {} +
  find -P "${shopkeeper_dir}" -path "${screenshot_dir}" -prune -o \
    -exec chown -h root:root -- {} +

  # These shipped files are read by the non-root service even when the build
  # checkout used umask 077. Keep configuration secrets and captures separate.
  chmod 0755 "${shopkeeper_dir}/shopkeeper"
  local readable_dir
  for readable_dir in "${shopkeeper_dir}/migrations" "${shopkeeper_dir}/data"; do
    [[ -d "${readable_dir}" && ! -L "${readable_dir}" ]] || continue
    find -P "${readable_dir}" -type d -exec chown "root:${LIME_USER:-lime}" -- {} + \
      -exec chmod 0750 -- {} +
    find -P "${readable_dir}" -type f \( -name '*.json' -o -name '*.sql' \) \
      -exec chown "root:${LIME_USER:-lime}" -- {} + -exec chmod 0640 -- {} +
  done
}
