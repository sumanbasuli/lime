#!/usr/bin/env bash
# Create a fresh source-Docker .env without changing an existing installation.
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
template="${root_dir}/.env.example"
env_file="${root_dir}/.env"

if [[ -e "${env_file}" || -L "${env_file}" ]]; then
  printf '%s\n' 'An existing .env was preserved. This command is only for a new checkout.' >&2
  exit 1
fi
[[ -f "${template}" && ! -L "${template}" ]] || { printf '%s\n' 'Missing or linked .env.example.' >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { printf '%s\n' 'OpenSSL is required to create a database password.' >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { printf '%s\n' 'Docker is required to check for an existing database volume.' >&2; exit 1; }
case "${DOCKER_COMPOSE:-docker compose}" in
  'docker compose'|'docker-compose') ;;
  *)
    printf '%s\n' 'init-env supports the standard docker compose or docker-compose command only. Put project selection in COMPOSE_PROJECT_NAME and use the same Docker context for initialization and startup.' >&2
    exit 1
    ;;
esac
if [[ -n "${COMPOSE_FILE:-}" && "${COMPOSE_FILE}" != docker-compose.yml ]]; then
  printf '%s\n' 'A custom COMPOSE_FILE cannot be verified by init-env. Use the source Compose file for initialization.' >&2
  exit 1
fi
docker info >/dev/null 2>&1 || { printf '%s\n' 'Start Docker before initializing .env; existing database volumes must be checked first.' >&2; exit 1; }
project="${COMPOSE_PROJECT_NAME:-$(basename "${root_dir}" | tr '[:upper:]' '[:lower:]')}"
[[ "${project}" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || {
  printf '%s\n' 'Set a valid COMPOSE_PROJECT_NAME before initializing this checkout.' >&2
  exit 1
}
if docker container inspect lime-db >/dev/null 2>&1; then
  printf '%s\n' 'An existing lime-db container was found. Restore its original .env instead of generating new credentials.' >&2
  exit 1
fi
if docker volume inspect "${project}_pgdata" >/dev/null 2>&1; then
  printf '%s\n' 'An existing PostgreSQL volume was found for this Compose project. Restore its original .env instead of generating new credentials.' >&2
  exit 1
fi
volumes="$(docker volume ls --filter 'label=com.docker.compose.volume=pgdata' --format '{{.Name}}')" || {
  printf '%s\n' 'Could not check existing database volumes; no .env was created.' >&2
  exit 1
}
if [[ -n "${volumes}" && "${LIME_INIT_ENV_ALLOW_OTHER_PGDATA:-}" != true ]]; then
  printf '%s\n' 'A Compose pgdata volume exists on this Docker host. Confirm your original project and volume before continuing. If every listed volume is unrelated, rerun with LIME_INIT_ENV_ALLOW_OTHER_PGDATA=true.' >&2
  exit 1
fi
grep -qx 'POSTGRES_USER=lime' "${template}" && grep -qx 'POSTGRES_DB=lime_db' "${template}" || {
  printf '%s\n' 'Unexpected database settings in .env.example; review the template before initializing.' >&2
  exit 1
}

password="$(openssl rand -hex 24)"
[[ "${password}" =~ ^[0-9a-fA-F]{48}$ ]] || { printf '%s\n' 'OpenSSL did not produce a valid password.' >&2; exit 1; }
umask 077
temporary_file="$(mktemp "${root_dir}/.env.init.XXXXXXXX")"
trap 'rm -f "${temporary_file}"' EXIT
seen_password=0
seen_url=0
while IFS= read -r line || [[ -n "${line}" ]]; do
  case "${line}" in
    POSTGRES_PASSWORD=*)
      seen_password=$((seen_password + 1))
      printf 'POSTGRES_PASSWORD=%s\n' "${password}" >> "${temporary_file}"
      ;;
    DATABASE_URL=*)
      seen_url=$((seen_url + 1))
      printf 'DATABASE_URL=postgresql://lime:%s@localhost:5432/lime_db?sslmode=disable\n' "${password}" >> "${temporary_file}"
      ;;
    *) printf '%s\n' "${line}" >> "${temporary_file}" ;;
  esac
done < "${template}"
[[ "${seen_password}" -eq 1 && "${seen_url}" -eq 1 ]] || {
  printf '%s\n' '.env.example must contain one POSTGRES_PASSWORD and one DATABASE_URL.' >&2
  exit 1
}
chmod 600 "${temporary_file}"
# A hard link fails atomically if .env appeared while this file was prepared.
ln "${temporary_file}" "${env_file}" || {
  printf '%s\n' 'Could not create .env; an existing file was not changed.' >&2
  exit 1
}
printf '%s\n' 'Created private .env with a unique database password. Keep it for updates and backups.'
