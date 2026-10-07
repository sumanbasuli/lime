#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/debian-env.sh
. "${ROOT_DIR}/scripts/debian-env.sh"

test_dir="$(mktemp -d)"
trap 'rm -r -- "${test_dir}"' EXIT
env_file="${test_dir}/shopkeeper.env"

fail() {
  echo "Debian env verification failed: $1" >&2
  exit 1
}

expect_url() {
  local expected="$1"
  local actual
  actual="$(read_debian_database_url "${env_file}")" || fail "could not read expected URL"
  [[ "${actual}" == "${expected}" ]] || fail "DATABASE_URL did not match expected data"
}

printf '%s\n' \
  '# Shopkeeper runtime environment' \
  'DATABASE_URL=postgresql://lime:password@127.0.0.1:5432/lime_db?sslmode=disable' \
  'SHOPKEEPER_PORT=8080' > "${env_file}"
expect_url 'postgresql://lime:password@127.0.0.1:5432/lime_db?sslmode=disable'

printf '%s\n' \
  'DATABASE_URL=postgresql://old/db' \
  '  DATABASE_URL="postgresql://lime:p$word@localhost/db"' > "${env_file}"
expect_url 'postgresql://lime:p$word@localhost/db'

printf '%s\n' "DATABASE_URL='postgresql://lime:password@localhost/db'" > "${env_file}"
expect_url 'postgresql://lime:password@localhost/db'

marker="${test_dir}/executed"
printf 'PATH=$(touch %s)\nDATABASE_URL=$(touch %s)\n' "${marker}" "${marker}" > "${env_file}"
expect_url "\$(touch ${marker})"
[[ ! -e "${marker}" ]] || fail "environment-file command substitution executed"

printf '%s\n' 'DATABASE_URL=postgresql://lime:password@localhost/db\name' > "${env_file}"
if read_debian_database_url "${env_file}" >/dev/null 2>&1; then
  fail "unsupported escaping was silently accepted"
fi

printf '%s\n' 'SHOPKEEPER_PORT=8080' > "${env_file}"
if read_debian_database_url "${env_file}" >/dev/null 2>&1; then
  fail "missing DATABASE_URL was accepted"
fi

echo "Debian environment-file verification passed."
