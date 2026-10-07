#!/usr/bin/env bash
# Shared guard for local database dump destinations on macOS and Linux.

ensure_private_backup_dir() {
  local backup_dir="$1"
  local resolved_dir mode listing permissions

  umask 077
  mkdir -p -- "${backup_dir}"
  resolved_dir="$(cd -- "${backup_dir}" && pwd -P)" || return 1

  if [[ ! -O "${resolved_dir}" ]]; then
    echo "Backup directory must be owned by the account running the update: ${resolved_dir}" >&2
    return 1
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    mode="$(stat -f %Lp "${resolved_dir}")" || return 1
  else
    mode="$(stat -c %a "${resolved_dir}")" || return 1
  fi
  if [[ ! "${mode}" =~ ^[0-7]+$ ]] || (( (8#${mode} & 8#022) != 0 )); then
    echo "Backup directory must not be group- or world-writable: ${resolved_dir}" >&2
    return 1
  fi

  # Default/inherited ACLs can grant access to new files despite umask 077.
  # macOS may display @ rather than + when a directory has both xattrs and an
  # ACL, so inspect its ACL entries explicitly instead of trusting the marker.
  if [[ "$(uname -s)" == "Darwin" ]]; then
    listing="$(LC_ALL=C ls -lde "${resolved_dir}")" || return 1
    if [[ "${listing}" =~ $'\n'[[:space:]]*[0-9]+: ]]; then
      echo "Backup directory has ACLs; choose an ACL-free private directory: ${resolved_dir}" >&2
      return 1
    fi
  else
    listing="$(LC_ALL=C ls -ld "${resolved_dir}")" || return 1
    permissions="${listing%% *}"
    if [[ "${permissions}" == *+* || "${permissions}" == *\? ]]; then
      echo "Backup directory has ACLs or unknown access metadata: ${resolved_dir}" >&2
      return 1
    fi
  fi

  # Callers use the physical path, not a symlink that could be replaced later.
  LIME_PRIVATE_BACKUP_DIR="${resolved_dir}"
}
