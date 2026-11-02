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

# Decode URL credentials without invoking another process with the secret in
# its arguments. PostgreSQL URI query values use percent encoding, not form
# encoding, so a literal '+' remains a plus.
decode_backup_uri_component() {
  local input="$1" output="" char hex decoded i
  for ((i = 0; i < ${#input}; i++)); do
    char="${input:i:1}"
    if [[ "${char}" == "%" ]]; then
      hex="${input:i+1:2}"
      [[ "${hex}" =~ ^[[:xdigit:]]{2}$ ]] || return 1
      [[ "${hex}" != "00" ]] || return 1
      printf -v decoded '%b' "\\x${hex}"
      output+="${decoded}"
      ((i += 2))
    else
      output+="${char}"
    fi
  done
  printf '%s' "${output}"
}

# Keep the original connection options while taking the database password out
# of pg_dump's argv. libpq reads it from a short-lived, mode-0600 passfile.
dump_external_database() {
  local database_url="$1"
  local backup_file="$2"
  local scheme rest authority suffix userinfo hostpart clean_authority sanitized_url
  local password="" password_found=0 query_head query_tail query
  local segment key value decoded_key kept="" remaining passfile passfile_dir escaped_password i
  local -a kept_segments=() kept_keys=()

  case "${database_url}" in
    postgresql://*|postgres://*) ;;
    *) echo "External backup requires a PostgreSQL connection URI." >&2; return 1 ;;
  esac
  [[ "${database_url}" != *$'\n'* && "${database_url}" != *$'\r'* && "${database_url}" != *'#'* ]] || {
    echo "External backup URI contains an unsupported control or fragment." >&2
    return 1
  }
  scheme="${database_url%%://*}"
  rest="${database_url#*://}"
  authority="${rest%%/*}"
  authority="${authority%%\?*}"
  suffix="${rest#"${authority}"}"
  clean_authority="${authority}"
  if [[ "${authority}" == *@* ]]; then
    userinfo="${authority%@*}"
    hostpart="${authority##*@}"
    if [[ "${userinfo}" == *:* ]]; then
      [[ "${userinfo#*:}" != *%0[aAdD]* ]] || {
        echo "External backup URI has an unsupported password character." >&2
        return 1
      }
      password="$(decode_backup_uri_component "${userinfo#*:}")" || {
        echo "External backup URI has invalid password encoding." >&2
        return 1
      }
      [[ "${password}" != *$'\n'* && "${password}" != *$'\r'* ]] || {
        echo "External backup URI has an unsupported password character." >&2
        return 1
      }
      password_found=1
      clean_authority="${userinfo%%:*}@${hostpart}"
    fi
  fi
  sanitized_url="${scheme}://${clean_authority}${suffix}"

  if [[ "${sanitized_url}" == *\?* ]]; then
    query_head="${sanitized_url%%\?*}"
    query_tail="${sanitized_url#*\?}"
    query="${query_tail}"
    remaining="${query}"
    while :; do
      if [[ "${remaining}" == *'&'* ]]; then
        segment="${remaining%%&*}"
        remaining="${remaining#*&}"
      else
        segment="${remaining}"
        remaining=""
      fi
      key="${segment%%=*}"
      decoded_key="$(decode_backup_uri_component "${key}")" || {
        echo "External backup URI has invalid query encoding." >&2
        return 1
      }
      decoded_key="$(printf '%s' "${decoded_key}" | tr '[:upper:]' '[:lower:]')"
      case "${decoded_key}" in
        password)
          [[ "${segment}" == *=* && "${password_found}" == 0 ]] || {
            echo "External backup URI has ambiguous password parameters." >&2
            return 1
          }
          value="${segment#*=}"
          [[ "${value}" != *%0[aAdD]* ]] || {
            echo "External backup URI has an unsupported password character." >&2
            return 1
          }
          password="$(decode_backup_uri_component "${value}")" || {
            echo "External backup URI has invalid password encoding." >&2
            return 1
          }
          [[ "${password}" != *$'\n'* && "${password}" != *$'\r'* ]] || {
            echo "External backup URI has an unsupported password character." >&2
            return 1
          }
          password_found=1
          ;;
        sslpassword)
          echo "External backup cannot safely pass sslpassword in a URI; use a manual backup." >&2
          return 1
          ;;
        *)
          kept_segments+=("${segment}")
          kept_keys+=("${decoded_key}")
          ;;
      esac
      [[ -n "${remaining}" ]] || break
    done
    for ((i = 0; i < ${#kept_segments[@]}; i++)); do
      if [[ "${password_found}" == 1 && -n "${password}" ]]; then
        case "${kept_keys[i]}" in
          passfile) continue ;;
          service)
            echo "External backup URI combines a password with a service; use a manual backup." >&2
            return 1
            ;;
        esac
      fi
      if [[ -z "${kept}" ]]; then kept="${kept_segments[i]}"; else kept+="&${kept_segments[i]}"; fi
    done
    sanitized_url="${query_head}"
    [[ -z "${kept}" ]] || sanitized_url+="?${kept}"
  fi
  if [[ "${password_found}" == 1 && -n "${password}" && -n "${PGSERVICE:-}" ]]; then
    echo "External backup URI combines a password with PGSERVICE; use a manual backup." >&2
    return 1
  fi

  (
    set -C
    unset DATABASE_URL
    if [[ "${password_found}" == 1 && -n "${password}" ]]; then
      # A custom TMPDIR can have inherited ACLs or weaker parent permissions.
      # Keep the credential file beside the dump in a validated private dir.
      ensure_private_backup_dir "$(dirname -- "${backup_file}")" || return 1
      passfile_dir="${LIME_PRIVATE_BACKUP_DIR}"
      passfile="$(mktemp "${passfile_dir}/.lime-pgpass.XXXXXXXX")" || return 1
      trap 'rm -f -- "${passfile}"' EXIT
      chmod 0600 "${passfile}" || return 1
      escaped_password="${password//\\/\\\\}"
      escaped_password="${escaped_password//:/\\:}"
      printf '*:*:*:*:%s\n' "${escaped_password}" >| "${passfile}"
      unset PGPASSWORD
      PGPASSFILE="${passfile}" pg_dump --dbname="${sanitized_url}" | gzip -9 > "${backup_file}"
    else
      pg_dump --dbname="${sanitized_url}" | gzip -9 > "${backup_file}"
    fi
  )
}
