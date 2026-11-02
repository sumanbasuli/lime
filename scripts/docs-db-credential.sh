#!/usr/bin/env bash

# Source this after checking that Node.js is available. The generated value is
# URL-safe because the docs Compose file also embeds it in DATABASE_URL.
lime_docs_db_credential() {
  if [ -z "${LIME_DOCS_DB_PASSWORD:-}" ]; then
    LIME_DOCS_DB_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')" || return 1
  fi
  if ! [[ "${LIME_DOCS_DB_PASSWORD}" =~ ^[A-Za-z0-9_-]{16,}$ ]]; then
    echo "LIME_DOCS_DB_PASSWORD must have at least 16 URL-safe letters, digits, underscores, or hyphens." >&2
    return 1
  fi
  export LIME_DOCS_DB_PASSWORD
}

# Dependency install/build tools do not need the isolated database credential.
# A subshell preserves it for subsequent Compose and verification commands.
lime_docs_without_password() (
  unset LIME_DOCS_DB_PASSWORD
  "$@"
)

# The product runner removes its own Compose volumes on exit. Refuse a retained
# verification project rather than taking ownership of data from an earlier run.
lime_verify_project_unoccupied() {
  local existing_containers existing_volumes
  if ! existing_containers="$(docker ps -aq --filter 'label=com.docker.compose.project=lime-verification')" ||
     ! existing_volumes="$(docker volume ls -q --filter 'label=com.docker.compose.project=lime-verification')"; then
    echo "Cannot inspect the isolated lime-verification Docker project." >&2
    return 1
  fi
  if [ -n "${existing_containers}" ] || [ -n "${existing_volumes}" ] ||
     docker volume inspect lime-verification_pgdata >/dev/null 2>&1 ||
     docker volume inspect lime-verification_screenshots >/dev/null 2>&1; then
    echo "The lime-verification Docker project already exists. Inspect it and remove only that disposable project yourself before running make verify-app." >&2
    return 1
  fi
}
