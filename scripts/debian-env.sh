#!/usr/bin/env bash
# Read the database connection string from a systemd EnvironmentFile as data.
# This is intentionally not a general shell or EnvironmentFile evaluator.

read_debian_database_url() {
  local env_file="$1"
  local line value database_url="" found=false

  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "${line}" in
      DATABASE_URL=*)
        value="${line#DATABASE_URL=}"
        value="${value#"${value%%[![:space:]]*}"}"
        value="${value%"${value##*[![:space:]]}"}"
        case "${value}" in
          \"*\"|\'*\')
            value="${value:1:${#value}-2}"
            ;;
          \"*|\'*)
            echo "Unsupported DATABASE_URL quoting in ${env_file}; use a single-line value." >&2
            return 1
            ;;
        esac
        if [[ "${value}" == *\\* ]]; then
          echo "Unsupported DATABASE_URL escaping in ${env_file}; URL-encode special characters." >&2
          return 1
        fi
        database_url="${value}"
        found=true
        ;;
    esac
  done < "${env_file}"

  if [[ "${found}" != true || -z "${database_url}" ]]; then
    echo "DATABASE_URL is not set in ${env_file}; cannot back up before update." >&2
    return 1
  fi

  printf '%s' "${database_url}"
}

# Read the backend port without evaluating the EnvironmentFile as shell code.
read_debian_shopkeeper_port() {
  local env_file="$1"
  local line value port=8080

  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "${line}" in
      SHOPKEEPER_PORT=*)
        value="${line#SHOPKEEPER_PORT=}"
        value="${value#"${value%%[![:space:]]*}"}"
        value="${value%"${value##*[![:space:]]}"}"
        case "${value}" in
          \"*\"|\'*\') value="${value:1:${#value}-2}" ;;
        esac
        if [[ ! "${value}" =~ ^[0-9]{1,5}$ ]] ||
           (( 10#${value} < 1 || 10#${value} > 65535 )); then
          echo "Invalid SHOPKEEPER_PORT in ${env_file}; expected a TCP port from 1 to 65535." >&2
          return 1
        fi
        port="${value}"
        ;;
    esac
  done < "${env_file}"

  printf '%s' "${port}"
}
